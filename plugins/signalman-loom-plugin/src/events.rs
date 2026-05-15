//! Live event streaming into Loom's `EventBus` (P5.3 — closes audit C2).
//!
//! P5.3 closes audit C2: agents subscribe to Loom's EventBus for run
//! progress instead of Signalman building its own streaming protocol.
//! Trace-id propagation rides on `TelemetryEvent.labels["signalman-trace-id"]`,
//! which closes audit C10's residual.
//!
//! # Why a trait instead of a direct `loom_core::event_bus::EventBus`?
//!
//! At the time P5.3 lands, the exact `EventBus` surface in `loom-core` is
//! still settling — concretely, whether `PluginContext` exposes the bus
//! handle directly, whether `publish` is sync or async, and whether the
//! event payload type is named `TelemetryEvent` vs. something else. The
//! trait below pins the *plugin-side* contract (one synchronous
//! fire-and-forget call per event, with a labels map carrying trace
//! correlation) so the rest of the plugin can integrate without depending
//! on whichever shape Loom ultimately ships.
//!
//! When Loom exposes a stable bus handle, [`LoomBusEmitter`] is the only
//! piece that needs updating: it stores whatever handle Loom hands us and
//! its [`EventSink::publish`] forwards into Loom's API. Tests use
//! [`MockEventSink`] which captures published events into a `Vec` so the
//! test suite stays green even when Loom isn't available at compile time.
//!
//! # Event taxonomy (matches ROADMAP §P5.3)
//!
//! Event kinds use the `signalman.run.<phase>` namespace, mapping the
//! Signalman envelope event types (`host/src/output/envelope.ts`) onto
//! Loom-flavoured names. The mapping is intentionally lossy in only one
//! direction: rare envelope events (`vm.state_changed`, `tool.*`, `log`)
//! are NOT promoted to the EventBus; agents that care about them still
//! get them through `loom.signalman.status`. The bus is the agent's
//! *progress* channel, not a full audit log.
//!
//! ```text
//! signalman.run.started        ← envelope event run.started OR record_started
//! signalman.run.streaming      ← Started → Streaming transition
//! signalman.run.step_started   ← envelope event step.started
//! signalman.run.step_completed ← envelope event step.completed
//! signalman.run.step_failed    ← envelope event step.failed
//! signalman.run.assertion_passed ← envelope event assertion.passed
//! signalman.run.assertion_failed ← envelope event assertion.failed
//! signalman.run.finished       ← terminal envelope (result=pass|fail|error|skipped)
//! signalman.run.lost           ← Streaming → Lost transition
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// Label key that carries the cross-process trace-id on every emitted
/// event. Mirrors the gRPC metadata header Signalman injects on outbound
/// VM calls so a single trace_id correlates Loom + Signalman + service
/// log lines. Closes audit C10 residual (P5.3 scope).
pub const TRACE_ID_LABEL: &str = "signalman-trace-id";

/// Label key that carries the run handle. Set on every event so a
/// subscriber can filter `kind == "signalman.run.*" AND
/// labels["signalman-run-id"] == "<handle>"` without parsing the payload.
pub const RUN_ID_LABEL: &str = "signalman-run-id";

/// Label key that carries the scenario id when known. Optional — not
/// every event has scenario-id context (e.g. `signalman.run.lost` may
/// fire on a state-store record that pre-dates the scenario being
/// recorded). Subscribers should treat missing as "unknown".
pub const SCENARIO_ID_LABEL: &str = "signalman-scenario-id";

/// Taxonomy of plugin-level events emitted onto Loom's EventBus.
///
/// Kept narrow on purpose — see the module-level doc for which envelope
/// events get promoted. Adding a variant is a non-breaking change for
/// subscribers (they should default to "unknown" for variants they don't
/// recognise), but please update the ROADMAP P5.3 taxonomy section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEventKind {
    /// Run handle accepted by Signalman and recorded by the plugin.
    Started,
    /// First event(s) drained from a poll; the run is actively streaming.
    Streaming,
    /// A single step began executing.
    StepStarted,
    /// A single step completed successfully.
    StepCompleted,
    /// A single step failed (non-recoverable for that step).
    StepFailed,
    /// An assertion against scenario state passed.
    AssertionPassed,
    /// An assertion against scenario state failed.
    AssertionFailed,
    /// Terminal envelope received from Signalman; run is finished.
    RunFinished,
    /// Subprocess died / disappeared; the run is unrecoverable.
    Lost,
}

