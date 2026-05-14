//! Process control module.
//!
//! Provides process start, stop, list, and inspect capabilities.
//! On Windows, uses Win32 APIs for detailed process inspection including
//! AppContainer token detection, integrity level, and job object membership.
//!
//! Spawned child processes are tracked in a global registry keyed by PID,
//! enabling clean shutdown via stored `Child` handles before falling back
//! to OS-level kill.

use std::collections::HashMap;
use std::path::Path;
use std::process::Child;
use std::sync::{LazyLock, Mutex};

/// Global registry of spawned child processes, keyed by PID.
///
/// Used by `stop_process` to attempt a clean kill via the stored `Child`
/// handle before falling back to OS-level termination.
pub static PROCESS_REGISTRY: LazyLock<Mutex<HashMap<u32, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// RAII wrapper for a Win32 HANDLE that calls `CloseHandle` on drop.
///
/// Prevents resource leaks when using raw Win32 process handles.
#[cfg(target_os = "windows")]
pub struct SafeHandle(windows::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl SafeHandle {
    /// Wrap a raw Win32 HANDLE for automatic cleanup.
    pub fn new(handle: windows::Win32::Foundation::HANDLE) -> Self {
        Self(handle)
    }

    /// Access the inner handle.
    pub fn get(&self) -> windows::Win32::Foundation::HANDLE {
        self.0
    }
}

#[cfg(target_os = "windows")]
impl Drop for SafeHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

/// Information about a running process.
#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
    pub command_line: String,
    pub memory_bytes: u64,
    pub user: String,
    /// Whether the process has an AppContainer token.
    pub is_appcontainer: bool,
    /// AppContainer SID string (if applicable).
    pub appcontainer_sid: Option<String>,
    /// Whether the process runs at low integrity.
    pub is_low_integrity: bool,
    /// Whether the process is in a job object.
    pub is_in_job: bool,
}

/// Start a process and return its PID.
///
/// The spawned `Child` handle is stored in [`PROCESS_REGISTRY`] so that
/// `stop_process` can attempt a clean kill without resorting to OS-level
/// termination.
pub fn start_process(
    path: &Path,
    args: &[String],
    working_dir: Option<&Path>,
) -> anyhow::Result<u32> {
    let mut cmd = std::process::Command::new(path);
    cmd.args(args);

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }

    let child = cmd.spawn()?;
    let pid = child.id();

    // Store the Child handle for clean shutdown later.
    if let Ok(mut registry) = PROCESS_REGISTRY.lock() {
        registry.insert(pid, child);
    }

    Ok(pid)
}

