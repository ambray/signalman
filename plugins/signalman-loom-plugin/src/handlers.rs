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
use crate::hermetic_identity::extract_hermetic_identity;
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

/// Returns all [`McpToolRegistration`] entries the plugin exposes.
/// P5.4 added `loom.signalman.form_descriptor` for the TUI's guided
/// scenario-launch form. v0.3.0-5 sub-task 6 adds the cloud + stack +
/// reaper + budget + creds surface (17 handlers); the inventory now
/// totals 25 registrations.
pub fn all_tool_registrations() -> Vec<McpToolRegistration> {
    vec![
        // ── v0.1.0 + v0.3.0-1 scenario surface ─────────────────────
        register_list(),
        register_describe(),
        register_plan(),
        register_run(),
        register_status(),
        register_record(),
        register_record_finalize(),
        register_form_descriptor(),
        // ── v0.3.0-5 sub-task 6: cloud VM surface ──────────────────
        register_cloud_provision(),
        register_cloud_terminate(),
        register_cloud_status(),
        register_cloud_list(),
        register_cloud_backends(),
        register_cloud_connection_descriptor(),
        // ── v0.3.0-5 reaper ────────────────────────────────────────
        register_reaper_run_once(),
        register_reaper_status(),
        // ── v0.3.0-5 cost guardrails ───────────────────────────────
        register_budget_get(),
        register_budget_set(),
        register_budget_usage(),
        // ── v0.3.0-5 OpenTofu stack lifecycle ──────────────────────
        register_stack_apply(),
        register_stack_destroy(),
        register_stack_plan_cost(),
        // ── v0.3.0-5 per-org credentials ───────────────────────────
        register_creds_set(),
        register_creds_get(),
        register_creds_remove(),
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
    // v0.3.0 follow-up: input field renamed from `network_class` to
    // `requested_network_class` so it doesn't collide with the
    // OBSERVED `network_class` on the result envelope.  We accept
    // both for backward compat:
    //   - `requested_network_class` wins when present
    //   - `network_class` (legacy) is accepted with a tracing-level
    //     deprecation warning the operator sees in plugin logs
    //   - declaring BOTH is a schema error (ambiguous intent)
    let requested = args.get("requested_network_class").and_then(Value::as_str);
    let legacy = args.get("network_class").and_then(Value::as_str);
    let nc = match (requested, legacy) {
        (Some(r), None) => Some(r),
        // Legacy alias accepted silently for back-compat. The schema's
        // `description` field flags it DEPRECATED — that's the
        // discoverable signal for MCP-tool browsers. A runtime
        // warning would require adding a `tracing` dependency for
        // one-line value; not worth it.
        (None, Some(l)) => Some(l),
        (Some(_), Some(_)) => {
            return Err(LoomError::SchemaValidation(
                "loom.signalman.run accepts exactly one of \
                 requested_network_class OR network_class (legacy), \
                 not both"
                    .to_string(),
            ));
        }
        (None, None) => None,
    };
    if let Some(nc) = nc {
        if !matches!(nc, "isolated" | "nat" | "internet") {
            return Err(LoomError::SchemaValidation(format!(
                "loom.signalman.run.requested_network_class must be one of \
                 [isolated,nat,internet]; got '{}'",
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

    // v0.3.0-4 — promote the envelope's hermetic identity subset to a
    // top-level `hermetic_identity` field so Loom workflow nodes can
    // gate on it without descending into envelope JSON. Returns None
    // (field absent in response) when the envelope is missing or
    // pre-v0.3.0-3.
    Ok(promote_hermetic_identity(response))
}

/// Augment a plugin response object with a top-level
/// `hermetic_identity` field extracted from its inner `envelope`.
///
/// v0.3.0-4 contract: the field is present only when the response
/// carries an envelope AND that envelope has at least one identity
/// field. Returns the response unchanged otherwise (pre-v0.3.0-3
/// signalman, or a run that failed before populating identity).
fn promote_hermetic_identity(mut response: Value) -> Value {
    let identity = response.get("envelope").and_then(extract_hermetic_identity);
    if let Some(id) = identity {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("hermetic_identity".to_string(), id);
        }
    }
    response
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
            // v0.3.0-4 — promote the envelope's hermetic identity subset
            // to a top-level field; absent when no envelope or no
            // identity fields are present (pre-v0.3.0-3 signalman).
            Ok(promote_hermetic_identity(value))
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

// ── record (v0.3.0-1) ────────────────────────────────────────────

fn register_record() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.record".to_string(),
        description: "Start a durable record/replay capture session. Every \
             subsequent MCP tool invocation in this server is appended \
             to .signalman/recordings/<safe_name>/<recording_id>/calls.jsonl \
             until the session expires (duration_seconds) or is \
             explicitly finalised via loom.signalman.record_finalize. \
             Returns the recording_id workflow nodes pass to \
             record_finalize."
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

// ── record_finalize (v0.3.0-1) ────────────────────────────────────

fn register_record_finalize() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.record_finalize".to_string(),
        description: "Promote a record/replay capture session into a candidate \
             scenario directory. Reads calls.jsonl from the recording, \
             synthesises setup.yaml + workflow.md + assertions.yaml \
             under .signalman/scenarios/<scenario_id>/, and returns the \
             promoted paths plus per-call counts (captured / emitted / \
             skipped / malformed). Pass either recording_id (from a \
             prior loom.signalman.record) or an absolute recording_path."
            .to_string(),
        input_schema: schemas::record_finalize_input(),
        output_schema: schemas::record_finalize_output(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_record_finalize),
        meta: meta(),
    }
}

pub(crate) fn build_record_finalize_args(args: &Value) -> LoomResult<Vec<String>> {
    let recording_id = args.get("recording_id").and_then(Value::as_str);
    let recording_path = args.get("recording_path").and_then(Value::as_str);

    // The CLI surfaces this error itself, but catching at the
    // plugin layer means a malformed agent invocation gets a
    // structured LoomError rather than a CLI subprocess failure
    // string buried in stderr.
    let target = match (recording_id, recording_path) {
        (Some(id), None) => id.to_string(),
        (None, Some(p)) => p.to_string(),
        (Some(_), Some(_)) => {
            return Err(LoomError::SchemaValidation(
                "record_finalize accepts exactly one of recording_id \
                 OR recording_path, not both"
                    .to_string(),
            ));
        }
        (None, None) => {
            return Err(LoomError::SchemaValidation(
                "record_finalize requires recording_id or recording_path".to_string(),
            ));
        }
    };

    let mut a = vec!["record".to_string(), "finalize".to_string(), target];
    if let Some(scenario_id) = args.get("scenario_id").and_then(Value::as_str) {
        a.push("--scenario-id".to_string());
        a.push(scenario_id.to_string());
    }
    if args.get("force").and_then(Value::as_bool).unwrap_or(false) {
        a.push("--force".to_string());
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_record_finalize(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_record_finalize_args(&args)?)
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

// ──────────────────────────────────────────────────────────────────
// v0.3.0-5 sub-task 6 — cloud + stack + reaper + budget + creds
// ──────────────────────────────────────────────────────────────────
//
// Every handler in this section shells out to a `signalman cloud …`
// or `signalman stack …` CLI verb. The schemas are hand-rolled inline
// (rather than living in `schemas::`) because the cloud surface is
// large and the helpers are small enough that inlining keeps the
// register / build / handle triple visually adjacent.
//
// Validation principles:
//   * Required fields are caught here via [`require_string`] so we
//     return a structured [`LoomError::SchemaValidation`] rather than
//     bubbling up a CLI subprocess failure.
//   * Enum-shaped fields (provider, backend, network_mode) are
//     checked at the plugin boundary so we never spend a subprocess
//     on a typo.
//   * Cost-relevant fields (`monthly_cap_cents`, `ttl_minutes`) are
//     bounded here too — defense in depth alongside the CLI's own
//     `Number.isInteger && > 0` checks.

fn permissive_object_schema() -> Value {
    json!({ "type": "object", "additionalProperties": true })
}

fn provider_property() -> Value {
    json!({
        "type": "string",
        "enum": ["aws", "azure"],
        "description": "Cloud backend. One of 'aws' or 'azure'."
    })
}

fn network_mode_property() -> Value {
    json!({
        "type": "string",
        "enum": ["public_mtls", "aws_ssm", "azure_bastion"],
        "description":
            "Network mode the descriptor / provisioned VM should use. \
             Defaults to 'public_mtls' (mTLS over public IP). \
             'aws_ssm' uses AWS Systems Manager Session Manager; \
             'azure_bastion' uses Azure Bastion."
    })
}

fn require_provider(args: &Value) -> LoomResult<String> {
    let p = require_string(args, "provider")?;
    if p != "aws" && p != "azure" {
        return Err(LoomError::SchemaValidation(format!(
            "provider must be 'aws' or 'azure'; got '{}'",
            p
        )));
    }
    Ok(p)
}

fn require_backend(args: &Value) -> LoomResult<String> {
    // Creds CLI uses --backend with the same enum as --provider.
    let b = require_string(args, "backend")?;
    if b != "aws" && b != "azure" {
        return Err(LoomError::SchemaValidation(format!(
            "backend must be 'aws' or 'azure'; got '{}'",
            b
        )));
    }
    Ok(b)
}

fn optional_network_mode(args: &Value) -> LoomResult<Option<String>> {
    let Some(mode) = args.get("network_mode").and_then(Value::as_str) else {
        return Ok(None);
    };
    if !matches!(mode, "public_mtls" | "aws_ssm" | "azure_bastion") {
        return Err(LoomError::SchemaValidation(format!(
            "network_mode must be one of [public_mtls, aws_ssm, azure_bastion]; \
             got '{}'",
            mode
        )));
    }
    Ok(Some(mode.to_string()))
}

/// Push every entry of `vars: { k: v }` to `into` as repeated
/// `--param k=v` flags. Mirrors [`push_param_flags`] but with no
/// nested-object handling — used by both `stack apply / plan-cost` (for
/// OpenTofu vars) and `cloud list / provision` (for tags).
fn push_kv_param_flags(into: &mut Vec<String>, map: Option<&Value>, field: &str) -> LoomResult<()> {
    let Some(obj) = map.and_then(Value::as_object) else {
        return Ok(());
    };
    for (k, v) in obj {
        let scalar = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => continue,
            _ => {
                return Err(LoomError::SchemaValidation(format!(
                    "{}.{} must be a scalar (string/number/bool); objects and \
                     arrays are not supported by signalman's --param parser",
                    field, k
                )));
            }
        };
        if k.contains('=') {
            return Err(LoomError::SchemaValidation(format!(
                "{} key '{}' must not contain '=' (CLI ambiguity with --param k=v)",
                field, k
            )));
        }
        into.push("--param".to_string());
        into.push(format!("{}={}", k, scalar));
    }
    Ok(())
}

// ── cloud_provision ───────────────────────────────────────────────

/// Build the `loom.signalman.cloud_provision` registration. Operators
/// invoke this with phrases like "provision a VM on AWS in us-east-1"
/// or "spin up an Azure test instance for org acme".
fn register_cloud_provision() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.cloud_provision".to_string(),
        description: "Provision a cloud VM via the configured backend. \
             Returns the instance handle (id, name, region, network_mode). \
             Use this to 'provision a VM on AWS' or 'spin up an Azure \
             test instance'. Cost-bounded — set ttl_minutes for auto-reap \
             and org_id for per-org budget attribution."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "provider": provider_property(),
                "region": { "type": "string", "description": "Cloud region (e.g. 'us-east-1', 'eastus')." },
                "instance_type": { "type": "string", "description": "SKU / instance type (e.g. 't3.small', 'Standard_B2s')." },
                "image_ref": { "type": "string", "description": "Provider-specific image id / URN." },
                "name": { "type": "string", "description": "Friendly tag — used as the Name tag (AWS) or VM name (Azure)." },
                "ttl_minutes": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional auto-reap deadline in minutes. Reaper sweeps terminate instances past their TTL."
                },
                "org_id": { "type": "string", "description": "Optional org id; usage rows attach to it for budget attribution." },
                "network_mode": network_mode_property()
            },
            "required": ["provider", "region", "instance_type", "image_ref", "name"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_cloud_provision),
        meta: meta(),
    }
}

pub(crate) fn build_cloud_provision_args(args: &Value) -> LoomResult<Vec<String>> {
    let provider = require_provider(args)?;
    let region = require_string(args, "region")?;
    let instance_type = require_string(args, "instance_type")?;
    let image_ref = require_string(args, "image_ref")?;
    let name = require_string(args, "name")?;
    let mut a = vec![
        "cloud".to_string(),
        "provision".to_string(),
        "--provider".to_string(),
        provider,
        "--region".to_string(),
        region,
        "--instance-type".to_string(),
        instance_type,
        "--image-ref".to_string(),
        image_ref,
        "--name".to_string(),
        name,
    ];
    if let Some(ttl) = args.get("ttl_minutes").and_then(Value::as_i64) {
        if ttl <= 0 {
            return Err(LoomError::SchemaValidation(
                "ttl_minutes must be a positive integer".to_string(),
            ));
        }
        a.push("--ttl-minutes".to_string());
        a.push(ttl.to_string());
    }
    if let Some(org) = args.get("org_id").and_then(Value::as_str) {
        a.push("--org-id".to_string());
        a.push(org.to_string());
    }
    if let Some(mode) = optional_network_mode(args)? {
        a.push("--network-mode".to_string());
        a.push(mode);
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_cloud_provision(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_cloud_provision_args(&args)?)
}

// ── cloud_terminate ───────────────────────────────────────────────

fn register_cloud_terminate() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.cloud_terminate".to_string(),
        description: "Terminate a cloud VM previously provisioned via Signalman. \
             Idempotent — repeat sweeps are safe. Use for 'tear down my \
             test instance' / 'kill the AWS VM <id>'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "provider": provider_property(),
                "id": { "type": "string", "description": "Instance id returned by cloud_provision." },
                "name": { "type": "string", "description": "Friendly name supplied at provision time." },
                "region": { "type": "string", "description": "Cloud region the instance lives in." }
            },
            "required": ["provider", "id", "name", "region"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_cloud_terminate),
        meta: meta(),
    }
}

