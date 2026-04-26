//! Signalman Loom Plugin (P5.1)
//!
//! Registers `loom.signalman.{list,describe,plan,run,status,record}` MCP
//! tools through Loom's [`PluginCapability::RegisterMcpTools`] capability.
//! Each handler shells out to the Signalman CLI and returns the structured
//! JSON envelope unmodified.
//!
//! # P5.1 scope
//! Pass-through plugin manifest + tool registration + subprocess invocation.
//! Run-handle persistence (P5.2 — Loom [`TaskOwnership`]-shaped state),
//! [`EventBus`] streaming (P5.3), descriptor-backed TUI forms (P5.4), and
//! Loom directives (P5.5) ship in subsequent deliverables.
//!
//! # Subprocess discovery
//! The plugin invokes the binary named by `SIGNALMAN_CMD` (space-separated
//! command line allowed for `node host/dist/cli.js` style invocations) and
//! falls back to `signalman` on PATH. Programs are validated against the
//! [`PluginCapability::RunSubprocess`] allowlist (`signalman` / `node`)
//! before spawn.

use std::sync::Arc;

use loom_core::LoomResult;
use loom_plugin_api::{
    LOOM_PLUGIN_API_VERSION, PluginCapability, PluginContext, PluginHandles, PluginTier,
    TrustedPlugin, TrustedPluginEntry, TrustedPluginManifest,
};

pub mod handlers;
pub mod schemas;
pub mod state;
pub mod subprocess;

/// Stable plugin id used by Loom's manifest registry. Do NOT rename without
/// a coordinated Loom config migration; existing user installs key off this.
pub const PLUGIN_ID: &str = "signalman-loom-plugin";

/// Plugin crate version. Reported by [`SignalmanPlugin::manifest`].
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Allowlisted subprocess executable names. Defense-in-depth alongside Loom's
/// plugin-host policy enforcement of [`PluginCapability::RunSubprocess`].
pub const SUBPROCESS_ALLOWLIST: &[&str] = &["signalman", "node"];

const CAPABILITIES: &[PluginCapability] = &[
    PluginCapability::RegisterMcpTools,
    PluginCapability::RunSubprocess {
        allowlist: SUBPROCESS_ALLOWLIST,
    },
];

/// The Signalman trusted-plugin entry point. Loom instantiates exactly one of
/// these per process via the [`inventory`] registry.
pub struct SignalmanPlugin;

impl SignalmanPlugin {
    pub const fn new() -> Self {
        Self
    }
}

impl Default for SignalmanPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl TrustedPlugin for SignalmanPlugin {
    fn manifest(&self) -> TrustedPluginManifest {
        TrustedPluginManifest {
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            tier: PluginTier::Free,
            requires_loom_api: LOOM_PLUGIN_API_VERSION,
            capabilities: CAPABILITIES,
        }
    }

    fn initialize(&self, _cx: &PluginContext) -> LoomResult<PluginHandles> {
        let mut handles = PluginHandles::default();
        handles.mcp_tools = handlers::all_tool_registrations();
        Ok(handles)
    }
}

inventory::submit! {
    TrustedPluginEntry::new(|| Arc::new(SignalmanPlugin::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_id_and_version_are_stable() {
        let plugin = SignalmanPlugin::new();
        let m = plugin.manifest();
        assert_eq!(m.id, "signalman-loom-plugin");
        assert_eq!(m.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(m.tier, PluginTier::Free);
        assert_eq!(m.requires_loom_api, LOOM_PLUGIN_API_VERSION);
    }

    #[test]
    fn manifest_declares_required_capabilities() {
        let plugin = SignalmanPlugin::new();
        let m = plugin.manifest();
        assert!(
            m.capabilities
                .iter()
                .any(|c| matches!(c, PluginCapability::RegisterMcpTools)),
            "RegisterMcpTools must be declared",
        );
        let has_subprocess = m.capabilities.iter().any(|c| match c {
            PluginCapability::RunSubprocess { allowlist } => {
                allowlist.contains(&"signalman") && allowlist.contains(&"node")
            }
            _ => false,
        });
        assert!(has_subprocess, "RunSubprocess allowlist must include signalman + node");
    }

    #[test]
    fn registers_six_mcp_tools_with_loom_namespace() {
        let regs = handlers::all_tool_registrations();
        assert_eq!(regs.len(), 6, "exactly six verbs registered");
        let names: Vec<&str> = regs.iter().map(|r| r.name.as_str()).collect();
        for expected in &[
            "loom.signalman.list",
            "loom.signalman.describe",
            "loom.signalman.plan",
            "loom.signalman.run",
            "loom.signalman.status",
            "loom.signalman.record",
        ] {
            assert!(
                names.contains(expected),
                "missing registration for {}",
                expected,
            );
        }
    }
}
