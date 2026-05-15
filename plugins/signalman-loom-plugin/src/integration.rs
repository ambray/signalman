//! Loom directive + agent-guidance integration (P5.5).
//!
//! Implements [`AgentIntegrationProvider`] so that when an operator
//! enables the Signalman plugin in Loom, every agent target (Claude
//! Code, Codex, Cursor, …) gets a stable rule supplement injected
//! into its agent-guidance file (`CLAUDE.md`, `AGENTS.md`, or
//! `.cursor/rules/loom.mdc`). The supplement tells the agent:
//!
//!   1. Use `loom.signalman.list` to discover scenarios.
//!   2. Use `loom.signalman.run` for VM-based validation.
//!   3. Use `loom.signalman.status` to poll progress.
//!   4. Subscribe to `signalman.run.*` events on the EventBus for live
//!      step + assertion results.
//!
//! ## Why this exists (replaces the "approve a scenarios directory" prompt)
//!
//! Before Loom integration, Signalman's MCP server emitted a
//! capability prompt the first time an agent looked at a `.signalman/`
//! directory ("approve this scenarios directory once?"). That worked
//! for the standalone CLI but doesn't compose with Loom's permission
//! model — Loom owns the once-per-plugin approval at install time, so
//! the per-directory prompt becomes redundant noise.
//!
//! With this integration, the operator approves the Signalman plugin
//! ONCE through Loom's standard plugin install flow (which renders
//! this provider's bundle). After that, every agent loop sees the
//! `loom.signalman.*` tool surface in their guidance file without a
//! second approval gate.
//!
//! ## What we render
//!
//! Three rule supplements (one per [`RuleFileKind`]) carry the same
//! marker (`io.signalman.loom-plugin`) and the same human-readable
//! content tailored to the file format. Loom's
//! `IntegrationManager::sync_targets` is responsible for de-duping
//! against existing markers and surfacing drift via the
//! [`DirectiveStatusReport`] / [`DirectiveApplyReport`] flow.
//!
//! ## What we DON'T do (yet)
//!
//! - **No hooks.** Future agent-guidance work may add a
//!   `PreToolUse` hook that auto-rejects `Bash(sudo*)` calls when the
//!   agent should be using `loom.signalman.run` instead. v0.1.0 keeps
//!   the surface to rule supplements — the hook surface is an
//!   intentional follow-up so we have time to land the policy
//!   correctly without coupling to v0.1.0 ship pressure.
//! - **No `ManagedFile` body files.** All guidance is inline in the
//!   rule supplement; there's no `.loom/signalman/` payload directory.

use loom_core::LoomResult;
use loom_plugin_api::{
    AgentIntegrationProvider, AgentTarget, IntegrationBundle, IntegrationDescriptor, RuleFileKind,
    RuleSupplement,
};

/// Marker string written into every rule-supplement block. Loom uses
/// this as the dedupe key when reconciling drift between the file on
/// disk and the supplement the plugin wants to inject. Keep stable —
/// changing it forces every operator's agent-guidance file to grow a
/// duplicate block.
pub const SUPPLEMENT_MARKER: &str = "io.signalman.loom-plugin";

/// The integration provider Loom registers via
/// [`PluginHandles::agent_integration_providers`]. v0.1.0 produces the
/// same content for every [`AgentTarget`]; only the rule-file destination
/// varies. v0.2.0+ may tailor content to the agent (e.g. Claude Code
/// gets a tools list, Codex gets the JSON schema, Cursor gets a
/// shorter summary).
#[derive(Debug, Default, Clone, Copy)]
pub struct SignalmanIntegrationProvider;

impl SignalmanIntegrationProvider {
    pub const fn new() -> Self {
        Self
    }
}