pub(crate) fn build_cloud_terminate_args(args: &Value) -> LoomResult<Vec<String>> {
    let provider = require_provider(args)?;
    let id = require_string(args, "id")?;
    let name = require_string(args, "name")?;
    let region = require_string(args, "region")?;
    Ok(vec![
        "cloud".to_string(),
        "terminate".to_string(),
        "--provider".to_string(),
        provider,
        "--id".to_string(),
        id,
        "--name".to_string(),
        name,
        "--region".to_string(),
        region,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_cloud_terminate(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_cloud_terminate_args(&args)?)
}

// ── cloud_status ──────────────────────────────────────────────────

fn register_cloud_status() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.cloud_status".to_string(),
        description: "Fetch the live status of a cloud VM (state, public_ip, \
             private_ip, reason). Use to 'check if the VM is ready' \
             or 'wait for the AWS instance to be running'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "provider": provider_property(),
                "id": { "type": "string" },
                "name": { "type": "string" },
                "region": { "type": "string" }
            },
            "required": ["provider", "id", "name", "region"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_cloud_status),
        meta: meta(),
    }
}

pub(crate) fn build_cloud_status_args(args: &Value) -> LoomResult<Vec<String>> {
    let provider = require_provider(args)?;
    let id = require_string(args, "id")?;
    let name = require_string(args, "name")?;
    let region = require_string(args, "region")?;
    Ok(vec![
        "cloud".to_string(),
        "status".to_string(),
        "--provider".to_string(),
        provider,
        "--id".to_string(),
        id,
        "--name".to_string(),
        name,
        "--region".to_string(),
        region,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_cloud_status(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_cloud_status_args(&args)?)
}

// ── cloud_list ────────────────────────────────────────────────────

fn register_cloud_list() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.cloud_list".to_string(),
        description: "List Signalman-managed VMs on the given provider. Use to \
             'show all running AWS instances' or 'find Signalman VMs \
             tagged env=ci'. Tag filters intersect."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "provider": provider_property(),
                "tags": {
                    "type": "object",
                    "description":
                        "Optional tag filter map. Repeated as --param k=v \
                         which the CLI promotes onto --tag intersection.",
                    "additionalProperties": true
                }
            },
            "required": ["provider"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_cloud_list),
        meta: meta(),
    }
}

