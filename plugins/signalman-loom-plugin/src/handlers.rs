//! Seven MCP tool handlers — one per Signalman verb plus the P5.4
//! `loom.signalman.form_descriptor` helper. Each handler validates the
//! input shape (defense-in-depth alongside Loom's MCP layer schema
//! check), translates the JSON into `signalman <verb>` CLI args, shells
//! out, and returns the JSON envelope unchanged.
//!
//! Handler logic is split into a pure `build_*_args` step (unit-testable
//! without spawning) and a `handle_*` wrapper that plumbs into
//! [`crate::subprocess::run_signalman`].

use std::sync::Arc;

use loom_core::{LoomError, LoomResult};
use loom_plugin_api::{McpToolMeta, McpToolRegistration, PluginContext, PluginTier, Stability};
use serde_json::{json, Value};

use crate::events::{emit_envelope_events, EventEmitter};
use crate::forms::{descriptor_for_scenario, ScenarioMeta, ScenarioParameter};
use crate::schemas;
use crate::state::{RunState, RunStateStore};
use crate::subprocess::run_signalman;
use crate::trace::{new_trace_id, parse_trace_id};

const TIER: PluginTier = PluginTier::Free;
const STABILITY: Stability = Stability::Experimental;

fn meta() -> McpToolMeta {
    McpToolMeta {
        skill_hint: Some("vm-validation".to_string()),
        cost: Some("low".to_string()),
        provenance: Some(crate::PLUGIN_ID.to_string()),
    }
}

/// Returns all seven [`McpToolRegistration`] entries the plugin exposes.
/// P5.4 added `loom.signalman.form_descriptor` for the TUI's guided
/// scenario-launch form.
pub fn all_tool_registrations() -> Vec<McpToolRegistration> {
    vec![
        register_list(),
        register_describe(),
        register_plan(),
        register_run(),
        register_status(),
        register_record(),
        register_form_descriptor(),
    ]
}

/// Build the [`EventEmitter`] a handler should use for live event
/// emission. P5.3: today this returns a no-op emitter because
/// `PluginContext` does not yet expose a Loom EventBus handle. When Loom
/// adds (e.g.) `cx.event_bus()`, this is the single call site to wire
/// the real sink in. The rest of the plugin already routes events
/// through the [`EventEmitter`] abstraction so the rewire is one line.
fn emitter_for(_cx: &PluginContext) -> EventEmitter {
    // TODO(P5.3): once `loom_plugin_api::PluginContext` exposes an
    // EventBus accessor, build a `LoomBusEmitter` here that forwards
    // into Loom's bus (see crate::events module-level doc). Until then
    // we emit into the noop sink so the rest of the plugin can rely on
    // a non-`Option<EventEmitter>` handle without branching everywhere.
    EventEmitter::noop()
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
    let mut a = vec![
        "list".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
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
        description: "Execute a scenario. Returns a run handle synchronously; events stream live via Loom EventBus (signalman.run.* taxonomy) and via loom.signalman.status long-poll for replay."
            .to_string(),
        input_schema: schemas::run_input(),
        output_schema: schemas::run_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_run),
        meta: meta(),
    }
}

/// Resolve the trace-id for a `loom.signalman.run` invocation. If the
/// caller supplied one in `args.trace_id`, validate and canonicalise
/// it; otherwise generate a fresh 32-char hex id. P3.d.
pub(crate) fn resolve_trace_id(args: &Value) -> LoomResult<String> {
    if let Some(supplied) = args.get("trace_id").and_then(Value::as_str) {
        return parse_trace_id(supplied, "trace_id");
    }
    Ok(new_trace_id())
}

pub(crate) fn build_run_args(args: &Value) -> LoomResult<Vec<String>> {
    build_run_args_with_trace(args, &resolve_trace_id(args)?)
}

