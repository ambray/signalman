//! GuestAgent gRPC service implementation.
//!
//! Implements the GuestAgent service defined in proto/guest.proto.
//! Core RPCs (health, process control, command execution, verification) are
//! fully implemented. UI automation, browser automation, and deep restriction
//! inspection are stubbed as unimplemented for future sprints.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use crate::guest_proto::guest_agent_server::GuestAgent;
use crate::guest_proto::*;
use crate::{process, ui_sidecar, verification};

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

/// Dangerous-command tripwire patterns.
///
/// **B9 / Sec F9 — scope clarification.** This list is NOT a security
/// boundary. It is a tripwire / "obviously wrong" filter that catches the
/// most blatant mistakes (a runaway test script piping `rm -rf /` through
/// `run_command`, an agent hallucinating a `format C:` invocation, etc.).
///
/// The audit (Sec F9) noted that a substring denylist is bypassed
/// trivially by `format C:` → `FORMAT C:`, `cipher /w`, encoded
/// PowerShell, alternate codepaths via `cmd.exe /C`, etc. We agree.
/// **The actual security boundary is:**
///   1. mTLS authentication on the host↔guest channel (any caller who
///      reaches `is_denied_command` already passed cert verification).
///   2. The `process_start` `run_as="system"` path — gated behind the
///      same checks as `run_command`, with cmd.exe shelling removed
///      (P4.c-B5 / Sec F5).
///   3. The named-pipe SECURITY_DESCRIPTOR on the host service crate
///      (P4.c-B6 / Sec F6) — restricts pipe connect to SY + BA + Hyper-V
///      Admins only.
///   4. The future client-cert SHA-256 pin (B2 / Sec F1) — pins the
///      caller identity to a single cert rather than "any cert from
///      this CA".
///
/// We keep the tripwire because:
///   - It surfaces audit-log entries on blatant misuse (operators see
///     "denied: rm -rf /" rather than silent execution).
///   - It catches the 80% case of agent hallucination cheaply.
///   - Removing it without a positive allowlist replacement is strictly
///     a regression in observability.
///
/// We don't replace it with a positive allowlist because the workload
/// is generic VM scenario execution — operators legitimately need to
/// run arbitrary `winget`, `choco`, `pwsh`, custom installers, etc. An
/// allowlist would either (a) be enormous and still bypassable or
/// (b) cripple the product. Per-scenario allowlists are an option for
/// v0.2.0+ once we have scenario-author-provided manifests.
///
/// Match is case-insensitive (P4.c-B9 / Sec F9 mitigation): we lowercase
/// both the joined command and the pattern before substring testing.
/// This catches `FORMAT C:` and `RM -RF /` without expanding the
/// pattern list. Encoded PowerShell etc. is still bypass — see the
/// scope clarification above.
const DENIED_COMMANDS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "format c:",
    "format d:",
    "format /q",
    "del /s /q c:\\",
    "del /s /q c:/",
    "rd /s /q c:\\",
    "mkfs",
    "dd if=/dev/zero",
    "cipher /w",
    ":(){:|:&};:",
];

impl From<ui_sidecar::UiElementResult> for UiElement {
    fn from(element: ui_sidecar::UiElementResult) -> Self {
        Self {
            name: element.name,
            automation_id: element.automation_id,
            control_type: element.control_type,
            class_name: element.class_name,
            is_enabled: element.is_enabled,
            is_visible: element.is_visible,
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
            value: element.value,
        }
    }
}

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
///
/// # Match semantics
///
/// **Case-insensitive** (P4.c-B9 / Sec F9): both sides are lowercased
/// before testing.
///
/// **Multi-token patterns** (e.g. `"rm -rf /"`, `"format c:"`,
/// `"cipher /w"`) match as plain substrings. The internal spaces give
/// them enough specificity that an embedded false-positive is
/// effectively impossible (`"format c:"` doesn't substring-match
/// inside any benign command line we've seen).
///
/// **Single-token patterns** (e.g. `"format"`, `"mkfs"`) match with a
/// word-boundary check via [`find_token`]. This rules out a class of
/// false-positives that bit us in scenario flakiness:
/// `Test-NetConnection -InformationLevel Quiet` was getting denied
/// because the substring `"format"` appears inside `"Information"`.
/// We require the matched token to be surrounded by non-word
/// characters (or start/end of the input) so the denylist actually
/// triggers on `format c:` and not on every PowerShell cmdlet that
/// happens to contain those six letters.
///
/// See the doc-comment on [`DENIED_COMMANDS`] for the rationale + the
/// explicit statement that this is a tripwire, not a security
/// boundary.
fn is_denied_command(command: &str, args: &[String]) -> bool {
    let full_lc = format!("{} {}", command, args.join(" ")).to_ascii_lowercase();
    for denied in DENIED_COMMANDS {
        // Each pattern in DENIED_COMMANDS is already lowercase by
        // construction; we lowercase the input side to make the match
        // direction-independent.
        if denied.contains(' ') {
            // Multi-token — surrounding spaces in the pattern already
            // give us enough specificity, so plain substring is fine.
            if full_lc.contains(denied) {
                return true;
            }
        } else if find_token(&full_lc, denied) {
            // Single-token pattern — word-boundary search prevents
            // benign-cmdlet false positives like `format` matching
            // inside `Information`.
            return true;
        }
    }
    false
}

