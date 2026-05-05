//! Windows-service install / uninstall / SCM-driven run.
//!
//! The `windows-service` crate provides the SCM glue. We register a
//! service entry point that builds a `tokio` runtime and dispatches
//! to [`crate::transport::serve`].

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use tokio::sync::watch;
use windows_service::{
    define_windows_service,
    service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
        ServiceStatus, ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};

use crate::backend::{Backend, HyperVBackend};
use crate::tls::{ensure_certs, CertBundle};
use crate::transport::{serve, TransportConfig};
use crate::{
    DEFAULT_GRPC_PORT, PIPE_NAME, SERVICE_DESCRIPTION, SERVICE_DISPLAY_NAME, SERVICE_NAME,
};

/// Settings for the install command.
#[derive(Debug, Clone)]
pub struct InstallOptions {
    /// Absolute path to the service binary.
    pub binary: PathBuf,
    /// Cert directory (defaults to `crate::tls::default_cert_dir()`).
    pub cert_dir: Option<PathBuf>,
    /// Optional service account ("DOMAIN\user"). None = LocalSystem.
    pub account_name: Option<String>,
    /// Password for the service account, if any.
    pub account_password: Option<String>,
}

pub fn install(opts: InstallOptions) -> Result<()> {
    let manager_access = ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .context("opening Windows service manager")?;

    let cert_dir = opts.cert_dir.unwrap_or_else(crate::tls::default_cert_dir);
    let _bundle = ensure_certs(&cert_dir)
        .with_context(|| format!("ensuring cert bundle at {}", cert_dir.display()))?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: opts.binary,
        launch_arguments: vec![OsString::from("run-service")],
        dependencies: vec![],
        account_name: opts.account_name.map(OsString::from),
        account_password: opts.account_password.map(OsString::from),
    };

    let service = manager
        .create_service(&info, ServiceAccess::CHANGE_CONFIG)
        .context("creating service")?;
    service
        .set_description(SERVICE_DESCRIPTION)
        .context("setting service description")?;

    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager_access = ServiceManagerAccess::CONNECT;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)
        .context("opening service manager")?;
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    let service = manager
        .open_service(SERVICE_NAME, service_access)
        .context("opening service")?;

    // Best-effort stop before delete.
    if let Ok(status) = service.query_status() {
        if status.current_state != ServiceState::Stopped {
            let _ = service.stop();
            // Brief wait for the SCM to acknowledge.
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(100));
                if let Ok(s) = service.query_status() {
                    if s.current_state == ServiceState::Stopped {
                        break;
                    }
                }
            }
        }
    }
    service.delete().context("deleting service")?;
    Ok(())
}

pub fn start_service() -> Result<()> {
    let manager_access = ServiceManagerAccess::CONNECT;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::START)?;
    service.start::<&str>(&[])?;
    Ok(())
}

pub fn stop_service() -> Result<()> {
    let manager_access = ServiceManagerAccess::CONNECT;
    let manager = ServiceManager::local_computer(None::<&str>, manager_access)?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::STOP)?;
    let _ = service.stop()?;
    Ok(())
}

// ── SCM-driven run path ───────────────────────────────────────────

/// Static signal channel used by the SCM control handler to ask the
/// async runtime to drain. Set up at the top of `service_main`.
static SHUTDOWN_TX: OnceLock<watch::Sender<bool>> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

/// Entry point invoked by the SCM. The `windows-service` macro
/// generates an `extern "system"` shim that forwards to this fn.
fn service_main(_args: Vec<OsString>) {
    append_service_log("service_main entered");
    if let Err(e) = run_service() {
        append_service_log(&format!("service exited with error: {e:?}"));
        tracing::error!(error = ?e, "service exited with error");
    } else {
        append_service_log("service_main exited cleanly");
    }
}

/// Hand control to the SCM dispatcher. Blocks until the service stops.
pub fn dispatch() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("registering service dispatcher")?;
    Ok(())
}

fn run_service() -> Result<()> {
    append_service_log("run_service starting");
    let (tx, rx) = watch::channel(false);
    SHUTDOWN_TX.set(tx).ok();

    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            windows_service::service::ServiceControl::Stop
            | windows_service::service::ServiceControl::Shutdown => {
                if let Some(tx) = SHUTDOWN_TX.get() {
                    let _ = tx.send(true);
                }
                ServiceControlHandlerResult::NoError
            }
            windows_service::service::ServiceControl::Interrogate => {
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    append_service_log("registering service control handler");
    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)
        .context("registering service control handler")?;
    append_service_log("reporting service running");
    status_handle
        .set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: windows_service::service::ServiceControlAccept::STOP
                | windows_service::service::ServiceControlAccept::SHUTDOWN,
            exit_code: windows_service::service::ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })
        .context("reporting service running")?;

    // Build the tokio runtime here — service_main runs on a thread the
    // SCM owns and is *not* a tokio runtime.
    append_service_log("building tokio runtime");
    let runtime = tokio::runtime::Runtime::new().context("building tokio runtime")?;
    append_service_log("entering async serve loop");
    let res = runtime.block_on(async move {
        let cert_dir = crate::tls::default_cert_dir();
        append_service_log(&format!("ensuring certs at {}", cert_dir.display()));
        let bundle: CertBundle = ensure_certs(&cert_dir)?;
        let backend: Arc<dyn Backend> = Arc::new(HyperVBackend::new());
        let config = TransportConfig {
            tcp: Some(format!("127.0.0.1:{DEFAULT_GRPC_PORT}").parse()?),
            pipe: Some(PIPE_NAME.to_string()),
            certs: bundle,
        };
        serve(backend, config, rx).await
    });
    append_service_log(&format!(
        "async serve loop returned: {:?}",
        res.as_ref().map(|_| ())
    ));

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: windows_service::service::ServiceControlAccept::empty(),
        exit_code: windows_service::service::ServiceExitCode::Win32(if res.is_ok() {
            0
        } else {
            1
        }),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;
    res
}

fn append_service_log(message: &str) {
    let root = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    let dir = root.join("Signalman").join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("service-runtime.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{:?} {message}", SystemTime::now());
    }
}