/// `build_run_args` split for testability: separates trace-id resolution
/// (which uses `new_trace_id` and is therefore non-deterministic) from
/// the deterministic CLI-arg construction. Tests pin a fixed trace_id
/// and verify the args.
pub(crate) fn build_run_args_with_trace(args: &Value, trace_id: &str) -> LoomResult<Vec<String>> {
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
    // P3.d: forward the resolved trace-id to Signalman so its CLI can
    // generate matching gRPC metadata on every outbound call.
    a.push("--trace-id".to_string());
    a.push(trace_id.to_string());
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

/// Records a started run into the state store and returns the original
/// Signalman response unchanged. Pure side-effect-on-store layer; unit-
/// testable via [`finalize_run_start`] without spawning a subprocess.
///
/// Public so integration tests in `tests/` can drive the lifecycle without
/// spawning a real Signalman; not part of the agent-facing surface.
pub fn finalize_run_start(
    args: &Value,
    response: Value,
    store: &RunStateStore,
) -> LoomResult<Value> {
    finalize_run_start_with_emitter(args, response, store, None)
}

/// P5.3: same as [`finalize_run_start`] but additionally emits live
/// events onto Loom's EventBus via `emitter`. Each step / assertion
/// event in the envelope (when present) is promoted; the terminal run
/// event is emitted by `record_finished_with_emitter` so it fires
/// exactly once even if Signalman returns an immediate-finish envelope
/// off the run handler.
pub fn finalize_run_start_with_emitter(
    args: &Value,
    response: Value,
    store: &RunStateStore,
    emitter: Option<&EventEmitter>,
) -> LoomResult<Value> {
    let run_id = response
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            LoomError::PluginRuntime(
                "signalman run response missing run_id; cannot persist state".to_string(),
            )
        })?
        .to_string();

    let scenario_id = args.get("id").and_then(Value::as_str);
    // P3.d: prefer the trace_id Signalman echoed back in the response
    // (it round-tripped through the CLI's parseTraceId so we know
    // it's canonical); fall back to the input args if Signalman didn't
    // surface it for some reason.
    let trace_id = response
        .get("trace_id")
        .and_then(Value::as_str)
        .or_else(|| args.get("trace_id").and_then(Value::as_str));

    store.record_started_with_emitter(&run_id, scenario_id, trace_id, emitter)?;

    // If Signalman returned an envelope already (e.g. immediate-fail run)
    // promote it through Streaming/Finished so the state reflects reality.
    if let Some(envelope) = response.get("envelope") {
        // First: per-event emission. emit_envelope_events is a no-op
        // when there's no events array, so this is safe regardless of
        // envelope shape.
        if let Some(em) = emitter {
            emit_envelope_events(em, &run_id, envelope, trace_id, scenario_id);
        }
        if envelope_is_terminal(envelope) {
            store.record_finished_with_emitter(&run_id, envelope, emitter)?;
        } else {
            store.record_streaming_with_emitter(
                &run_id,
                response_event_seq(&response),
                Some(envelope),
                emitter,
            )?;
        }
    }

    Ok(response)
}