/// Single-token word-boundary search. Returns `true` iff `needle`
/// appears in `haystack` surrounded by characters that aren't
/// alphanumeric, `-`, or `_` (so flags like `-NoProfile` and option
/// values like `format_c` count as separate tokens). Boundaries at
/// start / end of the haystack also count.
///
/// Inputs are expected to be ASCII — the denylist is, and the caller
/// lowercases the haystack before calling. Behaviour on multibyte
/// UTF-8 is "no false positive" since the byte indices we test as
/// boundary chars are always ASCII boundaries.
fn find_token(haystack: &str, needle: &str) -> bool {
    let nb = needle.as_bytes();
    let hb = haystack.as_bytes();
    if nb.is_empty() || nb.len() > hb.len() {
        return false;
    }
    let mut i = 0usize;
    while i + nb.len() <= hb.len() {
        if hb[i..i + nb.len()] == *nb {
            let prev_ok = i == 0 || !is_token_char(hb[i - 1]);
            let next_ok = i + nb.len() == hb.len() || !is_token_char(hb[i + nb.len()]);
            if prev_ok && next_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[inline]
fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Argument flags whose VALUES are likely credentials. The value
/// (which appears as the next argv element OR as the right-hand side
/// of `flag=value`) is replaced with `***REDACTED***` in audit logs.
/// Match is case-insensitive against the flag name and tolerates
/// either a leading `-` or `--`.
///
/// P4.c-B11 / Sec F11. Conservative list — when in doubt, redact.
const CREDENTIAL_FLAGS: &[&str] = &[
    "password",
    "passwd",
    "pass",
    "pwd",
    "secret",
    "token",
    "api-key",
    "api_key",
    "apikey",
    "auth",
    "auth-token",
    "auth_token",
    "credentials",
    "client-secret",
    "client_secret",
    "p", // gpg, openssl, vmrun -gp
    "u", // some tools pair -u <user> -p <pass>; we don't redact -u itself
];

/// Strip the leading `-`/`--` and lowercase a flag name for matching.
fn normalise_flag(arg: &str) -> Option<&str> {
    let s = arg.strip_prefix("--").or_else(|| arg.strip_prefix("-"))?;
    Some(s)
}

/// Returns true when `flag` (already with `-`/`--` prefix removed)
/// is a known credential-bearing flag name. Case-insensitive.
fn is_credential_flag(flag: &str) -> bool {
    // Strip a `=value` suffix before comparing (`--password=foo`
    // pattern). The value-side redaction happens separately in
    // redact_credential_args.
    let name = flag.split_once('=').map(|(n, _)| n).unwrap_or(flag);
    let name_lc = name.to_ascii_lowercase();
    CREDENTIAL_FLAGS.iter().any(|f| *f == name_lc)
}

/// Walk an argv vector and produce a copy in which the value
/// component of any credential-bearing flag is replaced with
/// `***REDACTED***`. Two patterns recognised:
///
///   - Whitespace-separated: `["--password", "secret"]` →
///     `["--password", "***REDACTED***"]`. The value is the NEXT
///     element after the flag.
///   - Equals-separated: `["--password=secret"]` →
///     `["--password=***REDACTED***"]`.
///
/// Bare flags with no value (e.g. `["--password"]` at end of argv)
/// pass through unchanged — there's no value to redact.
fn redact_credential_args(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        // Equals form: `--password=secret`
        if let Some(stripped) = normalise_flag(arg) {
            if let Some((name, _value)) = stripped.split_once('=') {
                if is_credential_flag(name) {
                    let prefix_len = arg.len() - stripped.len();
                    let prefix = &arg[..prefix_len];
                    out.push(format!("{prefix}{name}=***REDACTED***"));
                    i += 1;
                    continue;
                }
            } else if is_credential_flag(stripped) {
                // Whitespace form: this is the flag, redact next
                // element if present.
                out.push(arg.clone());
                if i + 1 < args.len() {
                    out.push("***REDACTED***".to_string());
                    i += 2;
                    continue;
                } else {
                    i += 1;
                    continue;
                }
            }
        }
        out.push(arg.clone());
        i += 1;
    }
    out
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

fn decode_base64(input: &str) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = [0u8; 4];
    let mut len = 0usize;
    for b in input.bytes().filter(|b| !b.is_ascii_whitespace()) {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => anyhow::bail!("invalid base64 byte 0x{b:02x}"),
        };
        buf[len] = v;
        len += 1;
        if len == 4 {
            out.push((buf[0] << 2) | (buf[1] >> 4));
            if buf[2] != 64 {
                out.push((buf[1] << 4) | (buf[2] >> 2));
            }
            if buf[3] != 64 {
                out.push((buf[2] << 6) | buf[3]);
            }
            len = 0;
        }
    }
    if len != 0 {
        anyhow::bail!("invalid base64 length");
    }
    Ok(out)
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
    } else if cfg!(target_os = "macos") {
        "macos"
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
        "file_read".into(),
        "file_write".into(),
        "directory_list".into(),
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
        let uptime = START_TIME.get().map(|t| t.elapsed().as_secs()).unwrap_or(0);

        Ok(Response::new(HealthResponse {
            hostname: hostname(),
            os: os_name().into(),
            os_version: std::env::consts::OS.into(),
            agent_version: env!("CARGO_PKG_VERSION").into(),
            uptime_seconds: uptime,
            capabilities: capabilities(),
        }))
    }

    // P8: server-push readiness stream is the proto-reserved future
    // replacement for the host's poll-based waitForGuestAgents path.
    // v0.1.0 ships it as `unimplemented` to lock the wire shape; the
    // host orchestrator continues to use the existing Health-based
    // poll. When a real implementation lands, the host can detect
    // support via the gRPC reflection or by handling unimplemented
    // gracefully.
    type StreamReadinessStream = std::pin::Pin<
        Box<
            dyn tonic::codegen::tokio_stream::Stream<Item = Result<ReadinessUpdate, Status>>
                + Send
                + 'static,
        >,
    >;

    async fn stream_readiness(
        &self,
        _request: Request<StreamReadinessRequest>,
    ) -> Result<Response<Self::StreamReadinessStream>, Status> {
        Err(Status::unimplemented(
            "StreamReadiness reserved for the future server-push readiness path; v0.1.0 uses Health polling",
        ))
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

        // P4.a / Sec F4: enforce the same denylist + shell-metacharacter
        // gate that `run_command` runs. Before this fix, `process_start`
        // (especially with `run_as="system"`) was a strictly more
        // dangerous primitive than `run_command` and yet skipped both
        // checks. A caller blocked from `run_command(rm,[-rf,/])` could
        // simply call `process_start("rm",["-rf","/"], run_as="system")`
        // and receive SYSTEM-privileged execution. Both checks now run
        // BEFORE the SYSTEM branch (line ~298) so escalation attempts
        // are stopped at the door.
        //
        // Argument count cap mirrors `run_command`'s MAX_ARG_COUNT.
        if req.args.len() > MAX_ARG_COUNT {
            return Err(Status::invalid_argument(format!(
                "process_start args exceed maximum of {MAX_ARG_COUNT}"
            )));
        }
        if is_denied_command(&req.path, &req.args) {
            tracing::warn!(
                target: "signalman::audit",
                path = %req.path,
                arg_count = req.args.len(),
                run_as = %req.run_as,
                "process_start denied: path/args matched denied-command pattern"
            );
            return Err(Status::permission_denied(
                "process_start matches a denied command pattern",
            ));
        }
        if contains_shell_metacharacters(&req.path, &req.args) {
            tracing::warn!(
                target: "signalman::audit",
                path = %req.path,
                arg_count = req.args.len(),
                run_as = %req.run_as,
                "process_start denied: path/args contain shell metacharacters"
            );
            return Err(Status::invalid_argument(
                "process_start path/args may not contain shell metacharacters (; | &)",
            ));
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
            let env_map: std::collections::HashMap<String, String> = req.env.into_iter().collect();
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
                // P8: Windows-specific token info now lives in the
                // platform_details oneof. Linux/macOS guests will fill
                // their own variants when those crates ship.
                platform_details: Some(process_info::PlatformDetails::Windows(
                    WindowsProcessDetails {
                        is_appcontainer: p.is_appcontainer,
                        appcontainer_sid: p.appcontainer_sid.unwrap_or_default(),
                        is_low_integrity: p.is_low_integrity,
                        is_in_job: p.is_in_job,
                    },
                )),
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
                // Token / AppContainer / Job details not yet populated
                // in this stub; Windows variant placeholder so the
                // oneof carries the right discriminator.
                platform_details: Some(process_info::PlatformDetails::Windows(
                    WindowsProcessDetails {
                        is_appcontainer: false,
                        appcontainer_sid: String::new(),
                        is_low_integrity: false,
                        is_in_job: false,
                    },
                )),
            }),
            privileges: vec![],
            groups: vec![],
            blocked_domains: vec![],
            allowed_domains: vec![],
            // P8: deep token / AppContainer / Job evidence moved into
            // the WindowsInspectDetails oneof variant. Empty defaults
            // for now since this RPC is a v0.1.0 stub.
            platform_details: Some(process_inspect_response::PlatformDetails::Windows(
                WindowsInspectDetails {
                    integrity_level: String::new(),
                    appcontainer_name: String::new(),
                    appcontainer_capabilities: vec![],
                    job_name: String::new(),
                    job_memory_limit: 0,
                },
            )),
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

        // P4.c-B11 / Sec F11: redact arg patterns that commonly carry
        // credentials BEFORE writing the audit log. Operators leave
        // `signalman::audit` log streams open in shared TUIs and
        // ship them to centralised log stores; a verbatim
        // `--password supersecret` in argv would leak straight to
        // disk and to anyone with read access to the log destination.
        // Audit logging stays comprehensive (command name + arg
        // count + shape) for forensics; only the specific
        // sensitive-flag values are redacted.
        warn!(
            command = %req.command,
            args = ?redact_credential_args(&req.args),
            arg_count = req.args.len(),
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

        // SYSTEM elevation: pass argv directly via CreateProcessAsUserW.
        //
        // P4.c-B5 / Sec F5 (High) — was: shell through cmd.exe /C with
        // the user's command interpolated as the script. cmd.exe re-
        // interprets metacharacters that our metachar gate above does
        // NOT cover — `>`, `<`, `(`, `)`, `^`, `%VAR%`, encoded
        // PowerShell, embedded backticks. A request with a benign-
        // looking `command="echo evil>C:\\Windows\\Temp\\evil.bat"`
        // (no banned chars) would write a SYSTEM-context batch file.
        //
        // Now: req.command is the program path; req.args is the argv.
        // CreateProcessAsUserW sees only what we pass — no shell
        // expansion, no metachar reinterpretation. Callers that
        // previously relied on cmd.exe builtins (echo, dir) must now
        // pass `command="cmd.exe"` and put the rest in args
        // explicitly (`["/C","echo","..."]`). The denylist + metachar
        // gate above run BEFORE this branch is even reached, so those
        // explicit cmd.exe invocations are subject to the same
        // checks as everything else.
        //
        // This is a behaviour change for SYSTEM callers; documented
        // in CHANGELOG (when written) and in the function header.
        if req.run_as.eq_ignore_ascii_case("system") {
            if req.command.is_empty() {
                return Err(Status::invalid_argument(
                    "run_as=system requires command to be a program path; cmd.exe builtins must be invoked explicitly via command=\"cmd.exe\" args=[\"/C\",...]",
                ));
            }
            let env_map = std::collections::HashMap::new();
            let working_dir = if req.working_directory.is_empty() {
                None
            } else {
                Some(Path::new(&req.working_directory))
            };

            let cmd_path = Path::new(&req.command);
            tracing::warn!(
                target: "signalman::audit",
                command = %req.command,
                arg_count = req.args.len(),
                "run_command(run_as=system) invoking CreateProcessAsUserW directly (no cmd.exe shell)"
            );
            match process::start_process_as_system(cmd_path, &req.args, working_dir, &env_map) {
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
            Ok(Err(e)) => Err(Status::internal(format!("Failed to wait for command: {e}"))),
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
        request: Request<UiClickRequest>,
    ) -> Result<Response<UiActionResponse>, Status> {
        let req = request.into_inner();
        let started = Instant::now();
        let result: ui_sidecar::UiActionResult = ui_sidecar::call_typed(
            "ui.click",
            json!({
                "selector": req.selector,
                "window_title": req.window_title,
                "click_type": req.click_type,
            }),
        )
        .await
        .map_err(|e| Status::failed_precondition(format!("UI sidecar click failed: {e}")))?;
        Ok(Response::new(UiActionResponse {
            success: result.success,
            error: result.error,
            duration_ms: started.elapsed().as_millis() as u64,
        }))
    }

    async fn ui_type(
        &self,
        request: Request<UiTypeRequest>,
    ) -> Result<Response<UiActionResponse>, Status> {
        let req = request.into_inner();
        let started = Instant::now();
        let result: ui_sidecar::UiActionResult = ui_sidecar::call_typed(
            "ui.type",
            json!({
                "text": req.text,
                "selector": req.selector,
                "window_title": req.window_title,
                "clear_first": req.clear_first,
            }),
        )
        .await
        .map_err(|e| Status::failed_precondition(format!("UI sidecar type failed: {e}")))?;
        Ok(Response::new(UiActionResponse {
            success: result.success,
            error: result.error,
            duration_ms: started.elapsed().as_millis() as u64,
        }))
    }

    async fn ui_key(
        &self,
        request: Request<UiKeyRequest>,
    ) -> Result<Response<UiActionResponse>, Status> {
        let req = request.into_inner();
        let started = Instant::now();
        let result: ui_sidecar::UiActionResult = ui_sidecar::call_typed(
            "ui.key",
            json!({
                "keys": req.keys,
                "selector": req.selector,
                "window_title": req.window_title,
                "repeat": req.repeat,
            }),
        )
        .await
        .map_err(|e| Status::failed_precondition(format!("UI sidecar key failed: {e}")))?;
        Ok(Response::new(UiActionResponse {
            success: result.success,
            error: result.error,
            duration_ms: started.elapsed().as_millis() as u64,
        }))
    }

    async fn ui_find(
        &self,
        request: Request<UiFindRequest>,
    ) -> Result<Response<UiFindResponse>, Status> {
        let req = request.into_inner();
        let started = Instant::now();
        let result: ui_sidecar::UiFindResult = ui_sidecar::call_typed(
            "ui.find",
            json!({
                "selector": req.selector,
                "window_title": req.window_title,
                "timeout_ms": req.timeout_ms,
            }),
        )
        .await
        .map_err(|e| Status::failed_precondition(format!("UI sidecar find failed: {e}")))?;
        let elements = result.elements.into_iter().map(UiElement::from).collect();
        Ok(Response::new(UiFindResponse {
            elements,
            duration_ms: started.elapsed().as_millis() as u64,
        }))
    }

    async fn ui_screenshot(
        &self,
        request: Request<UiScreenshotRequest>,
    ) -> Result<Response<UiScreenshotResponse>, Status> {
        let req = request.into_inner();
        let started = Instant::now();
        let result: ui_sidecar::UiScreenshotResult = ui_sidecar::call_typed(
            "ui.screenshot",
            json!({
                "window_title": req.window_title,
                "format": req.format,
            }),
        )
        .await
        .map_err(|e| Status::failed_precondition(format!("UI sidecar screenshot failed: {e}")))?;
        let image_data = decode_base64(&result.image_data_base64)
            .map_err(|e| Status::internal(format!("decode UI screenshot: {e}")))?;
        Ok(Response::new(UiScreenshotResponse {
            image_data,
            format: result.format,
            width: result.width,
            height: result.height,
            duration_ms: started.elapsed().as_millis() as u64,
        }))
    }

    // ── Browser Automation (unimplemented) ──────────────────────

    async fn ui_health(
        &self,
        _request: Request<UiHealthRequest>,
    ) -> Result<Response<UiHealthResponse>, Status> {
        let started = Instant::now();
        match ui_sidecar::call_typed::<ui_sidecar::UiHealthResult>("ui.health", json!({})).await {
            Ok(result) => Ok(Response::new(UiHealthResponse {
                sidecar_reachable: true,
                engine: result.engine,
                pid: result.pid,
                uptime_ms: result.uptime_ms,
                error: String::new(),
                duration_ms: started.elapsed().as_millis() as u64,
            })),
            Err(err) => Ok(Response::new(UiHealthResponse {
                sidecar_reachable: false,
                engine: String::new(),
                pid: 0,
                uptime_ms: 0,
                error: err.to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
            })),
        }
    }

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

    // ── File Operations ─────────────────────────────────────────

    async fn read_file(
        &self,
        request: Request<ReadFileRequest>,
    ) -> Result<Response<ReadFileResponse>, Status> {
        let req = request.into_inner();
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path must not be empty"));
        }

        let file_len = std::fs::metadata(&req.path).ok().map(|m| m.len());
        let data = file_ops::read_file(&req.path, req.offset, req.limit)
            .map_err(|e| Status::internal(format!("read_file failed: {e}")))?;
        let truncated = file_len
            .map(|len| req.offset.saturating_add(data.len() as u64) < len)
            .unwrap_or(false);

        Ok(Response::new(ReadFileResponse { data, truncated }))
    }

    async fn write_file(
        &self,
        request: Request<WriteFileRequest>,
    ) -> Result<Response<WriteFileResponse>, Status> {
        let req = request.into_inner();
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path must not be empty"));
        }

        let bytes_written = file_ops::write_file(&req.path, &req.data, req.append)
            .map_err(|e| Status::invalid_argument(format!("write_file failed: {e}")))?;

        Ok(Response::new(WriteFileResponse { bytes_written }))
    }

    async fn list_directory(
        &self,
        request: Request<ListDirectoryRequest>,
    ) -> Result<Response<ListDirectoryResponse>, Status> {
        let req = request.into_inner();
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path must not be empty"));
        }

        let entries = file_ops::list_directory(&req.path)
            .map_err(|e| Status::internal(format!("list_directory failed: {e}")))?
            .into_iter()
            .map(|entry| DirectoryEntry {
                name: entry.name,
                size: entry.size,
                is_dir: entry.is_dir,
                modified_unix_secs: entry.modified_secs,
            })
            .collect();

        Ok(Response::new(ListDirectoryResponse { entries }))
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
            // P9.2: msstore is winget-with-source-flag. Routing through
            // a separate string-enum lets host-side bundles distinguish
            // explicit Microsoft-Store sourcing (which has slightly
            // different semantics: store packages may require user
            // sign-in, which silent install can't satisfy — so we log
            // a warning if --silent is requested but don't fail).
            "msstore" => {
                if req.silent {
                    warn!(
                        package = %req.package_id,
                        "msstore source: --silent may fail for packages that \
                         require Microsoft account sign-in; proceeding anyway"
                    );
                }
                let mut a = vec![
                    "install".to_string(),
                    req.package_id.clone(),
                    "--source".to_string(),
                    "msstore".to_string(),
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
            // P9.2 Tier-2 v0.1.1: scoop. The bundle author is responsible
            // for ordering — scoop must already be bootstrapped on the
            // guest before the first scoop-source entry runs (Q10(a)).
            // Other Tier-2 sources (npm / pip / cargo / powershell) route
            // through RunCommand from the host side, not through this RPC.
            "scoop" => {
                let target = if req.version.is_empty() {
                    req.package_id.clone()
                } else {
                    // Scoop pins via `<package>@<version>`.
                    format!("{}@{}", req.package_id, req.version)
                };
                let mut a = vec!["install".to_string(), target];
                if req.silent {
                    // Defang interactive scoop-self-update prompts.
                    a.push("--no-update-scoop".into());
                }
                ("scoop".to_string(), a)
            }
            other => {
                return Err(Status::invalid_argument(format!(
                    "Unsupported install source: '{other}'. Use 'winget', 'choco', \
                     'scoop', 'msstore', or call InstallDirect / InstallDocker for \
                     direct installer / docker-image sources. Tier-2 npm/pip/cargo/ \
                     powershell route through RunCommand on the host side."
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
            .map_err(|e| Status::internal(format!("Failed to run {program}: {e}")))?;

        let stdout: String = String::from_utf8_lossy(&output.stdout).into();
        let stderr: String = String::from_utf8_lossy(&output.stderr).into();
        let exit_code = output.status.code().unwrap_or(-1);
        // P9.2: idempotent re-runs report `already_installed` so the
        // bundle orchestrator counts the package as `skipped` rather
        // than `installed`. Detection is package-manager-specific and
        // crude (substring match) but doesn't have false positives in
        // practice — winget and choco use stable phrasing.
        let already_installed =
            is_already_installed_output(&req.source, exit_code, &stdout, &stderr);

        Ok(Response::new(InstallSoftwareResponse {
            success: output.status.success() || already_installed,
            exit_code,
            stdout,
            stderr,
            installed_path: String::new(), // Would need to query the installer for this
            already_installed,
        }))
    }

    // ── P9.2: InstallDirect ──────────────────────────────────────
    //
    // Downloads an installer from a HTTPS URL, verifies the SHA-256,
    // then spawns it with the supplied silent-install args. The
    // download is streamed (no full-file-in-memory) and the partial
    // file is shredded on any failure path so a hash mismatch can't
    // leak a half-downloaded payload.
    async fn install_direct(
        &self,
        request: Request<InstallDirectRequest>,
    ) -> Result<Response<InstallSoftwareResponse>, Status> {
        let req = request.into_inner();

        // Validate inputs before touching the network.
        if req.url.is_empty() {
            return Err(Status::invalid_argument("InstallDirect: url is required"));
        }
        if !req.url.starts_with("https://") {
            return Err(Status::invalid_argument(format!(
                "InstallDirect: url must use https:// (got: {})",
                truncate_for_log(&req.url, 80),
            )));
        }
        if req.sha256.len() != 64 || !req.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(Status::invalid_argument(
                "InstallDirect: sha256 must be 64 lowercase hex characters",
            ));
        }
        let timeout = if req.timeout_ms > 0 {
            Duration::from_millis(req.timeout_ms)
        } else {
            Duration::from_secs(5 * 60)
        };

        // Audit log BEFORE the download — so a hung download still
        // shows up in the operator's inspection.
        warn!(
            id = %req.id,
            url = %truncate_for_log(&req.url, 80),
            "AUDIT: install_direct invoked"
        );

        // Download to a temp file under the agent's workspace dir so
        // any partial state stays inside the jail. Cross-platform
        // tempdir: prefer SIGNALMAN_WORKSPACE, fall back to std::env::temp_dir.
        let workspace = std::env::var("SIGNALMAN_WORKSPACE")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&workspace)
            .map_err(|e| Status::internal(format!("Failed to create workspace dir: {e}")))?;
        let installer_path = workspace.join(format!("signalman-direct-{}.tmp", req.id));

        // Streaming download + incremental SHA-256.
        let download = tokio::time::timeout(
            timeout,
            download_and_verify(&req.url, &req.sha256, &installer_path),
        )
        .await
        .map_err(|_| {
            // Clean up partial file.
            let _ = std::fs::remove_file(&installer_path);
            Status::deadline_exceeded(format!(
                "InstallDirect: download exceeded timeout {}ms",
                req.timeout_ms
            ))
        })?;

        if let Err(e) = download {
            let _ = std::fs::remove_file(&installer_path);
            return Err(Status::internal(format!(
                "InstallDirect: download/verify failed: {e}"
            )));
        }

        info!(
            id = %req.id,
            "install_direct: download verified, spawning installer"
        );

        // Spawn the installer with the supplied args.
        let output = tokio::process::Command::new(&installer_path)
            .args(&req.args)
            .output()
            .await;

        // Always clean up the downloaded installer, regardless of
        // success — we don't keep installer payloads around.
        let _ = std::fs::remove_file(&installer_path);

        let output = output.map_err(|e| {
            Status::internal(format!("InstallDirect: failed to spawn installer: {e}"))
        })?;

        Ok(Response::new(InstallSoftwareResponse {
            success: output.status.success(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into(),
            stderr: String::from_utf8_lossy(&output.stderr).into(),
            installed_path: req.install_dir.clone(),
            already_installed: false, // direct installers don't self-report idempotency
        }))
    }

    // ── P9.2: InstallDocker ──────────────────────────────────────
    //
    // Pulls a digest-pinned docker image and runs it with the supplied
    // options. Requires Docker on the VM; the bundle author orders
    // that prerequisite explicitly (Q10(a) locked).
    async fn install_docker(
        &self,
        request: Request<InstallDockerRequest>,
    ) -> Result<Response<InstallSoftwareResponse>, Status> {
        let req = request.into_inner();

        if req.image.is_empty() {
            return Err(Status::invalid_argument("InstallDocker: image is required"));
        }
        if req.image.contains('@') {
            return Err(Status::invalid_argument(
                "InstallDocker: image must NOT include @<digest> — \
                 the digest goes in image_sha256 instead",
            ));
        }
        if !req.image_sha256.starts_with("sha256:") {
            return Err(Status::invalid_argument(
                "InstallDocker: image_sha256 must be 'sha256:<64hex>' digest pin",
            ));
        }
        let restart = if req.restart_policy.is_empty() {
            "unless-stopped"
        } else {
            match req.restart_policy.as_str() {
                "no" | "always" | "unless-stopped" | "on-failure" => req.restart_policy.as_str(),
                other => {
                    return Err(Status::invalid_argument(format!(
                        "InstallDocker: invalid restart_policy '{other}'"
                    )));
                }
            }
        };
        let timeout = if req.timeout_ms > 0 {
            Duration::from_millis(req.timeout_ms)
        } else {
            Duration::from_secs(5 * 60)
        };

        warn!(
            id = %req.id,
            image = %req.image,
            "AUDIT: install_docker invoked"
        );

        // Pull image with digest pin: `docker pull <image>@<digest>`.
        let pull_ref = format!("{}@{}", req.image, req.image_sha256);
        let pull = tokio::time::timeout(
            timeout,
            tokio::process::Command::new("docker")
                .arg("pull")
                .arg(&pull_ref)
                .output(),
        )
        .await
        .map_err(|_| {
            Status::deadline_exceeded(format!(
                "InstallDocker: pull exceeded timeout {}ms",
                req.timeout_ms
            ))
        })?
        .map_err(|e| Status::internal(format!("InstallDocker: docker pull failed: {e}")))?;

        if !pull.status.success() {
            return Ok(Response::new(InstallSoftwareResponse {
                success: false,
                exit_code: pull.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&pull.stdout).into(),
                stderr: String::from_utf8_lossy(&pull.stderr).into(),
                installed_path: String::new(),
                already_installed: false,
            }));
        }

        // Build `docker run` command.
        let mut run_args: Vec<String> = vec![
            "run".into(),
            "-d".into(),
            "--restart".into(),
            restart.into(),
        ];
        if !req.container_name.is_empty() {
            run_args.push("--name".into());
            run_args.push(req.container_name.clone());
        }
        for port in &req.ports {
            run_args.push("-p".into());
            run_args.push(port.clone());
        }
        for (k, v) in &req.env {
            run_args.push("-e".into());
            run_args.push(format!("{k}={v}"));
        }
        run_args.push(pull_ref.clone());
        for arg in &req.command {
            run_args.push(arg.clone());
        }

        let run_out = tokio::process::Command::new("docker")
            .args(&run_args)
            .output()
            .await
            .map_err(|e| Status::internal(format!("InstallDocker: docker run failed: {e}")))?;

        // Treat "container name already in use" as already_installed
        // success rather than failure. Docker exits non-zero with a
        // specific error message we can string-match.
        let stderr: String = String::from_utf8_lossy(&run_out.stderr).into();
        let already_running = stderr.contains("is already in use by container")
            || stderr.contains("Conflict. The container name");

        Ok(Response::new(InstallSoftwareResponse {
            success: run_out.status.success() || already_running,
            exit_code: run_out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&run_out.stdout).into(),
            stderr,
            installed_path: pull_ref,
            already_installed: already_running,
        }))
    }
}

/// Detect "already installed" stdout/stderr patterns so the bundle
/// orchestrator can distinguish a fresh install from an idempotent
/// re-run. Substring match is conservative — false positives only
/// happen if a package legitimately includes one of these phrases in
/// its install output, which we haven't observed in practice.
fn is_already_installed_output(source: &str, exit_code: i32, stdout: &str, stderr: &str) -> bool {
    if exit_code != 0 {
        return false;
    }
    let by_source = match source {
        // winget exits 0 and prints "No newer package versions are
        // available from the configured sources." or "Found an
        // existing package already installed."
        "winget" | "" | "msstore" => {
            stdout.contains("Found an existing package")
                || stdout.contains("No newer package versions are available")
                || stdout.contains("already installed")
        }
        // choco exits 0 with "<pkg> v<ver> already installed."
        "choco" => stdout.contains("already installed"),
        // scoop exits 0 with "WARN  '<pkg>' (<ver>) is already installed."
        "scoop" => stdout.contains("is already installed") || stdout.contains("already installed"),
        _ => false,
    };
    // Also check stderr — some package managers route their
    // "already installed" message there.
    by_source
        || stderr.contains("Found an existing package")
        || stderr.contains("already installed")
}

/// Truncate a string to `max` chars for safe logging — avoids spilling
/// a 4 KB URL into the audit log.
fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…[+{}b]", &s[..max], s.len() - max)
    }
}

