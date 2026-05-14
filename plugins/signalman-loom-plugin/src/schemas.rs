//! Hand-ported JSON schemas for the six `loom.signalman.*` MCP tools.
//!
//! These mirror the Zod schemas in `host/src/server.ts` (verb registrations
//! at lines 251-320 as of 2026-04). The duplication is acknowledged technical
//! debt for v0.1.0; a build-time generator that emits these from the Zod
//! source is tracked under P6 packaging work.
//!
//! Schema invariants:
//!   * Inputs use `additionalProperties: false` so unknown fields fail
//!     fast at the Loom MCP layer rather than silently passing through to
//!     the Signalman CLI.
//!   * Outputs are intentionally permissive (`additionalProperties: true`)
//!     because the result envelope contains forward-compatible fields
//!     that future Signalman versions may add (per ROADMAP §"Hermetic
//!     envelope (staged)").

use serde_json::{Value, json};

// ── list ──────────────────────────────────────────────────────────

pub fn list_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tag": { "type": "string", "description": "Filter scenarios by tag." },
            "pattern": { "type": "string", "description": "Glob pattern over scenario id (e.g. 'mygroup/**')." }
        },
        "additionalProperties": false
    })
}

pub fn list_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "scenarios": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "name": { "type": "string" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "scenario_hash": { "type": "string" },
                        "last_run": {}
                    }
                }
            }
        },
        "required": ["scenarios"]
    })
}

// ── describe ──────────────────────────────────────────────────────

pub fn describe_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Scenario id (e.g. 'mygroup/v2/scenario-a')." }
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

pub fn describe_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "tags": { "type": "array", "items": { "type": "string" } },
            "setup": {},
            "assertions": {},
            "workflow_md": { "type": "string" },
            "scenario_hash": { "type": "string" }
        }
    })
}

// ── plan ──────────────────────────────────────────────────────────

pub fn plan_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Scenario id." },
            "parameters": {
                "type": "object",
                "description": "Caller-supplied parameter overrides.",
                "additionalProperties": true
            }
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

pub fn plan_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "steps": { "type": "array" },
            "affected_resources": { "type": "array" },
            "scenario_hash": { "type": "string" }
        }
    })
}

// ── run ───────────────────────────────────────────────────────────

pub fn run_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Scenario id." },
            "parameters": {
                "type": "object",
                "description": "Caller-supplied parameter overrides.",
                "additionalProperties": true
            },
            "network_class": {
                "type": "string",
                "enum": ["isolated", "nat", "internet"],
                "description": "Reserved for P4 — declared, not enforced in v0.1.0."
            },
            "trace_id": {
                "type": "string",
                "description":
                    "P3.d: optional 32-char hex (or dashed UUID) correlation root. Loom can supply this so an agent's view, the Loom task state, and Signalman gRPC log streams correlate by `grep $TRACE_ID`. When omitted, the plugin generates a fresh trace-id and surfaces it via RunState.trace_id."
            }
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

pub fn run_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": { "type": "string" },
            "started_at": { "type": "string" },
            "scenario_hash": { "type": "string" },
            // v0.3.0-4 — promoted from envelope when the run is
            // immediate-terminal. Workflow nodes gate on this for
            // cache-keying without descending into envelope JSON.
            // Absent when no envelope or no identity fields are
            // populated.
            "hermetic_identity": hermetic_identity_schema()
        },
        "required": ["run_id"]
    })
}

/// v0.3.0-4 — shape of the hermetic-identity object promoted to
/// top-level on `run` and `status` responses. Mirrors the
/// `ScenarioResult` identity-field subset (v0.3.0-3) structurally;
/// see `plugins/signalman-loom-plugin/src/hermetic_identity.rs` for
/// the locked contract.
fn hermetic_identity_schema() -> Value {
    json!({
        "type": "object",
        "description":
            "Hermetic identity fields (v0.3.0-4): subset of the run \
             envelope sufficient for cache-keying + Loom task evidence. \
             Always carries all four keys when present, with null for \
             individual absent fields.",
        "properties": {
            "scenario_hash":   { "type": ["string", "null"] },
            "vm_lineage_hash": { "type": ["string", "null"] },
            "agent_version":   { "type": ["string", "null"] },
            "network_class":   { "type": ["string", "null"] }
        },
        "additionalProperties": false
    })
}

// ── status ────────────────────────────────────────────────────────

pub fn status_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": {
                "type": "string",
                "description": "Run handle from loom.signalman.run. Omit for environment health."
            },
            "since_event_seq": {
                "type": "integer",
                "minimum": 0,
                "description": "Drain events with seq >= this value."
            },
            "wait_ms": {
                "type": "integer",
                "minimum": 0,
                "maximum": 30000,
                "description": "Long-poll up to this many ms for the next event."
            }
        },
        "additionalProperties": false
    })
}

pub fn status_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": { "type": "string" },
            "status": { "type": "string" },
            "events": { "type": "array" },
            "envelope": {},
            // v0.3.0-4 — see hermetic_identity_schema().
            "hermetic_identity": hermetic_identity_schema()
        }
    })
}