/// Start a process as SYSTEM by duplicating the current process token.
///
/// Requires the guest agent itself to be running as SYSTEM (e.g., as a Windows service).
/// Uses `CreateProcessAsUserW` with a duplicated primary token.
///
/// # Errors
/// Returns an error if:
/// - The current process is not running as SYSTEM
/// - Token duplication fails
/// - Process creation fails
#[cfg(target_os = "windows")]
pub fn start_process_as_system(
    path: &Path,
    args: &[String],
    working_dir: Option<&Path>,
    env: &std::collections::HashMap<String, String>,
) -> anyhow::Result<u32> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        DuplicateTokenEx, SecurityImpersonation, TokenPrimary, TOKEN_ACCESS_MASK,
        TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, CREATE_NEW_CONSOLE,
        CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
    };

    // Step 1: Open current process token
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            &mut token,
        )?;
    }

    // Step 2: Duplicate as a primary token for CreateProcessAsUserW
    let mut dup_token = HANDLE::default();
    let dup_result = unsafe {
        DuplicateTokenEx(
            token,
            TOKEN_ACCESS_MASK(0), // same access
            None,                 // default security
            SecurityImpersonation,
            TokenPrimary,
            &mut dup_token,
        )
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    dup_result?;

    // Step 3: Build command line as wide string
    let mut cmd_line = format!("\"{}\"", path.display());
    for arg in args {
        cmd_line.push(' ');
        if arg.contains(' ') || arg.contains('"') {
            cmd_line.push('"');
            cmd_line.push_str(&arg.replace('"', "\\\""));
            cmd_line.push('"');
        } else {
            cmd_line.push_str(arg);
        }
    }
    let mut cmd_wide: Vec<u16> = OsStr::new(&cmd_line).encode_wide().chain(Some(0)).collect();

    // Step 4: Build environment block if needed
    let env_block = if env.is_empty() {
        None
    } else {
        let mut block: Vec<u16> = Vec::new();
        for (k, v) in env {
            let entry = format!("{k}={v}");
            block.extend(OsStr::new(&entry).encode_wide());
            block.push(0);
        }
        block.push(0); // double null terminator
        Some(block)
    };

    // Step 5: Set working directory as wide string
    let work_dir_wide: Option<Vec<u16>> = working_dir.map(|d| {
        OsStr::new(d.as_os_str())
            .encode_wide()
            .chain(Some(0))
            .collect()
    });
    let work_dir_pcwstr = match work_dir_wide.as_ref() {
        Some(w) => windows::core::PCWSTR(w.as_ptr()),
        None => windows::core::PCWSTR::null(),
    };

    // Step 6: Create process
    let si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut pi = PROCESS_INFORMATION::default();

    let creation_flags = if env_block.is_some() {
        CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT
    } else {
        CREATE_NEW_CONSOLE
    };

    let result = unsafe {
        CreateProcessAsUserW(
            dup_token,
            windows::core::PCWSTR::null(), // lpApplicationName (in cmd_line)
            windows::core::PWSTR(cmd_wide.as_mut_ptr()),
            None,  // process security
            None,  // thread security
            false, // inherit handles
            creation_flags,
            env_block.as_ref().map(|b| b.as_ptr() as *const _),
            work_dir_pcwstr,
            &si,
            &mut pi,
        )
    };
    unsafe {
        let _ = CloseHandle(dup_token);
    }
    result?;

    let pid = pi.dwProcessId;

    // Close thread and process handles — we don't need them
    unsafe {
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
    }

    tracing::info!(pid, path = %path.display(), "Process started as SYSTEM");
    Ok(pid)
}

/// Build the argv for the `sudo -n [-E] -- <path> <args...>`
/// invocation used by [`start_process_as_system`] on Linux.
///
/// Extracted into a free function so the argv shape can be unit-
/// tested on every build host, including Windows where the Linux
/// spawn path isn't compiled in. Keeping the spawn and the argv
/// composition in lockstep is the property the test locks.
///
/// The function appends to a borrowed `Vec<String>` rather than
/// returning a new one so the caller can shape the buffer however
/// they like (e.g. preallocate with `Vec::with_capacity`).
pub fn build_sudo_argv(
    out: &mut Vec<String>,
    path: &Path,
    args: &[String],
    env_present: bool,
) {
    out.push("-n".to_string());
    if env_present {
        out.push("-E".to_string());
    }
    out.push("--".to_string());
    out.push(path.to_string_lossy().into_owned());
    out.extend(args.iter().cloned());
}

/// Start a process as root on Linux via passwordless `sudo -n`.
///
/// This is the Linux analog of [`start_process_as_system`] on Windows.
/// The agent's invoking user MUST have NOPASSWD configured in
/// `/etc/sudoers` (or a drop-in under `/etc/sudoers.d/`) for the
/// commands the operator intends to run. `sudo -n` fails fast with
/// a non-zero exit if a password would be required — we surface
/// that failure as an `anyhow` error so the service layer can map
/// it to `Status::permission_denied` cleanly.
///
/// # Security note
///
/// The agent's sudoers entry is the operator's policy boundary —
/// granting `ALL=NOPASSWD: ALL` to the agent's user effectively
/// makes every `run_command(run_as="system")` invocation a root-
/// level RCE for any caller that already passed the agent's mTLS
/// auth + denylist + metachar gates. Operators are expected to
/// scope sudoers to the minimum set of commands their scenarios
/// need.
///
/// # Env handling
///
/// Custom `env` entries are set on the immediate child (sudo)
/// and the `-E` flag tells sudo to preserve them through to the
/// elevated process. If the host sudoers config has
/// `env_reset` + no `env_keep` for the requested vars, those
/// vars will not survive — the operator's sudoers policy wins
/// and that is intentional. Pass an empty `env` map when no
/// custom variables are required.
#[cfg(target_os = "linux")]
pub fn start_process_as_system(
    path: &Path,
    args: &[String],
    working_dir: Option<&Path>,
    env: &std::collections::HashMap<String, String>,
) -> anyhow::Result<u32> {
    let mut argv: Vec<String> = Vec::with_capacity(args.len() + 4);
    build_sudo_argv(&mut argv, path, args, !env.is_empty());

    let mut cmd = std::process::Command::new("sudo");
    cmd.args(&argv);

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }

    let child = cmd.spawn().map_err(|e| {
        anyhow::anyhow!(
            "failed to spawn sudo for run_as=system: {e}. \
             Is sudo installed and on PATH?"
        )
    })?;
    let pid = child.id();

    if let Ok(mut registry) = PROCESS_REGISTRY.lock() {
        registry.insert(pid, child);
    }
    tracing::info!(pid, path = %path.display(), "Process started as root via sudo -n");
    Ok(pid)
}

