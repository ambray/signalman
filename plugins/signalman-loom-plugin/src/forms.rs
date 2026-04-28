//! P5.4 — Loom TUI form descriptors. Each Signalman scenario surfaces a
//! form analogous to `form.task.start` so operators see guided forms,
//! not freeform JSON.
//!
//! # Design rationale
//!
//! P5.1 registered six MCP verbs whose inputs are JSON objects validated by
//! the schemas in `crate::schemas`. For an LLM agent that's fine — schemas
//! are inputs to its prompt — but a human in `loom tui` should see a
//! labeled form with structured fields, not be expected to author raw JSON
//! like:
//!
//! ```ignore
//! { "id": "example/v2/network-egress",
//!   "parameters": { "vm": "endpoint-1", "verbose": true },
//!   "network_class": "isolated" }
//! ```
//!
//! P5.4 closes this gap by deriving a [`ScenarioFormDescriptor`] from a
//! scenario's `loom.signalman.describe` metadata. The TUI consumes the
//! descriptor and renders text inputs, dropdowns, toggles, and secret
//! prompts. Submission produces the same JSON the MCP tool expects, so the
//! agent and TUI paths converge on a single backend contract.
//!
//! # Loom integration surface
//!
//! Loom's `PluginHandles` exposes `mcp_tools` today (used by `lib.rs`).
//! A dedicated `forms` field is forward-looking; until Loom ships it, this
//! module surfaces descriptors via a NEW MCP tool
//! `loom.signalman.form_descriptor` (see [`crate::handlers`]). When Loom
//! adds direct form registration the [`ScenarioFormDescriptor`] type is
//! ready to plug into `PluginHandles.forms` without re-shaping JSON — the
//! [`Serialize`] derive emits the same wire format either way.
//!
//! # Status indicators
//!
//! The Loom "active work dashboard" requirement (running / passed / failed
//! / lost) maps to [`crate::state::RunStatus`] via
//! [`status_indicator_for_status`]. Each variant produces a
//! [`StatusBadge`] with a stable label, an ANSI-style colour key (the TUI
//! is responsible for the actual rendering), and a one-character glyph for
//! compact list rows.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::state::RunStatus;

// ── Form descriptor types ────────────────────────────────────────────

/// A guided form for launching one Signalman scenario. Mirrors Loom's
/// `form.task.start` shape so the TUI can render it with no special
/// casing for Signalman-vs-other-plugin forms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScenarioFormDescriptor {
    /// Stable identifier, by convention `loom.signalman.run.<scenario_id>`.
    /// Distinct from the scenario id so a single scenario can host
    /// multiple forms in the future (e.g. plan-only vs run).
    pub id: String,
    /// Short human label shown in the TUI's form picker.
    pub label: String,
    /// Multi-line description; markdown-friendly. Matches the
    /// scenario's `name` / first paragraph of `workflow_md`.
    pub description: String,
    /// MCP tool the form should invoke on submit. Always
    /// `loom.signalman.run` for scenario-launch forms.
    pub submit_tool: String,
    /// Ordered field list; the TUI renders top-to-bottom.
    pub fields: Vec<FormField>,
}

/// One field in a scenario form. The serialised JSON shape is intentionally
/// minimal so a future Loom `FormField` wire type can absorb it without a
/// breaking migration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormField {
    /// Field name as it appears in the submitted JSON. Top-level fields
    /// (`id`, `network_class`, `trace_id`) live at the document root;
    /// scenario parameters use `parameters.<name>` so the TUI can build
    /// the nested object without ambiguity.
    pub name: String,
    /// Human label for the form row.
    pub label: String,
    /// Optional helper text rendered under the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// Field kind drives the UI control selection.
    pub kind: FieldKind,
    /// True if the form cannot submit while this field is empty.
    pub required: bool,
    /// Pre-filled value (already-resolved JSON). Use `Value::Null` to
    /// represent "no default"; `${secret:NAME}` placeholders are valid
    /// defaults and the TUI must surface them as redacted with a "fill
    /// from keychain" affordance per the P4 secret-resolution roadmap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// Lightweight client-side validation. The Signalman CLI re-validates
    /// every value, so these are UX hints only — never a security boundary.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub validators: Vec<FieldValidator>,
}

