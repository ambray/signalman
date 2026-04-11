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
use tracing::{info, error};

mod process;
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

    let addr: SocketAddr = format!("0.0.0.0:{port}").parse()?;

    info!(
        address = %addr,
        version = env!("CARGO_PKG_VERSION"),
        "Signalman guest agent starting"
    );

    // TODO: Start gRPC server with GuestAgent service implementation
    // For now, just hold the process open
    info!("Guest agent ready. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    info!("Shutting down.");

    Ok(())
}