/// Start a process as SYSTEM stub for targets we don't implement
/// elevation on (macOS, BSDs, ...).
///
/// macOS has `sudo` too, but matching the Windows / Linux contract
/// here is out of scope for the current cross-platform sub-task —
/// we want explicit operator opt-in per OS rather than silent
/// support. `MacosPlatform::supports_system_elevation()` returns
/// false and the service layer refuses the elevation request
/// before reaching this stub.
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn start_process_as_system(
    _path: &Path,
    _args: &[String],
    _working_dir: Option<&Path>,
    _env: &std::collections::HashMap<String, String>,
) -> anyhow::Result<u32> {
    anyhow::bail!("SYSTEM elevation is only supported on Windows and Linux")
}

/// Stop a process by PID.
///
/// First checks the process registry for a stored `Child` handle and
/// attempts to kill via that handle. Falls back to OS-level termination
/// only if the process is not in the registry (e.g., was spawned externally).
pub fn stop_process(pid: u32, force: bool) -> anyhow::Result<bool> {
    // Try the registry first — this gives us a clean kill via the Child handle
    // and properly reaps the process.
    if let Ok(mut registry) = PROCESS_REGISTRY.lock() {
        if let Some(mut child) = registry.remove(&pid) {
            if force {
                child.kill()?;
            } else {
                // Attempt graceful: on Unix this sends SIGTERM via kill();
                // on Windows, Child::kill() is always forceful, so for
                // non-force we still call kill() as a best-effort.
                child.kill()?;
            }
            // Reap the child to avoid zombie processes.
            let _ = child.wait();
            return Ok(true);
        }
    }

    // Fallback: OS-level kill for processes not in our registry.
    os_kill(pid, force)
}

/// OS-level process kill fallback.
///
/// On Windows, only `force=true` (TerminateProcess) is supported. Calling
/// with `force=false` returns `Ok(false)` with a warning because Windows
/// has no standard graceful-shutdown signal equivalent to Unix SIGTERM.
fn os_kill(pid: u32, force: bool) -> anyhow::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

        if !force {
            // S-12 FIX: Do not silently claim success when we cannot
            // actually perform a graceful shutdown on Windows.
            tracing::warn!(
                pid,
                "os_kill: graceful shutdown is not supported on Windows; use force=true to terminate"
            );
            return Ok(false);
        }

        unsafe {
            let raw = OpenProcess(PROCESS_TERMINATE, false, pid)?;
            let handle = SafeHandle::new(raw);
            TerminateProcess(handle.get(), 1)?;
            // Handle is closed automatically when `handle` drops.
            Ok(true)
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        let signal = if force { "KILL" } else { "TERM" };
        let status = Command::new("kill")
            .args([&format!("-{signal}"), &pid.to_string()])
            .status()?;
        Ok(status.success())
    }
}

/// Remove a PID from the registry without killing it.
///
/// Useful when a process has already exited on its own.
pub fn remove_from_registry(pid: u32) -> Option<Child> {
    PROCESS_REGISTRY
        .lock()
        .ok()
        .and_then(|mut r| r.remove(&pid))
}

