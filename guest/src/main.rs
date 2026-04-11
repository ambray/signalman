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
use tracing::{info, warn};

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

    info!(
        address = %addr,
        version = env!("CARGO_PKG_VERSION"),
        insecure = cli.allow_insecure,
        "Signalman guest agent starting"
    );

    Server::builder()
        .add_service(
            guest_proto::guest_agent_server::GuestAgentServer::new(svc),
        )
        .serve_with_shutdown(addr, async {
            tokio::signal::ctrl_c().await.ok();
            info!("Shutting down.");
        })
        .await?;

    Ok(())
}