/// Renderable field types. Tagged so future variants can be added without
/// breaking existing TUI consumers (unknown variant => fall back to Text).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldKind {
    /// Single-line free-text input.
    Text,
    /// Dropdown / radio over a fixed set of values.
    Select { options: Vec<SelectOption> },
    /// Numeric input with optional bounds.
    Number {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    /// Boolean toggle / checkbox.
    Boolean,
    /// Single-line input that the TUI must redact and resolve via the
    /// keychain layer (P4). Defaults to a `${secret:NAME}` placeholder.
    Secret,
}

/// One option in a [`FieldKind::Select`]. `value` is the JSON the TUI
/// emits on submit; `label` is what the operator sees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: Value,
    pub label: String,
}

/// Client-side validation hints. Every rule is also enforced server-side
/// (Signalman CLI / `crate::handlers`) so a rogue TUI cannot bypass them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "rule", rename_all = "snake_case")]
pub enum FieldValidator {
    /// Value must be at least `min` characters.
    MinLength { min: usize },
    /// Value must match this regex (Loom-side regex; the plugin doesn't
    /// validate that the pattern parses — TUI consumers tolerate a bad
    /// pattern by skipping the check).
    Pattern { regex: String },
    /// Numeric value must be in `[min, max]`.
    Range {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    /// Trace-id format: 32-char hex, dashed UUID also accepted.
    TraceId,
}

// ── Status badges ────────────────────────────────────────────────────

/// Active-work-dashboard rendering hint for one [`RunStatus`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusBadge {
    /// Stable lowercase label matching `RunStatus::label`.
    pub label: &'static str,
    /// Human-friendly display string for the dashboard cell.
    pub display: &'static str,
    /// Colour key — the TUI maps this to a theme-specific ANSI/RGB value
    /// rather than the plugin hard-coding terminal escapes.
    pub color: BadgeColor,
    /// Single-character glyph for compact rows (Nerd-Font-friendly ASCII
    /// fallbacks: keep within the printable ASCII range so headless
    /// log scrapers don't break).
    pub glyph: char,
    /// True when this status will not change without operator action.
    pub terminal: bool,
}

/// Colour palette key for the active-work dashboard. Stable string names
/// make this serialisable into the form descriptor JSON without leaking
/// terminal-specific concerns.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BadgeColor {
    /// Run hasn't produced output yet.
    Neutral,
    /// In flight; events arriving.
    Info,
    /// Finished successfully (envelope.result == "pass").
    Success,
    /// Finished with failure or error envelope.
    Failure,
    /// Subprocess died; state recovered from disk.
    Warning,
    /// In flight but no progress for too long (P5.3 reconciler).
    Muted,
}

// ── Public API ───────────────────────────────────────────────────────

/// Minimal scenario metadata the descriptor builder needs. A subset of the
/// `loom.signalman.describe` envelope so callers can build descriptors
/// without first parsing the full Signalman response.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScenarioMeta<'a> {
    /// Scenario id (e.g. `example/v2/network-egress`).
    pub id: &'a str,
    /// Optional human-friendly name (`describe.name`).
    pub name: Option<&'a str>,
    /// First paragraph of the scenario's workflow markdown, used as the
    /// form description. The plugin does not re-render markdown — the TUI
    /// is expected to handle that if it wishes.
    pub description: Option<&'a str>,
    /// Declared parameters: `(name, kind_hint, required, default)`.
    /// `kind_hint` is one of `"text"`, `"number"`, `"bool"`, `"secret"`,
    /// or any string starting with `select:opt1|opt2|...` for dropdowns.
    /// Missing or unrecognised hints default to text.
    pub parameters: Vec<ScenarioParameter<'a>>,
    /// Tags from `describe.tags` — included on the descriptor as helper
    /// context, not as form fields.
    pub tags: Vec<&'a str>,
}

/// A single declared scenario parameter. Mirrors what `signalman describe`
/// is expected to surface once the host's parameter registry lands; until
/// then callers can synthesise these from the YAML's `parameters` block.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenarioParameter<'a> {
    pub name: &'a str,
    pub label: Option<&'a str>,
    pub kind_hint: Option<&'a str>,
    pub required: bool,
    pub default: Option<Value>,
    pub help: Option<&'a str>,
}

