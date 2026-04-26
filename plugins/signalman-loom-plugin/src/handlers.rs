//! Six MCP tool handlers — one per Signalman verb. Each handler validates
//! the input shape (defense-in-depth alongside Loom's MCP layer schema
//! check), translates the JSON into `signalman <verb>` CLI args, shells
//! out, and returns the JSON envelope unchanged.
//!
//! Handler logic is split into a pure `build_*_args` step (unit-testable
//! without spawning) and a `handle_*` wrapper that plumbs into
//! [`crate::subprocess::run_signalman`].

use std::sync::Arc;

use loom_core::{LoomError, LoomResult};
use loom_plugin_api::{
    McpToolMeta, McpToolRegistration, PluginContext, PluginTier, Stability,
};
use serde_json::Value;

use crate::schemas;
use crate::subprocess::run_signalman;

const TIER: PluginTier = PluginTier::Free;
const STABILITY: Stability = Stability::Experimental;

fn meta() -> McpToolMeta {
    McpToolMeta {
        skill_hint: Some("vm-validation".to_string()),
        cost: Some("low".to_string()),
        provenance: Some(crate::PLUGIN_ID.to_string()),
    }
}

/// Returns all six [`McpToolRegistration`] entries the plugin exposes.
pub fn all_tool_registrations() -> Vec<McpToolRegistration> {
    vec![
        register_list(),
        register_describe(),
        register_plan(),
        register_run(),
        register_status(),
        register_record(),
    ]
}

// ── list ──────────────────────────────────────────────────────────

fn register_list() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.list".to_string(),
        description: "List Signalman scenarios. Returns id, name, tags, scenario_hash, last_run."
            .to_string(),
        input_schema: schemas::list_input(),
        output_schema: schemas::list_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_list),
        meta: meta(),
    }
}

pub(crate) fn build_list_args(args: &Value) -> Vec<String> {
    let mut a = vec!["list".to_string(), "--format".to_string(), "json".to_string()];
    if let Some(tag) = args.get("tag").and_then(Value::as_str) {
        a.push("--tag".to_string());
        a.push(tag.to_string());
    }
    if let Some(pattern) = args.get("pattern").and_then(Value::as_str) {
        a.push("--pattern".to_string());
        a.push(pattern.to_string());
    }
    a
}

fn handle_list(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_list_args(&args))
}

// ── describe ──────────────────────────────────────────────────────

fn register_describe() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.describe".to_string(),
        description: "Return parsed setup, assertions, and workflow markdown for a scenario without executing it."
            .to_string(),
        input_schema: schemas::describe_input(),
        output_schema: schemas::describe_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_describe),
        meta: meta(),
    }
}

pub(crate) fn build_describe_args(args: &Value) -> LoomResult<Vec<String>> {
    let id = require_string(args, "id")?;
    Ok(vec![
        "describe".to_string(),
        id,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_describe(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_describe_args(&args)?)
}

// ── plan ──────────────────────────────────────────────────────────

fn register_plan() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.plan".to_string(),
        description: "Dry-run a scenario: validate, expand parameters, return resolved step plan and affected resources. No state mutation."
            .to_string(),
        input_schema: schemas::plan_input(),
        output_schema: schemas::plan_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_plan),
        meta: meta(),
    }
}

pub(crate) fn build_plan_args(args: &Value) -> LoomResult<Vec<String>> {
    let id = require_string(args, "id")?;
    let mut a = vec!["plan".to_string(), id];
    push_param_flags(&mut a, args.get("parameters"))?;
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_plan(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_plan_args(&args)?)
}

// ── run ───────────────────────────────────────────────────────────

fn register_run() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.run".to_string(),
        description: "Execute a scenario. Returns a run handle synchronously; events stream via loom.signalman.status long-poll (P5.3 will route via Loom EventBus)."
            .to_string(),
        input_schema: schemas::run_input(),
        output_schema: schemas::run_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_run),
        meta: meta(),
    }
}

