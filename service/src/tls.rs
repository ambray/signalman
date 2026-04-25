//! Dev-cert generation and rustls config helpers.
//!
//! At install time we generate a CA + service cert + client cert under
//! `%ProgramData%\Signalman\certs\`. The host MCP client reads the same
//! directory to load `ca.pem` + `client.pem` + `client.key`. v0.1.0
//! ships dev certs only — production code-signing + cert pinning is a
//! separate pickup.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose,
    PKCS_ECDSA_P256_SHA256,
};

/// Filenames written into the cert directory.
pub const CA_CERT: &str = "ca.pem";
pub const CA_KEY: &str = "ca.key";
pub const SERVER_CERT: &str = "server.pem";
pub const SERVER_KEY: &str = "server.key";
pub const CLIENT_CERT: &str = "client.pem";
pub const CLIENT_KEY: &str = "client.key";

/// Bundle paths for a generated cert directory.
#[derive(Debug, Clone)]
pub struct CertBundle {
    pub root: PathBuf,
    pub ca_cert: PathBuf,
    pub ca_key: PathBuf,
    pub server_cert: PathBuf,
    pub server_key: PathBuf,
    pub client_cert: PathBuf,
    pub client_key: PathBuf,
}

impl CertBundle {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            ca_cert: root.join(CA_CERT),
            ca_key: root.join(CA_KEY),
            server_cert: root.join(SERVER_CERT),
            server_key: root.join(SERVER_KEY),
            client_cert: root.join(CLIENT_CERT),
            client_key: root.join(CLIENT_KEY),
            root,
        }
    }

    /// True iff every cert/key file already exists.
    pub fn complete(&self) -> bool {
        [
            &self.ca_cert,
            &self.ca_key,
            &self.server_cert,
            &self.server_key,
            &self.client_cert,
            &self.client_key,
        ]
        .iter()
        .all(|p| p.exists())
    }
}

/// Default cert directory: `%ProgramData%\Signalman\certs` on Windows,
/// `/etc/signalman/certs` elsewhere (for libvirt port v0.3.0+).
pub fn default_cert_dir() -> PathBuf {
    if cfg!(windows) {
        let pd = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        PathBuf::from(pd).join("Signalman").join("certs")
    } else {
        PathBuf::from("/etc/signalman/certs")
    }
}

/// Ensure the cert bundle exists at `dir`, generating it if absent.
///
/// Idempotent: if every file is already present, this is a no-op.
/// Always creates the parent directory if it doesn't exist.
pub fn ensure_certs(dir: &Path) -> Result<CertBundle> {
    fs::create_dir_all(dir).with_context(|| format!("creating cert dir {}", dir.display()))?;
    let bundle = CertBundle::at(dir.to_path_buf());
    if bundle.complete() {
        return Ok(bundle);
    }
    generate_certs(&bundle)?;
    Ok(bundle)
}

/// Forcibly regenerate certs into `bundle`. Overwrites any existing files.
pub fn generate_certs(bundle: &CertBundle) -> Result<()> {
    fs::create_dir_all(&bundle.root)
        .with_context(|| format!("creating cert dir {}", bundle.root.display()))?;

    // ── CA ───────────────────────────────────────────────────────
    let mut ca_params = CertificateParams::new(vec!["Signalman Dev CA".to_string()])
        .context("building CA params")?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.distinguished_name = {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Signalman Dev CA");
        dn.push(DnType::OrganizationName, "Signalman");
        dn
    };
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("CA keypair")?;
    let ca_cert = ca_params.self_signed(&ca_key).context("self-signing CA")?;
    write_pem(&bundle.ca_cert, &ca_cert.pem())?;
    write_pem(&bundle.ca_key, &ca_key.serialize_pem())?;

    // ── Server cert ──────────────────────────────────────────────
    let mut srv_params = CertificateParams::new(vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "signalman-service".to_string(),
    ])
    .context("server params")?;
    srv_params.distinguished_name = {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "signalman-service");
        dn.push(DnType::OrganizationName, "Signalman");
        dn
    };
    srv_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    srv_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let srv_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("server keypair")?;
    let srv_cert = srv_params
        .signed_by(&srv_key, &ca_cert, &ca_key)
        .context("signing server cert")?;
    write_pem(&bundle.server_cert, &srv_cert.pem())?;
    write_pem(&bundle.server_key, &srv_key.serialize_pem())?;

    // ── Client cert ──────────────────────────────────────────────
    let mut cli_params =
        CertificateParams::new(vec!["signalman-client".to_string()]).context("client params")?;
    cli_params.distinguished_name = {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "signalman-client");
        dn.push(DnType::OrganizationName, "Signalman");
        dn
    };
    cli_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    cli_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
    let cli_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("client keypair")?;
    let cli_cert = cli_params
        .signed_by(&cli_key, &ca_cert, &ca_key)
        .context("signing client cert")?;
    write_pem(&bundle.client_cert, &cli_cert.pem())?;
    write_pem(&bundle.client_key, &cli_key.serialize_pem())?;

    Ok(())
}

fn write_pem(path: &Path, contents: &str) -> Result<()> {
    let mut f = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    f.write_all(contents.as_bytes())
        .with_context(|| format!("writing pem body to {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_certs_creates_then_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let b1 = ensure_certs(dir).unwrap();
        assert!(b1.complete(), "first run should produce all files");
        let mtime1 = fs::metadata(&b1.ca_cert).unwrap().modified().unwrap();
        // Second run is a no-op.
        let _b2 = ensure_certs(dir).unwrap();
        let mtime2 = fs::metadata(&b1.ca_cert).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "ensure_certs should be idempotent");
    }

    #[test]
    fn generated_pems_are_well_formed() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = CertBundle::at(tmp.path().to_path_buf());
        generate_certs(&bundle).unwrap();
        let ca_pem = fs::read_to_string(&bundle.ca_cert).unwrap();
        assert!(ca_pem.contains("BEGIN CERTIFICATE"));
        let cli_key_pem = fs::read_to_string(&bundle.client_key).unwrap();
        assert!(cli_key_pem.contains("PRIVATE KEY"));
    }
}