// ── form_descriptor (P5.4) ────────────────────────────────────────

/// Input schema for `loom.signalman.form_descriptor`. The TUI passes the
/// scenario id; the plugin returns a [`crate::forms::ScenarioFormDescriptor`].
pub fn form_descriptor_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "scenario": {
                "type": "string",
                "description": "Scenario id whose form to describe (e.g. 'mygroup/v2/scenario-a')."
            }
        },
        "required": ["scenario"],
        "additionalProperties": false
    })
}

/// Output schema for `loom.signalman.form_descriptor`. Mirrors the
/// `ScenarioFormDescriptor` Rust type's [`serde::Serialize`] shape.
/// `additionalProperties: true` so future field/validator kinds can land
/// without coordinating a Loom-side schema bump.
pub fn form_descriptor_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Stable form id, e.g. loom.signalman.run.<scenario>." },
            "label": { "type": "string" },
            "description": { "type": "string" },
            "submit_tool": {
                "type": "string",
                "description": "MCP tool the form invokes on submit; always loom.signalman.run."
            },
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "label": { "type": "string" },
                        "help": { "type": "string" },
                        "kind": {
                            "type": "object",
                            "description":
                                "Tagged union: { kind: 'text' } | { kind: 'select', options: [...] } | { kind: 'number', min?, max? } | { kind: 'boolean' } | { kind: 'secret' }.",
                            "additionalProperties": true
                        },
                        "required": { "type": "boolean" },
                        "default": {},
                        "validators": {
                            "type": "array",
                            "items": { "type": "object", "additionalProperties": true }
                        }
                    },
                    "required": ["name", "label", "kind", "required"],
                    "additionalProperties": true
                }
            }
        },
        "required": ["id", "label", "description", "submit_tool", "fields"],
        "additionalProperties": true
    })
}

// ── record ────────────────────────────────────────────────────────

pub fn record_input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "Scenario name to record under." },
            "duration_seconds": {
                "type": "integer",
                "minimum": 1,
                "description": "Max recording duration; default 600s. Stub in v0.1.0."
            }
        },
        "required": ["name"],
        "additionalProperties": false
    })
}

pub fn record_output() -> Value {
    json!({
        "type": "object",
        "properties": {
            "status": { "type": "string" },
            "message": { "type": "string" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema_is_object(v: &Value) {
        assert_eq!(v.get("type").and_then(Value::as_str), Some("object"));
        assert!(v.get("properties").is_some(), "schema missing properties");
    }

    #[test]
    fn all_input_schemas_are_objects_with_no_additional_properties() {
        for schema in [
            list_input(),
            describe_input(),
            plan_input(),
            run_input(),
            status_input(),
            record_input(),
            form_descriptor_input(),
        ] {
            schema_is_object(&schema);
            assert_eq!(
                schema.get("additionalProperties").and_then(Value::as_bool),
                Some(false),
                "input schemas must reject unknown fields: {:?}",
                schema
            );
        }
    }

    #[test]
    fn all_output_schemas_are_objects() {
        for schema in [
            list_output(),
            describe_output(),
            plan_output(),
            run_output(),
            status_output(),
            record_output(),
            form_descriptor_output(),
        ] {
            schema_is_object(&schema);
        }
    }

    #[test]
    fn form_descriptor_input_requires_scenario_field() {
        let s = form_descriptor_input();
        let req: Vec<&str> = s
            .get("required")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(req, vec!["scenario"]);
    }

    #[test]
    fn form_descriptor_output_is_permissive_for_forward_compat() {
        // Future field kinds (e.g. multi-select, file picker) must not
        // require a coordinated Loom schema bump.
        let s = form_descriptor_output();
        assert_eq!(
            s.get("additionalProperties").and_then(Value::as_bool),
            Some(true),
        );
    }

    #[test]
    fn run_input_enumerates_network_classes() {
        let s = run_input();
        let nc = s
            .get("properties")
            .and_then(|p| p.get("network_class"))
            .expect("network_class property");
        let variants = nc
            .get("enum")
            .and_then(Value::as_array)
            .expect("enum array");
        let names: Vec<&str> = variants.iter().filter_map(Value::as_str).collect();
        assert_eq!(names, vec!["isolated", "nat", "internet"]);
    }

    #[test]
    fn required_fields_match_signalman_verb_contract() {
        // Mirrors the Zod schemas in host/src/server.ts: id is required for
        // describe/plan/run; name is required for record. List + status take
        // optional filters only.
        let req = |s: Value| -> Vec<String> {
            s.get("required")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        assert_eq!(req(list_input()), Vec::<String>::new());
        assert_eq!(req(describe_input()), vec!["id"]);
        assert_eq!(req(plan_input()), vec!["id"]);
        assert_eq!(req(run_input()), vec!["id"]);
        assert_eq!(req(status_input()), Vec::<String>::new());
        assert_eq!(req(record_input()), vec!["name"]);
    }
}