pub(crate) fn build_run_args(args: &Value) -> LoomResult<Vec<String>> {
    let id = require_string(args, "id")?;
    let mut a = vec!["run".to_string(), id];
    push_param_flags(&mut a, args.get("parameters"))?;
    if let Some(nc) = args.get("network_class").and_then(Value::as_str) {
        if !matches!(nc, "isolated" | "nat" | "internet") {
            return Err(LoomError::SchemaValidation(format!(
                "loom.signalman.run.network_class must be one of [isolated,nat,internet]; got '{}'",
                nc
            )));
        }
        a.push("--network-class".to_string());
        a.push(nc.to_string());
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_run(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_run_args(&args)?)
}

// ── status ────────────────────────────────────────────────────────

fn register_status() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.status".to_string(),
        description: "Environment + run status. Without run_id: host health + recent runs. With run_id: drain events and (when terminal) full envelope."
            .to_string(),
        input_schema: schemas::status_input(),
        output_schema: schemas::status_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_status),
        meta: meta(),
    }
}

pub(crate) fn build_status_args(args: &Value) -> LoomResult<Vec<String>> {
    let mut a = vec!["status".to_string()];
    if let Some(run_id) = args.get("run_id").and_then(Value::as_str) {
        a.push("--run".to_string());
        a.push(run_id.to_string());
    }
    if let Some(seq) = args.get("since_event_seq").and_then(Value::as_i64) {
        if seq < 0 {
            return Err(LoomError::SchemaValidation(
                "since_event_seq must be >= 0".to_string(),
            ));
        }
        a.push("--since".to_string());
        a.push(seq.to_string());
    }
    if let Some(wait_ms) = args.get("wait_ms").and_then(Value::as_i64) {
        if !(0..=30_000).contains(&wait_ms) {
            return Err(LoomError::SchemaValidation(
                "wait_ms must be in [0, 30000]".to_string(),
            ));
        }
        a.push("--wait".to_string());
        a.push(wait_ms.to_string());
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_status(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_status_args(&args)?)
}

// ── record (v0.2.0 stub passthrough) ──────────────────────────────

fn register_record() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.record".to_string(),
        description: "[v0.2.0 stub] Capture next N MCP calls into .signalman/recordings/ as a candidate scenario. Returns not-implemented in v0.1.0."
            .to_string(),
        input_schema: schemas::record_input(),
        output_schema: schemas::record_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_record),
        meta: meta(),
    }
}

pub(crate) fn build_record_args(args: &Value) -> LoomResult<Vec<String>> {
    let name = require_string(args, "name")?;
    let mut a = vec!["record".to_string(), name];
    if let Some(d) = args.get("duration_seconds").and_then(Value::as_i64) {
        if d < 1 {
            return Err(LoomError::SchemaValidation(
                "duration_seconds must be >= 1".to_string(),
            ));
        }
        a.push("--duration".to_string());
        a.push(d.to_string());
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_record(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_record_args(&args)?)
}

// ── helpers ───────────────────────────────────────────────────────

fn require_string(args: &Value, field: &str) -> LoomResult<String> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            LoomError::SchemaValidation(format!(
                "missing required field '{}' (expected string)",
                field
            ))
        })
}

