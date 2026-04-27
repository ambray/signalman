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
/// Order of operations matters for correctness AND security:
///   1. Ensure the dir exists.
///   2. Generate certs into it (when absent).
///   3. **Harden the ACL** ([`harden_cert_dir_acls`]).
///
/// We harden AFTER the write, not before, so the writer (running as
/// whoever started this process) keeps write permission until the
/// keys land. The exposure window is microseconds on a one-time
/// install path — not race-able by an outside attacker — and it
/// keeps the install flow agnostic to which account runs it.
///
/// `harden_cert_dir_acls` runs on EVERY call — even when
/// `bundle.complete()` is true and no certs are written — so a
/// post-install ACL tamper (e.g. an attacker who widens access)
/// gets re-narrowed on the next service start.
pub fn ensure_certs(dir: &Path) -> Result<CertBundle> {
    fs::create_dir_all(dir).with_context(|| format!("creating cert dir {}", dir.display()))?;
    let bundle = CertBundle::at(dir.to_path_buf());
    if !bundle.complete() {
        generate_certs(&bundle)?;
    }
    // P4.b / Sec F2 — Critical fix:
    // Lock down the cert directory ACLs after writing any private-key
    // material. The default ACL on `%ProgramData%\Signalman\certs\` is
    // `Authenticated Users:R` (inherited), which means any local user
    // could copy `client.key` and impersonate the host MCP client to
    // the privileged daemon. Hardening strips inheritance and grants
    // only SYSTEM + Administrators.
    harden_cert_dir_acls(dir)?;
    Ok(bundle)
}