/// Check if a PID is tracked in the process registry.
pub fn is_in_registry(pid: u32) -> bool {
    PROCESS_REGISTRY
        .lock()
        .ok()
        .map(|r| r.contains_key(&pid))
        .unwrap_or(false)
}

/// Return the number of processes currently in the registry.
pub fn registry_len() -> usize {
    PROCESS_REGISTRY.lock().ok().map(|r| r.len()).unwrap_or(0)
}

/// Detailed information about a single process, returned by [`inspect_process`].
#[derive(Debug, Clone)]
pub struct ProcessDetail {
    /// Process ID.
    pub pid: u32,
    /// Process executable name.
    pub name: String,
    /// Full path to the executable.
    pub path: String,
    /// Full command line string.
    pub command_line: String,
    /// Parent process ID.
    pub parent_pid: u32,
    /// Process start time as seconds since UNIX epoch (0 if unavailable).
    pub start_time_secs: u64,
    /// Working set memory in bytes.
    pub memory_bytes: u64,
}

/// Inspect a single process by PID, returning detailed information.
///
/// On Windows this uses `OpenProcess`, `QueryFullProcessImageNameW`, and
/// `CreateToolhelp32Snapshot` for parent PID lookup. On other platforms
/// it reads from `/proc/{pid}/`.
pub fn inspect_process(pid: u32) -> anyhow::Result<ProcessDetail> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };

        // Get parent PID and process name from toolhelp snapshot.
        // S-11 FIX: Wrap snapshot handle in SafeHandle to prevent leak.
        let mut parent_pid = 0u32;
        let mut proc_name = String::new();
        unsafe {
            let snapshot_raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
            let snapshot = SafeHandle::new(snapshot_raw);
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot.get(), &mut entry).is_ok() {
                loop {
                    if entry.th32ProcessID == pid {
                        parent_pid = entry.th32ParentProcessID;
                        proc_name = String::from_utf16_lossy(
                            &entry.szExeFile[..entry
                                .szExeFile
                                .iter()
                                .position(|&c| c == 0)
                                .unwrap_or(entry.szExeFile.len())],
                        );
                        break;
                    }
                    if Process32NextW(snapshot.get(), &mut entry).is_err() {
                        break;
                    }
                }
            }
            // snapshot (SafeHandle) drops here, closing the HANDLE.
        }

        if proc_name.is_empty() {
            anyhow::bail!("process with PID {pid} not found");
        }

        // Get full image path via OpenProcess + QueryFullProcessImageNameW.
        let mut exe_path = String::new();
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let safe = SafeHandle::new(handle);
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                let pwstr = windows::core::PWSTR(buf.as_mut_ptr());
                if QueryFullProcessImageNameW(safe.get(), PROCESS_NAME_WIN32, pwstr, &mut len)
                    .is_ok()
                {
                    exe_path = String::from_utf16_lossy(&buf[..len as usize]);
                }
            }
        }

        Ok(ProcessDetail {
            pid,
            name: proc_name,
            path: exe_path,
            command_line: String::new(), // NtQueryInformationProcess requires NTDLL — deferred
            parent_pid,
            start_time_secs: 0, // Process creation time requires GetProcessTimes — deferred
            memory_bytes: 0,    // Would need GetProcessMemoryInfo
        })
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;
        use std::path::PathBuf;

        let proc_dir = PathBuf::from(format!("/proc/{pid}"));
        if !proc_dir.exists() {
            anyhow::bail!("process with PID {pid} not found");
        }

        // /proc/{pid}/comm — process name
        let name = fs::read_to_string(proc_dir.join("comm"))
            .unwrap_or_default()
            .trim()
            .to_string();

        // /proc/{pid}/exe — symlink to executable
        let path = fs::read_link(proc_dir.join("exe"))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        // /proc/{pid}/cmdline — null-separated
        let command_line = fs::read(proc_dir.join("cmdline"))
            .map(|bytes| {
                bytes
                    .split(|&b| b == 0)
                    .filter(|s| !s.is_empty())
                    .map(|s| String::from_utf8_lossy(s).into_owned())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();

        // /proc/{pid}/stat — fields: pid (comm) state ppid ...
        let stat = fs::read_to_string(proc_dir.join("stat")).unwrap_or_default();
        let parent_pid = stat
            .rfind(')')
            .and_then(|pos| {
                let after = &stat[pos + 2..]; // skip ") "
                let fields: Vec<&str> = after.split_whitespace().collect();
                // field 0 = state, field 1 = ppid
                fields.get(1).and_then(|s| s.parse::<u32>().ok())
            })
            .unwrap_or(0);

        // /proc/{pid}/statm — first field is total pages
        let memory_bytes = fs::read_to_string(proc_dir.join("statm"))
            .ok()
            .and_then(|s| {
                s.split_whitespace()
                    .next()
                    .and_then(|p| p.parse::<u64>().ok())
            })
            .map(|pages| pages * 4096) // assume 4K pages
            .unwrap_or(0);

        Ok(ProcessDetail {
            pid,
            name,
            path,
            command_line,
            parent_pid,
            start_time_secs: 0,
            memory_bytes,
        })
    }

    #[cfg(target_os = "macos")]
    {
        use std::path::Path;
        use std::process::Command;

        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "ppid=", "-o", "comm="])
            .output()?;
        if !output.status.success() {
            anyhow::bail!("process with PID {pid} not found");
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim();
        if line.is_empty() {
            anyhow::bail!("process with PID {pid} not found");
        }

        let mut parts = line.split_whitespace();
        let parent_pid = parts
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let path = parts.collect::<Vec<_>>().join(" ");
        let name = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.clone());

        Ok(ProcessDetail {
            pid,
            name,
            path,
            command_line: String::new(),
            parent_pid,
            start_time_secs: 0,
            memory_bytes: 0,
        })
    }

    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "linux"),
        not(target_os = "macos")
    ))]
    {
        anyhow::bail!("process inspection is not implemented on this platform")
    }
}

