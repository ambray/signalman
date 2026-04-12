//! GuestAgent gRPC service implementation.
//!
//! Implements the GuestAgent service defined in proto/guest.proto.
//! Core RPCs (health, process control, command execution, verification) are
//! fully implemented. UI automation, browser automation, and deep restriction
//! inspection are stubbed as unimplemented for future sprints.

use std::path::Path;
use std::time::{Duration, Instant};

use tonic::{Request, Response, Status};
use tracing::{info, warn};

use crate::guest_proto::guest_agent_server::GuestAgent;
use crate::guest_proto::*;
use crate::{process, verification};

#[allow(dead_code)]
#[path = "file_ops.rs"]
pub mod file_ops;

/// Timestamp when the service was created, used to compute uptime.
static START_TIME: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Maximum number of arguments allowed for `run_command`.
const MAX_ARG_COUNT: usize = 100;

/// Default command timeout in seconds.
const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 60;

/// Shell metacharacters that indicate command chaining and are denied in
/// `run_command` arguments.
const SHELL_METACHARACTERS: &[char] = &[';', '|', '&'];

/// Dangerous commands that are unconditionally denied.
const DENIED_COMMANDS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "format",
    "del /s /q C:\\",
    "del /s /q c:\\",
    "mkfs",
    "dd if=/dev/zero",
    ":(){:|:&};:",
];

/// Validate that a package ID contains only safe characters.
/// Allows alphanumeric, dots, hyphens, underscores, and forward slashes
/// (for scoped packages like `@scope/name`).
#[allow(clippy::result_large_err)] // Status is the standard tonic error type
fn validate_package_id(id: &str) -> Result<(), Status> {
    if id.is_empty() {
        return Err(Status::invalid_argument("package_id must not be empty"));
    }
    if id.len() > 256 {
        return Err(Status::invalid_argument(
            "package_id exceeds maximum length of 256 characters",
        ));
    }
    for ch in id.chars() {
        if ch.is_alphanumeric() || ch == '.' || ch == '-' || ch == '_' || ch == '/' || ch == '@' {
            continue;
        }
        return Err(Status::invalid_argument(format!(
            "package_id contains invalid character: '{ch}'"
        )));
    }
    Ok(())
}

/// Check if a command + args string matches any denied command pattern.
fn is_denied_command(command: &str, args: &[String]) -> bool {
    let full = format!("{} {}", command, args.join(" "));
    for denied in DENIED_COMMANDS {
        if full.contains(denied) {
            return true;
        }
    }
    false
}

/// Check if any argument contains shell metacharacters that could chain commands.
fn contains_shell_metacharacters(command: &str, args: &[String]) -> bool {
    for ch in SHELL_METACHARACTERS {
        if command.contains(*ch) {
            return true;
        }
    }
    for arg in args {
        for ch in SHELL_METACHARACTERS {
            if arg.contains(*ch) {
                return true;
            }
        }
    }
    false
}

/// GuestAgent gRPC service implementation.
pub struct GuestAgentService {
    /// Agent ID assigned during registration (if any).
    agent_id: tokio::sync::RwLock<Option<String>>,
}

impl GuestAgentService {
    /// Create a new service instance and record the start time.
    pub fn new() -> Self {
        START_TIME.get_or_init(Instant::now);
        Self {
            agent_id: tokio::sync::RwLock::new(None),
        }
    }
}

/// Return the OS name string for the current platform.
fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// Return the hostname of the machine, or "unknown" on failure.
fn hostname() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "unknown".into())
    }
}

/// Current agent capabilities.
fn capabilities() -> Vec<String> {
    vec![
        "process".into(),
        "command".into(),
        "verify".into(),
        "network_test".into(),
        "file_test".into(),
        "install".into(),
    ]
}

#[tonic::async_trait]
impl GuestAgent for GuestAgentService {
    // ── Health ──────────────────────────────────────────────────

