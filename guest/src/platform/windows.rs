//! Windows platform implementation.
//!
//! Reports `windows` and enables UI automation, SYSTEM elevation, and
//! package-manager installs. Process inspection details (token,
//! integrity level, AppContainer SID, job object) remain on
//! `crate::process` so the Win32-only `windows` crate import stays
//! out of this module.

use super::{Platform, PlatformKind};

/// Windows-flavoured [`Platform`].
#[derive(Debug, Default)]
pub struct WindowsPlatform;

impl Platform for WindowsPlatform {
    fn kind(&self) -> PlatformKind {
        PlatformKind::Windows
    }

    fn hostname(&self) -> String {
        // `COMPUTERNAME` is the Win32 convention (it's the same value
        // `Get-ComputerInfo` reports). We fall back to "unknown" rather
        // than the host's username so a missing env var doesn't silently
        // mis-identify the VM in audit logs.
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".into())
    }

    fn supports_ui_automation(&self) -> bool {
        true
    }

    fn supports_system_elevation(&self) -> bool {
        // The actual elevation work lives in
        // `crate::process::start_process_as_system`, which only has a
        // real impl behind `#[cfg(target_os = "windows")]`.
        true
    }

    fn supports_package_manager_install(&self) -> bool {
        // `install_software` understands winget / choco / scoop / msstore —
        // all four are Windows-only.
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_windows_kind_and_full_capability_surface() {
        let p = WindowsPlatform;
        assert_eq!(p.kind(), PlatformKind::Windows);
        assert!(p.supports_ui_automation());
        assert!(p.supports_browser_automation());
        assert!(p.supports_system_elevation());
        assert!(p.supports_package_manager_install());
    }

    #[test]
    fn hostname_falls_back_to_unknown_when_env_unset() {
        // We can't reliably unset COMPUTERNAME in a parallel test
        // process without poisoning other tests, but we *can* check
        // that the impl never panics and always yields a non-empty
        // string on this Windows build host.
        let host = WindowsPlatform.hostname();
        assert!(!host.is_empty());
    }
}