/// Build a [`ScenarioFormDescriptor`] for one scenario.
///
/// The returned descriptor always includes:
///   * a hidden-but-required `id` field pre-filled with `scenario_id`
///   * a `network_class` select with the three Signalman-supported values
///   * a `trace_id` text field (optional) with a TraceId validator
///   * one field per declared scenario parameter, nested under `parameters.*`
pub fn descriptor_for_scenario(
    scenario_id: &str,
    scenario_meta: &ScenarioMeta<'_>,
) -> ScenarioFormDescriptor {
    let label = scenario_meta
        .name
        .map(str::to_string)
        .unwrap_or_else(|| scenario_id.to_string());
    let description = scenario_meta
        .description
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!("Run Signalman scenario `{}`.", scenario_id)
        });

    let mut fields = Vec::with_capacity(3 + scenario_meta.parameters.len());

    // Scenario id — required, pre-filled, read-only by convention.
    fields.push(FormField {
        name: "id".to_string(),
        label: "Scenario".to_string(),
        help: Some("Scenario identifier; pre-filled from the form selection.".to_string()),
        kind: FieldKind::Text,
        required: true,
        default: Some(json!(scenario_id)),
        validators: vec![FieldValidator::MinLength { min: 1 }],
    });

    // Network class — Signalman enum from schemas::run_input.
    fields.push(FormField {
        name: "network_class".to_string(),
        label: "Network class".to_string(),
        help: Some(
            "Reserved for P4 — declared, not enforced in v0.1.0.".to_string(),
        ),
        kind: FieldKind::Select {
            options: vec![
                SelectOption {
                    value: json!("isolated"),
                    label: "isolated (no network)".to_string(),
                },
                SelectOption {
                    value: json!("nat"),
                    label: "nat (host network only)".to_string(),
                },
                SelectOption {
                    value: json!("internet"),
                    label: "internet (full egress)".to_string(),
                },
            ],
        },
        required: false,
        default: Some(json!("isolated")),
        validators: vec![],
    });

    // Trace id — optional, validated to the 32-hex / dashed-UUID grammar.
    fields.push(FormField {
        name: "trace_id".to_string(),
        label: "Trace id".to_string(),
        help: Some(
            "P3.d correlation id. Leave blank to auto-generate; supply a 32-char hex or dashed UUID to share a trace across runs."
                .to_string(),
        ),
        kind: FieldKind::Text,
        required: false,
        default: None,
        validators: vec![FieldValidator::TraceId],
    });

    // Scenario parameters — nested under `parameters.<name>`.
    for p in &scenario_meta.parameters {
        fields.push(field_for_parameter(p));
    }

    ScenarioFormDescriptor {
        id: format!("loom.signalman.run.{}", scenario_id),
        label,
        description,
        submit_tool: "loom.signalman.run".to_string(),
        fields,
    }
}

/// Convert one scenario parameter into a [`FormField`]. Pure helper for
/// unit testing of kind-hint parsing.
pub(crate) fn field_for_parameter(p: &ScenarioParameter<'_>) -> FormField {
    let label = p.label.map(str::to_string).unwrap_or_else(|| p.name.to_string());
    let kind = parse_kind_hint(p.kind_hint);

    // Secret fields default to `${secret:NAME}` so the saved form value
    // never contains the actual secret material — resolution happens at
    // run-time per the host's plan.ts contract.
    let default = match (&kind, &p.default) {
        (FieldKind::Secret, None) => Some(json!(format!("${{secret:{}}}", p.name.to_uppercase()))),
        _ => p.default.clone(),
    };

    FormField {
        name: format!("parameters.{}", p.name),
        label,
        help: p.help.map(str::to_string),
        kind,
        required: p.required,
        default,
        validators: vec![],
    }
}

fn parse_kind_hint(hint: Option<&str>) -> FieldKind {
    let Some(h) = hint else {
        return FieldKind::Text;
    };
    match h {
        "text" | "string" => FieldKind::Text,
        "bool" | "boolean" => FieldKind::Boolean,
        "number" | "integer" | "int" | "float" => FieldKind::Number { min: None, max: None },
        "secret" => FieldKind::Secret,
        other if other.starts_with("select:") => {
            let raw = &other["select:".len()..];
            let options = raw
                .split('|')
                .filter(|s| !s.is_empty())
                .map(|opt| SelectOption {
                    value: json!(opt),
                    label: opt.to_string(),
                })
                .collect::<Vec<_>>();
            if options.is_empty() {
                FieldKind::Text
            } else {
                FieldKind::Select { options }
            }
        }
        _ => FieldKind::Text,
    }
}

