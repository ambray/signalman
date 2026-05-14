//! Fallback platform implementation for targets that are neither
//! Windows, Linux, nor macOS (BSDs, solaris, wasi, ...).
//!
//! Reports `unknown` and disables every capability so the host gets a
//! clean `Status::unimplemented` for any RPC that requires platform
//! help. The crate doesn't *test* on these targets, but we want the
//! build to succeed there so cross-compilation experiments aren't
//! blocked by missing trait impls.

use super::{Platform, PlatformKind};

/// Fallback [`Platform`] for unknown targets.
#[derive(Debug, Default)]
pub struct OtherPlatform;

impl Platform for OtherPlatform {
    fn kind(&self) -> PlatformKind {
        PlatformKind::Other
    }

    fn hostname(&self) -> String {
        std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "unknown".into())
    }

    fn supports_ui_automation(&self) -> bool {
        false
    }

    fn supports_system_elevation(&self) -> bool {
        false
    }

    fn supported_package_sources(&self) -> &'static [&'static str] {
        &[]
    }
}
