//! Network and file-access probe helpers used by guest-agent RPCs.
//!
//! Generic primitives the host can call into a VM to verify the
//! environment behaves the way a scenario expects:
//! - TCP connectivity to a host:port
//! - File access (read / write / list) at a path
//! - Whether a named software package is installed
//!
//! These are intentionally simple checks; richer probes graduate when a
//! real consumer needs them.

use std::fs::OpenOptions;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Test TCP connectivity to a host:port.
///
/// Returns `true` if the connection succeeds (host is reachable),
/// `false` if blocked or timed out.
pub fn test_network_connectivity(host: &str, port: u16, timeout: Duration) -> NetworkTestResult {
    let addr = format!("{host}:{port}");

    match addr.parse::<SocketAddr>() {
        Ok(socket_addr) => match TcpStream::connect_timeout(&socket_addr, timeout) {
            Ok(_) => NetworkTestResult {
                reachable: true,
                latency_ms: 0, // TODO: measure actual latency
                error: None,
            },
            Err(e) => NetworkTestResult {
                reachable: false,
                latency_ms: 0,
                error: Some(e.to_string()),
            },
        },
        Err(_) => {
            // hostname — need DNS resolution first
            match std::net::ToSocketAddrs::to_socket_addrs(&addr) {
                Ok(mut addrs) => {
                    if let Some(socket_addr) = addrs.next() {
                        let start = std::time::Instant::now();
                        match TcpStream::connect_timeout(&socket_addr, timeout) {
                            Ok(_) => NetworkTestResult {
                                reachable: true,
                                latency_ms: start.elapsed().as_millis() as u64,
                                error: None,
                            },
                            Err(e) => NetworkTestResult {
                                reachable: false,
                                latency_ms: start.elapsed().as_millis() as u64,
                                error: Some(e.to_string()),
                            },
                        }
                    } else {
                        NetworkTestResult {
                            reachable: false,
                            latency_ms: 0,
                            error: Some("DNS resolved but no addresses".into()),
                        }
                    }
                }
                Err(e) => NetworkTestResult {
                    reachable: false,
                    latency_ms: 0,
                    error: Some(format!("DNS resolution failed: {e}")),
                },
            }
        }
    }
}

/// Result of a network connectivity test.
#[derive(Debug, Clone)]
pub struct NetworkTestResult {
    pub reachable: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Test file access (read, write, delete).
pub fn test_file_access(path: &str, operation: &str) -> FileAccessResult {
    match operation {
        "read" => match std::fs::read(path) {
            Ok(_) => FileAccessResult {
                allowed: true,
                error: None,
            },
            Err(e) => FileAccessResult {
                allowed: false,
                error: Some(e.to_string()),
            },
        },
        "write" => {
            // Use a unique temp file with create_new to avoid overwriting existing data.
            let random_suffix: u64 = rand::random();
            let test_path = format!("{path}.signalman-test-{random_suffix:016x}");
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&test_path)
            {
                Ok(_file) => {
                    // Clean up test file
                    let _ = std::fs::remove_file(&test_path);
                    FileAccessResult {
                        allowed: true,
                        error: None,
                    }
                }
                Err(e) => {
                    // Clean up on failure too, in case partial create occurred.
                    let _ = std::fs::remove_file(&test_path);
                    FileAccessResult {
                        allowed: false,
                        error: Some(e.to_string()),
                    }
                }
            }
        }
        "list" => match std::fs::read_dir(path) {
            Ok(_) => FileAccessResult {
                allowed: true,
                error: None,
            },
            Err(e) => FileAccessResult {
                allowed: false,
                error: Some(e.to_string()),
            },
        },
        _ => FileAccessResult {
            allowed: false,
            error: Some(format!("Unknown operation: {operation}")),
        },
    }
}

/// Result of a file access test.
#[derive(Debug, Clone)]
pub struct FileAccessResult {
    pub allowed: bool,
    pub error: Option<String>,
}

/// Result of checking whether specific software is installed.
#[derive(Debug, Clone)]
pub struct SoftwareCheckResult {
    /// Whether the software was found.
    pub found: bool,
    /// Version string, if available.
    pub version: String,
    /// Install path, if available.
    pub install_path: String,
}

