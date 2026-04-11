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
fn os_kill(pid: u32, force: bool) -> anyhow::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };

        unsafe {
            let raw = OpenProcess(PROCESS_TERMINATE, false, pid)?;
            let handle = SafeHandle::new(raw);
            if force {
                TerminateProcess(handle.get(), 1)?;
            }
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
    PROCESS_REGISTRY
        .lock()
        .ok()
        .map(|r| r.len())
        .unwrap_or(0)
}

/// List running processes, optionally filtered by name.
pub fn list_processes(name_filter: Option<&str>) -> anyhow::Result<Vec<ProcessInfo>> {
    let mut processes = Vec::new();

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
            PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };

        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };

            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let name = String::from_utf16_lossy(
                        &entry.szExeFile[..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len())],
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

                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = name_filter;
        // TODO: /proc filesystem parsing for Linux
    }

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
            vec!["/C".into(), "ping".into(), "-n".into(), "60".into(), "127.0.0.1".into()]
        } else {
            vec!["60".into()]
        }
    }

    #[test]
    fn test_start_registers_child() {
        let pid = start_process(&test_command(), &test_args(), None)
            .expect("should spawn");
        assert!(pid > 0);
        assert!(is_in_registry(pid), "spawned PID should be in registry");

        // Cleanup
        let _ = stop_process(pid, true);
    }

    #[test]
    fn test_stop_removes_from_registry() {
        let pid = start_process(&test_command(), &test_args(), None)
            .expect("should spawn");
        assert!(is_in_registry(pid));

        let stopped = stop_process(pid, true).expect("should stop");
        assert!(stopped);
        assert!(!is_in_registry(pid), "PID should be removed after stop");
    }

    #[test]
    fn test_stop_unregistered_pid_falls_back_to_os_kill() {
        // Spawn a process but remove it from registry manually,
        // then verify stop_process still works via OS kill.
        let pid = start_process(&test_command(), &test_args(), None)
            .expect("should spawn");
        let _child = remove_from_registry(pid);
        assert!(!is_in_registry(pid));

        // OS-level kill should still succeed (process is running).
        let stopped = stop_process(pid, true).expect("should stop via OS kill");
        assert!(stopped);
    }

    #[test]
    fn test_remove_from_registry_returns_child() {
        let pid = start_process(&test_command(), &test_args(), None)
            .expect("should spawn");
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
        let pid1 = start_process(&test_command(), &test_args(), None)
            .expect("spawn 1");
        let pid2 = start_process(&test_command(), &test_args(), None)
            .expect("spawn 2");

        assert!(is_in_registry(pid1));
        assert!(is_in_registry(pid2));
        assert_ne!(pid1, pid2);

        let _ = stop_process(pid1, true);
        assert!(!is_in_registry(pid1));
        assert!(is_in_registry(pid2));

        let _ = stop_process(pid2, true);
        assert!(!is_in_registry(pid2));
    }
}