impl RunEventKind {
    /// Wire string for the `TelemetryEvent.kind` field. Stable across
    /// minor versions; subscribers match on these. **Renaming a variant
    /// is a breaking change** — bump the plugin manifest version.
    pub fn kind_str(self) -> &'static str {
        match self {
            Self::Started => "signalman.run.started",
            Self::Streaming => "signalman.run.streaming",
            Self::StepStarted => "signalman.run.step_started",
            Self::StepCompleted => "signalman.run.step_completed",
            Self::StepFailed => "signalman.run.step_failed",
            Self::AssertionPassed => "signalman.run.assertion_passed",
            Self::AssertionFailed => "signalman.run.assertion_failed",
            Self::RunFinished => "signalman.run.finished",
            Self::Lost => "signalman.run.lost",
        }
    }

    /// Map a Signalman envelope event `type` (e.g. `"step.started"`) to
    /// the corresponding bus kind. Returns `None` for envelope events
    /// that are intentionally not promoted to the bus (see module doc).
    pub fn from_envelope_event_type(envelope_type: &str) -> Option<Self> {
        match envelope_type {
            "run.started" => Some(Self::Started),
            "run.finished" => Some(Self::RunFinished),
            "step.started" => Some(Self::StepStarted),
            "step.completed" => Some(Self::StepCompleted),
            "step.failed" => Some(Self::StepFailed),
            "assertion.passed" => Some(Self::AssertionPassed),
            "assertion.failed" => Some(Self::AssertionFailed),
            // step.skipped, step.retry_started, vm.state_changed,
            // tool.started, tool.completed, log → not promoted.
            _ => None,
        }
    }
}

/// One published event. Mirrors the shape we expect Loom's
/// `TelemetryEvent` to take — when Loom's API stabilises this struct is
/// either replaced with the canonical type or kept as the
/// plugin-side mapping layer (whichever the integration prefers).
#[derive(Debug, Clone, PartialEq)]
pub struct EmittedEvent {
    /// `signalman.run.<phase>` taxonomy.
    pub kind: String,
    /// Run handle this event belongs to. Hoisted out of `payload` to
    /// match Loom's expected `repo_id` correlation slot — Loom uses
    /// `repo_id` semantically as "the entity this stream belongs to".
    pub run_id: String,
    /// Free-form labels. Always carries [`TRACE_ID_LABEL`] when the
    /// run has a known trace-id, plus [`RUN_ID_LABEL`] (duplicated for
    /// label-based filtering) and optionally [`SCENARIO_ID_LABEL`].
    pub labels: HashMap<String, String>,
    /// Event-specific JSON payload. Forward-compatible: subscribers
    /// must tolerate unknown fields.
    pub payload: Value,
    /// Epoch milliseconds at emission. Set by [`emit_run_event`]
    /// rather than the caller so all events share a clock source.
    pub timestamp_ms: u64,
    /// Monotonically-increasing sequence number assigned by the
    /// [`EventEmitter`]. Lets subscribers detect dropped events even
    /// if the bus reorders.
    pub seq: u64,
}

/// Plugin-side abstraction over Loom's EventBus. The real implementation
/// forwards into `loom_core::event_bus::EventBus::publish`; the test
/// implementation captures into a `Vec` for assertions.
///
/// Sync + fire-and-forget by contract. If Loom's actual `publish` turns
/// out to be `async`, the real impl spawns onto a runtime here; the
/// plugin handler call sites stay the same.
pub trait EventSink: Send + Sync {
    /// Publish a single event. Implementations MUST be best-effort and
    /// non-blocking — a slow or failed sink must not back up the
    /// plugin's tool-handler critical path.
    fn publish(&self, event: EmittedEvent);
}

/// Default no-op sink. Used when the plugin can't acquire a real
/// EventBus handle (e.g. older Loom builds without `PluginContext`
/// exposure). Lets the rest of the plugin keep emitting without
/// branching on `Option<&dyn EventSink>` everywhere.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn publish(&self, _event: EmittedEvent) {
        // intentional no-op
    }
}

/// Owns the sink + sequence counter and is the single call site that
/// stamps timestamps and labels onto outgoing events. Cheap to clone (the
/// inner `Arc<dyn EventSink>` is reference-counted) so handlers can hold
/// their own copy without contention.
#[derive(Clone)]
pub struct EventEmitter {
    inner: std::sync::Arc<EventEmitterInner>,
}