fn handle_run(cx: &PluginContext, args: Value) -> LoomResult<Value> {
    let store = RunStateStore::for_plugin(&cx.data_dir)?;
    let emitter = emitter_for(cx);
    let cli_args = build_run_args(&args)?;
    let response = run_signalman(&cli_args)?;
    finalize_run_start_with_emitter(&args, response, &store, Some(&emitter))
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

/// Updates the state store from a status response and falls back to the
/// last persisted state if the underlying subprocess failed but we have a
/// record of the run id. Pure logic layer for unit testing. See doc on
/// [`finalize_run_start`] for the rationale on the `pub` exposure.
pub fn finalize_status(
    args: &Value,
    response: Result<Value, LoomError>,
    store: &RunStateStore,
) -> LoomResult<Value> {
    finalize_status_with_emitter(args, response, store, None)
}

/// P5.3: same as [`finalize_status`] plus per-envelope-event emission
/// onto the Loom EventBus and (on transitions) lifecycle events.
pub fn finalize_status_with_emitter(
    args: &Value,
    response: Result<Value, LoomError>,
    store: &RunStateStore,
    emitter: Option<&EventEmitter>,
) -> LoomResult<Value> {
    let run_id = args.get("run_id").and_then(Value::as_str);

    match response {
        Ok(value) => {
            if let Some(rid) = run_id {
                let envelope = value.get("envelope");
                let event_seq = response_event_seq(&value);
                // P5.3: emit per-event events first so subscribers see
                // them ordered before any terminal-run lifecycle event.
                // We intentionally DO NOT dedupe against state.last_event_seq
                // here — Loom's EventBus is a one-shot bus, not the
                // long-poll replay channel; subscribers get exactly the
                // events that arrive on this poll.
                if let (Some(em), Some(env)) = (emitter, envelope) {
                    // Look up scenario_id / trace_id from persisted state
                    // for label consistency with the started event.
                    let (trace_id, scenario_id) = match store.load(rid) {
                        Ok(Some(s)) => (s.trace_id.clone(), s.scenario_id.clone()),
                        _ => (None, None),
                    };
                    emit_envelope_events(em, rid, env, trace_id.as_deref(), scenario_id.as_deref());
                }
                if let Some(env) = envelope.filter(|e| envelope_is_terminal(e)) {
                    store.record_finished_with_emitter(rid, env, emitter)?;
                } else {
                    store.record_streaming_with_emitter(rid, event_seq, envelope, emitter)?;
                }
            }
            Ok(value)
        }
        Err(err) => {
            // No run_id => the agent asked for environment health; no
            // record to recover, propagate the error.
            let Some(rid) = run_id else {
                return Err(err);
            };
            // Try to recover the last-known state. If we have one, mark
            // it Lost and return the persisted view; if not, propagate
            // the original error.
            let lost = store.record_lost_with_emitter(rid, &err.to_string(), emitter)?;
            match lost {
                Some(state) => Ok(lost_response_payload(&state)),
                None => Err(err),
            }
        }
    }
}

fn handle_status(cx: &PluginContext, args: Value) -> LoomResult<Value> {
    let store = RunStateStore::for_plugin(&cx.data_dir)?;
    let emitter = emitter_for(cx);
    let cli_args = build_status_args(&args)?;
    let response = run_signalman(&cli_args);
    finalize_status_with_emitter(&args, response, &store, Some(&emitter))
}

fn lost_response_payload(state: &RunState) -> Value {
    let mut v = state.to_status_value();
    v["recovered_from_state_file"] = json!(true);
    v
}

fn envelope_is_terminal(envelope: &Value) -> bool {
    // Signalman's envelope sets either a `result` field (pass/fail/error)
    // or an explicit `terminal: true`. Either qualifies.
    if envelope
        .get("terminal")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return true;
    }
    matches!(
        envelope.get("result").and_then(Value::as_str),
        Some("pass" | "fail" | "error" | "skipped")
    )
}

fn response_event_seq(response: &Value) -> Option<i64> {
    response
        .get("envelope")
        .and_then(|e| e.get("events"))
        .and_then(Value::as_array)
        .and_then(|events| {
            events
                .iter()
                .filter_map(|ev| ev.get("seq").and_then(Value::as_i64))
                .max()
        })
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

// ── form_descriptor (P5.4) ────────────────────────────────────────

fn register_form_descriptor() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.form_descriptor".to_string(),
        description:
            "Return a guided form descriptor for a scenario. The TUI renders this as a form with labeled inputs (text / select / number / boolean / secret) instead of asking the operator to author raw JSON. Submit binds to loom.signalman.run."
                .to_string(),
        input_schema: schemas::form_descriptor_input(),
        output_schema: schemas::form_descriptor_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_form_descriptor),
        meta: meta(),
    }
}

/// Build the scenario-form descriptor by shelling out to
/// `signalman describe <id> --format json`, parsing the metadata, and
/// running it through [`descriptor_for_scenario`]. The shell-out is
/// deliberate: keeping the form derivation close to what `describe`
/// actually returns means the TUI never sees a parameter the run verb
/// can't accept.
fn handle_form_descriptor(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    let scenario = require_string(&args, "scenario")?;
    let describe_args = vec![
        "describe".to_string(),
        scenario.clone(),
        "--format".to_string(),
        "json".to_string(),
    ];
    let raw_meta = run_signalman(&describe_args)?;
    let descriptor = descriptor_from_describe_response(&scenario, &raw_meta);
    serde_json::to_value(&descriptor).map_err(|e| {
        LoomError::PluginRuntime(format!(
            "failed to serialise form descriptor for '{}': {}",
            scenario, e
        ))
    })
}

