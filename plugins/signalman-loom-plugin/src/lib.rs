//! Signalman Loom Plugin (P5.1 + P5.2 + P5.3 + P5.4 + P5.5)
//!
//! Registers `loom.signalman.{list,describe,plan,run,status,record,form_descriptor}`
//! MCP tools through Loom's [`PluginCapability::RegisterMcpTools`] capability.
//! Each handler shells out to the Signalman CLI and returns the structured
//! JSON envelope unmodified.
//!
//! # Phase scope
//! - **P5.1** — Pass-through plugin manifest + tool registration + subprocess.
//! - **P5.2** — Run-handle persistence in `<data_dir>/runs/<run_id>.json`,
//!   modelled on Loom's [`TaskOwnership`] state machine. Closes audit C1.
//! - **P5.3** — Live event streaming. Run + step + assertion progress
//!   emitted onto Loom's `EventBus` via [`crate::events::EventEmitter`].
//!   Closes audit C2 + C10 (trace-id propagation via
//!   `TelemetryEvent.labels["signalman-trace-id"]`).
//! - **P5.4** — Descriptor-backed TUI forms via [`crate::forms`].
//! - **P5.5** — Loom directives + agent-guidance defaults via
//!   [`crate::integration::SignalmanIntegrationProvider`]. The provider
//!   is registered in [`PluginHandles::agent_integration_providers`] so
//!   every Loom-managed agent target picks up `loom.signalman.*`
//!   guidance from a single plugin approval — replaces the old
//!   "approve a scenarios directory" capability prompt.
//!
//! # Subprocess discovery
//! The plugin invokes the binary named by `SIGNALMAN_CMD` (space-separated
//! command line allowed for `node host/dist/cli.js` style invocations) and
//! falls back to `signalman` on PATH. Programs are validated against the
//! [`PluginCapability::RunSubprocess`] allowlist (`signalman` / `node`)
//! before spawn.
//!
//! # P5.3 EventBus integration
//! See [`crate::events`] for the full event taxonomy. The plugin owns its
//! own [`EventEmitter`] abstraction over Loom's bus so the per-handler
//! emission call sites stay decoupled from whichever shape the Loom API
//! ultimately ships. When `PluginContext` exposes an EventBus accessor,
//! [`crate::handlers::emitter_for`] is the single place to wire it in.

use std::sync::Arc;

use loom_core::LoomResult;
use loom_plugin_api::{
    PluginCapability, PluginContext, PluginHandles, PluginTier, TrustedPlugin, TrustedPluginEntry,
    TrustedPluginManifest, LOOM_PLUGIN_API_VERSION,
};

pub mod events;
pub mod forms;
pub mod handlers;
pub mod integration;
pub mod schemas;
pub mod state;
pub mod subprocess;
pub mod trace;

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
        // P5.3 wiring point: when `loom_plugin_api::PluginContext` exposes
        // an EventBus accessor (e.g. `_cx.event_bus()`), capture it here
        // and stash it on plugin state so handler call sites can build a
        // real-bus-backed `EventEmitter` instead of the no-op fallback
        // returned by `handlers::emitter_for`. The plugin already routes
        // every progress event through that abstraction, so the wiring
        // is one localised change.
        //
        // Until then, every handler emits into a no-op sink — the rest
        // of the P5.3 surface (taxonomy, label propagation, per-event
        // promotion) is in place and exercised by unit tests via the
        // mock sink in `crate::events::MockEventSink`.
        let handles = PluginHandles {
            mcp_tools: handlers::all_tool_registrations(),
            // P5.5: register the directive + agent-guidance provider so
            // Loom's IntegrationManager renders our rule supplements
            // into every agent target (CLAUDE.md, AGENTS.md,
            // .cursor/rules) on plugin install.
            agent_integration_providers: vec![Arc::new(
                integration::SignalmanIntegrationProvider::new(),
            )],
            ..PluginHandles::default()
        };
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
        assert!(
            has_subprocess,
            "RunSubprocess allowlist must include signalman + node"
        );
    }

    #[test]
    fn integration_provider_id_is_stable_for_loom_dedupe() {
        // P5.5: the SignalmanIntegrationProvider that `initialize`
        // registers MUST have an id that matches PLUGIN_ID, otherwise
        // Loom's IntegrationManager treats every install as a new
        // provider rather than reconciling drift against the prior
        // bundle. Regression guard.
        //
        // We test the provider directly rather than going through
        // `SignalmanPlugin::initialize`, because `PluginContext` has
        // trait-object fields that require a real Loom runtime to
        // construct — out of scope for this unit test.
        use loom_plugin_api::AgentIntegrationProvider;
        let provider = integration::SignalmanIntegrationProvider::new();
        assert_eq!(provider.id(), PLUGIN_ID);
    }

    #[test]
    fn registers_seven_mcp_tools_with_loom_namespace() {
        // P5.4 added `loom.signalman.form_descriptor` so the TUI can
        // request a guided form for a scenario without learning the
        // Signalman parameter format. When Loom adds direct
        // `PluginHandles.forms` registration we may retire this verb,
        // but keeping it as an MCP tool also lets agents introspect
        // forms — useful for "ask the human" tool plans.
        let regs = handlers::all_tool_registrations();
        assert_eq!(regs.len(), 7, "exactly seven verbs registered");
        let names: Vec<&str> = regs.iter().map(|r| r.name.as_str()).collect();
        for expected in &[
            "loom.signalman.list",
            "loom.signalman.describe",
            "loom.signalman.plan",
            "loom.signalman.run",
            "loom.signalman.status",
            "loom.signalman.record",
            "loom.signalman.form_descriptor",
        ] {
            assert!(
                names.contains(expected),
                "missing registration for {}",
                expected,
            );
        }
    }
}