struct EventEmitterInner {
    sink: Box<dyn EventSink + Send + Sync>,
    seq: AtomicU64,
}

impl std::fmt::Debug for EventEmitter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventEmitter")
            .field("seq", &self.inner.seq.load(Ordering::Relaxed))
            .finish()
    }
}

impl EventEmitter {
    /// Build an emitter wrapping the given sink.
    pub fn new(sink: Box<dyn EventSink + Send + Sync>) -> Self {
        Self {
            inner: std::sync::Arc::new(EventEmitterInner {
                sink,
                seq: AtomicU64::new(0),
            }),
        }
    }

    /// Convenience constructor for the no-op sink (production fallback
    /// when a real EventBus handle isn't yet available).
    pub fn noop() -> Self {
        Self::new(Box::new(NoopEventSink))
    }

    /// Returns the next sequence number and bumps the counter.
    fn next_seq(&self) -> u64 {
        self.inner.seq.fetch_add(1, Ordering::Relaxed)
    }
}

/// Build + publish a single run event. Handles label assembly +
/// timestamp + sequence number assignment so call sites stay terse.
pub fn emit_run_event(
    emitter: &EventEmitter,
    run_id: &str,
    kind: RunEventKind,
    payload: Value,
    trace_id: Option<&str>,
    scenario_id: Option<&str>,
) {
    let mut labels = HashMap::new();
    labels.insert(RUN_ID_LABEL.to_string(), run_id.to_string());
    if let Some(t) = trace_id {
        labels.insert(TRACE_ID_LABEL.to_string(), t.to_string());
    }
    if let Some(s) = scenario_id {
        labels.insert(SCENARIO_ID_LABEL.to_string(), s.to_string());
    }
    let event = EmittedEvent {
        kind: kind.kind_str().to_string(),
        run_id: run_id.to_string(),
        labels,
        payload,
        timestamp_ms: now_ms(),
        seq: emitter.next_seq(),
    };
    emitter.inner.sink.publish(event);
}