pub(crate) fn build_cloud_list_args(args: &Value) -> LoomResult<Vec<String>> {
    let provider = require_provider(args)?;
    let mut a = vec![
        "cloud".to_string(),
        "list".to_string(),
        "--provider".to_string(),
        provider,
    ];
    push_kv_param_flags(&mut a, args.get("tags"), "tags")?;
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_cloud_list(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_cloud_list_args(&args)?)
}

// ── cloud_backends ────────────────────────────────────────────────

fn register_cloud_backends() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.cloud_backends".to_string(),
        description: "List cloud backends registered in this Signalman process. \
             Use to answer 'which cloud providers does Signalman support?' \
             or to verify backend registration before provisioning."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_cloud_backends),
        meta: meta(),
    }
}

pub(crate) fn build_cloud_backends_args(_args: &Value) -> LoomResult<Vec<String>> {
    Ok(vec![
        "cloud".to_string(),
        "backends".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_cloud_backends(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_cloud_backends_args(&args)?)
}

// ── cloud_connection_descriptor ───────────────────────────────────

fn register_cloud_connection_descriptor() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.cloud_connection_descriptor".to_string(),
        description: "Build a connection descriptor for an existing cloud VM. \
             Returns kind/port/host or kind=aws_ssm/azure_bastion + the \
             vendor-specific fields a client needs to dial in. Use to \
             'show how to connect to the AWS VM' before SSH-ing or \
             before invoking a probe."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "provider": provider_property(),
                "id": { "type": "string" },
                "name": { "type": "string" },
                "region": { "type": "string" },
                "network_mode": network_mode_property(),
                "subscription_id": { "type": "string", "description": "Azure-only: subscription containing the VM." },
                "resource_group": { "type": "string", "description": "Azure-only: resource group containing the VM." },
                "bastion_name": { "type": "string", "description": "Azure-only: Bastion resource name." },
                "aws_profile": { "type": "string", "description": "AWS-only: profile name passed through to the Session Manager client." }
            },
            "required": ["provider", "id", "name", "region"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_cloud_connection_descriptor),
        meta: meta(),
    }
}

pub(crate) fn build_cloud_connection_descriptor_args(args: &Value) -> LoomResult<Vec<String>> {
    let provider = require_provider(args)?;
    let id = require_string(args, "id")?;
    let name = require_string(args, "name")?;
    let region = require_string(args, "region")?;
    let mut a = vec![
        "cloud".to_string(),
        "connection-descriptor".to_string(),
        "--provider".to_string(),
        provider,
        "--id".to_string(),
        id,
        "--name".to_string(),
        name,
        "--region".to_string(),
        region,
    ];
    if let Some(mode) = optional_network_mode(args)? {
        a.push("--network-mode".to_string());
        a.push(mode);
    }
    for (json_key, cli_flag) in &[
        ("subscription_id", "--subscription-id"),
        ("resource_group", "--resource-group"),
        ("bastion_name", "--bastion-name"),
        ("aws_profile", "--aws-profile"),
    ] {
        if let Some(v) = args.get(*json_key).and_then(Value::as_str) {
            a.push((*cli_flag).to_string());
            a.push(v.to_string());
        }
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_cloud_connection_descriptor(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_cloud_connection_descriptor_args(&args)?)
}

// ── reaper_run_once ───────────────────────────────────────────────

fn register_reaper_run_once() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.reaper_run_once".to_string(),
        description: "Force a TTL sweep across every registered cloud backend. \
             Terminates instances past their ttl_minutes and returns \
             per-backend inspect/terminate counts. Use to 'force a \
             reaper sweep now' or 'clean up expired test VMs'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_reaper_run_once),
        meta: meta(),
    }
}

pub(crate) fn build_reaper_run_once_args(_args: &Value) -> LoomResult<Vec<String>> {
    Ok(vec![
        "cloud".to_string(),
        "reaper".to_string(),
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_reaper_run_once(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_reaper_run_once_args(&args)?)
}

// ── reaper_status ─────────────────────────────────────────────────

fn register_reaper_status() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.reaper_status".to_string(),
        description: "Return the last reaper sweep result (start/finish, total \
             terminated, per-backend stats) and whether a sweep is \
             currently running. Use to 'show the latest reaper run' or \
             'is the reaper still working?'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_reaper_status),
        meta: meta(),
    }
}

pub(crate) fn build_reaper_status_args(_args: &Value) -> LoomResult<Vec<String>> {
    Ok(vec![
        "cloud".to_string(),
        "reaper".to_string(),
        "status".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_reaper_status(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_reaper_status_args(&args)?)
}

// ── budget_get ────────────────────────────────────────────────────

fn register_budget_get() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.budget_get".to_string(),
        description: "Show the current monthly budget for an org (limit, soft \
             warn pct, current month usage). Use to 'check the cloud \
             budget for org acme' or 'how much have we burned this \
             month?'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "org_id": {
                    "type": "string",
                    "description":
                        "Organisation id. CLI maps this to its --org flag; \
                         we accept org_id at the JSON boundary for \
                         consistency with the rest of the cloud surface."
                }
            },
            "required": ["org_id"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_budget_get),
        meta: meta(),
    }
}

pub(crate) fn build_budget_get_args(args: &Value) -> LoomResult<Vec<String>> {
    let org = require_string(args, "org_id")?;
    Ok(vec![
        "cloud".to_string(),
        "budget".to_string(),
        "get".to_string(),
        "--org".to_string(),
        org,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_budget_get(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_budget_get_args(&args)?)
}

// ── budget_set ────────────────────────────────────────────────────

fn register_budget_set() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.budget_set".to_string(),
        description: "Set or update an org's monthly budget cap (in cents). \
             Use to 'cap org acme at $50/month' (monthly_cap_cents = 5000) \
             or 'update the test org budget to 1000 cents'. \
             Crossing the cap returns budget_exceeded on subsequent \
             provision calls."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "org_id": { "type": "string" },
                "monthly_cap_cents": {
                    "type": "integer",
                    "minimum": 1,
                    "description":
                        "Monthly limit in cents. Forwarded to --monthly-cents \
                         at the CLI layer."
                }
            },
            "required": ["org_id", "monthly_cap_cents"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_budget_set),
        meta: meta(),
    }
}