/// Map a [`RunStatus`] to its dashboard rendering hint. Every variant is
/// covered — adding a new status to `state.rs` will trigger a compile
/// error here, which is the desired behaviour.
pub fn status_indicator_for_status(status: RunStatus) -> StatusBadge {
    match status {
        RunStatus::Started => StatusBadge {
            label: "started",
            display: "queued",
            color: BadgeColor::Neutral,
            glyph: '.',
            terminal: false,
        },
        RunStatus::Streaming => StatusBadge {
            label: "streaming",
            display: "running",
            color: BadgeColor::Info,
            glyph: '>',
            terminal: false,
        },
        RunStatus::Finished => StatusBadge {
            // Finished is split into pass / fail at envelope-decoding time;
            // the dashboard widget that owns the run row is responsible for
            // distinguishing pass-from-fail by inspecting envelope.result.
            // The badge here represents the status-only view.
            label: "finished",
            display: "passed",
            color: BadgeColor::Success,
            glyph: '+',
            terminal: true,
        },
        RunStatus::Lost => StatusBadge {
            label: "lost",
            display: "lost",
            color: BadgeColor::Warning,
            glyph: '?',
            terminal: true,
        },
        RunStatus::Stale => StatusBadge {
            label: "stale",
            display: "stale",
            color: BadgeColor::Muted,
            glyph: '~',
            terminal: true,
        },
    }
}