impl AgentIntegrationProvider for SignalmanIntegrationProvider {
    fn id(&self) -> &'static str {
        crate::PLUGIN_ID
    }

    fn describe(&self) -> IntegrationDescriptor {
        IntegrationDescriptor {
            name: "Signalman".to_string(),
            description:
                "VM-based scenario validation: list, plan, run, and stream results from the \
                 Signalman runner via loom.signalman.* MCP tools."
                    .to_string(),
            // We don't restrict by agent — any agent that consumes
            // CLAUDE.md / AGENTS.md / .cursor/rules can use the
            // tools. Empty `supported_agents` means "applicable to
            // any agent" by Loom's manager convention.
            supported_agents: Vec::new(),
        }
    }

    fn render(&self, _target: &AgentTarget) -> LoomResult<IntegrationBundle> {
        Ok(IntegrationBundle {
            files: Vec::new(),
            rule_supplements: vec![
                RuleSupplement {
                    file: RuleFileKind::ClaudeMd,
                    marker: SUPPLEMENT_MARKER.to_string(),
                    content: claude_md_content(),
                },
                RuleSupplement {
                    file: RuleFileKind::AgentsMd,
                    marker: SUPPLEMENT_MARKER.to_string(),
                    content: agents_md_content(),
                },
                RuleSupplement {
                    file: RuleFileKind::CursorRules,
                    marker: SUPPLEMENT_MARKER.to_string(),
                    content: cursor_rules_content(),
                },
            ],
            hooks: Vec::new(),
        })
    }
}

/// CLAUDE.md content — Markdown, agent-narrative voice. Claude Code
/// reads this on every session start so we keep it short and
/// example-heavy rather than reference-style.
fn claude_md_content() -> String {
    r#"## Signalman — VM-based validation

When you need to validate behavior inside a guest VM (Windows scenario
runs, kernel debug, software-install verification, network-restriction
checks), use the `loom.signalman.*` MCP tools rather than ad-hoc
`Bash(...)` invocations against the host:

- `loom.signalman.list` — list available scenarios.
- `loom.signalman.describe { scenario }` — show inputs + assertions.
- `loom.signalman.plan { scenario, parameters? }` — dry-run preview.
- `loom.signalman.run { scenario, parameters?, requested_network_class? }` — execute.
- `loom.signalman.status { run_id }` — poll progress (or subscribe to
  `signalman.run.*` events on the EventBus for live updates).
- `loom.signalman.record { run_id }` — fetch the full run envelope.

Run state is persisted in Loom-managed task state, so a scenario you
kicked off survives host restarts and shows up in `loom tui` even if
you reconnect from a different session.

The standalone Signalman MCP server still exists for direct CLI use,
but inside Loom you should always prefer the `loom.signalman.*`
namespace — it routes through the plugin's persistence and event
streaming layers automatically.
"#
    .to_string()
}

/// AGENTS.md content — same surface, slightly more terse, no Markdown
/// callouts (some Codex variants render plain text only).
fn agents_md_content() -> String {
    r#"Signalman (VM-based validation)

For tasks that need to run inside a guest VM, prefer the
loom.signalman.* MCP tools over host-side shell commands:

  loom.signalman.list                 -> list scenarios
  loom.signalman.describe { scenario }-> inputs + assertions
  loom.signalman.plan { scenario }    -> dry-run preview
  loom.signalman.run { scenario }     -> execute
  loom.signalman.status { run_id }    -> poll progress
  loom.signalman.record { run_id }    -> full envelope

Run state survives host restart (Loom-managed task state). Subscribe
to `signalman.run.*` events for live step and assertion results.
"#
    .to_string()
}