/// Iterate the events array of a Signalman envelope and emit a bus
/// event for each one whose envelope `type` maps to a [`RunEventKind`]
/// (per [`RunEventKind::from_envelope_event_type`]). The original event
/// JSON is forwarded as the payload verbatim. Used by the run / status
/// handlers to layer EventBus emission alongside the existing state
/// transitions without duplicating the parse logic.
///
/// Returns the number of events emitted (useful for tests + metrics).
pub fn emit_envelope_events(
    emitter: &EventEmitter,
    run_id: &str,
    envelope: &Value,
    trace_id: Option<&str>,
    scenario_id: Option<&str>,
) -> usize {
    let Some(events) = envelope.get("events").and_then(Value::as_array) else {
        return 0;
    };
    let mut emitted = 0;
    for ev in events {
        let Some(ty) = ev.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some(kind) = RunEventKind::from_envelope_event_type(ty) else {
            continue;
        };
        emit_run_event(emitter, run_id, kind, ev.clone(), trace_id, scenario_id);
        emitted += 1;
    }
    emitted
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── test scaffolding ──────────────────────────────────────────────────

/// In-memory sink for unit + integration tests. Captures every published
/// event into a `Vec` so assertions can inspect them after the action
/// under test. Not cfg-gated to `test` so integration tests in
/// `tests/` (which compile as separate crates and cannot see
/// `#[cfg(test)]` items) can use it too.
#[derive(Debug, Default, Clone)]
pub struct MockEventSink {
    events: std::sync::Arc<Mutex<Vec<EmittedEvent>>>,
}

impl MockEventSink {
    pub fn new() -> Self {
        Self {
            events: std::sync::Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Snapshot of every event published since construction. Returns a
    /// clone so callers can iterate without holding the lock.
    pub fn published(&self) -> Vec<EmittedEvent> {
        self.events.lock().expect("mock sink poisoned").clone()
    }

    /// Returns the number of events published since construction.
    pub fn len(&self) -> usize {
        self.events.lock().expect("mock sink poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Returns every event whose `kind` matches `expected`.
    pub fn filter_by_kind(&self, expected: &str) -> Vec<EmittedEvent> {
        self.published()
            .into_iter()
            .filter(|e| e.kind == expected)
            .collect()
    }
}

impl EventSink for MockEventSink {
    fn publish(&self, event: EmittedEvent) {
        self.events.lock().expect("mock sink poisoned").push(event);
    }
}

/// Convenience: build an [`EventEmitter`] backed by a fresh
/// [`MockEventSink`] and return both. The mock is cloned out so the
/// caller retains a handle for assertions.
pub fn mock_emitter() -> (EventEmitter, MockEventSink) {
    let mock = MockEventSink::new();
    let emitter = EventEmitter::new(Box::new(mock.clone()));
    (emitter, mock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kind_str_uses_signalman_run_namespace() {
        // Stable wire taxonomy — renaming any of these is a breaking
        // change for subscribers, hence the explicit pinned strings.
        assert_eq!(RunEventKind::Started.kind_str(), "signalman.run.started");
        assert_eq!(
            RunEventKind::Streaming.kind_str(),
            "signalman.run.streaming"
        );
        assert_eq!(
            RunEventKind::StepStarted.kind_str(),
            "signalman.run.step_started"
        );
        assert_eq!(
            RunEventKind::StepCompleted.kind_str(),
            "signalman.run.step_completed"
        );
        assert_eq!(
            RunEventKind::StepFailed.kind_str(),
            "signalman.run.step_failed"
        );
        assert_eq!(
            RunEventKind::AssertionPassed.kind_str(),
            "signalman.run.assertion_passed"
        );
        assert_eq!(
            RunEventKind::AssertionFailed.kind_str(),
            "signalman.run.assertion_failed"
        );
        assert_eq!(
            RunEventKind::RunFinished.kind_str(),
            "signalman.run.finished"
        );
        assert_eq!(RunEventKind::Lost.kind_str(), "signalman.run.lost");
    }

    #[test]
    fn from_envelope_event_type_promotes_documented_types() {
        // Promoted types — must round-trip into a kind.
        for (envelope_ty, expected) in [
            ("run.started", RunEventKind::Started),
            ("run.finished", RunEventKind::RunFinished),
            ("step.started", RunEventKind::StepStarted),
            ("step.completed", RunEventKind::StepCompleted),
            ("step.failed", RunEventKind::StepFailed),
            ("assertion.passed", RunEventKind::AssertionPassed),
            ("assertion.failed", RunEventKind::AssertionFailed),
        ] {
            assert_eq!(
                RunEventKind::from_envelope_event_type(envelope_ty),
                Some(expected),
                "envelope type {} must map to a bus kind",
                envelope_ty
            );
        }
    }

    #[test]
    fn from_envelope_event_type_drops_non_promoted_types() {
        // These ARE valid envelope event types (see envelope.ts) but
        // are intentionally not promoted to the bus.
        for not_promoted in [
            "step.skipped",
            "step.retry_started",
            "vm.state_changed",
            "tool.started",
            "tool.completed",
            "log",
        ] {
            assert_eq!(
                RunEventKind::from_envelope_event_type(not_promoted),
                None,
                "envelope type {} must NOT be promoted",
                not_promoted
            );
        }
    }

    #[test]
    fn from_envelope_event_type_returns_none_for_unknown_types() {
        assert_eq!(
            RunEventKind::from_envelope_event_type("totally.made.up"),
            None
        );
        assert_eq!(RunEventKind::from_envelope_event_type(""), None);
    }

    #[test]
    fn emit_run_event_stamps_labels_and_seq() {
        let (emitter, mock) = mock_emitter();
        emit_run_event(
            &emitter,
            "run-1",
            RunEventKind::Started,
            json!({ "scenario_id": "scn" }),
            Some("trace-abc"),
            Some("scn"),
        );
        emit_run_event(
            &emitter,
            "run-1",
            RunEventKind::RunFinished,
            json!({ "result": "pass" }),
            Some("trace-abc"),
            Some("scn"),
        );

        let events = mock.published();
        assert_eq!(events.len(), 2);

        let first = &events[0];
        assert_eq!(first.kind, "signalman.run.started");
        assert_eq!(first.run_id, "run-1");
        assert_eq!(first.seq, 0);
        assert_eq!(
            first.labels.get(TRACE_ID_LABEL).map(String::as_str),
            Some("trace-abc")
        );
        assert_eq!(
            first.labels.get(RUN_ID_LABEL).map(String::as_str),
            Some("run-1")
        );
        assert_eq!(
            first.labels.get(SCENARIO_ID_LABEL).map(String::as_str),
            Some("scn")
        );
        assert_eq!(first.payload["scenario_id"], "scn");

        let second = &events[1];
        assert_eq!(second.seq, 1, "seq must monotonically increment");
        assert_eq!(second.kind, "signalman.run.finished");
    }

    #[test]
    fn emit_run_event_omits_trace_label_when_unknown() {
        let (emitter, mock) = mock_emitter();
        emit_run_event(
            &emitter,
            "run-1",
            RunEventKind::Started,
            json!({}),
            None,
            None,
        );
        let events = mock.published();
        let labels = &events[0].labels;
        // Only the run-id label is unconditional.
        assert_eq!(labels.len(), 1);
        assert!(labels.contains_key(RUN_ID_LABEL));
        assert!(!labels.contains_key(TRACE_ID_LABEL));
        assert!(!labels.contains_key(SCENARIO_ID_LABEL));
    }

    #[test]
    fn emit_envelope_events_promotes_recognised_types_and_skips_others() {
        let (emitter, mock) = mock_emitter();
        let envelope = json!({
            "events": [
                { "seq": 0, "type": "run.started" },
                { "seq": 1, "type": "step.started", "step_index": 0 },
                { "seq": 2, "type": "log", "message": "noise" },        // skipped
                { "seq": 3, "type": "step.completed", "step_index": 0 },
                { "seq": 4, "type": "vm.state_changed", "vm": "endpoint-1" }, // skipped
                { "seq": 5, "type": "assertion.failed", "id": "assert-1" },
                { "seq": 6, "type": "run.finished", "result": "fail" },
            ]
        });
        let n = emit_envelope_events(&emitter, "run-1", &envelope, Some("trace-xyz"), Some("scn"));
        assert_eq!(n, 5, "5 of 7 envelope events must be promoted");

        let kinds: Vec<String> = mock.published().iter().map(|e| e.kind.clone()).collect();
        assert_eq!(
            kinds,
            vec![
                "signalman.run.started".to_string(),
                "signalman.run.step_started".to_string(),
                "signalman.run.step_completed".to_string(),
                "signalman.run.assertion_failed".to_string(),
                "signalman.run.finished".to_string(),
            ]
        );

        // Original event JSON survives in the payload.
        let started = mock.filter_by_kind("signalman.run.step_started");
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].payload["step_index"], 0);
    }

    #[test]
    fn emit_envelope_events_handles_missing_or_malformed_events_array() {
        let (emitter, mock) = mock_emitter();
        // No events field → 0 emissions, no panic.
        assert_eq!(
            emit_envelope_events(&emitter, "r", &json!({}), None, None),
            0
        );
        // Events field is the wrong type → 0 emissions, no panic.
        assert_eq!(
            emit_envelope_events(
                &emitter,
                "r",
                &json!({ "events": "not-an-array" }),
                None,
                None
            ),
            0
        );
        // Event without `type` is silently skipped.
        let n = emit_envelope_events(
            &emitter,
            "r",
            &json!({ "events": [{ "seq": 0 }, { "seq": 1, "type": "step.started" }] }),
            None,
            None,
        );
        assert_eq!(n, 1);
        assert!(mock.len() == 1);
    }

    #[test]
    fn noop_sink_publishes_silently_without_errors() {
        // Defensive: NoopEventSink must compile and accept publishes
        // without doing anything.
        let emitter = EventEmitter::noop();
        emit_run_event(&emitter, "r", RunEventKind::Lost, json!({}), None, None);
        // No assertion possible (sink discards); the test asserts the
        // call doesn't panic.
    }

    #[test]
    fn emitter_is_shareable_across_threads() {
        let (emitter, mock) = mock_emitter();
        let mut handles = Vec::new();
        for i in 0..8 {
            let e = emitter.clone();
            handles.push(std::thread::spawn(move || {
                emit_run_event(
                    &e,
                    &format!("run-{}", i),
                    RunEventKind::StepStarted,
                    json!({ "i": i }),
                    None,
                    None,
                );
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(mock.len(), 8, "every thread's event must land");
        // seq values must be unique across threads (atomic counter).
        let mut seqs: Vec<u64> = mock.published().iter().map(|e| e.seq).collect();
        seqs.sort();
        seqs.dedup();
        assert_eq!(seqs.len(), 8);
    }

    #[test]
    fn label_keys_are_stable_constants() {
        // Subscribers depend on these exact strings; any rename is a
        // breaking change for them. Re-asserting the values protects
        // against accidental edits.
        assert_eq!(TRACE_ID_LABEL, "signalman-trace-id");
        assert_eq!(RUN_ID_LABEL, "signalman-run-id");
        assert_eq!(SCENARIO_ID_LABEL, "signalman-scenario-id");
    }
}