/// Convenience helper for rendering a failed terminal run. When the
/// envelope's `result` field reads `fail` or `error`, the active-work
/// dashboard should swap the [`RunStatus::Finished`] badge for this one
/// without re-walking the state machine.
pub fn failed_finished_badge() -> StatusBadge {
    StatusBadge {
        label: "finished",
        display: "failed",
        color: BadgeColor::Failure,
        glyph: 'x',
        terminal: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── descriptor_for_scenario ──────────────────────────────────────

    #[test]
    fn descriptor_for_scenario_with_no_parameters_emits_three_top_level_fields() {
        let d = descriptor_for_scenario(
            "example/v2/network-egress",
            &ScenarioMeta {
                id: "example/v2/network-egress",
                ..Default::default()
            },
        );
        assert_eq!(d.id, "loom.signalman.run.example/v2/network-egress");
        assert_eq!(d.submit_tool, "loom.signalman.run");
        let names: Vec<&str> = d.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "network_class", "trace_id"]);
    }

    #[test]
    fn descriptor_id_field_is_required_and_prefilled() {
        let d = descriptor_for_scenario("scn", &ScenarioMeta { id: "scn", ..Default::default() });
        let id_field = d.fields.iter().find(|f| f.name == "id").unwrap();
        assert!(id_field.required, "id field must be required");
        assert_eq!(id_field.default.as_ref().unwrap().as_str(), Some("scn"));
    }

    #[test]
    fn descriptor_network_class_select_lists_signalman_enum_values() {
        let d = descriptor_for_scenario("scn", &ScenarioMeta { id: "scn", ..Default::default() });
        let nc = d.fields.iter().find(|f| f.name == "network_class").unwrap();
        match &nc.kind {
            FieldKind::Select { options } => {
                let vals: Vec<&str> = options
                    .iter()
                    .filter_map(|o| o.value.as_str())
                    .collect();
                assert_eq!(vals, vec!["isolated", "nat", "internet"]);
            }
            other => panic!("network_class must be a Select, got {:?}", other),
        }
    }

    #[test]
    fn descriptor_trace_id_is_optional_with_traceid_validator() {
        let d = descriptor_for_scenario("scn", &ScenarioMeta { id: "scn", ..Default::default() });
        let t = d.fields.iter().find(|f| f.name == "trace_id").unwrap();
        assert!(!t.required);
        assert!(t.validators.iter().any(|v| matches!(v, FieldValidator::TraceId)));
    }

    #[test]
    fn descriptor_with_all_optional_fields_renders_full_form() {
        let params = vec![
            ScenarioParameter {
                name: "vm",
                label: Some("Target VM"),
                kind_hint: Some("text"),
                required: true,
                default: Some(json!("endpoint-1")),
                help: Some("VM template name"),
            },
            ScenarioParameter {
                name: "verbose",
                label: None,
                kind_hint: Some("bool"),
                required: false,
                default: Some(json!(false)),
                help: None,
            },
            ScenarioParameter {
                name: "count",
                label: Some("Iterations"),
                kind_hint: Some("number"),
                required: false,
                default: Some(json!(3)),
                help: None,
            },
            ScenarioParameter {
                name: "tier",
                label: None,
                kind_hint: Some("select:gold|silver|bronze"),
                required: true,
                default: None,
                help: None,
            },
            ScenarioParameter {
                name: "api_key",
                label: Some("API key"),
                kind_hint: Some("secret"),
                required: true,
                default: None,
                help: Some("Resolved from the keychain at run time."),
            },
        ];
        let d = descriptor_for_scenario(
            "example/v2/full",
            &ScenarioMeta {
                id: "example/v2/full",
                name: Some("Example v2 — full sweep"),
                description: Some("Runs the full example v2 assertion battery."),
                parameters: params,
                tags: vec!["smoke", "example"],
            },
        );

        assert_eq!(d.label, "Example v2 — full sweep");
        assert_eq!(d.description, "Runs the full example v2 assertion battery.");

        let names: Vec<&str> = d.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "id",
                "network_class",
                "trace_id",
                "parameters.vm",
                "parameters.verbose",
                "parameters.count",
                "parameters.tier",
                "parameters.api_key",
            ]
        );

        // Spot-check kinds.
        let vm = d.fields.iter().find(|f| f.name == "parameters.vm").unwrap();
        assert!(matches!(vm.kind, FieldKind::Text));
        assert!(vm.required);
        assert_eq!(vm.default.as_ref().unwrap().as_str(), Some("endpoint-1"));
        assert_eq!(vm.label, "Target VM");
        assert_eq!(vm.help.as_deref(), Some("VM template name"));

        let verbose = d.fields.iter().find(|f| f.name == "parameters.verbose").unwrap();
        assert!(matches!(verbose.kind, FieldKind::Boolean));
        assert_eq!(verbose.label, "verbose"); // falls back to name when label is None

        let count = d.fields.iter().find(|f| f.name == "parameters.count").unwrap();
        assert!(matches!(count.kind, FieldKind::Number { .. }));

        let tier = d.fields.iter().find(|f| f.name == "parameters.tier").unwrap();
        match &tier.kind {
            FieldKind::Select { options } => {
                let labels: Vec<&str> = options.iter().map(|o| o.label.as_str()).collect();
                assert_eq!(labels, vec!["gold", "silver", "bronze"]);
            }
            other => panic!("tier must be Select, got {:?}", other),
        }

        let api_key = d.fields.iter().find(|f| f.name == "parameters.api_key").unwrap();
        assert!(matches!(api_key.kind, FieldKind::Secret));
        // No default supplied => synthesise the ${secret:NAME} placeholder.
        assert_eq!(
            api_key.default.as_ref().unwrap().as_str(),
            Some("${secret:API_KEY}")
        );
    }

    #[test]
    fn descriptor_required_only_form_omits_optional_field_metadata() {
        // Required-fields-only baseline: just the id; no parameters; no
        // human metadata. The TUI should still render a usable form.
        let d = descriptor_for_scenario("scn", &ScenarioMeta { id: "scn", ..Default::default() });
        assert_eq!(d.label, "scn"); // falls back to id
        assert!(d.description.contains("scn"));
        // Three baseline fields, in stable order.
        assert_eq!(d.fields.len(), 3);
        assert_eq!(d.fields[0].name, "id");
        assert_eq!(d.fields[1].name, "network_class");
        assert_eq!(d.fields[2].name, "trace_id");
    }

    #[test]
    fn parameter_with_secret_kind_and_existing_default_keeps_default() {
        // If the scenario author hand-wrote a `${secret:CUSTOM}` default,
        // honour it rather than rewriting it to `${secret:<NAME>}`.
        let p = ScenarioParameter {
            name: "api_key",
            label: None,
            kind_hint: Some("secret"),
            required: true,
            default: Some(json!("${secret:EXAMPLE_API_KEY}")),
            help: None,
        };
        let f = field_for_parameter(&p);
        assert!(matches!(f.kind, FieldKind::Secret));
        assert_eq!(
            f.default.as_ref().unwrap().as_str(),
            Some("${secret:EXAMPLE_API_KEY}"),
        );
    }

    #[test]
    fn parse_kind_hint_falls_back_to_text_for_unknown_or_empty() {
        assert!(matches!(parse_kind_hint(None), FieldKind::Text));
        assert!(matches!(parse_kind_hint(Some("")), FieldKind::Text));
        assert!(matches!(parse_kind_hint(Some("nonsense")), FieldKind::Text));
        // select: with no values is still a Text fallback (don't render an
        // empty dropdown).
        assert!(matches!(parse_kind_hint(Some("select:")), FieldKind::Text));
    }

    #[test]
    fn parse_kind_hint_recognises_select_options() {
        match parse_kind_hint(Some("select:a|b|c")) {
            FieldKind::Select { options } => {
                assert_eq!(options.len(), 3);
                let vals: Vec<&str> = options
                    .iter()
                    .filter_map(|o| o.value.as_str())
                    .collect();
                assert_eq!(vals, vec!["a", "b", "c"]);
            }
            other => panic!("expected Select, got {:?}", other),
        }
    }

    #[test]
    fn descriptor_serialises_with_stable_kind_tags() {
        // The wire format must use the discriminator `kind` so a future
        // Loom FormField type can deserialise it without a custom parser.
        let d = descriptor_for_scenario("scn", &ScenarioMeta { id: "scn", ..Default::default() });
        let v = serde_json::to_value(&d).unwrap();
        let fields = v.get("fields").and_then(Value::as_array).unwrap();
        // network_class is a Select; expect kind: "select" and options[].
        let nc = fields.iter().find(|f| f["name"] == "network_class").unwrap();
        assert_eq!(nc["kind"]["kind"], "select");
        assert!(nc["kind"]["options"].is_array());
        // trace_id is Text; expect kind: "text" with no extra fields.
        let t = fields.iter().find(|f| f["name"] == "trace_id").unwrap();
        assert_eq!(t["kind"]["kind"], "text");
    }

    // ── status_indicator_for_status — one assertion per RunStatus ────

    #[test]
    fn status_indicator_for_started() {
        let b = status_indicator_for_status(RunStatus::Started);
        assert_eq!(b.label, "started");
        assert_eq!(b.color, BadgeColor::Neutral);
        assert!(!b.terminal);
    }

    #[test]
    fn status_indicator_for_streaming_signals_running() {
        let b = status_indicator_for_status(RunStatus::Streaming);
        assert_eq!(b.label, "streaming");
        assert_eq!(b.display, "running");
        assert_eq!(b.color, BadgeColor::Info);
        assert!(!b.terminal);
    }

    #[test]
    fn status_indicator_for_finished_signals_passed() {
        let b = status_indicator_for_status(RunStatus::Finished);
        assert_eq!(b.label, "finished");
        assert_eq!(b.display, "passed");
        assert_eq!(b.color, BadgeColor::Success);
        assert!(b.terminal);
    }

    #[test]
    fn status_indicator_for_lost() {
        let b = status_indicator_for_status(RunStatus::Lost);
        assert_eq!(b.label, "lost");
        assert_eq!(b.color, BadgeColor::Warning);
        assert!(b.terminal);
    }

    #[test]
    fn status_indicator_for_stale() {
        let b = status_indicator_for_status(RunStatus::Stale);
        assert_eq!(b.label, "stale");
        assert_eq!(b.color, BadgeColor::Muted);
        assert!(b.terminal);
    }

    #[test]
    fn failed_finished_badge_colour_is_failure_not_success() {
        let b = failed_finished_badge();
        assert_eq!(b.label, "finished");
        assert_eq!(b.display, "failed");
        assert_eq!(b.color, BadgeColor::Failure);
        assert!(b.terminal);
    }

    #[test]
    fn status_indicator_glyphs_are_distinct_printable_ascii() {
        // Compact dashboard rows rely on per-status glyphs; if two
        // statuses ever collapse to the same glyph the human can't tell
        // them apart at a glance.
        let glyphs = [
            status_indicator_for_status(RunStatus::Started).glyph,
            status_indicator_for_status(RunStatus::Streaming).glyph,
            status_indicator_for_status(RunStatus::Finished).glyph,
            status_indicator_for_status(RunStatus::Lost).glyph,
            status_indicator_for_status(RunStatus::Stale).glyph,
            failed_finished_badge().glyph,
        ];
        for g in glyphs {
            assert!(g.is_ascii_graphic(), "glyph '{}' must be printable ASCII", g);
        }
        let mut seen = std::collections::HashSet::new();
        for g in glyphs {
            assert!(seen.insert(g), "duplicate glyph '{}'", g);
        }
    }
}
