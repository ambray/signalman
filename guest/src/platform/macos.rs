//! macOS platform implementation.
//!
//! Mirrors the Linux capability surface — the portable RPCs (Health,
//! Register, RunCommand, TestNetwork, TestFileAccess) work; UI
//! automation, SYSTEM elevation and the package-manager install path
//! are deferred. macOS GUI automation needs AppleScript / Accessibility
//! API integration which is out of scope for v0.4.0.

use super::{Platform, PlatformKind};

/// macOS-flavoured [`Platform`].
#[derive(Debug, Default)]
pub struct MacosPlatform;

impl Platform for MacosPlatform {
    fn kind(&self) -> PlatformKind {
        PlatformKind::Macos
    }

    fn hostname(&self) -> String {
        std::env::var("HOST")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "unknown".into())
    }

    fn supports_ui_automation(&self) -> bool {
        false
    }

    fn supports_system_elevation(&self) -> bool {
        false
    }

    fn supports_package_manager_install(&self) -> bool {
        // brew / mas would be the obvious fits; the
        // `install_software` enum doesn't yet route to them. Operators
        // call `brew install ...` through `RunCommand` for now.
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_macos_kind_and_minimal_capability_surface() {
        let p = MacosPlatform;
        assert_eq!(p.kind(), PlatformKind::Macos);
        assert!(!p.supports_ui_automation());
        assert!(!p.supports_browser_automation());
        assert!(!p.supports_system_elevation());
        assert!(!p.supports_package_manager_install());
    }

    #[test]
    fn hostname_falls_back_to_unknown_when_env_unset() {
        let host = MacosPlatform.hostname();
        assert!(!host.is_empty());
    }
}