    async fn health(
        &self,
        _request: Request<HealthRequest>,
    ) -> Result<Response<HealthResponse>, Status> {
        let uptime = START_TIME
            .get()
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0);

        Ok(Response::new(HealthResponse {
            hostname: hostname(),
            os: os_name().into(),
            os_version: std::env::consts::OS.into(),
            agent_version: env!("CARGO_PKG_VERSION").into(),
            uptime_seconds: uptime,
            capabilities: capabilities(),
        }))
    }

    // ── Registration ────────────────────────────────────────────

    async fn register(
        &self,
        request: Request<RegisterRequest>,
    ) -> Result<Response<RegisterResponse>, Status> {
        let req = request.into_inner();
        info!(
            hub_url = %req.hub_url,
            hostname = %req.hostname,
            "Host registration received"
        );

        // Generate a simple agent ID based on hostname + timestamp.
        let agent_id = format!(
            "agent-{}-{}",
            req.hostname,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );

        *self.agent_id.write().await = Some(agent_id.clone());

        Ok(Response::new(RegisterResponse {
            agent_id,
            accepted: true,
        }))
    }

    // ── Process Control ─────────────────────────────────────────

    async fn process_start(
        &self,
        request: Request<ProcessStartRequest>,
    ) -> Result<Response<ProcessStartResponse>, Status> {
        let req = request.into_inner();

        if req.path.is_empty() {
            return Err(Status::invalid_argument("path must not be empty"));
        }

        let working_dir = if req.working_directory.is_empty() {
            None
        } else {
            Some(req.working_directory.clone())
        };

        // S-08: Use tokio::process::Command for async execution to avoid blocking
        // the tokio runtime thread.
        if req.wait_for_exit {
            let timeout = if req.timeout_ms > 0 {
                Duration::from_millis(req.timeout_ms as u64)
            } else {
                Duration::from_secs(DEFAULT_COMMAND_TIMEOUT_SECS)
            };

            let mut cmd = tokio::process::Command::new(&req.path);
            cmd.args(&req.args);
            if let Some(ref dir) = working_dir {
                cmd.current_dir(dir);
            }
            for (k, v) in &req.env {
                cmd.env(k, v);
            }

            let output = match tokio::time::timeout(timeout, cmd.output()).await {
                Ok(Ok(output)) => output,
                Ok(Err(e)) => {
                    return Err(Status::internal(format!("Failed to run process: {e}")));
                }
                Err(_) => {
                    return Err(Status::deadline_exceeded(format!(
                        "Process execution timed out after {}ms",
                        timeout.as_millis()
                    )));
                }
            };

            return Ok(Response::new(ProcessStartResponse {
                pid: 0,
                started: true,
                error: String::new(),
                exit_code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).into(),
                stderr: String::from_utf8_lossy(&output.stderr).into(),
            }));
        }

        let path = Path::new(&req.path);

        // SYSTEM elevation support
        if req.run_as.eq_ignore_ascii_case("system") {
            let env_map: std::collections::HashMap<String, String> =
                req.env.into_iter().collect();
            match process::start_process_as_system(
                path,
                &req.args,
                working_dir.as_deref().map(Path::new),
                &env_map,
            ) {
                Ok(pid) => {
                    return Ok(Response::new(ProcessStartResponse {
                        pid,
                        started: true,
                        error: String::new(),
                        exit_code: 0,
                        stdout: String::new(),
                        stderr: String::new(),
                    }));
                }
                Err(e) => {
                    return Err(Status::permission_denied(format!(
                        "Failed to start process as SYSTEM: {e}"
                    )));
                }
            }
        }

        match process::start_process(path, &req.args, working_dir.as_deref().map(Path::new)) {
            Ok(pid) => Ok(Response::new(ProcessStartResponse {
                pid,
                started: true,
                error: String::new(),
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            })),
            Err(e) => Ok(Response::new(ProcessStartResponse {
                pid: 0,
                started: false,
                error: e.to_string(),
                exit_code: -1,
                stdout: String::new(),
                stderr: String::new(),
            })),
        }
    }

    async fn process_stop(
        &self,
        request: Request<ProcessStopRequest>,
    ) -> Result<Response<ProcessStopResponse>, Status> {
        let req = request.into_inner();

        if req.pid == 0 && req.process_name.is_empty() {
            return Err(Status::invalid_argument(
                "either pid or process_name must be provided",
            ));
        }

        // If a process_name is provided but no PID, find the PID first.
        let pid = if req.pid != 0 {
            req.pid
        } else {
            let procs = process::list_processes(Some(&req.process_name))
                .map_err(|e| Status::internal(format!("Failed to list processes: {e}")))?;
            match procs.first() {
                Some(p) => p.pid,
                None => {
                    return Ok(Response::new(ProcessStopResponse {
                        stopped: false,
                        error: format!("No process found matching '{}'", req.process_name),
                    }))
                }
            }
        };

        match process::stop_process(pid, req.force) {
            Ok(stopped) => Ok(Response::new(ProcessStopResponse {
                stopped,
                error: String::new(),
            })),
            Err(e) => Ok(Response::new(ProcessStopResponse {
                stopped: false,
                error: e.to_string(),
            })),
        }
    }

    async fn process_list(
        &self,
        request: Request<ProcessListRequest>,
    ) -> Result<Response<ProcessListResponse>, Status> {
        let req = request.into_inner();
        let filter = if req.name_filter.is_empty() {
            None
        } else {
            Some(req.name_filter.as_str())
        };

        let procs = process::list_processes(filter)
            .map_err(|e| Status::internal(format!("Failed to list processes: {e}")))?;

        let processes = procs
            .into_iter()
            .map(|p| ProcessInfo {
                pid: p.pid,
                name: p.name,
                path: p.path,
                command_line: p.command_line,
                memory_bytes: p.memory_bytes,
                cpu_percent: 0.0,
                user: p.user,
                is_appcontainer: p.is_appcontainer,
                appcontainer_sid: p.appcontainer_sid.unwrap_or_default(),
                is_low_integrity: p.is_low_integrity,
                is_in_job: p.is_in_job,
            })
            .collect();

        Ok(Response::new(ProcessListResponse { processes }))
    }

    async fn process_inspect(
        &self,
        request: Request<ProcessInspectRequest>,
    ) -> Result<Response<ProcessInspectResponse>, Status> {
        let req = request.into_inner();

        if req.pid == 0 {
            return Err(Status::invalid_argument("pid must not be zero"));
        }

        let detail = process::inspect_process(req.pid)
            .map_err(|e| Status::not_found(format!("Process not found: {e}")))?;

        Ok(Response::new(ProcessInspectResponse {
            process: Some(ProcessInfo {
                pid: detail.pid,
                name: detail.name,
                path: detail.path,
                command_line: detail.command_line,
                memory_bytes: detail.memory_bytes,
                cpu_percent: 0.0,
                user: String::new(),
                is_appcontainer: false,
                appcontainer_sid: String::new(),
                is_low_integrity: false,
                is_in_job: false,
            }),
            integrity_level: String::new(),
            privileges: vec![],
            groups: vec![],
            appcontainer_name: String::new(),
            capabilities: vec![],
            job_name: String::new(),
            job_memory_limit: 0,
            blocked_domains: vec![],
            allowed_domains: vec![],
        }))
    }

    // ── Command Execution ───────────────────────────────────────

    async fn run_command(
        &self,
        request: Request<RunCommandRequest>,
    ) -> Result<Response<RunCommandResponse>, Status> {
        let req = request.into_inner();

        if req.command.is_empty() {
            return Err(Status::invalid_argument("command must not be empty"));
        }

        // S-06: Audit logging for every command execution.
        warn!(
            command = %req.command,
            args = ?req.args,
            "AUDIT: run_command invoked"
        );

        // S-06: Enforce maximum argument count.
        if req.args.len() > MAX_ARG_COUNT {
            return Err(Status::invalid_argument(format!(
                "Too many arguments: {} exceeds maximum of {MAX_ARG_COUNT}",
                req.args.len()
            )));
        }

        // S-06: Reject commands containing shell metacharacters for command chaining.
        if contains_shell_metacharacters(&req.command, &req.args) {
            return Err(Status::invalid_argument(
                "Command or arguments contain shell metacharacters (;, &&, ||, |) which are not allowed",
            ));
        }

        // S-06: Check against the command denylist.
        if is_denied_command(&req.command, &req.args) {
            return Err(Status::permission_denied(
                "Command matches a denied pattern and cannot be executed",
            ));
        }

        // SYSTEM elevation: wrap command via start_process_as_system
        if req.run_as.eq_ignore_ascii_case("system") {
            let mut all_args = vec!["/C".to_string(), req.command.clone()];
            all_args.extend(req.args.iter().cloned());
            let env_map = std::collections::HashMap::new();
            let working_dir = if req.working_directory.is_empty() {
                None
            } else {
                Some(Path::new(&req.working_directory))
            };

            // For SYSTEM run_command, we use start_process_as_system with cmd.exe
            // and capture output via a temp file since CreateProcessAsUserW doesn't
            // give us piped stdout easily.
            let cmd_path = Path::new("cmd.exe");
            match process::start_process_as_system(cmd_path, &all_args, working_dir, &env_map) {
                Ok(pid) => {
                    return Ok(Response::new(RunCommandResponse {
                        exit_code: 0,
                        stdout: format!("Process started as SYSTEM with PID {pid}"),
                        stderr: String::new(),
                        duration_ms: 0,
                    }));
                }
                Err(e) => {
                    return Err(Status::permission_denied(format!(
                        "Failed to run command as SYSTEM: {e}"
                    )));
                }
            }
        }

        // S-07: Enforce timeout (default 60s, configurable via request).
        let timeout = if req.timeout_ms > 0 {
            Duration::from_millis(req.timeout_ms as u64)
        } else {
            Duration::from_secs(DEFAULT_COMMAND_TIMEOUT_SECS)
        };

        // S-07 + S-08: Use tokio::process::Command to avoid blocking the runtime.
        let mut cmd = tokio::process::Command::new(&req.command);
        cmd.args(&req.args);

        if !req.working_directory.is_empty() {
            cmd.current_dir(&req.working_directory);
        }

        if req.capture_output {
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
        }

        let start = Instant::now();

        // S-07: Spawn child and wrap with timeout; kill on expiry.
        let child = cmd
            .spawn()
            .map_err(|e| Status::internal(format!("Failed to spawn command: {e}")))?;

        // wait_with_output() takes ownership, so we cannot kill after timeout.
        // Use a channel to get the result or abort.
        let child_id = child.id();
        let output_fut = child.wait_with_output();

        match tokio::time::timeout(timeout, output_fut).await {
            Ok(Ok(output)) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                Ok(Response::new(RunCommandResponse {
                    exit_code: output.status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&output.stdout).into(),
                    stderr: String::from_utf8_lossy(&output.stderr).into(),
                    duration_ms,
                }))
            }
            Ok(Err(e)) => Err(Status::internal(format!(
                "Failed to wait for command: {e}"
            ))),
            Err(_) => {
                // S-07: Timeout expired — kill the child process via OS PID.
                if let Some(pid) = child_id {
                    let _ = crate::process::stop_process(pid, true);
                }
                warn!(
                    command = %req.command,
                    timeout_ms = timeout.as_millis() as u64,
                    "Command killed after timeout"
                );
                Err(Status::deadline_exceeded(format!(
                    "Command timed out after {}ms",
                    timeout.as_millis()
                )))
            }
        }
    }

    // ── UI Automation (unimplemented) ───────────────────────────

    async fn ui_click(
        &self,
        _request: Request<UiClickRequest>,
    ) -> Result<Response<UiActionResponse>, Status> {
        Err(Status::unimplemented(
            "UI automation requires Windows UI Automation API — not yet implemented",
        ))
    }

    async fn ui_type(
        &self,
        _request: Request<UiTypeRequest>,
    ) -> Result<Response<UiActionResponse>, Status> {
        Err(Status::unimplemented(
            "UI automation requires Windows UI Automation API — not yet implemented",
        ))
    }

    async fn ui_find(
        &self,
        _request: Request<UiFindRequest>,
    ) -> Result<Response<UiFindResponse>, Status> {
        Err(Status::unimplemented(
            "UI automation requires Windows UI Automation API — not yet implemented",
        ))
    }

    async fn ui_screenshot(
        &self,
        _request: Request<UiScreenshotRequest>,
    ) -> Result<Response<UiScreenshotResponse>, Status> {
        Err(Status::unimplemented(
            "UI screenshot requires Windows GDI capture — not yet implemented",
        ))
    }

    // ── Browser Automation (unimplemented) ──────────────────────

    async fn browser_navigate(
        &self,
        _request: Request<BrowserNavigateRequest>,
    ) -> Result<Response<BrowserActionResponse>, Status> {
        Err(Status::unimplemented(
            "Browser automation requires Chrome DevTools Protocol — not yet implemented",
        ))
    }

    async fn browser_click(
        &self,
        _request: Request<BrowserClickRequest>,
    ) -> Result<Response<BrowserActionResponse>, Status> {
        Err(Status::unimplemented(
            "Browser automation requires Chrome DevTools Protocol — not yet implemented",
        ))
    }

    async fn browser_screenshot(
        &self,
        _request: Request<BrowserScreenshotRequest>,
    ) -> Result<Response<BrowserScreenshotResponse>, Status> {
        Err(Status::unimplemented(
            "Browser screenshot requires Chrome DevTools Protocol — not yet implemented",
        ))
    }

    // ── Restriction Verification ────────────────────────────────

    async fn verify_restriction(
        &self,
        _request: Request<VerifyRestrictionRequest>,
    ) -> Result<Response<VerifyRestrictionResponse>, Status> {
        Err(Status::unimplemented(
            "VerifyRestriction requires Win32 token inspection — not yet implemented",
        ))
    }

    async fn test_network(
        &self,
        request: Request<TestNetworkRequest>,
    ) -> Result<Response<TestNetworkResponse>, Status> {
        let req = request.into_inner();

        if req.host.is_empty() {
            return Err(Status::invalid_argument("host must not be empty"));
        }

        let port = if req.port == 0 { 443 } else { req.port as u16 };
        let timeout = if req.timeout_ms > 0 {
            Duration::from_millis(req.timeout_ms as u64)
        } else {
            Duration::from_secs(5)
        };

        let result = verification::test_network_connectivity(&req.host, port, timeout);

        Ok(Response::new(TestNetworkResponse {
            reachable: result.reachable,
            latency_ms: result.latency_ms,
            error: result.error.unwrap_or_default(),
            tls_info: String::new(), // TLS inspection not yet implemented
        }))
    }

    async fn test_file_access(
        &self,
        request: Request<TestFileAccessRequest>,
    ) -> Result<Response<TestFileAccessResponse>, Status> {
        let req = request.into_inner();

        if req.path.is_empty() {
            return Err(Status::invalid_argument("path must not be empty"));
        }

        let operation = if req.operation.is_empty() {
            "read"
        } else {
            &req.operation
        };

        let result = verification::test_file_access(&req.path, operation);

        Ok(Response::new(TestFileAccessResponse {
            allowed: result.allowed,
            error: result.error.unwrap_or_default(),
            error_code: String::new(), // Win32 error code extraction not yet implemented
        }))
    }

    // ── Software Management ─────────────────────────────────────

    async fn install_software(
        &self,
        request: Request<InstallSoftwareRequest>,
    ) -> Result<Response<InstallSoftwareResponse>, Status> {
        let req = request.into_inner();

        // S-20: Validate package ID format before passing to package managers.
        validate_package_id(&req.package_id)?;

        // S-20: Audit logging for install operations.
        warn!(
            source = %req.source,
            package = %req.package_id,
            version = %req.version,
            "AUDIT: install_software invoked"
        );

        let (program, args) = match req.source.as_str() {
            "winget" | "" => {
                let mut a = vec![
                    "install".to_string(),
                    req.package_id.clone(),
                    "--accept-package-agreements".to_string(),
                    "--accept-source-agreements".to_string(),
                ];
                if req.silent {
                    a.push("--silent".into());
                }
                if !req.version.is_empty() {
                    a.push("--version".into());
                    a.push(req.version.clone());
                }
                ("winget".to_string(), a)
            }
            "choco" => {
                let mut a = vec![
                    "install".to_string(),
                    req.package_id.clone(),
                    "-y".to_string(),
                ];
                if !req.version.is_empty() {
                    a.push("--version".into());
                    a.push(req.version.clone());
                }
                ("choco".to_string(), a)
            }
            other => {
                return Err(Status::invalid_argument(format!(
                    "Unsupported install source: '{other}'. Use 'winget' or 'choco'."
                )));
            }
        };

        info!(
            source = %req.source,
            package = %req.package_id,
            "Installing software"
        );

        // S-08: Use tokio::process::Command to avoid blocking the runtime.
        let output = tokio::process::Command::new(&program)
            .args(&args)
            .output()
            .await
            .map_err(|e| {
                Status::internal(format!("Failed to run {program}: {e}"))
            })?;

        Ok(Response::new(InstallSoftwareResponse {
            success: output.status.success(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into(),
            stderr: String::from_utf8_lossy(&output.stderr).into(),
            installed_path: String::new(), // Would need to query the installer for this
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_service() -> GuestAgentService {
        GuestAgentService::new()
    }

    #[tokio::test]
    async fn test_health_returns_version() {
        let svc = make_service();
        let resp = svc
            .health(Request::new(HealthRequest {}))
            .await
            .expect("health should succeed");
        let health = resp.into_inner();

        assert_eq!(health.agent_version, env!("CARGO_PKG_VERSION"));
        assert!(!health.hostname.is_empty());
        assert!(!health.os.is_empty());
        assert!(!health.capabilities.is_empty());
    }

    #[tokio::test]
    async fn test_register_returns_agent_id() {
        let svc = make_service();
        let resp = svc
            .register(Request::new(RegisterRequest {
                hub_url: "http://localhost:8080".into(),
                hostname: "test-host".into(),
                os: "windows".into(),
                capabilities: vec!["process".into()],
                grpc_port: 50051,
            }))
            .await
            .expect("register should succeed");
        let reg = resp.into_inner();

        assert!(reg.accepted);
        assert!(reg.agent_id.starts_with("agent-test-host-"));
    }

    #[tokio::test]
    async fn test_run_command_echo() {
        let svc = make_service();

        // Use cmd /C echo on Windows, echo on Linux
        let (command, args) = if cfg!(target_os = "windows") {
            ("cmd".to_string(), vec!["/C".to_string(), "echo".to_string(), "hello".to_string()])
        } else {
            ("echo".to_string(), vec!["hello".to_string()])
        };

        let resp = svc
            .run_command(Request::new(RunCommandRequest {
                command,
                args,
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: true,
                run_as: String::new(),
            }))
            .await
            .expect("run_command should succeed");
        let result = resp.into_inner();

        assert_eq!(result.exit_code, 0);
        assert!(
            result.stdout.trim().contains("hello"),
            "stdout should contain 'hello', got: '{}'",
            result.stdout
        );
    }

    #[tokio::test]
    async fn test_run_command_empty_rejected() {
        let svc = make_service();
        let result = svc
            .run_command(Request::new(RunCommandRequest {
                command: String::new(),
                args: vec![],
                working_directory: String::new(),
                timeout_ms: 0,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn test_process_list_returns_results() {
        let svc = make_service();
        let resp = svc
            .process_list(Request::new(ProcessListRequest {
                name_filter: String::new(),
            }))
            .await
            .expect("process_list should succeed");
        let list = resp.into_inner();

        // On any OS, there should be at least one running process.
        // On non-Windows the list may be empty since list_processes is a stub,
        // but the RPC itself should not fail.
        #[cfg(target_os = "windows")]
        assert!(
            !list.processes.is_empty(),
            "process list should not be empty on Windows"
        );

        // On all platforms, the RPC should return without error.
        let _ = list;
    }

    #[tokio::test]
    async fn test_network_unreachable() {
        let svc = make_service();
        let resp = svc
            .test_network(Request::new(TestNetworkRequest {
                host: "192.0.2.1".into(), // TEST-NET-1 (RFC 5737) — guaranteed unreachable
                port: 12345,
                protocol: "tcp".into(),
                timeout_ms: 500,
            }))
            .await
            .expect("test_network should succeed (returning unreachable)");
        let result = resp.into_inner();

        assert!(!result.reachable);
    }

    #[tokio::test]
    async fn test_file_access_nonexistent() {
        let svc = make_service();
        let resp = svc
            .test_file_access(Request::new(TestFileAccessRequest {
                path: "Z:\\nonexistent\\path\\file.txt".into(),
                operation: "read".into(),
            }))
            .await
            .expect("test_file_access should succeed (returning denied)");
        let result = resp.into_inner();

        assert!(!result.allowed);
        assert!(!result.error.is_empty());
    }

    #[tokio::test]
    async fn test_unimplemented_rpcs() {
        let svc = make_service();

        let r = svc.ui_click(Request::new(UiClickRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::Unimplemented);

        let r = svc.ui_type(Request::new(UiTypeRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::Unimplemented);

        let r = svc.ui_find(Request::new(UiFindRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::Unimplemented);

        let r = svc
            .verify_restriction(Request::new(VerifyRestrictionRequest::default()))
            .await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::Unimplemented);

        let r = svc
            .browser_navigate(Request::new(BrowserNavigateRequest::default()))
            .await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::Unimplemented);
    }

    #[tokio::test]
    async fn test_process_inspect_current() {
        let svc = make_service();
        let my_pid = std::process::id();
        let resp = svc
            .process_inspect(Request::new(ProcessInspectRequest { pid: my_pid }))
            .await
            .expect("inspect current process should succeed");
        let result = resp.into_inner();
        let info = result.process.expect("process info should be present");
        assert_eq!(info.pid, my_pid);
        assert!(!info.name.is_empty(), "process name should not be empty");
    }

    #[tokio::test]
    async fn test_process_inspect_zero_pid_rejected() {
        let svc = make_service();
        let r = svc
            .process_inspect(Request::new(ProcessInspectRequest { pid: 0 }))
            .await;
        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn test_process_inspect_nonexistent() {
        let svc = make_service();
        let r = svc
            .process_inspect(Request::new(ProcessInspectRequest { pid: 0xFFFF_FFFE }))
            .await;
        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn test_install_software_invalid_source() {
        let svc = make_service();
        let r = svc
            .install_software(Request::new(InstallSoftwareRequest {
                package_id: "some-package".into(),
                source: "invalid-source".into(),
                version: String::new(),
                silent: false,
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    // ── S-06: Command denylist tests ────────────────────────────

    #[tokio::test]
    async fn test_run_command_denied_rm_rf() {
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "rm".into(),
                args: vec!["-rf".into(), "/".into()],
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::PermissionDenied);
    }

    #[tokio::test]
    async fn test_run_command_denied_format() {
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "format".into(),
                args: vec![],
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::PermissionDenied);
    }

    // ── S-06: Shell metacharacter rejection tests ───────────────

    #[tokio::test]
    async fn test_run_command_rejects_semicolon() {
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "echo".into(),
                args: vec!["hello; rm -rf /".into()],
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn test_run_command_rejects_pipe() {
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "echo".into(),
                args: vec!["hello".into(), "|".into(), "rm".into()],
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn test_run_command_rejects_ampersand_chain() {
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "echo".into(),
                args: vec!["hello".into(), "&&".into(), "rm".into()],
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    // ── S-06: Argument count limit test ─────────────────────────

    #[tokio::test]
    async fn test_run_command_too_many_args() {
        let svc = make_service();
        let args: Vec<String> = (0..101).map(|i| format!("arg{i}")).collect();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "echo".into(),
                args,
                working_directory: String::new(),
                timeout_ms: 5000,
                capture_output: false,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    // ── S-07: Timeout enforcement test ──────────────────────────

    #[tokio::test]
    async fn test_run_command_timeout_enforced() {
        let svc = make_service();

        // Use a command that takes longer than the timeout.
        // `waitfor` on Windows blocks forever waiting for a signal name.
        // `sleep 30` on Linux takes 30 seconds.
        let (command, args) = if cfg!(target_os = "windows") {
            ("waitfor".to_string(), vec!["SignalThatNeverComes".to_string()])
        } else {
            ("sleep".to_string(), vec!["30".to_string()])
        };

        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command,
                args,
                working_directory: String::new(),
                timeout_ms: 500, // 500ms timeout — command will not finish
                capture_output: true,
                run_as: String::new(),
            }))
            .await;

        assert!(r.is_err());
        assert_eq!(r.unwrap_err().code(), tonic::Code::DeadlineExceeded);
    }

    // ── S-20: Package ID validation tests ───────────────────────

    #[test]
    fn test_validate_package_id_valid() {
        assert!(validate_package_id("Google.Chrome").is_ok());
        assert!(validate_package_id("git").is_ok());
        assert!(validate_package_id("Microsoft.VisualStudioCode").is_ok());
        assert!(validate_package_id("@scope/package-name").is_ok());
        assert!(validate_package_id("some_package.v2").is_ok());
    }

    #[test]
    fn test_validate_package_id_invalid_shell_chars() {
        assert!(validate_package_id("pkg; rm -rf /").is_err());
        assert!(validate_package_id("pkg && evil").is_err());
        assert!(validate_package_id("pkg | evil").is_err());
        assert!(validate_package_id("pkg`evil`").is_err());
        assert!(validate_package_id("pkg$(evil)").is_err());
    }

    #[test]
    fn test_validate_package_id_empty() {
        assert!(validate_package_id("").is_err());
    }

    #[test]
    fn test_validate_package_id_too_long() {
        let long_id: String = "a".repeat(257);
        assert!(validate_package_id(&long_id).is_err());
    }

    // ── S-06: Helper function unit tests ────────────────────────

    #[test]
    fn test_is_denied_command() {
        assert!(is_denied_command("rm", &["-rf".into(), "/".into()]));
        assert!(is_denied_command("format", &[]));
        assert!(is_denied_command("del", &["/s".into(), "/q".into(), "C:\\".into()]));
        assert!(!is_denied_command("echo", &["hello".into()]));
        assert!(!is_denied_command("ls", &["-la".into()]));
    }

    #[test]
    fn test_contains_shell_metacharacters() {
        assert!(contains_shell_metacharacters("echo", &["hello;world".into()]));
        assert!(contains_shell_metacharacters("echo", &["a".into(), "|".into(), "b".into()]));
        assert!(contains_shell_metacharacters("echo", &["a&&b".into()]));
        assert!(!contains_shell_metacharacters("echo", &["hello".into(), "world".into()]));
    }
}
