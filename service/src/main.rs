//! `signalman-service` CLI entry point.
//!
//! Sub-commands:
//!   - install    — register with the Windows SCM (also generates dev certs)
//!   - uninstall  — stop + delete the service
//!   - start      — `sc start Signalman`
//!   - stop       — `sc stop Signalman`
//!   - run        — foreground mode, primarily for development
//!   - run-service — invoked by the SCM only; not for human use
//!
//! On non-Windows targets the CLI compiles, but install/uninstall/SCM
//! sub-commands return an error explaining that v0.1.0 is Windows-only.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use tokio::sync::watch;
use tracing_subscriber::{fmt, EnvFilter};

use signalman_service::backend::{Backend, HyperVBackend};
use signalman_service::tls::{ensure_certs, rotate_certs};
use signalman_service::transport::{serve, TransportConfig};
use signalman_service::{DEFAULT_GRPC_PORT, PIPE_NAME};

#[derive(Parser, Debug)]
#[command(
    name = "signalman-service",
    about = "Signalman host control-plane service.",
    version,
    long_about = "Privileged daemon that brokers Hyper-V management calls on behalf of \
                  unelevated Signalman clients. Replaces per-call gsudo elevation with a \
                  single install-time grant."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Register the service with the Windows Service Control Manager.
    Install {
        /// Override the binary path (defaults to the current exe).
        #[arg(long)]
        binary: Option<PathBuf>,

        /// Cert directory (defaults to %ProgramData%\Signalman\certs).
        #[arg(long)]
        cert_dir: Option<PathBuf>,

        /// Run as a specific account ("DOMAIN\\user"). LocalSystem if unset.
        #[arg(long)]
        account: Option<String>,

        /// Password for the service account.
        #[arg(long)]
        password: Option<String>,
    },

    /// Stop and remove the service.
    Uninstall,

    /// Ask the SCM to start the service.
    Start,

    /// Ask the SCM to stop the service.
    Stop,

    /// Rotate the service mTLS cert bundle. Restart the service after this.
    #[command(name = "rotate-certs")]
    RotateCerts {
        /// Cert directory (defaults to %ProgramData%\Signalman\certs).
        #[arg(long)]
        cert_dir: Option<PathBuf>,
    },

    /// Run the service in the foreground (development).
    Run {
        /// Override the cert directory.
        #[arg(long)]
        cert_dir: Option<PathBuf>,

        /// TCP port for the localhost mTLS listener.
        #[arg(long, default_value_t = DEFAULT_GRPC_PORT)]
        port: u16,

        /// Disable the named-pipe listener (TCP only).
        #[arg(long)]
        no_pipe: bool,

        /// Disable the TCP listener (pipe only).
        #[arg(long)]
        no_tcp: bool,
    },

    /// Internal: invoked by the Windows SCM. Don't run by hand.
    #[command(hide = true)]
    RunService,
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).with_target(false).init();
}

fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        Command::Install {
            binary,
            cert_dir,
            account,
            password,
        } => install(binary, cert_dir, account, password),
        Command::Uninstall => uninstall(),
        Command::Start => start(),
        Command::Stop => stop(),
        Command::RotateCerts { cert_dir } => rotate_cert_bundle(cert_dir),
        Command::Run {
            cert_dir,
            port,
            no_pipe,
            no_tcp,
        } => run_foreground(cert_dir, port, no_pipe, no_tcp),
        Command::RunService => run_under_scm(),
    }
}

#[cfg(target_os = "windows")]
fn install(
    binary: Option<PathBuf>,
    cert_dir: Option<PathBuf>,
    account: Option<String>,
    password: Option<String>,
) -> Result<()> {
    use signalman_service::service_runtime::{install as do_install, InstallOptions};
    let exe = match binary {
        Some(p) => p,
        None => std::env::current_exe()?,
    };
    let opts = InstallOptions {
        binary: exe,
        cert_dir,
        account_name: account,
        account_password: password,
    };
    do_install(opts)?;
    println!("Installed Signalman service.");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install(
    _: Option<PathBuf>,
    _: Option<PathBuf>,
    _: Option<String>,
    _: Option<String>,
) -> Result<()> {
    Err(anyhow!(
        "service install is only supported on Windows in v0.1.0"
    ))
}

#[cfg(target_os = "windows")]
fn uninstall() -> Result<()> {
    signalman_service::service_runtime::uninstall()?;
    println!("Uninstalled Signalman service.");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn uninstall() -> Result<()> {
    Err(anyhow!(
        "service uninstall is only supported on Windows in v0.1.0"
    ))
}

#[cfg(target_os = "windows")]
fn start() -> Result<()> {
    signalman_service::service_runtime::start_service()?;
    println!("Started Signalman service.");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn start() -> Result<()> {
    Err(anyhow!(
        "service start is only supported on Windows in v0.1.0"
    ))
}

#[cfg(target_os = "windows")]
fn stop() -> Result<()> {
    signalman_service::service_runtime::stop_service()?;
    println!("Stopped Signalman service.");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn stop() -> Result<()> {
    Err(anyhow!(
        "service stop is only supported on Windows in v0.1.0"
    ))
}

#[cfg(target_os = "windows")]
fn run_under_scm() -> Result<()> {
    signalman_service::service_runtime::dispatch()
}

#[cfg(not(target_os = "windows"))]
fn run_under_scm() -> Result<()> {
    Err(anyhow!("SCM dispatch is only supported on Windows"))
}

fn run_foreground(cert_dir: Option<PathBuf>, port: u16, no_pipe: bool, no_tcp: bool) -> Result<()> {
    if no_pipe && no_tcp {
        return Err(anyhow!("at least one of TCP or pipe must be enabled"));
    }
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let cert_dir = cert_dir.unwrap_or_else(signalman_service::tls::default_cert_dir);
        let bundle = ensure_certs(&cert_dir)?;
        let (tx, rx) = watch::channel(false);

        let backend: Arc<dyn Backend> = Arc::new(HyperVBackend::new());
        let config = TransportConfig {
            tcp: if no_tcp {
                None
            } else {
                Some(format!("127.0.0.1:{port}").parse()?)
            },
            pipe: if no_pipe {
                None
            } else {
                Some(PIPE_NAME.to_string())
            },
            certs: bundle,
        };

        // Wire ctrl-c to shutdown.
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = tx.send(true);
            }
        });

        tracing::info!(?config.tcp, ?config.pipe, "starting signalman-service");
        serve(backend, config, rx).await
    })
}

fn rotate_cert_bundle(cert_dir: Option<PathBuf>) -> Result<()> {
    let cert_dir = cert_dir.unwrap_or_else(signalman_service::tls::default_cert_dir);
    let report = rotate_certs(&cert_dir)?;
    println!(
        "Rotated Signalman service cert bundle at {}.",
        report.bundle.root.display()
    );
    if let Some(backup_dir) = report.backup_dir {
        println!("Previous bundle backed up at {}.", backup_dir.display());
    } else {
        println!("No previous complete bundle was present; generated a fresh bundle.");
    }
    println!("Restart signalman-service for the TCP mTLS listener to load the new certs.");
    Ok(())
}