pub(crate) fn build_budget_set_args(args: &Value) -> LoomResult<Vec<String>> {
    let org = require_string(args, "org_id")?;
    let cents = args
        .get("monthly_cap_cents")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            LoomError::SchemaValidation(
                "missing required field 'monthly_cap_cents' (expected positive integer)"
                    .to_string(),
            )
        })?;
    if cents <= 0 {
        return Err(LoomError::SchemaValidation(
            "monthly_cap_cents must be a positive integer".to_string(),
        ));
    }
    Ok(vec![
        "cloud".to_string(),
        "budget".to_string(),
        "set".to_string(),
        "--org".to_string(),
        org,
        "--monthly-cents".to_string(),
        cents.to_string(),
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_budget_set(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_budget_set_args(&args)?)
}

// ── budget_usage ──────────────────────────────────────────────────

fn register_budget_usage() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.budget_usage".to_string(),
        description: "List per-instance cost rows for an org's current month. \
             Use to 'break down cloud spend by instance' or 'show what \
             my CI runners cost this month'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "org_id": { "type": "string" }
            },
            "required": ["org_id"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_budget_usage),
        meta: meta(),
    }
}

pub(crate) fn build_budget_usage_args(args: &Value) -> LoomResult<Vec<String>> {
    let org = require_string(args, "org_id")?;
    Ok(vec![
        "cloud".to_string(),
        "budget".to_string(),
        "usage".to_string(),
        "--org".to_string(),
        org,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_budget_usage(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_budget_usage_args(&args)?)
}

// ── stack_apply ───────────────────────────────────────────────────

fn register_stack_apply() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.stack_apply".to_string(),
        description: "Apply an OpenTofu module to bring up (or reconcile) a stack. \
             Returns the workspace path, change summary, and module \
             outputs. Use to 'apply the dev-cluster stack' or 'tofu apply \
             my module'. vars are forwarded as -var k=v."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "stack_name": { "type": "string", "description": "Logical stack name; one workspace per name under .signalman/stacks/." },
                "module_path": { "type": "string", "description": "Path to the OpenTofu module root (directory holding *.tf)." },
                "vars": {
                    "type": "object",
                    "description":
                        "OpenTofu input variables, k=scalar. Forwarded \
                         as repeated --param k=v.",
                    "additionalProperties": true
                }
            },
            "required": ["stack_name", "module_path"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_stack_apply),
        meta: meta(),
    }
}

pub(crate) fn build_stack_apply_args(args: &Value) -> LoomResult<Vec<String>> {
    let stack_name = require_string(args, "stack_name")?;
    let module_path = require_string(args, "module_path")?;
    let mut a = vec![
        "stack".to_string(),
        "apply".to_string(),
        "--stack-name".to_string(),
        stack_name,
        "--module-path".to_string(),
        module_path,
    ];
    push_kv_param_flags(&mut a, args.get("vars"), "vars")?;
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_stack_apply(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_stack_apply_args(&args)?)
}

// ── stack_destroy ─────────────────────────────────────────────────

fn register_stack_destroy() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.stack_destroy".to_string(),
        description: "Destroy a previously-applied OpenTofu stack. Idempotent \
             (returns alreadyEmpty when the workspace is gone). Use to \
             'tear down the dev-cluster stack' or 'tofu destroy this \
             environment'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "stack_name": { "type": "string" },
                "module_path": {
                    "type": "string",
                    "description":
                        "Kept for API symmetry with stack_apply / \
                         stack_plan_cost; not consumed by the CLI's \
                         destroy verb today but accepted so calling \
                         workflows can pass the same triple."
                }
            },
            "required": ["stack_name", "module_path"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_stack_destroy),
        meta: meta(),
    }
}

pub(crate) fn build_stack_destroy_args(args: &Value) -> LoomResult<Vec<String>> {
    let stack_name = require_string(args, "stack_name")?;
    // module_path is required at the JSON layer for symmetry; CLI
    // destroy doesn't read it (workspace is keyed on stack_name).
    let _module_path = require_string(args, "module_path")?;
    Ok(vec![
        "stack".to_string(),
        "destroy".to_string(),
        "--stack-name".to_string(),
        stack_name,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_stack_destroy(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_stack_destroy_args(&args)?)
}

// ── stack_plan_cost ───────────────────────────────────────────────

fn register_stack_plan_cost() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.stack_plan_cost".to_string(),
        description: "Pre-flight cost estimate for an OpenTofu module. Returns \
             change summary, estimated monthly cents, and per-resource \
             SKU costs. Use to 'estimate what this stack will cost' \
             before stack_apply."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "stack_name": { "type": "string" },
                "module_path": { "type": "string" },
                "vars": {
                    "type": "object",
                    "description": "OpenTofu input variables (forwarded as --param k=v).",
                    "additionalProperties": true
                }
            },
            "required": ["stack_name", "module_path"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_stack_plan_cost),
        meta: meta(),
    }
}

pub(crate) fn build_stack_plan_cost_args(args: &Value) -> LoomResult<Vec<String>> {
    let stack_name = require_string(args, "stack_name")?;
    let module_path = require_string(args, "module_path")?;
    let mut a = vec![
        "stack".to_string(),
        "plan-cost".to_string(),
        "--stack-name".to_string(),
        stack_name,
        "--module-path".to_string(),
        module_path,
    ];
    push_kv_param_flags(&mut a, args.get("vars"), "vars")?;
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_stack_plan_cost(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_stack_plan_cost_args(&args)?)
}

// ── creds_set ─────────────────────────────────────────────────────

fn register_creds_set() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.creds_set".to_string(),
        description: "Store an AWS or Azure credential at rest for an org. \
             The plaintext_json field carries the secret bundle: \
             AWS = {access_key_id, secret_access_key, session_token?}; \
             Azure = {tenant_id, client_id, client_secret}. Use to \
             'configure AWS creds for org acme' or 'add Azure SP for \
             tenant X'. Plaintext is never persisted unencrypted."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "org_id": { "type": "string" },
                "backend": {
                    "type": "string",
                    "enum": ["aws", "azure"],
                    "description": "Cloud backend the credential is for."
                },
                "plaintext_json": {
                    "type": "object",
                    "description":
                        "Secret bundle. Shape depends on backend: \
                         AWS requires access_key_id + secret_access_key \
                         (session_token optional); Azure requires \
                         tenant_id + client_id + client_secret.",
                    "additionalProperties": true
                }
            },
            "required": ["org_id", "backend", "plaintext_json"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_creds_set),
        meta: meta(),
    }
}

