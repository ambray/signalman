//! Signalman Guest Agent
//!
//! Runs inside each VM as a Windows service (or Linux daemon) providing:
//! - Process control (start, stop, inspect)
//! - UI automation (Windows UI Automation API)
//! - Browser automation (Chrome DevTools Protocol)
//! - Restriction verification (AppContainer, firewall, ACL)
//! - Software installation (winget, choco, direct)
//! - Screenshot capture
//!
//! Communicates with the host MCP server via gRPC. Wire encryption is
//! configured through the `--tls-cert`, `--tls-key`, and `--tls-ca`
//! flags; bearer-token authentication via `--token` continues to apply
//! on top of TLS as a defense-in-depth layer.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;
use tonic::transport::Server;
use tracing::{error, info, warn};

/// Generated protobuf types for the GuestAgent service.
pub mod guest_proto {
    tonic::include_proto!("signalman.guest");
}

pub mod process;
mod service;
pub mod tls;
pub mod verification;

/// Default gRPC listen address (loopback only for security).
const DEFAULT_BIND: &str = "127.0.0.1:50051";

/// Signalman Guest Agent — gRPC service for VM process control and verification.
#[derive(Parser, Debug)]
#[command(name = "signalman-guest", version, about)]
struct Cli {
    /// Bind address in `host:port` format.
    /// Defaults to 127.0.0.1:50051 (loopback only).
    /// Override with `--bind 0.0.0.0:50051` for VM-accessible binding.
    #[arg(long, default_value = DEFAULT_BIND, env = "SIGNALMAN_BIND")]
    bind: String,

    /// Allow running without TLS or bearer token. Useful only for local
    /// development; refuses to bind a non-loopback interface.
    #[arg(long)]
    allow_insecure: bool,

    /// Bearer token for gRPC authentication. Clients must send this token
    /// in the `authorization` metadata header as `Bearer <token>`.
    /// Can also be set via the `SIGNALMAN_AUTH_TOKEN` environment variable.
    #[arg(long, env = "SIGNALMAN_AUTH_TOKEN")]
    token: Option<String>,

    /// PEM-encoded TLS server certificate. When supplied together with
    /// `--tls-key`, the gRPC listener is wrapped in TLS. Combine with
    /// `--tls-ca` to require client certificates (full mTLS).
    #[arg(long, env = "SIGNALMAN_TLS_CERT")]
    tls_cert: Option<PathBuf>,

    /// PEM-encoded TLS private key matching `--tls-cert`.
    #[arg(long, env = "SIGNALMAN_TLS_KEY")]
    tls_key: Option<PathBuf>,

    /// PEM-encoded CA certificate used to validate client certificates.
    /// Requires `--tls-cert` and `--tls-key`. When this flag is omitted
    /// but identity flags are present, the server still negotiates TLS but
    /// does not verify client identity at the TLS layer.
    #[arg(long, env = "SIGNALMAN_TLS_CA")]
    tls_ca: Option<PathBuf>,
}

/// Bearer-token authentication interceptor for gRPC requests.
///
/// If a token is configured, every inbound request must include an
/// `authorization` metadata header with value `Bearer <token>`.
/// Requests without a valid token are rejected with `UNAUTHENTICATED`.
#[derive(Clone)]
struct AuthInterceptor {
    /// The expected bearer token, if authentication is enabled.
    expected_token: Option<String>,
}

impl AuthInterceptor {
    /// Create a new interceptor. Pass `None` to disable authentication
    /// (only valid when `--allow-insecure` is set).
    fn new(token: Option<String>) -> Self {
        Self {
            expected_token: token,
        }
    }
}