/// Stream-download `url` to `dest`, hashing as we go. On success the
/// file at `dest` has SHA-256 == `expected_hex`. On any error the
/// caller is responsible for `remove_file(dest)` cleanup; we leave
/// the partial file in place so the caller's catch path can shred
/// it deliberately rather than silently.
async fn download_and_verify(
    url: &str,
    expected_hex: &str,
    dest: &std::path::Path,
) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let response = reqwest::get(url)
        .await
        .map_err(|e| anyhow::anyhow!("HTTPS GET failed: {e}"))?;
    if !response.status().is_success() {
        anyhow::bail!("HTTPS GET returned {}", response.status());
    }
    let mut hasher = Sha256::new();
    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| anyhow::anyhow!("stream read: {e}"))?;
        hasher.update(&bytes);
        file.write_all(&bytes).await?;
    }
    file.flush().await?;
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_hex) {
        anyhow::bail!("SHA-256 mismatch: expected {expected_hex}, got {actual}");
    }
    Ok(())
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
            (
                "cmd".to_string(),
                vec!["/C".to_string(), "echo".to_string(), "hello".to_string()],
            )
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

    // ── P4.a / Sec F4: process_start denylist parity ─────────────

    fn make_process_start_request(path: &str, args: Vec<String>) -> ProcessStartRequest {
        ProcessStartRequest {
            path: path.to_string(),
            args,
            working_directory: String::new(),
            env: Default::default(),
            wait_for_exit: false,
            timeout_ms: 0,
            run_as: String::new(),
        }
    }

    #[tokio::test]
    async fn test_process_start_rejects_denied_command_pattern() {
        // Before P4.a, `process_start` skipped this check entirely —
        // a caller blocked from `run_command(rm,[-rf,/])` could simply
        // pass the same args through `process_start` and get them
        // executed (often with run_as=system). Test pins the new gate.
        let svc = make_service();
        for (path, args) in [
            ("rm", vec!["-rf".to_string(), "/".to_string()]),
            ("format", vec!["c:".to_string()]),
            ("dd", vec!["if=/dev/zero".to_string()]),
        ] {
            let result = svc
                .process_start(Request::new(make_process_start_request(path, args)))
                .await;
            assert!(
                result.is_err(),
                "process_start should reject `{path}` denylist match",
            );
            assert_eq!(
                result.unwrap_err().code(),
                tonic::Code::PermissionDenied,
                "denied-command pattern must surface as PermissionDenied"
            );
        }
    }

    #[tokio::test]
    async fn test_process_start_rejects_shell_metacharacters() {
        let svc = make_service();
        // Each variant places a metachar in either the path or one
        // arg, in cases that DO NOT also match the denied-command
        // denylist (denylist runs first and would surface as
        // PermissionDenied; we want to pin the metachar gate
        // specifically, which surfaces as InvalidArgument).
        let cases: &[(&str, Vec<String>)] = &[
            ("/bin/echo; touch foo", vec![]),
            ("echo", vec!["hello | tee bar".to_string()]),
            (
                "echo",
                vec!["a".to_string(), "b & curl evil.example".to_string()],
            ),
        ];
        for (path, args) in cases {
            let result = svc
                .process_start(Request::new(make_process_start_request(path, args.clone())))
                .await;
            assert!(
                result.is_err(),
                "process_start must reject metachars in `{path}` / {args:?}"
            );
            assert_eq!(
                result.unwrap_err().code(),
                tonic::Code::InvalidArgument,
                "shell-metachar gate must surface as InvalidArgument"
            );
        }
    }

    // ── P4.c-B11 / Sec F11: credential redaction in audit logs ───

    #[test]
    fn redact_credential_args_handles_whitespace_form() {
        let args = vec![
            "--user".into(),
            "alice".into(),
            "--password".into(),
            "supersecret".into(),
            "--verbose".into(),
        ];
        let redacted = redact_credential_args(&args);
        assert_eq!(
            redacted,
            vec![
                "--user",
                "alice",
                "--password",
                "***REDACTED***",
                "--verbose"
            ]
        );
        // Original is untouched.
        assert_eq!(args[3], "supersecret");
    }

    #[test]
    fn redact_credential_args_handles_equals_form() {
        let args = vec![
            "--password=hunter2".into(),
            "--token=abc123".into(),
            "--api-key=xyz".into(),
        ];
        let redacted = redact_credential_args(&args);
        assert_eq!(
            redacted,
            vec![
                "--password=***REDACTED***",
                "--token=***REDACTED***",
                "--api-key=***REDACTED***"
            ]
        );
    }

    #[test]
    fn redact_credential_args_is_case_insensitive() {
        let args = vec!["--PASSWORD".into(), "x".into(), "--Token=y".into()];
        let redacted = redact_credential_args(&args);
        assert_eq!(redacted[1], "***REDACTED***");
        assert!(redacted[2].ends_with("***REDACTED***"));
    }

    #[test]
    fn redact_credential_args_handles_short_flags() {
        // vmrun -gp <password> pattern.
        let args = vec!["-gu".into(), "alice".into(), "-gp".into(), "secret".into()];
        let redacted = redact_credential_args(&args);
        // `-gp` (g + p) — only `-p` is in the credential list, but
        // we don't redact `-gp` because it doesn't match `password`
        // or any other flag in the list. Document this gap: the
        // caller must use `-p` short form OR `--password` long form
        // to get redaction. The vmware backend (host-side) does
        // its own redactCredentials() at the call site for vmrun.
        assert_eq!(redacted[3], "secret"); // NOT redacted — known gap
    }

    #[test]
    fn redact_credential_args_leaves_non_credential_args_untouched() {
        let args = vec![
            "--config".into(),
            "/etc/foo".into(),
            "--verbose".into(),
            "positional".into(),
        ];
        let redacted = redact_credential_args(&args);
        assert_eq!(redacted, args);
    }

    #[test]
    fn redact_credential_args_handles_bare_flag_at_end() {
        // Trailing bare flag — no value to redact, pass through.
        let args = vec!["--password".into()];
        let redacted = redact_credential_args(&args);
        assert_eq!(redacted, vec!["--password"]);
    }

    #[tokio::test]
    async fn test_process_start_rejects_excessive_arg_count() {
        let svc = make_service();
        let many: Vec<String> = (0..(MAX_ARG_COUNT + 1))
            .map(|i| format!("arg{i}"))
            .collect();
        let result = svc
            .process_start(Request::new(make_process_start_request("echo", many)))
            .await;
        assert!(result.is_err(), "process_start must cap arg count");
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
    async fn test_file_rpc_roundtrip() {
        let svc = make_service();
        let dir = std::env::temp_dir().join(format!(
            "signalman-service-file-rpc-{}",
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let file_path = dir.join("payload.txt");
        let path = file_path.to_string_lossy().into_owned();

        let write = svc
            .write_file(Request::new(WriteFileRequest {
                path: path.clone(),
                data: b"hello mac guest".to_vec(),
                append: false,
            }))
            .await
            .expect("write_file should succeed")
            .into_inner();
        assert_eq!(write.bytes_written, 15);

        let read = svc
            .read_file(Request::new(ReadFileRequest {
                path: path.clone(),
                offset: 6,
                limit: 3,
            }))
            .await
            .expect("read_file should succeed")
            .into_inner();
        assert_eq!(read.data, b"mac");
        assert!(read.truncated);

        let list = svc
            .list_directory(Request::new(ListDirectoryRequest {
                path: dir.to_string_lossy().into_owned(),
            }))
            .await
            .expect("list_directory should succeed")
            .into_inner();
        assert!(list.entries.iter().any(|entry| entry.name == "payload.txt"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_unimplemented_rpcs() {
        let svc = make_service();

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
    async fn test_ui_rpcs_require_sidecar() {
        let svc = make_service();

        let r = svc.ui_click(Request::new(UiClickRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::FailedPrecondition);

        let r = svc.ui_type(Request::new(UiTypeRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::FailedPrecondition);

        let r = svc.ui_key(Request::new(UiKeyRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::FailedPrecondition);

        let r = svc.ui_find(Request::new(UiFindRequest::default())).await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::FailedPrecondition);

        let r = svc
            .ui_screenshot(Request::new(UiScreenshotRequest::default()))
            .await;
        assert_eq!(r.unwrap_err().code(), tonic::Code::FailedPrecondition);
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
        // P4.c-B9: pattern is `format c:`, `format /q`, etc. — bare
        // `format` is no longer a match because it collides with cargo
        // subcommand and rustfmt callsites. Test the pattern that
        // actually destroys data.
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "format".into(),
                args: vec!["c:".into()],
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
    async fn test_run_command_denied_format_uppercase() {
        // P4.c-B9: case-insensitive matching catches `FORMAT C:` —
        // pre-fix this surfaced as a successful command execution.
        let svc = make_service();
        let r = svc
            .run_command(Request::new(RunCommandRequest {
                command: "FORMAT".into(),
                args: vec!["C:".into()],
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
            (
                "waitfor".to_string(),
                vec!["SignalThatNeverComes".to_string()],
            )
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
        // P4.c-B9 / Sec F9 mitigation tests:
        //   - Patterns now require a target (`format c:` not bare
        //     `format`), so `format C:` matches but `format` alone
        //     does not — `format` alone is the cargo subcommand and
        //     legitimate.
        //   - Match is case-insensitive: `RM -RF /`, `Format C:`,
        //     `DEL /S /Q C:\` all hit.
        //   - Substring matching is still bypassable (`format c :`,
        //     encoded PowerShell, etc.) — the doc comment on
        //     DENIED_COMMANDS makes the tripwire-not-boundary scope
        //     explicit.
        assert!(is_denied_command("rm", &["-rf".into(), "/".into()]));
        assert!(is_denied_command("format", &["c:".into()]));
        assert!(is_denied_command(
            "del",
            &["/s".into(), "/q".into(), "C:\\".into()]
        ));
        assert!(is_denied_command("cipher", &["/w".into(), "C:\\".into()]));
        assert!(!is_denied_command("echo", &["hello".into()]));
        assert!(!is_denied_command("ls", &["-la".into()]));
        // `format` alone (no target) is the cargo subcommand — must
        // NOT match (regression guard).
        assert!(!is_denied_command("cargo", &["format".into()]));
        assert!(!is_denied_command("rustfmt", &[]));
    }

    #[test]
    fn test_is_denied_command_case_insensitive() {
        // P4.c-B9 / Sec F9 — case folding catches the most obvious
        // bypass attempts. Encoded / non-canonical inputs are still
        // bypass — see the doc comment on DENIED_COMMANDS.
        assert!(is_denied_command("RM", &["-RF".into(), "/".into()]));
        assert!(is_denied_command("Format", &["C:".into()]));
        assert!(is_denied_command(
            "DEL",
            &["/S".into(), "/Q".into(), "c:\\".into()]
        ));
        assert!(is_denied_command("FORMAT", &["/Q".into()]));
        assert!(is_denied_command("Cipher", &["/W".into(), "c:\\".into()]));
    }

    #[test]
    fn test_contains_shell_metacharacters() {
        assert!(contains_shell_metacharacters(
            "echo",
            &["hello;world".into()]
        ));
        assert!(contains_shell_metacharacters(
            "echo",
            &["a".into(), "|".into(), "b".into()]
        ));
        assert!(contains_shell_metacharacters("echo", &["a&&b".into()]));
        assert!(!contains_shell_metacharacters(
            "echo",
            &["hello".into(), "world".into()]
        ));
    }
}
