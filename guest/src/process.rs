//! Process control module.
//!
//! Provides process start, stop, list, and inspect capabilities.
//! On Windows, uses Win32 APIs for detailed process inspection including
//! AppContainer token detection, integrity level, and job object membership.

use std::path::Path;

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
    Ok(child.id())
}

/// Stop a process by PID.
pub fn stop_process(pid: u32, force: bool) -> anyhow::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };

        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, false, pid)?;
            if force {
                TerminateProcess(handle, 1)?;
            }
            // TODO: Graceful shutdown via WM_CLOSE for non-force
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
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

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
