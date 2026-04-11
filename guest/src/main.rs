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
//! Communicates with the host MCP server via gRPC (mTLS).

use std::net::SocketAddr;

use clap::Parser;
use tonic::transport::Server;
use tracing::{error, info, warn};

/// Generated protobuf types for the GuestAgent service.
pub mod guest_proto {
    tonic::include_proto!("signalman.guest");
}

pub mod process;
mod service;
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

    /// Allow running without TLS. When omitted, a warning is logged that
    /// TLS is not yet configured but will be required in the future.
    #[arg(long)]
    allow_insecure: bool,

    /// Bearer token for gRPC authentication. Clients must send this token
    /// in the `authorization` metadata header as `Bearer <token>`.
    /// Can also be set via the `SIGNALMAN_AUTH_TOKEN` environment variable.
    #[arg(long, env = "SIGNALMAN_AUTH_TOKEN")]
    token: Option<String>,
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
    fn call(
        &mut self,
        request: tonic::Request<()>,
    ) -> Result<tonic::Request<()>, tonic::Status> {
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
    if cli.allow_insecure {
        warn!("Running in insecure mode \u{2014} no TLS");
    } else {
        warn!(
            "TLS is not yet configured but will be required in a future release. \
             Pass --allow-insecure to suppress this warning."
        );
    }

    let svc = service::GuestAgentService::new();
    let interceptor = AuthInterceptor::new(cli.token);

    info!(
        address = %addr,
        version = env!("CARGO_PKG_VERSION"),
        insecure = cli.allow_insecure,
        auth_enabled = interceptor.expected_token.is_some(),
        "Signalman guest agent starting"
    );

    Server::builder()
        .add_service(
            guest_proto::guest_agent_server::GuestAgentServer::with_interceptor(
                svc,
                interceptor,
            ),
        )
        .serve_with_shutdown(addr, async {
            tokio::signal::ctrl_c().await.ok();
            info!("Shutting down.");
        })
        .await?;

    Ok(())
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