/// Translate the JSON response from `signalman describe` into a
/// [`crate::forms::ScenarioFormDescriptor`].
///
/// Tolerant of partial responses: missing fields fall back to defaults
/// (id-as-label, generic description, no parameters). Pure / unit-testable
/// without spawning a subprocess.
pub(crate) fn descriptor_from_describe_response(
    scenario_id: &str,
    describe_response: &Value,
) -> crate::forms::ScenarioFormDescriptor {
    let name = describe_response.get("name").and_then(Value::as_str);
    // Use the first paragraph of workflow_md as the form description if
    // available; falls back to None and the descriptor builder synthesises
    // a generic line.
    let description_owned: Option<String> = describe_response
        .get("workflow_md")
        .and_then(Value::as_str)
        .and_then(|md| md.split("\n\n").next().map(str::to_string))
        .filter(|s| !s.trim().is_empty());

    let tags_owned: Vec<String> = describe_response
        .get("tags")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let parameters_owned: Vec<ParameterOwned> = describe_response
        .get("parameters")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parameter_owned_from_value).collect())
        .unwrap_or_default();

    // Build borrowed view of the owned data; the descriptor builder takes
    // a `ScenarioMeta<'_>` of borrows so we don't pay for clones in the
    // hot path even though the describe response only lives until this
    // function returns.
    let parameters: Vec<ScenarioParameter<'_>> = parameters_owned
        .iter()
        .map(ParameterOwned::as_borrow)
        .collect();
    let tags_borrow: Vec<&str> = tags_owned.iter().map(String::as_str).collect();

    let meta = ScenarioMeta {
        id: scenario_id,
        name,
        description: description_owned.as_deref(),
        parameters,
        tags: tags_borrow,
    };
    descriptor_for_scenario(scenario_id, &meta)
}

/// Owned-string mirror of `ScenarioParameter` so we can build the
/// borrowed view from values that came out of the describe response.
struct ParameterOwned {
    name: String,
    label: Option<String>,
    kind_hint: Option<String>,
    required: bool,
    default: Option<Value>,
    help: Option<String>,
}

impl ParameterOwned {
    fn as_borrow(&self) -> ScenarioParameter<'_> {
        ScenarioParameter {
            name: &self.name,
            label: self.label.as_deref(),
            kind_hint: self.kind_hint.as_deref(),
            required: self.required,
            default: self.default.clone(),
            help: self.help.as_deref(),
        }
    }
}