/// Check whether a named software package is installed on this system.
///
/// On Windows, checks the registry under
/// `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` (and the
/// Wow6432Node variant for 32-bit software on 64-bit Windows).
///
/// On other platforms, searches PATH for an executable matching `name`.
pub fn verify_software_installed(name: &str) -> SoftwareCheckResult {
    #[cfg(target_os = "windows")]
    {
        verify_software_installed_windows(name)
    }

    #[cfg(not(target_os = "windows"))]
    {
        verify_software_installed_unix(name)
    }
}

/// Windows implementation: scan Uninstall registry keys.
#[cfg(target_os = "windows")]
fn verify_software_installed_windows(name: &str) -> SoftwareCheckResult {
    use std::process::Command;

    // Use reg query to search both native and Wow6432Node uninstall keys.
    let registry_paths = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    let name_lower = name.to_lowercase();

    for reg_path in &registry_paths {
        // Enumerate subkeys.
        let output = Command::new("reg")
            .args(["query", reg_path, "/s", "/f", name, "/d"])
            .output();

        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            // Parse reg output for DisplayName, DisplayVersion, InstallLocation.
            let mut version = String::new();
            let mut install_path = String::new();
            let mut found = false;

            for line in text.lines() {
                let line_trimmed = line.trim();
                if line_trimmed.contains("DisplayName") {
                    if let Some(val) = line_trimmed.split("REG_SZ").nth(1) {
                        let val = val.trim();
                        if val.to_lowercase().contains(&name_lower) {
                            found = true;
                        }
                    }
                }
                if found && line_trimmed.contains("DisplayVersion") {
                    if let Some(val) = line_trimmed.split("REG_SZ").nth(1) {
                        version = val.trim().to_string();
                    }
                }
                if found && line_trimmed.contains("InstallLocation") {
                    if let Some(val) = line_trimmed.split("REG_SZ").nth(1) {
                        install_path = val.trim().to_string();
                    }
                }
            }

            if found {
                return SoftwareCheckResult {
                    found: true,
                    version,
                    install_path,
                };
            }
        }
    }

    // Fallback: also check PATH (e.g., cmd.exe, powershell.exe).
    verify_software_installed_path(name)
}

/// Unix implementation: search PATH for the executable.
#[cfg(not(target_os = "windows"))]
fn verify_software_installed_unix(name: &str) -> SoftwareCheckResult {
    verify_software_installed_path(name)
}

/// Shared fallback: search PATH for an executable matching `name`.
fn verify_software_installed_path(name: &str) -> SoftwareCheckResult {
    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(target_os = "windows") {
            ';'
        } else {
            ':'
        };
        for dir in path_var.split(separator) {
            let candidate = std::path::Path::new(dir).join(name);
            if candidate.exists() {
                return SoftwareCheckResult {
                    found: true,
                    version: String::new(),
                    install_path: candidate.to_string_lossy().into_owned(),
                };
            }
            // On Windows, also try with .exe extension.
            if cfg!(target_os = "windows") && !name.contains('.') {
                let candidate_exe = std::path::Path::new(dir).join(format!("{name}.exe"));
                if candidate_exe.exists() {
                    return SoftwareCheckResult {
                        found: true,
                        version: String::new(),
                        install_path: candidate_exe.to_string_lossy().into_owned(),
                    };
                }
            }
        }
    }

    SoftwareCheckResult {
        found: false,
        version: String::new(),
        install_path: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_connectivity_localhost() {
        // Localhost with no listener should fail
        let result = test_network_connectivity("127.0.0.1", 59999, Duration::from_millis(100));
        assert!(!result.reachable);
    }

    #[test]
    fn test_file_access_read_nonexistent() {
        let result = test_file_access("C:\\nonexistent\\file.txt", "read");
        assert!(!result.allowed);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_file_access_unknown_operation() {
        let result = test_file_access(".", "unknown");
        assert!(!result.allowed);
        assert!(result.error.unwrap().contains("Unknown operation"));
    }

    #[test]
    fn test_verify_software_exists() {
        // cmd.exe exists on Windows, sh exists on Unix — both are in PATH.
        let name = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        };
        let result = verify_software_installed(name);
        assert!(result.found, "expected to find '{name}' on PATH");
        assert!(!result.install_path.is_empty());
    }

    #[test]
    fn test_verify_software_not_exists() {
        let result = verify_software_installed("zzz-nonexistent-software-xyz");
        assert!(!result.found);
        assert!(result.install_path.is_empty());
    }
}
