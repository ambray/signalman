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

use tonic::transport::Server;
use tracing::info;

/// Generated protobuf types for the GuestAgent service.
pub mod guest_proto {
    tonic::include_proto!("signalman.guest");
}

mod process;
mod service;
mod verification;

/// Default gRPC listen port.
const DEFAULT_PORT: u16 = 50051;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "signalman_guest=info".into()),
        )
        .init();

    let port = std::env::var("SIGNALMAN_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Default to loopback; override with SIGNALMAN_BIND for VM-accessible binding.
    let bind_addr =
        std::env::var("SIGNALMAN_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());

    let addr: SocketAddr = format!("{bind_addr}:{port}").parse()?;

    let svc = service::GuestAgentService::new();

    info!(
        address = %addr,
        version = env!("CARGO_PKG_VERSION"),
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
