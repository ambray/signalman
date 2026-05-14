//! Platform abstraction layer for the guest agent.
//!
//! Each supported OS has its own module here implementing the [`Platform`]
//! trait. The service layer dispatches platform-conditional behaviour
//! through [`current()`] instead of scattering `#[cfg(target_os = "...")]`
//! arms across every RPC handler.
//!
//! ## Why a trait
//!
//! Before the v0.4.0-4 split, platform branches sat inline in
//! `service.rs`, `process.rs`, and `probes.rs`. That worked while the
//! crate was Windows-only, but as Linux/macOS support grows the inline
//! `#[cfg]` style makes it hard to:
//!
//! * tell at a glance which capabilities exist on a given OS,
//! * inject a fake implementation in tests, and
//! * keep the Win32-only `windows` crate dep out of the dependency
//!   graph on non-Windows targets.
//!
//! The trait centralises capability checks (`supports_ui_automation`,
//! `supports_system_elevation`, etc.) and lets the gRPC service layer
//! return a clean `Status::unimplemented` on platforms that don't
//! support a given RPC, rather than relying on an indirect failure
//! (e.g. the UI sidecar refusing to start).
//!
//! ## Design constraints
//!
//! * **Const-friendly capability flags.** The capability getters all
//!   return `bool` or `&'static str` so callers can match on them
//!   without allocating. Heavyweight platform queries (e.g. real
//!   process inspection) continue to live in `process.rs` / `probes.rs`
//!   because they are already well-organised and have their own tests;
//!   the trait stays narrow to keep the surface auditable.
//! * **No dynamic dispatch on the hot path.** [`current()`] returns a
//!   reference to a `'static` instance whose methods are
//!   straight-line; LLVM should devirtualise.
//! * **Tests can substitute a fake.** [`Platform`] is object-safe; the
//!   tests in this module exercise the trait via a fake impl rather
//!   than relying on whichever OS the build host happens to be.

use std::fmt::Debug;

/// Logical platform identifier. Mirrors `target_os` for the four shapes
/// we care about; anything else collapses to [`PlatformKind::Other`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformKind {
    Windows,
    Linux,
    Macos,
    Other,
}

impl PlatformKind {
    /// Stable lowercase identifier used in RPC responses and tracing.
    pub fn as_str(self) -> &'static str {
        match self {
            PlatformKind::Windows => "windows",
            PlatformKind::Linux => "linux",
            PlatformKind::Macos => "macos",
            PlatformKind::Other => "unknown",
        }
    }
}

/// Capability surface exposed by every platform implementation.
///
/// Methods return cheap-to-evaluate values; richer operations stay on
/// the existing modules (`process`, `probes`, `file_ops`) which already
/// own their cfg-gated implementations. The point of this trait is to
/// give the service layer **one** dispatch point that says "is this
/// RPC supported here, and if not, what is the canonical message?".
pub trait Platform: Debug + Send + Sync {
    /// OS identifier reported in `HealthResponse.os`.
    fn kind(&self) -> PlatformKind;

    /// Hostname as the agent reports it. Falls back to "unknown" when
    /// the underlying env var lookup fails.
    fn hostname(&self) -> String;

    /// Whether the UI Automation RPCs (`ui_click`, `ui_type`, ...) can
    /// actually drive a desktop on this platform. The host is expected
    /// to skip-gate scenarios that require UI automation when this
    /// returns false rather than relying on the sidecar to error out.
    fn supports_ui_automation(&self) -> bool;

    /// Whether the browser-automation RPCs are wired in (they sit on
    /// top of the UI sidecar, so this is gated by the same flag in
    /// practice — exposed separately so callers don't have to know
    /// the implementation detail).
    fn supports_browser_automation(&self) -> bool {
        self.supports_ui_automation()
    }

    /// Whether `run_command(run_as="system")` can actually elevate.
    /// Windows duplicates the SYSTEM token via `CreateProcessAsUserW`;
    /// Linux and macOS do not have an equivalent integration here yet,
    /// so the service layer rejects the request early instead of
    /// silently running as the agent user.
    fn supports_system_elevation(&self) -> bool;

    /// Whether `install_software` can route through a real package
    /// manager (`winget`, `choco`, `scoop`, `msstore`). The Linux and
    /// macOS impls return false; the host orchestrator is expected to
    /// route through `RunCommand` to invoke `apt`, `dnf`, `brew`, etc.
    /// explicitly — the package-manager string-enum on `InstallSoftware`
    /// is Windows-only.
    fn supports_package_manager_install(&self) -> bool;

    /// Canonical "not supported here" RPC message for the given
    /// feature name. Lives on the trait so wording stays consistent
    /// across handlers and tests.
    fn unsupported_message(&self, feature: &str) -> String {
        format!(
            "{feature} is not supported on {os}; see the v0.4.0 cross-platform doc",
            os = self.kind().as_str()
        )
    }
}

// All platform impls compile on every host so the trait-based tests
// can exercise each one regardless of the build host's OS. Only the
// `Current` re-export is cfg-gated — that's the type the runtime
// dispatches through.
pub mod linux;
pub mod macos;
pub mod windows;
pub mod other;

#[cfg(target_os = "windows")]
pub use windows::WindowsPlatform as Current;
#[cfg(target_os = "linux")]
pub use linux::LinuxPlatform as Current;
#[cfg(target_os = "macos")]
pub use macos::MacosPlatform as Current;
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub use other::OtherPlatform as Current;