fn parameter_owned_from_value(v: &Value) -> Option<ParameterOwned> {
    let name = v.get("name").and_then(Value::as_str)?.to_string();
    Some(ParameterOwned {
        name,
        label: v.get("label").and_then(Value::as_str).map(str::to_string),
        kind_hint: v
            .get("kind")
            .and_then(Value::as_str)
            .or_else(|| v.get("type").and_then(Value::as_str))
            .map(str::to_string),
        required: v.get("required").and_then(Value::as_bool).unwrap_or(false),
        default: v.get("default").cloned(),
        help: v
            .get("help")
            .and_then(Value::as_str)
            .or_else(|| v.get("description").and_then(Value::as_str))
            .map(str::to_string),
    })
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
    use crate::state::RunStatus;
    use serde_json::json;
    use tempfile::tempdir;

    fn store() -> (RunStateStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let store = RunStateStore::new(dir.path()).unwrap();
        (store, dir)
    }

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

    const FAKE_TRACE: &str = "abcdef0123456789abcdef0123456789";

    #[test]
    fn run_args_pass_network_class_when_valid() {
        let a = build_run_args_with_trace(
            &json!({
                "id": "x",
                "network_class": "nat"
            }),
            FAKE_TRACE,
        )
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--network-class nat"));
    }

    #[test]
    fn run_args_reject_invalid_network_class() {
        let r = build_run_args_with_trace(
            &json!({
                "id": "x",
                "network_class": "wide-open"
            }),
            FAKE_TRACE,
        );
        assert!(r.is_err());
    }

    #[test]
    fn run_args_always_include_trace_id_flag() {
        // P3.d: the plugin forwards a resolved trace_id on every run
        // invocation so log streams correlate even when Loom itself
        // didn't supply one.
        let a = build_run_args_with_trace(&json!({ "id": "x" }), FAKE_TRACE).unwrap();
        let joined = a.join(" ");
        assert!(joined.contains(&format!("--trace-id {}", FAKE_TRACE)));
    }

    #[test]
    fn resolve_trace_id_uses_caller_supplied_value_when_valid() {
        let resolved = resolve_trace_id(&json!({ "trace_id": FAKE_TRACE })).unwrap();
        assert_eq!(resolved, FAKE_TRACE);
    }

    #[test]
    fn resolve_trace_id_canonicalises_dashed_uuid_input() {
        // Loom may pass a dashed UUID for ergonomics; we canonicalise
        // before forwarding to the CLI.
        let dashed = "550E8400-E29B-41D4-A716-446655440000";
        let resolved = resolve_trace_id(&json!({ "trace_id": dashed })).unwrap();
        assert_eq!(resolved, "550e8400e29b41d4a716446655440000");
    }

    #[test]
    fn resolve_trace_id_generates_when_caller_omits() {
        let resolved = resolve_trace_id(&json!({ "id": "x" })).unwrap();
        assert_eq!(resolved.len(), 32);
        assert!(resolved.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn resolve_trace_id_rejects_malformed_caller_input() {
        let r = resolve_trace_id(&json!({ "trace_id": "not-a-trace" }));
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

    // ── finalize_run_start (P5.2) ─────────────────────────────────

    #[test]
    fn finalize_run_start_persists_initial_state() {
        let (store, _dir) = store();
        let args = json!({ "id": "example/v2/network-egress" });
        let response = json!({ "run_id": "abc-123", "started_at": "now" });
        let returned = finalize_run_start(&args, response.clone(), &store).unwrap();
        assert_eq!(returned, response, "response must pass through unchanged");

        let state = store.load("abc-123").unwrap().unwrap();
        assert_eq!(
            state.scenario_id.as_deref(),
            Some("example/v2/network-egress")
        );
        assert_eq!(state.status, RunStatus::Started);
    }

    #[test]
    fn finalize_run_start_records_trace_id_from_signalman_response() {
        // Signalman echoes the canonicalised trace_id back on its
        // run-start response. The plugin prefers that value (it's
        // already passed through parseTraceId) over the input args.
        let (store, _dir) = store();
        let args = json!({ "id": "scn", "trace_id": "550E8400-E29B-41D4-A716-446655440000" });
        let canonical = "550e8400e29b41d4a716446655440000";
        let response = json!({
            "run_id": "rid",
            "trace_id": canonical
        });
        finalize_run_start(&args, response, &store).unwrap();
        let state = store.load("rid").unwrap().unwrap();
        assert_eq!(state.trace_id.as_deref(), Some(canonical));
    }

    #[test]
    fn finalize_run_start_falls_back_to_input_trace_id_when_response_missing() {
        // If Signalman didn't surface trace_id (older binary, smoke
        // test, etc.), fall back to the input. The state file should
        // still capture some trace_id so log correlation works.
        let (store, _dir) = store();
        let trace = "a".repeat(32);
        let args = json!({ "id": "scn", "trace_id": trace });
        let response = json!({ "run_id": "rid" });
        finalize_run_start(&args, response, &store).unwrap();
        let state = store.load("rid").unwrap().unwrap();
        assert_eq!(state.trace_id.as_deref(), Some(&"a".repeat(32)[..]));
    }

    #[test]
    fn finalize_run_start_promotes_to_finished_for_terminal_envelope() {
        let (store, _dir) = store();
        let args = json!({ "id": "scn" });
        let response = json!({
            "run_id": "rid",
            "envelope": { "result": "pass", "events": [] }
        });
        finalize_run_start(&args, response, &store).unwrap();
        let state = store.load("rid").unwrap().unwrap();
        assert_eq!(state.status, RunStatus::Finished);
        assert!(state.envelope.is_some());
    }

    #[test]
    fn finalize_run_start_marks_streaming_for_partial_envelope() {
        let (store, _dir) = store();
        let args = json!({ "id": "scn" });
        let response = json!({
            "run_id": "rid",
            "envelope": { "events": [{ "seq": 1 }, { "seq": 2 }] }
        });
        finalize_run_start(&args, response, &store).unwrap();
        let state = store.load("rid").unwrap().unwrap();
        assert_eq!(state.status, RunStatus::Streaming);
        assert_eq!(state.last_event_seq, 2);
    }

    #[test]
    fn finalize_run_start_rejects_response_without_run_id() {
        let (store, _dir) = store();
        let r = finalize_run_start(
            &json!({ "id": "x" }),
            json!({ "started_at": "now" }),
            &store,
        );
        assert!(r.is_err(), "response without run_id must fail loudly");
    }

    // ── finalize_status (P5.2) ────────────────────────────────────

    #[test]
    fn finalize_status_with_ok_response_advances_streaming() {
        let (store, _dir) = store();
        store.record_started("rid", Some("scn"), None).unwrap();
        let args = json!({ "run_id": "rid" });
        let resp = Ok(json!({
            "envelope": { "events": [{ "seq": 5 }] }
        }));
        let v = finalize_status(&args, resp, &store).unwrap();
        assert!(v.get("envelope").is_some());
        let s = store.load("rid").unwrap().unwrap();
        assert_eq!(s.status, RunStatus::Streaming);
        assert_eq!(s.last_event_seq, 5);
    }

    #[test]
    fn finalize_status_with_terminal_envelope_marks_finished() {
        let (store, _dir) = store();
        store.record_started("rid", None, None).unwrap();
        let args = json!({ "run_id": "rid" });
        let resp = Ok(json!({
            "envelope": { "result": "fail", "events": [{ "seq": 1 }] }
        }));
        finalize_status(&args, resp, &store).unwrap();
        let s = store.load("rid").unwrap().unwrap();
        assert_eq!(s.status, RunStatus::Finished);
    }

    #[test]
    fn finalize_status_falls_back_to_state_file_when_subprocess_fails() {
        let (store, _dir) = store();
        store.record_started("rid", Some("scn"), None).unwrap();
        store
            .record_streaming("rid", Some(3), Some(&json!({ "events": [{ "seq": 3 }] })))
            .unwrap();

        let args = json!({ "run_id": "rid" });
        let err: LoomResult<Value> = Err(LoomError::PluginRuntime(
            "signalman exited with code 1: ECONNREFUSED".to_string(),
        ));
        let v = finalize_status(&args, err, &store).unwrap();
        assert_eq!(v["status"], "lost");
        assert_eq!(v["recovered_from_state_file"], true);
        assert!(v.get("envelope").is_some());
        assert!(v["last_error"].as_str().unwrap().contains("ECONNREFUSED"));

        let s = store.load("rid").unwrap().unwrap();
        assert_eq!(s.status, RunStatus::Lost);
    }

    #[test]
    fn finalize_status_propagates_subprocess_error_when_no_state_to_recover() {
        let (store, _dir) = store();
        let args = json!({ "run_id": "never-existed" });
        let err: LoomResult<Value> = Err(LoomError::PluginRuntime("boom".to_string()));
        let r = finalize_status(&args, err, &store);
        assert!(r.is_err(), "no record to recover => propagate error");
    }

    #[test]
    fn finalize_status_propagates_error_for_environment_health_calls() {
        let (store, _dir) = store();
        let args = json!({}); // no run_id => environment health
        let err: LoomResult<Value> = Err(LoomError::PluginRuntime("offline".to_string()));
        let r = finalize_status(&args, err, &store);
        assert!(r.is_err(), "environment health failure must surface");
    }

    #[test]
    fn finalize_status_does_not_downgrade_finished_runs_on_subprocess_error() {
        let (store, _dir) = store();
        store.record_started("rid", None, None).unwrap();
        store
            .record_finished("rid", &json!({ "result": "pass" }))
            .unwrap();

        let args = json!({ "run_id": "rid" });
        let err: LoomResult<Value> = Err(LoomError::PluginRuntime("transient".to_string()));
        let v = finalize_status(&args, err, &store).unwrap();
        assert_eq!(
            v["status"], "finished",
            "Finished must not downgrade to Lost"
        );
    }

    // ── envelope helpers ──────────────────────────────────────────

    #[test]
    fn envelope_is_terminal_recognises_result_and_explicit_flag() {
        assert!(envelope_is_terminal(&json!({ "result": "pass" })));
        assert!(envelope_is_terminal(&json!({ "result": "fail" })));
        assert!(envelope_is_terminal(&json!({ "result": "error" })));
        assert!(envelope_is_terminal(&json!({ "result": "skipped" })));
        assert!(envelope_is_terminal(&json!({ "terminal": true })));
        assert!(!envelope_is_terminal(&json!({ "events": [] })));
        assert!(!envelope_is_terminal(&json!({ "result": "running" })));
    }

    #[test]
    fn response_event_seq_takes_max_across_events() {
        let resp = json!({
            "envelope": { "events": [{ "seq": 3 }, { "seq": 1 }, { "seq": 7 }, { "seq": 2 }] }
        });
        assert_eq!(response_event_seq(&resp), Some(7));
        assert_eq!(response_event_seq(&json!({})), None);
        assert_eq!(response_event_seq(&json!({ "envelope": {} })), None);
    }

    // ── P5.3 EventBus emission ────────────────────────────────────

    use crate::events::mock_emitter;

    #[test]
    fn finalize_run_start_with_emitter_emits_started_event() {
        // Run handle accepted, no envelope yet → only the lifecycle
        // Started event should fire.
        let (store, _dir) = store();
        let (emitter, mock) = mock_emitter();
        let trace = "a".repeat(32);
        let args = json!({ "id": "scn", "trace_id": trace.clone() });
        let response = json!({ "run_id": "rid", "trace_id": trace.clone() });
        finalize_run_start_with_emitter(&args, response, &store, Some(&emitter)).unwrap();
        let started = mock.filter_by_kind("signalman.run.started");
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].labels.get("signalman-trace-id"), Some(&trace));
    }

    #[test]
    fn finalize_run_start_with_emitter_promotes_envelope_events() {
        // An immediate-finish run that returned an envelope with step
        // and assertion events MUST emit a bus event for each promoted
        // type plus the terminal Finished event.
        let (store, _dir) = store();
        let (emitter, mock) = mock_emitter();
        let args = json!({ "id": "scn" });
        let response = json!({
            "run_id": "rid",
            "envelope": {
                "result": "pass",
                "events": [
                    { "seq": 0, "type": "step.started", "step_index": 0 },
                    { "seq": 1, "type": "step.completed", "step_index": 0 },
                    { "seq": 2, "type": "assertion.passed", "id": "a1" }
                ]
            }
        });
        finalize_run_start_with_emitter(&args, response, &store, Some(&emitter)).unwrap();
        // Expected: 1 Started + 3 envelope events + 1 RunFinished = 5.
        assert_eq!(
            mock.len(),
            5,
            "expected 5 events; got {:?}",
            mock.published()
        );
        assert_eq!(mock.filter_by_kind("signalman.run.started").len(), 1);
        assert_eq!(mock.filter_by_kind("signalman.run.step_started").len(), 1);
        assert_eq!(mock.filter_by_kind("signalman.run.step_completed").len(), 1);
        assert_eq!(
            mock.filter_by_kind("signalman.run.assertion_passed").len(),
            1
        );
        assert_eq!(mock.filter_by_kind("signalman.run.finished").len(), 1);
    }

    #[test]
    fn finalize_status_with_emitter_emits_envelope_events_and_finished() {
        let (store, _dir) = store();
        let (emitter, mock) = mock_emitter();
        store
            .record_started_with_emitter("rid", Some("scn"), Some("trace-1"), Some(&emitter))
            .unwrap();
        // Drain mock so the assertion below counts only status-driven events.
        let started_count = mock.filter_by_kind("signalman.run.started").len();
        assert_eq!(started_count, 1);

        let args = json!({ "run_id": "rid" });
        let resp = Ok(json!({
            "envelope": {
                "result": "fail",
                "events": [
                    { "seq": 0, "type": "step.started", "step_index": 0 },
                    { "seq": 1, "type": "step.failed", "step_index": 0, "error": "boom" }
                ]
            }
        }));
        finalize_status_with_emitter(&args, resp, &store, Some(&emitter)).unwrap();
        assert_eq!(mock.filter_by_kind("signalman.run.step_started").len(), 1);
        assert_eq!(mock.filter_by_kind("signalman.run.step_failed").len(), 1);
        assert_eq!(mock.filter_by_kind("signalman.run.finished").len(), 1);

        // Trace-id label must be present on the per-event events too,
        // pulled from the persisted RunState (not the response, which
        // doesn't carry trace_id on per-event payloads).
        let step = &mock.filter_by_kind("signalman.run.step_started")[0];
        assert_eq!(
            step.labels.get("signalman-trace-id").map(String::as_str),
            Some("trace-1")
        );
    }

    #[test]
    fn finalize_status_with_emitter_emits_lost_on_subprocess_failure() {
        let (store, _dir) = store();
        let (emitter, mock) = mock_emitter();
        store.record_started("rid", None, None).unwrap();

        let args = json!({ "run_id": "rid" });
        let err: LoomResult<Value> = Err(LoomError::PluginRuntime("ECONNREFUSED".to_string()));
        finalize_status_with_emitter(&args, err, &store, Some(&emitter)).unwrap();

        let lost = mock.filter_by_kind("signalman.run.lost");
        assert_eq!(lost.len(), 1);
        // The reason carries LoomError's Display format which includes
        // the variant prefix (`plugin runtime error: ...`). Asserting
        // contains() rather than == keeps the test resilient to
        // future LoomError formatting tweaks while still proving the
        // underlying error message reaches the event payload.
        assert!(
            lost[0].payload["reason"]
                .as_str()
                .unwrap_or("")
                .contains("ECONNREFUSED"),
            "reason payload should contain ECONNREFUSED; got {:?}",
            lost[0].payload["reason"],
        );
    }

    #[test]
    fn finalize_status_emits_streaming_event_only_on_first_transition() {
        // Streaming → Streaming on subsequent polls must not re-emit.
        let (store, _dir) = store();
        let (emitter, mock) = mock_emitter();
        store.record_started("rid", None, None).unwrap();

        for seq in [1, 2, 3] {
            finalize_status_with_emitter(
                &json!({ "run_id": "rid" }),
                Ok(json!({ "envelope": { "events": [{ "seq": seq, "type": "log" }] } })),
                &store,
                Some(&emitter),
            )
            .unwrap();
        }
        // Exactly one streaming lifecycle event despite three polls.
        assert_eq!(mock.filter_by_kind("signalman.run.streaming").len(), 1);
    }

    #[test]
    fn finalize_run_start_without_emitter_preserves_legacy_behaviour() {
        // P5.3 backward-compat: callers that don't pass an emitter
        // (existing tests, integration tests in tests/) must still
        // observe the original state-only behaviour.
        let (store, _dir) = store();
        let args = json!({ "id": "scn" });
        let response = json!({
            "run_id": "rid",
            "envelope": { "result": "pass", "events": [] }
        });
        // No emitter — call the legacy entry point.
        finalize_run_start(&args, response, &store).unwrap();
        let s = store.load("rid").unwrap().unwrap();
        assert_eq!(s.status, RunStatus::Finished);
    }

    // ── P5.4 form_descriptor ──────────────────────────────────────

    #[test]
    fn descriptor_from_empty_describe_response_still_includes_baseline_fields() {
        // Tolerance check: a describe response that lacks every optional
        // field still produces a usable form (id + network_class + trace_id).
        let d = descriptor_from_describe_response("scn", &json!({}));
        let names: Vec<&str> = d.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "network_class", "trace_id"]);
        assert_eq!(d.submit_tool, "loom.signalman.run");
    }

    #[test]
    fn descriptor_from_describe_response_uses_first_paragraph_of_workflow_md() {
        let resp = json!({
            "name": "Network egress",
            "workflow_md": "Validate the VM can reach external HTTPS endpoints.\n\n## Steps\n\n1. Setup",
            "tags": ["smoke"],
        });
        let d = descriptor_from_describe_response("example/v2/network-egress", &resp);
        assert_eq!(d.label, "Network egress");
        assert_eq!(
            d.description,
            "Validate the VM can reach external HTTPS endpoints."
        );
    }

    #[test]
    fn descriptor_from_describe_response_translates_parameters_to_fields() {
        // The describe response surfaces a `parameters` array of declared
        // overrides; each one should land in the descriptor with the right
        // kind hint.
        let resp = json!({
            "parameters": [
                { "name": "vm", "label": "Target VM", "kind": "text", "required": true,
                  "default": "endpoint-1", "help": "VM template name" },
                { "name": "verbose", "type": "bool", "default": false },
                { "name": "tier", "kind": "select:gold|silver|bronze", "required": true },
                { "name": "api_key", "kind": "secret", "required": true,
                  "description": "Resolved at runtime." }
            ]
        });
        let d = descriptor_from_describe_response("scn", &resp);
        let names: Vec<&str> = d.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"parameters.vm"));
        assert!(names.contains(&"parameters.verbose"));
        assert!(names.contains(&"parameters.tier"));
        assert!(names.contains(&"parameters.api_key"));

        let api_key = d
            .fields
            .iter()
            .find(|f| f.name == "parameters.api_key")
            .unwrap();
        // Falls back to `description` when `help` is absent.
        assert_eq!(api_key.help.as_deref(), Some("Resolved at runtime."));
    }

    #[test]
    fn descriptor_from_describe_response_skips_parameters_without_name() {
        // Defensive: a malformed describe response with a nameless
        // parameter must not crash the form builder.
        let resp = json!({
            "parameters": [
                { "kind": "text" }, // no name
                { "name": "ok" },
            ]
        });
        let d = descriptor_from_describe_response("scn", &resp);
        let names: Vec<&str> = d.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"parameters.ok"));
        // Only one parameter field plus the three baselines.
        assert_eq!(d.fields.len(), 4);
    }
}