/// .cursor/rules/loom.mdc content — Cursor's rules-file format is
/// Markdown with optional YAML frontmatter; we emit plain Markdown
/// to keep the bundle format-agnostic.
fn cursor_rules_content() -> String {
    r#"## Signalman

Use the loom.signalman.* tools for any VM-based validation:
list, describe, plan, run, status, record. State is persisted by
Loom; subscribe to `signalman.run.*` events on the EventBus for
live progress.
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use loom_plugin_api::{AgentId, IntegrationScope};
    use std::path::PathBuf;

    fn target() -> AgentTarget {
        AgentTarget {
            agent: AgentId::ClaudeCode,
            scope: IntegrationScope::Project,
            root_dir: PathBuf::from("/tmp/repo"),
        }
    }

    #[test]
    fn provider_id_matches_plugin_id() {
        let provider = SignalmanIntegrationProvider::new();
        assert_eq!(provider.id(), crate::PLUGIN_ID);
    }

    #[test]
    fn descriptor_has_signalman_name() {
        let provider = SignalmanIntegrationProvider::new();
        let desc = provider.describe();
        assert_eq!(desc.name, "Signalman");
        assert!(
            desc.description.to_lowercase().contains("signalman"),
            "description should mention signalman"
        );
    }

    #[test]
    fn descriptor_supports_all_agents_by_omission() {
        // Empty `supported_agents` means "any agent" by Loom convention.
        let provider = SignalmanIntegrationProvider::new();
        let desc = provider.describe();
        assert!(
            desc.supported_agents.is_empty(),
            "supported_agents should be empty (= any agent)",
        );
    }

    #[test]
    fn bundle_has_three_rule_supplements() {
        let provider = SignalmanIntegrationProvider::new();
        let bundle = provider.render(&target()).expect("render");
        assert_eq!(
            bundle.rule_supplements.len(),
            3,
            "one supplement per RuleFileKind",
        );
        let kinds: Vec<RuleFileKind> = bundle.rule_supplements.iter().map(|s| s.file).collect();
        assert!(kinds.contains(&RuleFileKind::ClaudeMd));
        assert!(kinds.contains(&RuleFileKind::AgentsMd));
        assert!(kinds.contains(&RuleFileKind::CursorRules));
    }

    #[test]
    fn bundle_supplements_share_stable_marker() {
        let provider = SignalmanIntegrationProvider::new();
        let bundle = provider.render(&target()).expect("render");
        for sup in &bundle.rule_supplements {
            assert_eq!(sup.marker, SUPPLEMENT_MARKER);
        }
    }

    #[test]
    fn bundle_has_no_hooks_or_files_in_v0_1_0() {
        // v0.1.0 surface: rule supplements only. Hooks + ManagedFiles
        // are intentional follow-ups.
        let provider = SignalmanIntegrationProvider::new();
        let bundle = provider.render(&target()).expect("render");
        assert!(bundle.hooks.is_empty(), "no hooks in v0.1.0");
        assert!(bundle.files.is_empty(), "no managed files in v0.1.0");
    }

    #[test]
    fn supplement_contents_mention_loom_signalman_namespace() {
        // Regression guard: if someone refactors the content and drops
        // the tool-namespace prefix, the agent guidance breaks.
        let provider = SignalmanIntegrationProvider::new();
        let bundle = provider.render(&target()).expect("render");
        for sup in &bundle.rule_supplements {
            assert!(
                sup.content.contains("loom.signalman."),
                "{:?} supplement must reference loom.signalman.* namespace",
                sup.file,
            );
        }
    }

    #[test]
    fn render_is_deterministic() {
        // Two calls with the same target produce byte-identical
        // bundles. This matters because Loom fingerprints content for
        // drift detection — non-determinism would manifest as
        // perpetual `Drifted` state.
        let provider = SignalmanIntegrationProvider::new();
        let a = provider.render(&target()).expect("render a");
        let b = provider.render(&target()).expect("render b");
        assert_eq!(a, b);
    }

    #[test]
    fn render_is_target_independent_in_v0_1_0() {
        // v0.1.0 emits the same bundle for every agent. v0.2.0 may
        // diverge per agent; this test pins the current contract.
        let provider = SignalmanIntegrationProvider::new();
        let claude = AgentTarget {
            agent: AgentId::ClaudeCode,
            scope: IntegrationScope::Project,
            root_dir: PathBuf::from("/tmp/c"),
        };
        let cursor = AgentTarget {
            agent: AgentId::Cursor,
            scope: IntegrationScope::Project,
            root_dir: PathBuf::from("/tmp/c"),
        };
        let a = provider.render(&claude).expect("render claude");
        let b = provider.render(&cursor).expect("render cursor");
        assert_eq!(a, b);
    }
}