/// Lock down the cert directory's ACLs so the principals that need
/// access can read its contents AND nobody else can. P4.b / Sec F2
/// closure.
///
/// On Windows this shells out to `icacls` and:
///   1. Strips inherited ACEs with `/inheritance:r` — this is the
///      load-bearing flag for the security fix; the inherited
///      `Authenticated Users:R` that `%ProgramData%` cascades to its
///      children is what the audit flagged as Critical.
///   2. Grants `SYSTEM` full control (locale-independent SID
///      `*S-1-5-18`). The service runs under SYSTEM in the typical
///      MSI install.
///   3. Grants `BUILTIN\Administrators` full control (`*S-1-5-32-544`)
///      so install / uninstall / diagnostic flows work.
///   4. **Grants the current process's user** read access. This is
///      what makes the model work for non-Administrator host MCP
///      consumers: the host loads `client.pem` + `client.key` from
///      the same dir as the service, but typically runs as a
///      developer account that isn't a member of `Administrators`.
///      Without this grant, the host couldn't connect to the daemon
///      at all (the certs would be unreadable). The grant is `R`
///      (read-only) so the user can read the certs but not modify
///      them — modification still requires Administrator.
///
/// Production multi-user note: when multiple operators share a host,
/// the installer should add their accounts via an additional
/// `icacls "<dir>" /grant "<user>:(OI)(CI)R"` after this step runs.
/// The MSI build (P6) wires that for service-account-aware installs.
///
/// On non-Windows this is a no-op. Linux/macOS use a different cert
/// dir (`/etc/signalman/certs`) and rely on filesystem permissions
/// (mode 0700 owned by the service user) — not yet wired but
/// reserved here.
#[cfg(target_os = "windows")]
fn harden_cert_dir_acls(dir: &Path) -> Result<()> {
    use std::process::Command;

    let path_str = dir.to_string_lossy();
    let path_arg: &str = &path_str;

    // Two-step icacls flow so we replace the ENTIRE ACL atomically,
    // not just inherited ACEs. `/inheritance:r` alone leaves any
    // pre-existing EXPLICIT ACEs (e.g. an attacker who added
    // `Everyone:R` post-install) intact; the `/reset /T` step clears
    // all explicit ACEs first by re-applying the parent's inherited
    // ACL to this object. The follow-up `/inheritance:r /grant:r ...`
    // call then strips even that inherited ACL and lays down our
    // chosen grants. The result is an ACL containing exactly the
    // principals we specified — no leftover tamper grants survive.
    //
    // Two invocations means a brief window between them where the
    // ACL is "inherited only". That's still tighter than the default
    // post-install state (which IS inherited only with
    // `Authenticated Users:R`), so an attacker racing the window
    // gains nothing they didn't already have.
    let reset = Command::new("icacls")
        .arg(path_arg)
        .arg("/reset")
        .arg("/T")
        .output()
        .with_context(|| format!("invoking icacls /reset on {}", dir.display()))?;
    if !reset.status.success() {
        return Err(anyhow::anyhow!(
            "icacls /reset failed for {} (exit {}): {}",
            dir.display(),
            reset.status,
            String::from_utf8_lossy(&reset.stderr).trim()
        ));
    }

    // Build the harden invocation. SYSTEM and Administrators always
    // get FullControl; the current user gets Read (so the host MCP
    // can load its client cert).
    let mut cmd = Command::new("icacls");
    cmd.arg(path_arg)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg("*S-1-5-18:(OI)(CI)F") // Local SYSTEM SID
        .arg("/grant:r")
        .arg("*S-1-5-32-544:(OI)(CI)F"); // BUILTIN\Administrators SID

    // Add the current process's user as a Read grant. Use the
    // USERNAME env var when available (set in every Windows session);
    // skip silently if absent (the SYSTEM/Admins grants alone keep
    // the dir functional for the service path).
    if let Ok(user) = std::env::var("USERNAME") {
        if !user.is_empty() {
            cmd.arg("/grant:r")
                .arg(format!("{user}:(OI)(CI)R"));
        }
    }

    let output = cmd
        .output()
        .with_context(|| format!("invoking icacls on {}", dir.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(anyhow::anyhow!(
            "icacls failed for {} (exit {}): stderr={} stdout={}",
            dir.display(),
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn harden_cert_dir_acls(_dir: &Path) -> Result<()> {
    // Non-Windows hosts use a different cert dir convention; ACL
    // hardening for those will arrive with the cross-platform daemon
    // work in v0.3.0+.
    Ok(())
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

    // ── P4.b / Sec F2: cert dir ACL hardening ─────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn ensure_certs_strips_authenticated_users_acl_on_windows() {
        // After ensure_certs runs, the dir's ACL must NOT contain
        // "Authenticated Users" (the inherited grant that gave any
        // local user read access to client.key). The test parses
        // `icacls <dir>` output and asserts the principal is absent.
        // It also asserts the SYSTEM and Administrators principals
        // ARE present, since that's what we explicitly granted.
        use std::process::Command;

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let _bundle = ensure_certs(dir).expect("ensure_certs should harden ACLs");

        let output = Command::new("icacls")
            .arg(dir)
            .output()
            .expect("icacls invocation should succeed in test env");
        assert!(
            output.status.success(),
            "icacls inspection failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        // The strict-form output uses SIDs OR locale-localised principal
        // names; check for both shapes so the test isn't locale-fragile.
        assert!(
            !stdout.contains("Authenticated Users")
                && !stdout.contains("S-1-5-11"),
            "Authenticated Users (S-1-5-11) must NOT appear on the cert dir ACL after harden_cert_dir_acls; got:\n{}",
            stdout
        );
        // BUILTIN\Administrators SID = S-1-5-32-544. Localised name
        // varies (Administrators, Administrateurs, ...). Check SID.
        assert!(
            stdout.contains("S-1-5-32-544") || stdout.contains("Administrators"),
            "Administrators principal must remain on the cert dir ACL; got:\n{}",
            stdout
        );
        // SYSTEM SID = S-1-5-18.
        assert!(
            stdout.contains("S-1-5-18") || stdout.contains("SYSTEM"),
            "SYSTEM principal must remain on the cert dir ACL; got:\n{}",
            stdout
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ensure_certs_re_hardens_acl_on_idempotent_re_run() {
        // Defense-in-depth: a post-install attacker who widens the
        // ACL gets re-narrowed on the next service start. We
        // simulate post-install widening by running icacls /grant
        // ourselves, then calling ensure_certs again, then asserting
        // the wide grant is gone.
        use std::process::Command;

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        ensure_certs(dir).unwrap();

        // Tamper: explicitly add Everyone:R back. (S-1-1-0 = Everyone.)
        // If this command itself fails (e.g., test isn't running with
        // enough privileges), the test downgrades to a smoke check.
        let tamper = Command::new("icacls")
            .arg(dir)
            .arg("/grant:r")
            .arg("*S-1-1-0:(OI)(CI)R")
            .output()
            .expect("icacls tamper invocation");
        if !tamper.status.success() {
            // Skip rather than fail — some CI runners deny ACL writes.
            eprintln!(
                "skipping re-harden assertion: tamper-step icacls failed (likely insufficient privilege): {}",
                String::from_utf8_lossy(&tamper.stderr)
            );
            return;
        }

        // Re-harden via ensure_certs (idempotent path).
        ensure_certs(dir).unwrap();

        let inspect = Command::new("icacls")
            .arg(dir)
            .output()
            .expect("icacls inspect");
        let stdout = String::from_utf8_lossy(&inspect.stdout);
        assert!(
            !stdout.contains("Everyone") && !stdout.contains("S-1-1-0"),
            "Everyone (S-1-1-0) must be re-stripped on the next ensure_certs call; got:\n{}",
            stdout
        );
    }
}
