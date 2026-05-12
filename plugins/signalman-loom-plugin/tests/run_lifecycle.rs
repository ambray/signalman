//! Integration: simulate a full run lifecycle end-to-end through the
//! plugin's state-store layer, including the "host restarted" recovery
//! path that closes audit finding C1.
//!
//! These tests bypass the real Signalman subprocess and exercise the
//! `finalize_*` glue layer directly. End-to-end tests with a real
//! Signalman invocation belong in P7 (gated E2E lane) once the test
//! harness can fake or boot a Signalman binary.

use loom_core::{LoomError, LoomResult};
use serde_json::{Value, json};
use signalman_loom_plugin::handlers::{finalize_run_start, finalize_status};
use signalman_loom_plugin::state::{RunStateStore, RunStatus};
use tempfile::tempdir;

#[test]
fn full_lifecycle_started_streaming_finished() {
    let dir = tempdir().unwrap();
    let store = RunStateStore::new(dir.path()).unwrap();

    // 1. Agent invokes loom.signalman.run; subprocess returns just a handle.
    let run_args = json!({ "id": "mygroup/v2/scenario-a" });
    let run_resp = json!({ "run_id": "lifecycle-1", "started_at": "now" });
    let returned = finalize_run_start(&run_args, run_resp, &store).unwrap();
    assert_eq!(returned["run_id"], "lifecycle-1");
    assert_eq!(
        store.load("lifecycle-1").unwrap().unwrap().status,
        RunStatus::Started
    );

    // 2. Agent polls status; subprocess returns partial events.
    let status_args = json!({ "run_id": "lifecycle-1", "wait_ms": 1000 });
    let s1 = json!({ "envelope": { "events": [{ "seq": 1 }, { "seq": 2 }] } });
    finalize_status(&status_args, Ok(s1), &store).unwrap();
    let st1 = store.load("lifecycle-1").unwrap().unwrap();
    assert_eq!(st1.status, RunStatus::Streaming);
    assert_eq!(st1.last_event_seq, 2);

    // 3. Agent polls again; terminal envelope arrives.
    let s2 = json!({
        "envelope": { "result": "pass", "events": [{ "seq": 3 }] }
    });
    finalize_status(&status_args, Ok(s2), &store).unwrap();
    let st2 = store.load("lifecycle-1").unwrap().unwrap();
    assert_eq!(st2.status, RunStatus::Finished);
    assert_eq!(st2.envelope.as_ref().unwrap()["result"], "pass");
}

/// Audit C1 close: simulate "Signalman host restart mid-run" by recreating
/// the store from the same data dir and confirming the run handle is still
/// recoverable.
#[test]
fn run_handle_survives_plugin_recreation() {
    let dir = tempdir().unwrap();

    // First plugin process: start a run, observe streaming events.
    {
        let store = RunStateStore::new(dir.path()).unwrap();
        finalize_run_start(
            &json!({ "id": "scn" }),
            json!({ "run_id": "survives-1" }),
            &store,
        )
        .unwrap();
        finalize_status(
            &json!({ "run_id": "survives-1" }),
            Ok(json!({
                "envelope": { "events": [{ "seq": 5 }] }
            })),
            &store,
        )
        .unwrap();
    }

    // Plugin process is gone; data dir persists. Recreate.
    {
        let store = RunStateStore::new(dir.path()).unwrap();
        let inflight = store.list_in_flight().unwrap();
        assert_eq!(inflight.len(), 1);
        assert_eq!(inflight[0].run_id, "survives-1");
        assert_eq!(inflight[0].last_event_seq, 5);
        assert_eq!(inflight[0].status, RunStatus::Streaming);
    }
}

/// Audit C1 close: when the underlying Signalman host has died and a status
/// poll fails, the agent gets a Lost-marked response carrying the last
/// known envelope rather than a not-found error.
#[test]
fn lost_run_returns_last_known_state_with_recovery_marker() {
    let dir = tempdir().unwrap();
    let store = RunStateStore::new(dir.path()).unwrap();

    finalize_run_start(
        &json!({ "id": "scn" }),
        json!({ "run_id": "lost-1" }),
        &store,
    )
    .unwrap();
    finalize_status(
        &json!({ "run_id": "lost-1" }),
        Ok(json!({
            "envelope": { "events": [{ "seq": 3 }] }
        })),
        &store,
    )
    .unwrap();

    // Subprocess fails on next poll.
    let err: LoomResult<Value> =
        Err(LoomError::PluginRuntime("ECONNREFUSED 127.0.0.1:17777".to_string()));
    let recovered = finalize_status(&json!({ "run_id": "lost-1" }), err, &store).unwrap();

    assert_eq!(recovered["status"], "lost");
    assert_eq!(recovered["recovered_from_state_file"], true);
    assert_eq!(recovered["last_event_seq"], 3);
    assert!(
        recovered["last_error"]
            .as_str()
            .unwrap()
            .contains("ECONNREFUSED")
    );
    assert!(
        recovered.get("envelope").is_some(),
        "lost-recovery payload must carry the last observed envelope so the agent has the events it already paid to receive"
    );
}

/// Multiple concurrent runs are tracked independently; finishing one does
/// not affect the others.
#[test]
fn multiple_runs_are_isolated() {
    let dir = tempdir().unwrap();
    let store = RunStateStore::new(dir.path()).unwrap();

    for (id, scn) in [("a", "scn-a"), ("b", "scn-b"), ("c", "scn-c")] {
        finalize_run_start(
            &json!({ "id": scn }),
            json!({ "run_id": id }),
            &store,
        )
        .unwrap();
    }

    finalize_status(
        &json!({ "run_id": "b" }),
        Ok(json!({ "envelope": { "result": "pass" } })),
        &store,
    )
    .unwrap();

    let inflight = store.list_in_flight().unwrap();
    let mut ids: Vec<&str> = inflight.iter().map(|s| s.run_id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["a", "c"]);
    assert_eq!(
        store.load("b").unwrap().unwrap().status,
        RunStatus::Finished
    );
}