impl tonic::service::Interceptor for AuthInterceptor {
    fn call(&mut self, request: tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> {
        let Some(ref expected) = self.expected_token else {
            // No token configured — pass through (insecure mode).
            return Ok(request);
        };

        let auth_header = request
            .metadata()
            .get("authorization")
            .and_then(|v| v.to_str().ok());

        match auth_header {
            Some(value) if value == format!("Bearer {expected}") => Ok(request),
            Some(_) => Err(tonic::Status::unauthenticated("Invalid bearer token")),
            None => Err(tonic::Status::unauthenticated(
                "Missing authorization header",
            )),
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "signalman_guest=info".into()),
        )
        .init();

    let cli = Cli::parse();

    let addr: SocketAddr = cli.bind.parse()?;

    // Validate TLS flag combinations before any further work — this lets
    // the operator see the failure immediately rather than during the TLS
    // handshake.
    let tls_mode = match tls::classify(
        cli.tls_cert.as_deref().and_then(|p| p.to_str()),
        cli.tls_key.as_deref().and_then(|p| p.to_str()),
        cli.tls_ca.as_deref().and_then(|p| p.to_str()),
    ) {
        Ok(mode) => mode,
        Err(err) => {
            error!("Invalid TLS configuration: {err}");
            std::process::exit(1);
        }
    };

    // S-05: Enforce authentication configuration.
    // If no token is configured AND --allow-insecure is not set, refuse to start.
    if cli.token.is_none() && !cli.allow_insecure {
        error!(
            "No authentication token configured. Either set --token / SIGNALMAN_AUTH_TOKEN, \
             or pass --allow-insecure to run without authentication."
        );
        std::process::exit(1);
    }

    if cli.token.is_none() && cli.allow_insecure {
        warn!(
            "WARNING: Running without authentication! Any client can connect and execute commands. \
             This is intended for development/testing only."
        );
    }

    // TLS security posture logging
    match tls_mode {
        tls::TlsMode::Disabled if cli.allow_insecure => {
            warn!("Running in insecure mode — no TLS");
        }
        tls::TlsMode::Disabled => {
            warn!(
                "TLS is not yet configured but is the recommended posture. \
                 Pass --tls-cert/--tls-key (and optionally --tls-ca for mTLS), \
                 or --allow-insecure to suppress this warning."
            );
        }
        tls::TlsMode::ServerAuthOnly => {
            info!(
                "TLS enabled (server-auth-only). Wire is encrypted but client \
                 certificates are not validated. Consider providing --tls-ca \
                 for full mTLS in production."
            );
        }
        tls::TlsMode::MutualTls => {
            info!("Mutual TLS enabled — client certificates required.");
        }
    }

    let svc = service::GuestAgentService::new();
    let interceptor = AuthInterceptor::new(cli.token);

    info!(
        address = %addr,
        version = env!("CARGO_PKG_VERSION"),
        insecure = cli.allow_insecure,
        auth_enabled = interceptor.expected_token.is_some(),
        tls_mode = ?tls_mode,
        "Signalman guest agent starting"
    );

    let mut builder = Server::builder();
    if matches!(
        tls_mode,
        tls::TlsMode::ServerAuthOnly | tls::TlsMode::MutualTls
    ) {
        // unwrap is safe: classify guarantees cert/key are present in
        // these two arms.
        let cert_path = cli.tls_cert.as_ref().expect("validated by classify");
        let key_path = cli.tls_key.as_ref().expect("validated by classify");
        let ca_path = cli.tls_ca.as_deref();
        let tls_cfg = match tls::build_server_config(cert_path, key_path, ca_path) {
            Ok(cfg) => cfg,
            Err(err) => {
                error!("Failed to load TLS material: {err}");
                std::process::exit(1);
            }
        };
        builder = builder.tls_config(tls_cfg)?;
    }

    builder
        .add_service(
            guest_proto::guest_agent_server::GuestAgentServer::with_interceptor(svc, interceptor),
        )
        .serve_with_shutdown(addr, async {
            tokio::signal::ctrl_c().await.ok();
            info!("Shutting down.");
        })
        .await?;

    Ok(())
}

#[cfg(test)]
mod mtls_integration_tests {
    //! End-to-end integration tests for the guest agent's TLS modes.
    //!
    //! These tests spin up an actual `tonic::transport::Server` on a
    //! loopback port, connect with a real `tonic::transport::Endpoint`,
    //! and verify that:
    //! * a client with a valid certificate can call `health`,
    //! * a client with no certificate is rejected,
    //! * a client whose certificate is signed by a different CA is
    //!   rejected at the TLS handshake.
    //!
    //! Certificate material is generated in-process via `rcgen`.
    use super::*;
    use crate::guest_proto::guest_agent_client::GuestAgentClient;
    use crate::guest_proto::HealthRequest;
    use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, KeyPair};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Server};

    /// One issued cert + key as PEM strings.
    struct PemPair {
        cert: String,
        key: String,
    }

    /// One CA + one server cert + one client cert, all in PEM form.
    struct TestPki {
        ca: PemPair,
        server: PemPair,
        client: PemPair,
    }

    fn build_ca(common_name: &str) -> (rcgen::Certificate, KeyPair) {
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, common_name);
        let key_pair = KeyPair::generate().expect("ca keypair");
        let cert = params.self_signed(&key_pair).expect("ca self-sign");
        (cert, key_pair)
    }

    fn issue(
        ca: &rcgen::Certificate,
        ca_key: &KeyPair,
        sans: Vec<String>,
        common_name: &str,
    ) -> PemPair {
        let mut params = CertificateParams::new(sans).unwrap();
        params
            .distinguished_name
            .push(DnType::CommonName, common_name);
        let key_pair = KeyPair::generate().expect("leaf keypair");
        let cert = params.signed_by(&key_pair, ca, ca_key).expect("sign leaf");
        PemPair {
            cert: cert.pem(),
            key: key_pair.serialize_pem(),
        }
    }

    fn build_pki() -> TestPki {
        let (ca_cert, ca_key) = build_ca("Signalman Test CA");
        let server = issue(
            &ca_cert,
            &ca_key,
            vec!["localhost".into(), "127.0.0.1".into()],
            "signalman-guest",
        );
        let client = issue(
            &ca_cert,
            &ca_key,
            vec!["client.test".into()],
            "signalman-host",
        );
        let ca = PemPair {
            cert: ca_cert.pem(),
            key: ca_key.serialize_pem(),
        };
        TestPki { ca, server, client }
    }

    /// Spawn the GuestAgent service on a loopback port with the given TLS
    /// config. Returns the bound `host:port` string and a shutdown trigger.
    async fn spawn_server(
        tls_cfg: tonic::transport::ServerTlsConfig,
    ) -> (String, tokio::sync::oneshot::Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let svc = service::GuestAgentService::new();
        let interceptor = AuthInterceptor::new(None);
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            let stream = tokio_stream::wrappers::TcpListenerStream::new(listener);
            Server::builder()
                .tls_config(tls_cfg)
                .expect("server tls cfg")
                .add_service(
                    guest_proto::guest_agent_server::GuestAgentServer::with_interceptor(
                        svc,
                        interceptor,
                    ),
                )
                .serve_with_incoming_shutdown(stream, async {
                    rx.await.ok();
                })
                .await
                .ok();
        });

        // Brief delay so the server is accepting connections before the
        // first dial. 50ms is plenty on loopback.
        tokio::time::sleep(Duration::from_millis(50)).await;

        (format!("127.0.0.1:{}", addr.port()), tx)
    }

    fn server_tls_config(pki: &TestPki) -> tonic::transport::ServerTlsConfig {
        let identity = tonic::transport::Identity::from_pem(
            pki.server.cert.as_bytes(),
            pki.server.key.as_bytes(),
        );
        tonic::transport::ServerTlsConfig::new()
            .identity(identity)
            .client_ca_root(Certificate::from_pem(pki.ca.cert.as_bytes()))
    }

    #[tokio::test]
    async fn mtls_valid_client_succeeds() {
        let pki = build_pki();
        let (addr, shutdown) = spawn_server(server_tls_config(&pki)).await;

        let identity = tonic::transport::Identity::from_pem(
            pki.client.cert.as_bytes(),
            pki.client.key.as_bytes(),
        );
        let tls = ClientTlsConfig::new()
            .domain_name("localhost")
            .ca_certificate(Certificate::from_pem(pki.ca.cert.as_bytes()))
            .identity(identity);

        let endpoint = Endpoint::from_shared(format!("https://{addr}"))
            .unwrap()
            .tls_config(tls)
            .unwrap()
            .connect_timeout(Duration::from_secs(5));

        let channel = endpoint.connect().await.expect("client connect");
        let mut client = GuestAgentClient::new(channel);
        let resp = client
            .health(HealthRequest {})
            .await
            .expect("health rpc should succeed over mTLS");
        assert!(!resp.into_inner().agent_version.is_empty());

        let _ = shutdown.send(());
    }

    #[tokio::test]
    async fn mtls_no_client_cert_rejected() {
        let pki = build_pki();
        let (addr, shutdown) = spawn_server(server_tls_config(&pki)).await;

        // No client identity supplied — server-auth-only TLS.
        let tls = ClientTlsConfig::new()
            .domain_name("localhost")
            .ca_certificate(Certificate::from_pem(pki.ca.cert.as_bytes()));

        let endpoint = Endpoint::from_shared(format!("https://{addr}"))
            .unwrap()
            .tls_config(tls)
            .unwrap()
            .connect_timeout(Duration::from_secs(5));

        // The handshake (or first RPC) MUST fail when the server demands a
        // client certificate and none is presented. Some platforms surface
        // the failure at connect time; others defer until the first RPC.
        let outcome = match endpoint.connect().await {
            Err(_) => Err(()),
            Ok(channel) => {
                let mut client = GuestAgentClient::new(channel);
                match tokio::time::timeout(Duration::from_secs(5), client.health(HealthRequest {}))
                    .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(_)) | Err(_) => Err(()),
                }
            }
        };
        assert!(
            outcome.is_err(),
            "client without a certificate must not be able to call Health"
        );

        let _ = shutdown.send(());
    }

    #[tokio::test]
    async fn mtls_wrong_ca_rejected() {
        let pki = build_pki();
        let (addr, shutdown) = spawn_server(server_tls_config(&pki)).await;

        // Mint a brand-new CA + client cert; the server's `client_ca_root`
        // does not trust this issuer, so the handshake must fail.
        let (other_ca_cert, other_ca_key) = build_ca("Untrusted CA");
        let foreign_client = issue(
            &other_ca_cert,
            &other_ca_key,
            vec!["foreign.test".into()],
            "foreign-client",
        );

        let identity = tonic::transport::Identity::from_pem(
            foreign_client.cert.as_bytes(),
            foreign_client.key.as_bytes(),
        );
        let tls = ClientTlsConfig::new()
            .domain_name("localhost")
            .ca_certificate(Certificate::from_pem(pki.ca.cert.as_bytes()))
            .identity(identity);

        let endpoint = Endpoint::from_shared(format!("https://{addr}"))
            .unwrap()
            .tls_config(tls)
            .unwrap()
            .connect_timeout(Duration::from_secs(5));

        let outcome = match endpoint.connect().await {
            Err(_) => Err(()),
            Ok(channel) => {
                let mut client = GuestAgentClient::new(channel);
                match tokio::time::timeout(Duration::from_secs(5), client.health(HealthRequest {}))
                    .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(_)) | Err(_) => Err(()),
                }
            }
        };
        assert!(
            outcome.is_err(),
            "client cert from an untrusted CA must be rejected"
        );

        let _ = shutdown.send(());
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use tonic::service::Interceptor;

    #[test]
    fn test_auth_interceptor_valid_token() {
        let mut interceptor = AuthInterceptor::new(Some("secret123".into()));

        let mut request = tonic::Request::new(());
        request
            .metadata_mut()
            .insert("authorization", "Bearer secret123".parse().unwrap());

        assert!(interceptor.call(request).is_ok());
    }

    #[test]
    fn test_auth_interceptor_invalid_token() {
        let mut interceptor = AuthInterceptor::new(Some("secret123".into()));

        let mut request = tonic::Request::new(());
        request
            .metadata_mut()
            .insert("authorization", "Bearer wrong-token".parse().unwrap());

        let err = interceptor.call(request).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
        assert!(err.message().contains("Invalid"));
    }

    #[test]
    fn test_auth_interceptor_missing_token() {
        let mut interceptor = AuthInterceptor::new(Some("secret123".into()));

        let request = tonic::Request::new(());

        let err = interceptor.call(request).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
        assert!(err.message().contains("Missing"));
    }

    #[test]
    fn test_auth_interceptor_no_auth_configured() {
        let mut interceptor = AuthInterceptor::new(None);

        let request = tonic::Request::new(());
        assert!(interceptor.call(request).is_ok());
    }

    #[test]
    fn test_auth_interceptor_wrong_scheme() {
        let mut interceptor = AuthInterceptor::new(Some("secret123".into()));

        let mut request = tonic::Request::new(());
        request
            .metadata_mut()
            .insert("authorization", "Basic secret123".parse().unwrap());

        let err = interceptor.call(request).unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);
    }
}
