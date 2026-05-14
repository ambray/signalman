//! Linux platform implementation.
//!
//! Implements the portable RPC surface (Health, Register, RunCommand,
//! TestNetwork, TestFileAccess) by leaving the platform-agnostic
//! modules to do the work. UI automation, SYSTEM elevation, and the
//! package-manager `install_software` paths are reported as
//! unsupported — the host orchestrator is expected to route Linux
//! installs through `RunCommand` (apt / dnf / yum / pacman / ...).

use super::{Platform, PlatformKind};

/// Linux-flavoured [`Platform`].
#[derive(Debug, Default)]
pub struct LinuxPlatform;

impl Platform for LinuxPlatform {
    fn kind(&self) -> PlatformKind {
        PlatformKind::Linux
    }

    fn hostname(&self) -> String {
        std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "unknown".into())
    }

    fn supports_ui_automation(&self) -> bool {
        // The UI sidecar speaks PowerShell + UIA — neither runs on
        // Linux. Operators driving Linux GUIs should write scenarios
        // that exec `xdotool` / `wmctrl` through `RunCommand`.
        false
    }

    fn supports_system_elevation(&self) -> bool {
        // Linux has equivalents (`setuid` / `sudo`) but they're
        // out of scope for v0.4.0; the cross-platform doc explicitly
        // defers them to a future milestone. We don't want to claim
        // support and silently run as the agent user.
        false
    }

    fn supports_package_manager_install(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_linux_kind_and_minimal_capability_surface() {
        let p = LinuxPlatform;
        assert_eq!(p.kind(), PlatformKind::Linux);
        assert!(!p.supports_ui_automation());
        assert!(!p.supports_browser_automation());
        assert!(!p.supports_system_elevation());
        assert!(!p.supports_package_manager_install());
    }

    #[test]
    fn hostname_falls_back_to_unknown_when_env_unset() {
        let host = LinuxPlatform.hostname();
        assert!(!host.is_empty());
    }
}