/// Translates a `parameters: { k: v, ... }` JSON object into repeated
/// `--param k=v` CLI flags, matching the Signalman CLI's argv parser.
/// Non-string scalars are JSON-stringified; nested objects/arrays are
/// rejected (Signalman's CLI only accepts scalar param overrides today).
fn push_param_flags(into: &mut Vec<String>, params: Option<&Value>) -> LoomResult<()> {
    let Some(map) = params.and_then(Value::as_object) else {
        return Ok(());
    };
    for (k, v) in map {
        let scalar = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => continue, // skip
            _ => {
                return Err(LoomError::SchemaValidation(format!(
                    "parameters.{} must be a scalar (string/number/bool); objects and arrays are not supported by signalman --param",
                    k
                )));
            }
        };
        if k.contains('=') {
            return Err(LoomError::SchemaValidation(format!(
                "parameter key '{}' must not contain '=' (CLI ambiguity with --param k=v)",
                k
            )));
        }
        into.push("--param".to_string());
        into.push(format!("{}={}", k, scalar));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── list ──────────────────────────────────────────────────────

    #[test]
    fn list_args_default_to_json_format() {
        let a = build_list_args(&json!({}));
        assert_eq!(a, vec!["list", "--format", "json"]);
    }

    #[test]
    fn list_args_pass_tag_and_pattern_through() {
        let a = build_list_args(&json!({ "tag": "smoke", "pattern": "example/**" }));
        assert!(a.contains(&"--tag".to_string()));
        assert!(a.contains(&"smoke".to_string()));
        assert!(a.contains(&"--pattern".to_string()));
        assert!(a.contains(&"example/**".to_string()));
    }

    // ── describe ──────────────────────────────────────────────────

    #[test]
    fn describe_requires_id() {
        assert!(build_describe_args(&json!({})).is_err());
    }

    #[test]
    fn describe_args_carry_id_and_json_format() {
        let a = build_describe_args(&json!({ "id": "example/v2/network-egress" })).unwrap();
        assert_eq!(
            a,
            vec!["describe", "example/v2/network-egress", "--format", "json"]
        );
    }

    // ── plan ──────────────────────────────────────────────────────

    #[test]
    fn plan_args_handle_scalar_parameters() {
        let a = build_plan_args(&json!({
            "id": "x",
            "parameters": { "vm": "endpoint-1", "verbose": true, "count": 3 }
        }))
        .unwrap();
        // order is map-iteration dependent; verify presence
        let joined = a.join(" ");
        assert!(joined.contains("--param vm=endpoint-1"));
        assert!(joined.contains("--param verbose=true"));
        assert!(joined.contains("--param count=3"));
        assert!(joined.contains("--format json"));
    }

    #[test]
    fn plan_args_reject_object_parameters() {
        let r = build_plan_args(&json!({
            "id": "x",
            "parameters": { "config": { "nested": "object" } }
        }));
        assert!(r.is_err(), "nested object in parameters must be rejected");
    }

    #[test]
    fn plan_args_reject_param_key_with_equals_sign() {
        let r = build_plan_args(&json!({
            "id": "x",
            "parameters": { "k=v": "smuggled" }
        }));
        assert!(r.is_err(), "= in param key must be rejected");
    }

    // ── run ───────────────────────────────────────────────────────

    #[test]
    fn run_args_pass_network_class_when_valid() {
        let a = build_run_args(&json!({
            "id": "x",
            "network_class": "nat"
        }))
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--network-class nat"));
    }

    #[test]
    fn run_args_reject_invalid_network_class() {
        let r = build_run_args(&json!({
            "id": "x",
            "network_class": "wide-open"
        }));
        assert!(r.is_err());
    }

    // ── status ────────────────────────────────────────────────────

    #[test]
    fn status_args_with_no_input_just_request_health() {
        let a = build_status_args(&json!({})).unwrap();
        assert_eq!(a, vec!["status", "--format", "json"]);
    }

    #[test]
    fn status_args_long_poll_for_specific_run() {
        let a = build_status_args(&json!({
            "run_id": "abc-123",
            "since_event_seq": 7,
            "wait_ms": 5000
        }))
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--run abc-123"));
        assert!(joined.contains("--since 7"));
        assert!(joined.contains("--wait 5000"));
    }

    #[test]
    fn status_rejects_negative_event_seq_and_oversize_wait() {
        assert!(build_status_args(&json!({ "since_event_seq": -1 })).is_err());
        assert!(build_status_args(&json!({ "wait_ms": 60000 })).is_err());
    }

    // ── record ────────────────────────────────────────────────────

    #[test]
    fn record_requires_name() {
        assert!(build_record_args(&json!({})).is_err());
    }

    #[test]
    fn record_carries_duration_when_provided() {
        let a = build_record_args(&json!({ "name": "myrun", "duration_seconds": 120 })).unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--duration 120"));
    }

    #[test]
    fn record_rejects_zero_duration() {
        assert!(build_record_args(&json!({ "name": "x", "duration_seconds": 0 })).is_err());
    }
}