/// Translate the JSON credential bundle into the CLI's per-backend
/// argv flags. Deviation from the task spec: the CLI does NOT accept
/// a `--plaintext-json` blob — it takes split flags (--access-key-id,
/// --secret-access-key, --session-token / --tenant-id, --client-id,
/// --client-secret). The plugin layer keeps the agent-facing shape
/// uniform (one plaintext_json field) and splits to flags here so we
/// don't paper a JSON blob through argv.
pub(crate) fn build_creds_set_args(args: &Value) -> LoomResult<Vec<String>> {
    let org = require_string(args, "org_id")?;
    let backend = require_backend(args)?;
    let bundle = args
        .get("plaintext_json")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            LoomError::SchemaValidation(
                "missing required field 'plaintext_json' (expected object)".to_string(),
            )
        })?;

    let mut a = vec![
        "cloud".to_string(),
        "creds".to_string(),
        "set".to_string(),
        "--org".to_string(),
        org,
        "--backend".to_string(),
        backend.clone(),
    ];

    match backend.as_str() {
        "aws" => {
            let access_key_id = bundle
                .get("access_key_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    LoomError::SchemaValidation(
                        "plaintext_json.access_key_id is required for backend='aws'".to_string(),
                    )
                })?;
            let secret_access_key = bundle
                .get("secret_access_key")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    LoomError::SchemaValidation(
                        "plaintext_json.secret_access_key is required for backend='aws'"
                            .to_string(),
                    )
                })?;
            a.push("--access-key-id".to_string());
            a.push(access_key_id.to_string());
            a.push("--secret-access-key".to_string());
            a.push(secret_access_key.to_string());
            if let Some(token) = bundle.get("session_token").and_then(Value::as_str) {
                a.push("--session-token".to_string());
                a.push(token.to_string());
            }
        }
        "azure" => {
            let tenant_id = bundle
                .get("tenant_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    LoomError::SchemaValidation(
                        "plaintext_json.tenant_id is required for backend='azure'".to_string(),
                    )
                })?;
            let client_id = bundle
                .get("client_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    LoomError::SchemaValidation(
                        "plaintext_json.client_id is required for backend='azure'".to_string(),
                    )
                })?;
            let client_secret = bundle
                .get("client_secret")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    LoomError::SchemaValidation(
                        "plaintext_json.client_secret is required for backend='azure'".to_string(),
                    )
                })?;
            a.push("--tenant-id".to_string());
            a.push(tenant_id.to_string());
            a.push("--client-id".to_string());
            a.push(client_id.to_string());
            a.push("--client-secret".to_string());
            a.push(client_secret.to_string());
        }
        // require_backend already restricted to aws|azure.
        _ => unreachable!(),
    }
    a.push("--format".to_string());
    a.push("json".to_string());
    Ok(a)
}

fn handle_creds_set(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_creds_set_args(&args)?)
}

// ── creds_get ─────────────────────────────────────────────────────

fn register_creds_get() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.creds_get".to_string(),
        description: "Fetch the credential metadata for an org/backend pair. \
             NEVER returns plaintext; only a redacted hint, encryption \
             method, and timestamps. Use to 'check if AWS creds are \
             configured for org acme' or 'show the credential hint'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "org_id": { "type": "string" },
                "backend": { "type": "string", "enum": ["aws", "azure"] }
            },
            "required": ["org_id", "backend"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_creds_get),
        meta: meta(),
    }
}

pub(crate) fn build_creds_get_args(args: &Value) -> LoomResult<Vec<String>> {
    let org = require_string(args, "org_id")?;
    let backend = require_backend(args)?;
    Ok(vec![
        "cloud".to_string(),
        "creds".to_string(),
        "get".to_string(),
        "--org".to_string(),
        org,
        "--backend".to_string(),
        backend,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_creds_get(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_creds_get_args(&args)?)
}

// ── creds_remove ──────────────────────────────────────────────────

fn register_creds_remove() -> McpToolRegistration {
    McpToolRegistration {
        name: "loom.signalman.creds_remove".to_string(),
        description: "Remove the stored credential for an org/backend pair. \
             Idempotent — succeeds even if no credential is configured. \
             Use to 'rotate AWS creds for org acme' (call this then \
             creds_set) or 'revoke Azure credentials'."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "org_id": { "type": "string" },
                "backend": { "type": "string", "enum": ["aws", "azure"] }
            },
            "required": ["org_id", "backend"],
            "additionalProperties": false
        }),
        output_schema: permissive_object_schema(),
        stability: STABILITY,
        tier: TIER,
        handler: Arc::new(handle_creds_remove),
        meta: meta(),
    }
}

pub(crate) fn build_creds_remove_args(args: &Value) -> LoomResult<Vec<String>> {
    let org = require_string(args, "org_id")?;
    let backend = require_backend(args)?;
    Ok(vec![
        "cloud".to_string(),
        "creds".to_string(),
        "remove".to_string(),
        "--org".to_string(),
        org,
        "--backend".to_string(),
        backend,
        "--format".to_string(),
        "json".to_string(),
    ])
}