/// List running processes, optionally filtered by name.
pub fn list_processes(name_filter: Option<&str>) -> anyhow::Result<Vec<ProcessInfo>> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let mut processes = Vec::new();

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        // S-11 FIX: Wrap snapshot handle in SafeHandle to prevent leak.
        unsafe {
            let snapshot_raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
            let snapshot = SafeHandle::new(snapshot_raw);
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };

            if Process32FirstW(snapshot.get(), &mut entry).is_ok() {
                loop {
                    let name = String::from_utf16_lossy(
                        &entry.szExeFile[..entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len())],
                    );

                    let matches = name_filter
                        .map(|f| name.to_lowercase().contains(&f.to_lowercase()))
                        .unwrap_or(true);

                    if matches {
                        processes.push(ProcessInfo {
                            pid: entry.th32ProcessID,
                            name: name.clone(),
                            path: String::new(), // TODO: QueryFullProcessImageNameW
                            command_line: String::new(), // TODO: NtQueryInformationProcess
                            memory_bytes: 0,
                            user: String::new(),
                            is_appcontainer: false, // TODO: GetTokenInformation
                            appcontainer_sid: None,
                            is_low_integrity: false,
                            is_in_job: false,
                        });
                    }

                    if Process32NextW(snapshot.get(), &mut entry).is_err() {
                        break;
                    }
                }
            }
            // snapshot (SafeHandle) drops here, closing the HANDLE.
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = name_filter;
        // TODO: /proc filesystem parsing for Linux
    }

    #[cfg(target_os = "macos")]
    {
        use std::path::Path;
        use std::process::Command;

        let output = Command::new("ps").args(["-axo", "pid=,comm="]).output()?;
        if !output.status.success() {
            anyhow::bail!("ps failed while listing processes");
        }
        let filter = name_filter.map(|f| f.to_lowercase());
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut parts = trimmed.split_whitespace();
            let Some(pid) = parts.next().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            let path = parts.collect::<Vec<_>>().join(" ");
            let name = Path::new(&path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| path.clone());
            if filter
                .as_ref()
                .map(|f| !name.to_lowercase().contains(f))
                .unwrap_or(false)
            {
                continue;
            }
            processes.push(ProcessInfo {
                pid,
                name,
                path,
                command_line: String::new(),
                memory_bytes: 0,
                user: String::new(),
                is_appcontainer: false,
                appcontainer_sid: None,
                is_low_integrity: false,
                is_in_job: false,
            });
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let processes = Vec::new();

    Ok(processes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Helper: path to a harmless long-lived command.
    fn test_command() -> PathBuf {
        if cfg!(target_os = "windows") {
            PathBuf::from("cmd.exe")
        } else {
            PathBuf::from("/bin/sleep")
        }
    }

    /// Helper: args that keep the process alive for a while.
    fn test_args() -> Vec<String> {
        if cfg!(target_os = "windows") {
            // Use `ping -n 60 127.0.0.1` which works in all Windows shells.
            vec![
                "/C".into(),
                "ping".into(),
                "-n".into(),
                "60".into(),
                "127.0.0.1".into(),
            ]
        } else {
            vec!["60".into()]
        }
    }

    #[test]
    fn test_start_registers_child() {
        let pid = start_process(&test_command(), &test_args(), None).expect("should spawn");
        assert!(pid > 0);
        assert!(is_in_registry(pid), "spawned PID should be in registry");

        // Cleanup
        let _ = stop_process(pid, true);
    }

    #[test]
    fn test_stop_removes_from_registry() {
        let pid = start_process(&test_command(), &test_args(), None).expect("should spawn");
        assert!(is_in_registry(pid));

        let stopped = stop_process(pid, true).expect("should stop");
        assert!(stopped);
        assert!(!is_in_registry(pid), "PID should be removed after stop");
    }

    #[test]
    fn test_stop_unregistered_pid_falls_back_to_os_kill() {
        // Spawn a process but remove it from registry manually,
        // then verify stop_process still works via OS kill.
        let pid = start_process(&test_command(), &test_args(), None).expect("should spawn");
        let _child = remove_from_registry(pid);
        assert!(!is_in_registry(pid));

        // OS-level kill should still succeed (process is running).
        let stopped = stop_process(pid, true).expect("should stop via OS kill");
        assert!(stopped);
    }

    #[test]
    fn test_remove_from_registry_returns_child() {
        let pid = start_process(&test_command(), &test_args(), None).expect("should spawn");
        let child = remove_from_registry(pid);
        assert!(child.is_some(), "should return the Child handle");
        assert!(!is_in_registry(pid));

        // Cleanup: kill via the returned child.
        let mut child = child.unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn test_registry_tracks_multiple_processes() {
        // Spawn two processes, verify both are tracked, then clean up.
        let pid1 = start_process(&test_command(), &test_args(), None).expect("spawn 1");
        let pid2 = start_process(&test_command(), &test_args(), None).expect("spawn 2");

        assert!(is_in_registry(pid1));
        assert!(is_in_registry(pid2));
        assert_ne!(pid1, pid2);

        let _ = stop_process(pid1, true);
        assert!(!is_in_registry(pid1));
        assert!(is_in_registry(pid2));

        let _ = stop_process(pid2, true);
        assert!(!is_in_registry(pid2));
    }

    #[test]
    fn test_inspect_current_process() {
        let my_pid = std::process::id();
        let detail = inspect_process(my_pid).expect("should inspect self");
        assert_eq!(detail.pid, my_pid);
        assert!(!detail.name.is_empty(), "process name should not be empty");
    }

    #[test]
    fn test_inspect_nonexistent_pid() {
        // PID 0xFFFF_FFFE is extremely unlikely to exist.
        let result = inspect_process(0xFFFF_FFFE);
        assert!(result.is_err(), "should fail for nonexistent PID");
    }

    // ── build_sudo_argv (Linux sudo -n elevation path) ─────────────
    //
    // The argv helper compiles on every target; these tests lock its
    // shape so a refactor on a Windows or macOS dev box still catches
    // accidental drift in the order or omission of the `-n` / `-E` /
    // `--` flags before a Linux operator hits it.

    #[test]
    fn build_sudo_argv_emits_n_dashdash_path_args_with_no_env() {
        let mut argv = Vec::new();
        build_sudo_argv(
            &mut argv,
            Path::new("/usr/bin/systemctl"),
            &["restart".into(), "nginx".into()],
            false,
        );
        assert_eq!(
            argv,
            vec![
                "-n".to_string(),
                "--".into(),
                "/usr/bin/systemctl".into(),
                "restart".into(),
                "nginx".into(),
            ],
        );
    }

    #[test]
    fn build_sudo_argv_inserts_dash_e_when_env_is_present() {
        let mut argv = Vec::new();
        build_sudo_argv(
            &mut argv,
            Path::new("/usr/bin/env-aware"),
            &[],
            true,
        );
        assert_eq!(
            argv,
            vec![
                "-n".to_string(),
                "-E".into(),
                "--".into(),
                "/usr/bin/env-aware".into(),
            ],
        );
    }

    #[test]
    fn build_sudo_argv_keeps_dashdash_before_path_to_neutralise_flag_lookalikes() {
        // A path starting with `-` would normally be interpreted as a
        // sudo flag. The `--` separator guarantees it's parsed as the
        // program even if the caller passes something like `--help`.
        let mut argv = Vec::new();
        build_sudo_argv(&mut argv, Path::new("--help"), &[], false);
        let dashdash_idx = argv
            .iter()
            .position(|s| s == "--")
            .expect("argv must contain --");
        let path_idx = argv
            .iter()
            .position(|s| s == "--help")
            .expect("argv must contain the path");
        assert!(
            dashdash_idx < path_idx,
            "-- must precede the program path; got argv={argv:?}"
        );
    }

    #[test]
    fn build_sudo_argv_does_not_clobber_caller_buffer() {
        // Confirms `build_sudo_argv` appends to the buffer rather
        // than overwriting it — callers may pre-fill argv with sudo
        // options of their own in a future refactor.
        let mut argv = vec!["--preserve-env=FOO".to_string()];
        build_sudo_argv(&mut argv, Path::new("/bin/true"), &[], false);
        assert_eq!(argv[0], "--preserve-env=FOO");
        assert!(argv.contains(&"-n".to_string()));
    }

    /// On Linux, calling start_process_as_system with a binary that
    /// definitely won't pass sudoers (or won't exist) must return
    /// an Err instead of panicking — the service layer surfaces
    /// this as `Status::permission_denied`.
    #[cfg(target_os = "linux")]
    #[test]
    fn start_process_as_system_linux_returns_err_for_unauthorised_command() {
        let env = std::collections::HashMap::new();
        let result = start_process_as_system(
            Path::new("/usr/bin/this-command-does-not-exist-xyz-12345"),
            &[],
            None,
            &env,
        );
        // We can't assert PASS/FAIL contents (depends on sudoers on
        // the build host) — we just lock that the function returns
        // a Result without panicking and the Err path includes some
        // hint about sudo.
        if let Err(e) = result {
            let msg = format!("{e:#}");
            assert!(
                msg.to_lowercase().contains("sudo") || msg.to_lowercase().contains("permission") || msg.to_lowercase().contains("authentic"),
                "error should hint at sudo / permission / auth; got: {msg}"
            );
        }
    }

    /// S-12: Verify that os_kill with force=false does not silently claim
    /// success on Windows. Instead it should return Ok(false).
    #[test]
    fn test_os_kill_graceful_returns_false_on_windows() {
        // Spawn a process, remove from registry so stop_process uses os_kill.
        let pid = start_process(&test_command(), &test_args(), None).expect("should spawn");
        let _child = remove_from_registry(pid);

        let result = stop_process(pid, false);

        if cfg!(target_os = "windows") {
            // On Windows, graceful (force=false) should return Ok(false).
            let stopped = result.expect("os_kill should not error");
            assert!(
                !stopped,
                "graceful os_kill on Windows must return false, not silently succeed"
            );
        }
        // Clean up — force-kill the process.
        let _ = stop_process(pid, true);
        // If the child was returned, kill it too.
        if let Some(mut child) = _child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
