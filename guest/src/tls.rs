//! TLS configuration loader for the guest agent.
//!
//! Validates the `--tls-cert`, `--tls-key`, and `--tls-ca` CLI flags and
//! builds a [`tonic::transport::ServerTlsConfig`] suitable for either
//! server-auth-only TLS or full mTLS.
//!
//! ### Modes
//! - **disabled**: no flags supplied — plaintext gRPC, bearer token only.
//! - **server-auth**: `--tls-cert` + `--tls-key` only — wire is encrypted,
//!   client identity not verified at the TLS layer.
//! - **mTLS**: all three flags — server requires the client to present a
//!   certificate signed by the supplied CA. Defense-in-depth: the bearer
//!   token interceptor still runs unless `--allow-insecure` is set.
//!
//! Partial flag combinations (cert without key, key without cert, CA
//! without identity) are rejected before the server starts.

use std::fs;
use std::path::Path;

use tonic::transport::{Certificate, Identity, ServerTlsConfig};

/// Outcome of inspecting the three TLS-related CLI flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsMode {
    /// No TLS flags were provided. Server runs plaintext gRPC.
    Disabled,
    /// `--tls-cert` and `--tls-key` were provided without `--tls-ca`.
    /// TLS is enabled but client certificates are not validated.
    ServerAuthOnly,
    /// All three flags were provided. Full mTLS — clients must present a
    /// certificate signed by the supplied CA.
    MutualTls,
}

/// Errors that arise while validating or loading TLS material.
#[derive(Debug, thiserror::Error)]
pub enum TlsConfigError {
    /// One half of an identity pair was provided without the other half.
    #[error("Partial TLS configuration: --tls-cert and --tls-key must be specified together")]
    PartialIdentity,

    /// `--tls-ca` was given without `--tls-cert`/`--tls-key`. The server
    /// has no identity to present and so cannot start with TLS.
    #[error(
        "Partial TLS configuration: --tls-ca requires --tls-cert and --tls-key (the server needs an identity to present)"
    )]
    CaWithoutIdentity,

    /// A configured PEM file could not be read.
    #[error("failed to read TLS file {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// Inspect the three CLI flags and determine which TLS mode applies.
///
/// Refuses partial configurations so the operator gets an immediate
/// failure at startup rather than a confusing TLS handshake error later.
pub fn classify(
    cert: Option<&str>,
    key: Option<&str>,
    ca: Option<&str>,
) -> Result<TlsMode, TlsConfigError> {
    match (cert.is_some(), key.is_some(), ca.is_some()) {
        (false, false, false) => Ok(TlsMode::Disabled),
        (true, true, false) => Ok(TlsMode::ServerAuthOnly),
        (true, true, true) => Ok(TlsMode::MutualTls),
        (false, false, true) => Err(TlsConfigError::CaWithoutIdentity),
        // Any other shape — including (true,false,*), (false,true,*) — is a
        // partial identity. Surface the most actionable error first.
        _ => Err(TlsConfigError::PartialIdentity),
    }
}

/// Load PEM material from disk and assemble a [`ServerTlsConfig`].
///
/// Caller is expected to have already called [`classify`] and decided that
/// TLS should be enabled. `cert`/`key` must be present; `ca` is required
/// for full mTLS and ignored for server-auth-only mode.
pub fn build_server_config(
    cert_path: &Path,
    key_path: &Path,
    ca_path: Option<&Path>,
) -> Result<ServerTlsConfig, TlsConfigError> {
    let cert_pem = read_pem(cert_path)?;
    let key_pem = read_pem(key_path)?;
    let identity = Identity::from_pem(cert_pem, key_pem);

    let mut cfg = ServerTlsConfig::new().identity(identity);
    if let Some(ca) = ca_path {
        let ca_pem = read_pem(ca)?;
        cfg = cfg.client_ca_root(Certificate::from_pem(ca_pem));
    }
    Ok(cfg)
}

fn read_pem(path: &Path) -> Result<Vec<u8>, TlsConfigError> {
    fs::read(path).map_err(|source| TlsConfigError::Io {
        path: path.display().to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_disabled_when_no_flags() {
        assert_eq!(classify(None, None, None).unwrap(), TlsMode::Disabled);
    }

    #[test]
    fn classify_server_auth_when_cert_and_key() {
        assert_eq!(
            classify(Some("c.pem"), Some("k.pem"), None).unwrap(),
            TlsMode::ServerAuthOnly,
        );
    }

    #[test]
    fn classify_mtls_when_all_three() {
        assert_eq!(
            classify(Some("c.pem"), Some("k.pem"), Some("ca.pem")).unwrap(),
            TlsMode::MutualTls,
        );
    }

    #[test]
    fn classify_rejects_cert_without_key() {
        let err = classify(Some("c.pem"), None, None).unwrap_err();
        assert!(matches!(err, TlsConfigError::PartialIdentity));
    }

    #[test]
    fn classify_rejects_key_without_cert() {
        let err = classify(None, Some("k.pem"), None).unwrap_err();
        assert!(matches!(err, TlsConfigError::PartialIdentity));
    }

    #[test]
    fn classify_rejects_cert_without_key_with_ca() {
        let err = classify(Some("c.pem"), None, Some("ca.pem")).unwrap_err();
        assert!(matches!(err, TlsConfigError::PartialIdentity));
    }

    #[test]
    fn classify_rejects_ca_without_identity() {
        let err = classify(None, None, Some("ca.pem")).unwrap_err();
        assert!(matches!(err, TlsConfigError::CaWithoutIdentity));
    }

    #[test]
    fn build_server_config_reports_missing_file() {
        let err = build_server_config(
            Path::new("/nonexistent/cert.pem"),
            Path::new("/nonexistent/key.pem"),
            None,
        )
        .unwrap_err();
        match err {
            TlsConfigError::Io { path, .. } => {
                assert!(path.contains("cert.pem"), "unexpected path: {path}");
            }
            other => panic!("expected Io error, got {other:?}"),
        }
    }
}