fn handle_creds_remove(_cx: &PluginContext, args: Value) -> LoomResult<Value> {
    run_signalman(&build_creds_remove_args(&args)?)
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
        let a = build_list_args(&json!({ "tag": "smoke", "pattern": "mygroup/**" }));
        assert!(a.contains(&"--tag".to_string()));
        assert!(a.contains(&"smoke".to_string()));
        assert!(a.contains(&"--pattern".to_string()));
        assert!(a.contains(&"mygroup/**".to_string()));
    }

    // ── describe ──────────────────────────────────────────────────

    #[test]
    fn describe_requires_id() {
        assert!(build_describe_args(&json!({})).is_err());
    }

    #[test]
    fn describe_args_carry_id_and_json_format() {
        let a = build_describe_args(&json!({ "id": "mygroup/v2/scenario-a" })).unwrap();
        assert_eq!(
            a,
            vec!["describe", "mygroup/v2/scenario-a", "--format", "json"]
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
    fn run_args_pass_requested_network_class_when_valid() {
        let a = build_run_args_with_trace(
            &json!({
                "id": "x",
                "requested_network_class": "nat"
            }),
            FAKE_TRACE,
        )
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--network-class nat"));
    }

    #[test]
    fn run_args_reject_invalid_requested_network_class() {
        let r = build_run_args_with_trace(
            &json!({
                "id": "x",
                "requested_network_class": "wide-open"
            }),
            FAKE_TRACE,
        );
        assert!(r.is_err());
        // Error message must name the new field to guide migration.
        let msg = r.unwrap_err().to_string();
        assert!(
            msg.contains("requested_network_class"),
            "error message must name the canonical field; got {:?}",
            msg
        );
    }

    // ── v0.3.0 follow-up: legacy `network_class` input back-compat ──

    #[test]
    fn run_args_accept_legacy_network_class_input_for_backcompat() {
        // Pre-v0.3.0 workflows that pass the old `network_class`
        // input name continue to work; the alias resolves to the
        // same `--network-class` CLI flag downstream.
        let a = build_run_args_with_trace(
            &json!({
                "id": "x",
                "network_class": "isolated"
            }),
            FAKE_TRACE,
        )
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--network-class isolated"));
    }

    #[test]
    fn run_args_reject_both_requested_and_legacy_network_class() {
        // Declaring both is ambiguous: which intent wins? Refuse so
        // the operator surfaces and migrates the workflow cleanly.
        let r = build_run_args_with_trace(
            &json!({
                "id": "x",
                "requested_network_class": "nat",
                "network_class": "isolated"
            }),
            FAKE_TRACE,
        );
        assert!(r.is_err());
        let msg = r.unwrap_err().to_string();
        assert!(
            msg.contains("not both"),
            "error must surface the ambiguity; got {:?}",
            msg
        );
    }

    #[test]
    fn run_args_prefer_requested_when_only_requested_present() {
        // Sanity-check that the precedence rule lands the new name's
        // value into the CLI args.
        let a = build_run_args_with_trace(
            &json!({
                "id": "x",
                "requested_network_class": "internet"
            }),
            FAKE_TRACE,
        )
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--network-class internet"));
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
        let args = json!({ "id": "mygroup/v2/scenario-a" });
        let response = json!({ "run_id": "abc-123", "started_at": "now" });
        let returned = finalize_run_start(&args, response.clone(), &store).unwrap();
        assert_eq!(returned, response, "response must pass through unchanged");

        let state = store.load("abc-123").unwrap().unwrap();
        assert_eq!(state.scenario_id.as_deref(), Some("mygroup/v2/scenario-a"));
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
        // field still produces a usable form
        // (id + requested_network_class + trace_id).
        let d = descriptor_from_describe_response("scn", &json!({}));
        let names: Vec<&str> = d.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "requested_network_class", "trace_id"]);
        assert_eq!(d.submit_tool, "loom.signalman.run");
    }

    #[test]
    fn descriptor_from_describe_response_uses_first_paragraph_of_workflow_md() {
        let resp = json!({
            "name": "Network egress",
            "workflow_md": "Validate the VM can reach external HTTPS endpoints.\n\n## Steps\n\n1. Setup",
            "tags": ["smoke"],
        });
        let d = descriptor_from_describe_response("mygroup/v2/scenario-a", &resp);
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

    // ── v0.3.0-1: record_finalize arg builder ────────────────────────

    #[test]
    fn record_finalize_args_with_recording_id_emits_id_format_json() {
        let args = build_record_finalize_args(&json!({
            "recording_id": "rec_2026-01-01T00-00-00-000Z_abcdef"
        }))
        .expect("ok");
        assert!(args.contains(&"record".to_string()));
        assert!(args.contains(&"finalize".to_string()));
        assert!(args.contains(&"rec_2026-01-01T00-00-00-000Z_abcdef".to_string()));
        assert!(args.contains(&"--format".to_string()));
        assert!(args.contains(&"json".to_string()));
    }

    #[test]
    fn record_finalize_args_with_recording_path_emits_path() {
        let args = build_record_finalize_args(&json!({
            "recording_path": "C:\\src\\proj\\.signalman\\recordings\\foo\\rec_..."
        }))
        .expect("ok");
        assert!(args.iter().any(|a| a.contains(".signalman")));
    }

    #[test]
    fn record_finalize_args_passes_scenario_id_override() {
        let args = build_record_finalize_args(&json!({
            "recording_id": "rec_2026-01-01T00-00-00-000Z_abcdef",
            "scenario_id": "smoke/my-flow"
        }))
        .expect("ok");
        let i = args
            .iter()
            .position(|a| a == "--scenario-id")
            .expect("flag");
        assert_eq!(args[i + 1], "smoke/my-flow");
    }

    #[test]
    fn record_finalize_args_passes_force_flag() {
        let args = build_record_finalize_args(&json!({
            "recording_id": "rec_x",
            "force": true
        }))
        .expect("ok");
        assert!(args.contains(&"--force".to_string()));
    }

    #[test]
    fn record_finalize_args_omits_force_when_false() {
        let args = build_record_finalize_args(&json!({
            "recording_id": "rec_x",
            "force": false
        }))
        .expect("ok");
        assert!(!args.contains(&"--force".to_string()));
    }

    #[test]
    fn record_finalize_args_rejects_neither_id_nor_path() {
        let err = build_record_finalize_args(&json!({})).unwrap_err();
        assert!(
            matches!(err, LoomError::SchemaValidation(_)),
            "expected SchemaValidation, got {:?}",
            err
        );
        assert!(err.to_string().contains("recording_id"));
    }

    #[test]
    fn record_finalize_args_rejects_both_id_and_path() {
        let err = build_record_finalize_args(&json!({
            "recording_id": "rec_x",
            "recording_path": "/abs/p"
        }))
        .unwrap_err();
        assert!(
            matches!(err, LoomError::SchemaValidation(_)),
            "expected SchemaValidation, got {:?}",
            err
        );
        assert!(err.to_string().contains("not both"));
    }

    // ── v0.3.0-4: hermetic_identity promotion ────────────────────────

    #[test]
    fn promote_hermetic_identity_adds_top_level_field_when_envelope_has_identity() {
        let response = json!({
            "run_id": "abc",
            "envelope": {
                "name": "smoke",
                "status": "passed",
                "scenario_hash": "a".repeat(64),
                "vm_lineage_hash": "b".repeat(64),
                "agent_version": "0.2.1",
                "network_class": "default-switch"
            }
        });
        let promoted = promote_hermetic_identity(response);
        let id = promoted.get("hermetic_identity").expect("present");
        assert_eq!(id["scenario_hash"].as_str(), Some("a".repeat(64).as_str()));
        assert_eq!(
            id["vm_lineage_hash"].as_str(),
            Some("b".repeat(64).as_str())
        );
        assert_eq!(id["agent_version"].as_str(), Some("0.2.1"));
        assert_eq!(id["network_class"].as_str(), Some("default-switch"));
        // Original envelope unchanged.
        assert_eq!(
            promoted["envelope"]["scenario_hash"].as_str(),
            Some("a".repeat(64).as_str()),
        );
    }

    #[test]
    fn promote_hermetic_identity_no_op_when_envelope_missing() {
        let response = json!({ "run_id": "abc" });
        let promoted = promote_hermetic_identity(response);
        assert!(promoted.get("hermetic_identity").is_none());
    }

    #[test]
    fn promote_hermetic_identity_no_op_when_envelope_has_no_identity_fields() {
        // Pre-v0.3.0-3 envelope: has status + duration but no
        // identity fields. Promotion is a no-op so workflow nodes
        // can branch on `hermetic_identity` presence to know whether
        // the upstream signalman is new enough.
        let response = json!({
            "run_id": "abc",
            "envelope": {
                "name": "smoke",
                "status": "passed",
                "duration_ms": 1234
            }
        });
        let promoted = promote_hermetic_identity(response);
        assert!(promoted.get("hermetic_identity").is_none());
    }

    #[test]
    fn promote_hermetic_identity_partial_envelope_promotes_subset() {
        // Envelope from a run that captured scenario_hash but
        // didn't reach the guest-agent-version probe (e.g. crashed
        // in setup). Promotion surfaces what we have; missing
        // fields are null.
        let response = json!({
            "run_id": "abc",
            "envelope": {
                "status": "error",
                "scenario_hash": "d".repeat(64)
            }
        });
        let promoted = promote_hermetic_identity(response);
        let id = promoted.get("hermetic_identity").expect("present");
        assert_eq!(id["scenario_hash"].as_str(), Some("d".repeat(64).as_str()));
        assert!(id["vm_lineage_hash"].is_null());
        assert!(id["agent_version"].is_null());
        assert!(id["network_class"].is_null());
    }

    // ─────────────────────────────────────────────────────────────
    // v0.3.0-5 sub-task 6 — cloud + stack + reaper + budget + creds
    // ─────────────────────────────────────────────────────────────

    fn assert_pair(args: &[String], flag: &str, expected: &str) {
        let i = args
            .iter()
            .position(|a| a == flag)
            .unwrap_or_else(|| panic!("missing flag '{}' in args {:?}", flag, args));
        assert_eq!(
            args[i + 1],
            expected,
            "value for '{}' was {:?}, expected {:?}",
            flag,
            args[i + 1],
            expected,
        );
    }

    // ── cloud_provision ─────────────────────────────────────────

    #[test]
    fn cloud_provision_args_carry_every_required_flag() {
        let a = build_cloud_provision_args(&json!({
            "provider": "aws",
            "region": "us-east-1",
            "instance_type": "t3.small",
            "image_ref": "ami-abc",
            "name": "ci-runner"
        }))
        .unwrap();
        assert_eq!(a[0], "cloud");
        assert_eq!(a[1], "provision");
        assert_pair(&a, "--provider", "aws");
        assert_pair(&a, "--region", "us-east-1");
        assert_pair(&a, "--instance-type", "t3.small");
        assert_pair(&a, "--image-ref", "ami-abc");
        assert_pair(&a, "--name", "ci-runner");
        assert_pair(&a, "--format", "json");
    }

    #[test]
    fn cloud_provision_args_propagate_ttl_org_and_network_mode() {
        let a = build_cloud_provision_args(&json!({
            "provider": "azure",
            "region": "eastus",
            "instance_type": "Standard_B2s",
            "image_ref": "Canonical:UbuntuServer:22_04-lts:latest",
            "name": "test-vm",
            "ttl_minutes": 30,
            "org_id": "acme",
            "network_mode": "azure_bastion"
        }))
        .unwrap();
        assert_pair(&a, "--ttl-minutes", "30");
        assert_pair(&a, "--org-id", "acme");
        assert_pair(&a, "--network-mode", "azure_bastion");
    }

    #[test]
    fn cloud_provision_rejects_unknown_provider() {
        let r = build_cloud_provision_args(&json!({
            "provider": "gcp",
            "region": "r",
            "instance_type": "t",
            "image_ref": "i",
            "name": "n"
        }));
        assert!(r.is_err());
    }

    #[test]
    fn cloud_provision_rejects_zero_ttl() {
        let r = build_cloud_provision_args(&json!({
            "provider": "aws",
            "region": "r",
            "instance_type": "t",
            "image_ref": "i",
            "name": "n",
            "ttl_minutes": 0
        }));
        assert!(r.is_err());
    }

    #[test]
    fn cloud_provision_rejects_invalid_network_mode() {
        let r = build_cloud_provision_args(&json!({
            "provider": "aws",
            "region": "r",
            "instance_type": "t",
            "image_ref": "i",
            "name": "n",
            "network_mode": "ipv6_only"
        }));
        assert!(r.is_err());
    }

    // ── cloud_terminate ─────────────────────────────────────────

    #[test]
    fn cloud_terminate_args_have_all_four_required_flags() {
        let a = build_cloud_terminate_args(&json!({
            "provider": "aws",
            "id": "i-0abc",
            "name": "ci-runner",
            "region": "us-east-1"
        }))
        .unwrap();
        assert_pair(&a, "--provider", "aws");
        assert_pair(&a, "--id", "i-0abc");
        assert_pair(&a, "--name", "ci-runner");
        assert_pair(&a, "--region", "us-east-1");
        assert_pair(&a, "--format", "json");
    }

    // ── cloud_status ────────────────────────────────────────────

    #[test]
    fn cloud_status_args_have_all_four_required_flags() {
        let a = build_cloud_status_args(&json!({
            "provider": "azure",
            "id": "vm-1",
            "name": "test",
            "region": "eastus"
        }))
        .unwrap();
        assert_eq!(a[0], "cloud");
        assert_eq!(a[1], "status");
        assert_pair(&a, "--provider", "azure");
        assert_pair(&a, "--id", "vm-1");
    }

    // ── cloud_list ──────────────────────────────────────────────

    #[test]
    fn cloud_list_args_emit_tags_as_repeated_param_flags() {
        let a = build_cloud_list_args(&json!({
            "provider": "aws",
            "tags": { "env": "ci", "team": "platform" }
        }))
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--provider aws"));
        // Order is HashMap-iteration dependent; check both pairs present.
        assert!(joined.contains("--param env=ci"));
        assert!(joined.contains("--param team=platform"));
    }

    #[test]
    fn cloud_list_args_without_tags_still_request_json() {
        let a = build_cloud_list_args(&json!({ "provider": "aws" })).unwrap();
        assert_pair(&a, "--format", "json");
    }

    // ── cloud_backends ──────────────────────────────────────────

    #[test]
    fn cloud_backends_args_take_no_inputs() {
        let a = build_cloud_backends_args(&json!({})).unwrap();
        assert_eq!(a, vec!["cloud", "backends", "--format", "json"]);
    }

    // ── cloud_connection_descriptor ─────────────────────────────

    #[test]
    fn cloud_connection_descriptor_args_carry_required_quadruple() {
        let a = build_cloud_connection_descriptor_args(&json!({
            "provider": "aws",
            "id": "i-1",
            "name": "n",
            "region": "us-east-1"
        }))
        .unwrap();
        assert_eq!(a[0], "cloud");
        assert_eq!(a[1], "connection-descriptor");
        assert_pair(&a, "--provider", "aws");
        assert_pair(&a, "--id", "i-1");
    }

    #[test]
    fn cloud_connection_descriptor_propagates_azure_specific_flags() {
        let a = build_cloud_connection_descriptor_args(&json!({
            "provider": "azure",
            "id": "vm-1",
            "name": "n",
            "region": "eastus",
            "network_mode": "azure_bastion",
            "subscription_id": "sub-1",
            "resource_group": "rg-1",
            "bastion_name": "bast-1"
        }))
        .unwrap();
        assert_pair(&a, "--network-mode", "azure_bastion");
        assert_pair(&a, "--subscription-id", "sub-1");
        assert_pair(&a, "--resource-group", "rg-1");
        assert_pair(&a, "--bastion-name", "bast-1");
    }

    #[test]
    fn cloud_connection_descriptor_propagates_aws_profile() {
        let a = build_cloud_connection_descriptor_args(&json!({
            "provider": "aws",
            "id": "i-1",
            "name": "n",
            "region": "us-east-1",
            "aws_profile": "default"
        }))
        .unwrap();
        assert_pair(&a, "--aws-profile", "default");
    }

    // ── reaper_run_once / status ────────────────────────────────

    #[test]
    fn reaper_run_once_args_invoke_cloud_reaper_run() {
        let a = build_reaper_run_once_args(&json!({})).unwrap();
        assert_eq!(a, vec!["cloud", "reaper", "run", "--format", "json"]);
    }

    #[test]
    fn reaper_status_args_invoke_cloud_reaper_status() {
        let a = build_reaper_status_args(&json!({})).unwrap();
        assert_eq!(a, vec!["cloud", "reaper", "status", "--format", "json"]);
    }

    // ── budget_get / set / usage ────────────────────────────────

    #[test]
    fn budget_get_args_forward_org_to_dash_org_flag() {
        let a = build_budget_get_args(&json!({ "org_id": "acme" })).unwrap();
        assert_eq!(a[0], "cloud");
        assert_eq!(a[1], "budget");
        assert_eq!(a[2], "get");
        assert_pair(&a, "--org", "acme");
    }

    #[test]
    fn budget_set_args_translate_monthly_cap_cents_to_dash_monthly_cents() {
        let a = build_budget_set_args(&json!({
            "org_id": "acme",
            "monthly_cap_cents": 5000
        }))
        .unwrap();
        assert_pair(&a, "--org", "acme");
        assert_pair(&a, "--monthly-cents", "5000");
    }

    #[test]
    fn budget_set_rejects_zero_cap_cents() {
        // Cost-guardrail check: a zero cap is a configuration mistake,
        // not a legitimate "no spend allowed" signal. The CLI itself
        // also rejects it; we surface a structured SchemaValidation
        // error rather than spend a subprocess on a typo.
        let r = build_budget_set_args(&json!({
            "org_id": "acme",
            "monthly_cap_cents": 0
        }));
        assert!(r.is_err(), "zero cents cap must be rejected");
        let msg = r.unwrap_err().to_string();
        assert!(msg.contains("monthly_cap_cents"));
    }

    #[test]
    fn budget_set_rejects_missing_cap_cents() {
        let r = build_budget_set_args(&json!({ "org_id": "acme" }));
        assert!(r.is_err());
    }

    #[test]
    fn budget_usage_args_forward_org_to_dash_org_flag() {
        let a = build_budget_usage_args(&json!({ "org_id": "acme" })).unwrap();
        assert_pair(&a, "--org", "acme");
    }

    // ── stack_apply / destroy / plan_cost ───────────────────────

    #[test]
    fn stack_apply_args_emit_vars_as_param_flags() {
        let a = build_stack_apply_args(&json!({
            "stack_name": "dev-cluster",
            "module_path": "./modules/k8s",
            "vars": { "region": "us-east-1", "node_count": 3 }
        }))
        .unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--stack-name dev-cluster"));
        assert!(joined.contains("--module-path ./modules/k8s"));
        assert!(joined.contains("--param region=us-east-1"));
        assert!(joined.contains("--param node_count=3"));
    }

    #[test]
    fn stack_apply_requires_stack_name_and_module_path() {
        // Stack lifecycle is destructive; missing the workspace key
        // could wipe the wrong stack. Reject early.
        assert!(build_stack_apply_args(&json!({ "stack_name": "x" })).is_err());
        assert!(build_stack_apply_args(&json!({ "module_path": "./p" })).is_err());
    }

    #[test]
    fn stack_apply_rejects_nested_var_objects() {
        let r = build_stack_apply_args(&json!({
            "stack_name": "s",
            "module_path": "./p",
            "vars": { "tags": { "team": "ops" } }
        }));
        assert!(r.is_err(), "nested var object must be rejected");
    }

    #[test]
    fn stack_destroy_args_drop_module_path_from_argv() {
        // The destroy CLI verb keys the workspace on --stack-name and
        // does NOT consume --module-path; we accept the field for API
        // symmetry with apply/plan-cost and silently drop it from argv.
        let a = build_stack_destroy_args(&json!({
            "stack_name": "dev-cluster",
            "module_path": "./modules/k8s"
        }))
        .unwrap();
        assert_pair(&a, "--stack-name", "dev-cluster");
        assert!(
            !a.iter().any(|s| s == "--module-path"),
            "destroy must not forward --module-path (CLI doesn't read it)"
        );
    }

    #[test]
    fn stack_plan_cost_args_carry_vars() {
        let a = build_stack_plan_cost_args(&json!({
            "stack_name": "dev-cluster",
            "module_path": "./modules/k8s",
            "vars": { "instance_type": "t3.small" }
        }))
        .unwrap();
        assert_eq!(a[0], "stack");
        assert_eq!(a[1], "plan-cost");
        let joined = a.join(" ");
        assert!(joined.contains("--param instance_type=t3.small"));
    }

    // ── creds_set / get / remove ────────────────────────────────

    #[test]
    fn creds_set_args_explode_aws_plaintext_to_per_flag_argv() {
        // The CLI does NOT accept a `--plaintext-json` blob; the
        // plugin keeps a uniform JSON shape and splits to per-flag
        // argv here so secrets never round-trip through a JSON-on-
        // argv encoding.
        let a = build_creds_set_args(&json!({
            "org_id": "acme",
            "backend": "aws",
            "plaintext_json": {
                "access_key_id": "AKIA...",
                "secret_access_key": "wJal...",
                "session_token": "FQoG..."
            }
        }))
        .unwrap();
        assert_eq!(a[0], "cloud");
        assert_eq!(a[1], "creds");
        assert_eq!(a[2], "set");
        assert_pair(&a, "--org", "acme");
        assert_pair(&a, "--backend", "aws");
        assert_pair(&a, "--access-key-id", "AKIA...");
        assert_pair(&a, "--secret-access-key", "wJal...");
        assert_pair(&a, "--session-token", "FQoG...");
    }

    #[test]
    fn creds_set_args_explode_azure_plaintext_to_per_flag_argv() {
        let a = build_creds_set_args(&json!({
            "org_id": "acme",
            "backend": "azure",
            "plaintext_json": {
                "tenant_id": "t-1",
                "client_id": "c-1",
                "client_secret": "s-1"
            }
        }))
        .unwrap();
        assert_pair(&a, "--backend", "azure");
        assert_pair(&a, "--tenant-id", "t-1");
        assert_pair(&a, "--client-id", "c-1");
        assert_pair(&a, "--client-secret", "s-1");
    }

    #[test]
    fn creds_set_omits_aws_session_token_when_absent() {
        // session_token is the only optional field in the AWS bundle.
        // Verify the flag is dropped entirely (not pushed empty).
        let a = build_creds_set_args(&json!({
            "org_id": "acme",
            "backend": "aws",
            "plaintext_json": {
                "access_key_id": "AKIA...",
                "secret_access_key": "wJal..."
            }
        }))
        .unwrap();
        assert!(!a.iter().any(|s| s == "--session-token"));
    }

    #[test]
    fn creds_set_rejects_unknown_backend() {
        let r = build_creds_set_args(&json!({
            "org_id": "acme",
            "backend": "gcp",
            "plaintext_json": {}
        }));
        assert!(r.is_err());
    }

    #[test]
    fn creds_set_rejects_aws_bundle_missing_secret_access_key() {
        let r = build_creds_set_args(&json!({
            "org_id": "acme",
            "backend": "aws",
            "plaintext_json": { "access_key_id": "AKIA..." }
        }));
        assert!(r.is_err(), "AWS bundle without secret_access_key must fail");
        let msg = r.unwrap_err().to_string();
        // Error message must name the missing field so the operator
        // knows exactly what to supply.
        assert!(
            msg.contains("secret_access_key"),
            "error must name the missing field; got {:?}",
            msg
        );
    }

    #[test]
    fn creds_set_rejects_azure_bundle_missing_client_secret() {
        let r = build_creds_set_args(&json!({
            "org_id": "acme",
            "backend": "azure",
            "plaintext_json": {
                "tenant_id": "t",
                "client_id": "c"
            }
        }));
        assert!(r.is_err());
        let msg = r.unwrap_err().to_string();
        assert!(msg.contains("client_secret"));
    }

    #[test]
    fn creds_get_args_carry_org_and_backend() {
        let a = build_creds_get_args(&json!({
            "org_id": "acme",
            "backend": "aws"
        }))
        .unwrap();
        assert_eq!(a[0], "cloud");
        assert_eq!(a[1], "creds");
        assert_eq!(a[2], "get");
        assert_pair(&a, "--org", "acme");
        assert_pair(&a, "--backend", "aws");
    }

    #[test]
    fn creds_remove_args_carry_org_and_backend() {
        let a = build_creds_remove_args(&json!({
            "org_id": "acme",
            "backend": "azure"
        }))
        .unwrap();
        assert_eq!(a[2], "remove");
        assert_pair(&a, "--backend", "azure");
    }
}