/// Return a reference to the current platform implementation. The
/// returned instance is `'static` so callers can stash the reference
/// without lifetime juggling.
pub fn current() -> &'static Current {
    static INSTANCE: std::sync::OnceLock<Current> = std::sync::OnceLock::new();
    INSTANCE.get_or_init(Current::default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake platform used by tests in this module. We need it because
    /// the trait must work for any value of `target_os` — we cannot
    /// rely on the build host happening to be Windows.
    #[derive(Debug)]
    struct FakePlatform {
        kind: PlatformKind,
        ui: bool,
        elevation: bool,
        package_manager: bool,
    }

    impl FakePlatform {
        fn new(kind: PlatformKind) -> Self {
            Self {
                kind,
                ui: false,
                elevation: false,
                package_manager: false,
            }
        }
    }

    impl Platform for FakePlatform {
        fn kind(&self) -> PlatformKind {
            self.kind
        }
        fn hostname(&self) -> String {
            "fake-host".into()
        }
        fn supports_ui_automation(&self) -> bool {
            self.ui
        }
        fn supports_system_elevation(&self) -> bool {
            self.elevation
        }
        fn supports_package_manager_install(&self) -> bool {
            self.package_manager
        }
    }

    #[test]
    fn current_returns_a_consistent_instance_across_calls() {
        // `current()` is a `OnceLock` so two calls must hand back the
        // same reference. We test pointer identity to lock the
        // invariant in case the impl ever swaps to a per-call value.
        let a = current();
        let b = current();
        assert!(std::ptr::eq(a, b), "current() must be a singleton");
    }

    #[test]
    fn current_kind_matches_target_os() {
        let expected = if cfg!(target_os = "windows") {
            PlatformKind::Windows
        } else if cfg!(target_os = "linux") {
            PlatformKind::Linux
        } else if cfg!(target_os = "macos") {
            PlatformKind::Macos
        } else {
            PlatformKind::Other
        };
        assert_eq!(current().kind(), expected);
    }

    #[test]
    fn browser_support_defaults_to_ui_support() {
        let mut with_ui = FakePlatform::new(PlatformKind::Other);
        with_ui.ui = true;
        let without_ui = FakePlatform::new(PlatformKind::Other);
        assert!(with_ui.supports_browser_automation());
        assert!(!without_ui.supports_browser_automation());
    }

    #[test]
    fn unsupported_message_includes_os_and_feature() {
        let p = FakePlatform::new(PlatformKind::Linux);
        let msg = p.unsupported_message("ui.click");
        assert!(msg.contains("ui.click"), "should mention the feature");
        assert!(msg.contains("linux"), "should mention the OS");
    }

    #[test]
    fn platform_kind_as_str_round_trips_known_values() {
        assert_eq!(PlatformKind::Windows.as_str(), "windows");
        assert_eq!(PlatformKind::Linux.as_str(), "linux");
        assert_eq!(PlatformKind::Macos.as_str(), "macos");
        assert_eq!(PlatformKind::Other.as_str(), "unknown");
    }

    #[test]
    fn current_hostname_is_non_empty() {
        // We can't assert on the value (varies across machines) but we
        // can lock that the impl never hands back an empty string.
        let host = current().hostname();
        assert!(!host.is_empty(), "hostname() must not return empty");
    }

    // ── Cross-platform trait dispatch tests ──────────────────────
    //
    // These tests exercise the Linux / macOS / Other impls from a
    // Windows build host (and vice versa). The point is to lock the
    // capability surface for every platform in one place — so a
    // future refactor can't silently flip macOS into reporting "I
    // support UI automation" without the test going red.

    fn dispatch<P: Platform>(p: &P) -> (PlatformKind, bool, bool, bool, bool) {
        (
            p.kind(),
            p.supports_ui_automation(),
            p.supports_browser_automation(),
            p.supports_system_elevation(),
            p.supports_package_manager_install(),
        )
    }

    #[test]
    fn windows_impl_has_full_capability_surface() {
        assert_eq!(
            dispatch(&super::windows::WindowsPlatform),
            (PlatformKind::Windows, true, true, true, true),
        );
    }

    #[test]
    fn linux_impl_only_supports_portable_rpcs() {
        assert_eq!(
            dispatch(&super::linux::LinuxPlatform),
            (PlatformKind::Linux, false, false, false, false),
        );
    }

    #[test]
    fn macos_impl_only_supports_portable_rpcs() {
        assert_eq!(
            dispatch(&super::macos::MacosPlatform),
            (PlatformKind::Macos, false, false, false, false),
        );
    }

    #[test]
    fn other_impl_disables_every_capability() {
        assert_eq!(
            dispatch(&super::other::OtherPlatform),
            (PlatformKind::Other, false, false, false, false),
        );
    }

    #[test]
    fn unsupported_message_naming_is_consistent_across_impls() {
        // Verify all three impls produce the canonical
        // "<feature> is not supported on <os>" wording so the host
        // can pattern-match on it.
        let cases: [(&str, &dyn Platform); 3] = [
            ("linux", &super::linux::LinuxPlatform),
            ("macos", &super::macos::MacosPlatform),
            ("unknown", &super::other::OtherPlatform),
        ];
        for (os, p) in cases {
            let msg = p.unsupported_message("ui.click");
            assert!(msg.contains("ui.click"), "{os}: missing feature");
            assert!(msg.contains(os), "{os}: missing os name; got {msg}");
        }
    }
}
