//! Restriction verification module.
//!
//! Checks whether a process is properly restricted by the Example agent:
//! - AppContainer token present
//! - Low integrity level
//! - Job object membership
//! - Network restrictions (firewall rules)
//! - File access restrictions (ACLs)
//! - DLL injection (restrict hook loaded)

use std::net::{TcpStream, SocketAddr};
use std::time::Duration;

/// Restriction verification result.
#[derive(Debug, Clone)]
pub struct RestrictionVerdict {
    /// Whether any restriction is active.
    pub is_restricted: bool,
    /// Restriction mode detected.
    pub mode: RestrictionMode,
    /// Individual check results.
    pub checks: Vec<RestrictionCheck>,
    /// Overall verdict.
    pub verdict: Verdict,
    /// Issues found (empty if fully restricted).
    pub issues: Vec<String>,
}

/// Detected restriction mode.
#[derive(Debug, Clone, PartialEq)]
pub enum RestrictionMode {
    /// AppContainer kernel sandbox (Phase 2+).
    AppContainer { sid: String },
    /// Legacy 4-layer enforcement.
    Legacy,
    /// No restriction detected.
    None,
}

/// Overall verdict.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// All expected restrictions are active.
    FullyRestricted,
    /// Some restrictions are active but gaps exist.
    PartiallyRestricted,
    /// No restrictions detected.
    NotRestricted,
}

/// A single restriction check result.
#[derive(Debug, Clone)]
pub struct RestrictionCheck {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

/// Test TCP connectivity to a host:port.
///
/// Returns `true` if the connection succeeds (host is reachable),
/// `false` if blocked or timed out.
pub fn test_network_connectivity(
    host: &str,
    port: u16,
    timeout: Duration,
) -> NetworkTestResult {
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
        "read" => {
            match std::fs::read(path) {
                Ok(_) => FileAccessResult { allowed: true, error: None },
                Err(e) => FileAccessResult { allowed: false, error: Some(e.to_string()) },
            }
        }
        "write" => {
            match std::fs::write(path, b"signalman-test") {
                Ok(_) => {
                    // Clean up test file
                    let _ = std::fs::remove_file(path);
                    FileAccessResult { allowed: true, error: None }
                }
                Err(e) => FileAccessResult { allowed: false, error: Some(e.to_string()) },
            }
        }
        "list" => {
            match std::fs::read_dir(path) {
                Ok(_) => FileAccessResult { allowed: true, error: None },
                Err(e) => FileAccessResult { allowed: false, error: Some(e.to_string()) },
            }
        }
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
    fn test_restriction_mode_equality() {
        assert_eq!(RestrictionMode::None, RestrictionMode::None);
        assert_eq!(RestrictionMode::Legacy, RestrictionMode::Legacy);
        assert_ne!(RestrictionMode::None, RestrictionMode::Legacy);
    }

    #[test]
    fn test_verdict_equality() {
        assert_eq!(Verdict::FullyRestricted, Verdict::FullyRestricted);
        assert_ne!(Verdict::FullyRestricted, Verdict::NotRestricted);
    }
}
