//! Run-handle persistence (P5.2 — closes audit C1).
//!
//! When an agent invokes `loom.signalman.run`, the plugin records the run
//! handle and a state envelope to `<plugin_data_dir>/runs/<run_id>.json`.
//! On every subsequent `loom.signalman.status` call, the state is updated
//! atomically and surfaced even if the underlying Signalman host has
//! restarted (or died) in the interim. This is the Loom-fronted version
//! of the audit C1 fix: persistence lives in the plugin (Loom-managed
//! state) rather than in Signalman's in-memory `Map`.
//!
//! State machine (mirrors Loom's [`TaskOwnershipStatus`] shape):
//!
//! ```text
//!         start
//!           │
//!           ▼
//!       ┌───────┐  events arrive    ┌───────────┐  envelope.terminal=true
//!       │Started│ ─────────────────▶│ Streaming │ ──────────────────────▶ Finished
//!       └───┬───┘                   └─────┬─────┘
//!           │ subprocess error            │ subprocess error
//!           ▼                             ▼
//!         Lost                          Lost
//!           │
//!           │ no progress for N minutes (deferred to P5.3)
//!           ▼
//!         Stale
//! ```
//!
//! P5.2 does NOT yet implement Stale detection — that requires a
//! background reconciler which lands with P5.3 once we have an event-bus
//! tick to hang it off.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use loom_core::{LoomError, LoomResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Lifecycle state for a tracked run. JSON-serialised in the state file
/// under `status`. Forward-compatible: unknown variants on load become
/// `Lost` (with a warning surfaced via the plugin's error envelope).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Run record created; no events observed yet.
    Started,
    /// Events arriving from Signalman.
    Streaming,
    /// Terminal envelope received (pass / fail / error).
    Finished,
    /// Last subprocess invocation failed; underlying Signalman process is
    /// presumed dead. Last known events / envelope are still readable.
    Lost,
    /// In-flight but no progress for too long. Reserved for P5.3.
    Stale,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Finished | Self::Lost | Self::Stale)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Streaming => "streaming",
            Self::Finished => "finished",
            Self::Lost => "lost",
            Self::Stale => "stale",
        }
    }
}

/// Persisted state for a single run. Forward-compatible: new fields must
/// have `#[serde(default)]` to allow older state files to load cleanly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    /// Run handle as returned by Signalman.
    pub run_id: String,
    /// Scenario id supplied by the agent.
    #[serde(default)]
    pub scenario_id: Option<String>,
    /// Epoch milliseconds at which the run was started (per agent invocation).
    pub started_at_ms: u64,
    /// Epoch milliseconds of the most recent state update.
    pub last_observed_at_ms: u64,
    /// Highest event sequence number we've drained.
    #[serde(default)]
    pub last_event_seq: i64,
    /// Lifecycle state.
    pub status: RunStatus,
    /// The terminal Signalman envelope, populated when `status == Finished`.
    /// Stored verbatim as JSON so future Signalman versions adding fields
    /// pass through unmodified.
    #[serde(default)]
    pub envelope: Option<Value>,
    /// Cross-process trace id (reserved for P3 + P5.3 trace correlation).
    #[serde(default)]
    pub trace_id: Option<String>,
    /// Most recent error message if status == Lost. Plain string for now.
    #[serde(default)]
    pub last_error: Option<String>,
}

impl RunState {
    /// Returns the JSON shape exposed in `loom.signalman.status` responses.
    /// Includes both the persisted state and the most recent Signalman
    /// envelope (when present), so a `Lost` run still carries the last
    /// observed events.
    pub fn to_status_value(&self) -> Value {
        let mut v = json!({
            "run_id": self.run_id,
            "status": self.status.label(),
            "started_at_ms": self.started_at_ms,
            "last_observed_at_ms": self.last_observed_at_ms,
            "last_event_seq": self.last_event_seq,
        });
        if let Some(scenario_id) = &self.scenario_id {
            v["scenario_id"] = json!(scenario_id);
        }
        if let Some(envelope) = &self.envelope {
            v["envelope"] = envelope.clone();
        }
        if let Some(trace_id) = &self.trace_id {
            v["trace_id"] = json!(trace_id);
        }
        if let Some(err) = &self.last_error {
            v["last_error"] = json!(err);
        }
        v
    }
}

/// File-backed persistence layer for run state. One file per run id under
/// `<data_dir>/runs/<run_id>.json`. Writes are atomic (write-temp-then-
/// rename); reads are simple `fs::read` + JSON parse.
///
/// Run-id sanitisation rejects path-traversal sequences so a malicious
/// caller can't write `../../../etc/passwd.json` via a crafted run handle.
pub struct RunStateStore {
    runs_dir: PathBuf,
}

impl RunStateStore {
    /// Constructs a store rooted at `data_dir/runs/`. Creates the directory
    /// on first use; returns an error if creation fails for reasons other
    /// than "already exists."
    pub fn new(data_dir: &Path) -> LoomResult<Self> {
        let runs_dir = data_dir.join("runs");
        if !runs_dir.exists() {
            fs::create_dir_all(&runs_dir)?;
        } else if !runs_dir.is_dir() {
            return Err(LoomError::PluginRuntime(format!(
                "runs path exists but is not a directory: {}",
                runs_dir.display()
            )));
        }
        Ok(Self { runs_dir })
    }

    /// Convenience constructor matching plugin handler call sites.
    pub fn for_plugin(data_dir: &Path) -> LoomResult<Self> {
        Self::new(data_dir)
    }

    fn run_path(&self, run_id: &str) -> LoomResult<PathBuf> {
        validate_run_id(run_id)?;
        Ok(self.runs_dir.join(format!("{}.json", run_id)))
    }

    /// Initial state on `loom.signalman.run`. If a record already exists for
    /// this run id (rare — Signalman shouldn't reuse them) the existing
    /// record is preserved; we update timestamps but keep the original
    /// `started_at_ms`.
    pub fn record_started(
        &self,
        run_id: &str,
        scenario_id: Option<&str>,
        trace_id: Option<&str>,
    ) -> LoomResult<RunState> {
        let now = now_ms();
        let state = match self.load(run_id)? {
            Some(mut existing) => {
                existing.last_observed_at_ms = now;
                if existing.scenario_id.is_none() {
                    existing.scenario_id = scenario_id.map(str::to_string);
                }
                if existing.trace_id.is_none() {
                    existing.trace_id = trace_id.map(str::to_string);
                }
                existing
            }
            None => RunState {
                run_id: run_id.to_string(),
                scenario_id: scenario_id.map(str::to_string),
                started_at_ms: now,
                last_observed_at_ms: now,
                last_event_seq: 0,
                status: RunStatus::Started,
                envelope: None,
                trace_id: trace_id.map(str::to_string),
                last_error: None,
            },
        };
        self.write(&state)?;
        Ok(state)
    }

    /// Update on a successful `loom.signalman.status` poll. `events_drained`
    /// is the highest seq seen in the most recent batch.
    pub fn record_streaming(
        &self,
        run_id: &str,
        events_drained: Option<i64>,
        envelope_so_far: Option<&Value>,
    ) -> LoomResult<RunState> {
        let mut state = self.load(run_id)?.unwrap_or_else(|| RunState {
            run_id: run_id.to_string(),
            scenario_id: None,
            started_at_ms: now_ms(),
            last_observed_at_ms: now_ms(),
            last_event_seq: 0,
            status: RunStatus::Started,
            envelope: None,
            trace_id: None,
            last_error: None,
        });
        state.last_observed_at_ms = now_ms();
        if let Some(seq) = events_drained {
            if seq > state.last_event_seq {
                state.last_event_seq = seq;
            }
        }
        if let Some(env) = envelope_so_far {
            state.envelope = Some(env.clone());
        }
        if !state.status.is_terminal() {
            state.status = RunStatus::Streaming;
            state.last_error = None;
        }
        self.write(&state)?;
        Ok(state)
    }

    /// Mark the run finished and store the terminal envelope.
    pub fn record_finished(&self, run_id: &str, envelope: &Value) -> LoomResult<RunState> {
        let mut state = self.load(run_id)?.unwrap_or_else(|| RunState {
            run_id: run_id.to_string(),
            scenario_id: None,
            started_at_ms: now_ms(),
            last_observed_at_ms: now_ms(),
            last_event_seq: 0,
            status: RunStatus::Started,
            envelope: None,
            trace_id: None,
            last_error: None,
        });
        state.last_observed_at_ms = now_ms();
        state.envelope = Some(envelope.clone());
        state.status = RunStatus::Finished;
        state.last_error = None;
        self.write(&state)?;
        Ok(state)
    }

    /// Mark a run as Lost when the underlying subprocess invocation fails
    /// AND we still have a record for it. Returns `None` if no record exists
    /// (in which case the caller should propagate the original error).
    pub fn record_lost(&self, run_id: &str, reason: &str) -> LoomResult<Option<RunState>> {
        let Some(mut state) = self.load(run_id)? else {
            return Ok(None);
        };
        if state.status.is_terminal() && state.status != RunStatus::Lost {
            // Already terminal (e.g., Finished). Don't downgrade.
            return Ok(Some(state));
        }
        state.last_observed_at_ms = now_ms();
        state.status = RunStatus::Lost;
        state.last_error = Some(reason.to_string());
        self.write(&state)?;
        Ok(Some(state))
    }

    /// Loads a single run state, or `None` if no file exists for that id.
    /// Malformed files (parse error) bubble up as [`LoomError::Json`] so the
    /// caller can decide whether to fall back or fail.
    pub fn load(&self, run_id: &str) -> LoomResult<Option<RunState>> {
        let path = self.run_path(run_id)?;
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path)?;
        let state: RunState = serde_json::from_slice(&bytes)?;
        Ok(Some(state))
    }

    /// Lists every run state in the store. Order is filesystem-arbitrary;
    /// callers that want deterministic order should sort by
    /// `started_at_ms` or `run_id`.
    pub fn list(&self) -> LoomResult<Vec<RunState>> {
        let mut out = Vec::new();
        if !self.runs_dir.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(&self.runs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = fs::read(&path)?;
            // Skip files that fail to parse so one corrupt file doesn't
            // break the whole list. Production deployments may want a
            // structured warning here; for v0.1.0 we just skip.
            if let Ok(state) = serde_json::from_slice::<RunState>(&bytes) {
                out.push(state);
            }
        }
        Ok(out)
    }

    /// Returns runs that have not reached a terminal state. Used by
    /// reconciliation to enumerate things the agent might still want to
    /// re-attach to after a host restart.
    pub fn list_in_flight(&self) -> LoomResult<Vec<RunState>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|s| !s.status.is_terminal())
            .collect())
    }

    /// Atomically writes the state to disk: write to a sibling `.tmp` file,
    /// then rename. `std::fs::rename` is atomic for replace on POSIX and
    /// (since Win 10 1607) on NTFS. Avoids torn writes if the process
    /// crashes mid-update.
    fn write(&self, state: &RunState) -> LoomResult<()> {
        let final_path = self.run_path(&state.run_id)?;
        let mut tmp_path = final_path.clone();
        let tmp_name = format!(
            "{}.tmp.{}",
            final_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| state.run_id.clone()),
            std::process::id()
        );
        tmp_path.set_file_name(tmp_name);

        let bytes = serde_json::to_vec_pretty(state)?;
        {
            let mut f = fs::File::create(&tmp_path)?;
            f.write_all(&bytes)?;
            f.sync_all().ok(); // best-effort fsync; not all filesystems honor
        }
        fs::rename(&tmp_path, &final_path)?;
        Ok(())
    }
}

/// Validates a run id is safe to use as a filename (no path separators, no
/// `..`, non-empty, length-bounded). Rejects anything that could write
/// outside the runs dir.
fn validate_run_id(run_id: &str) -> LoomResult<()> {
    if run_id.is_empty() {
        return Err(LoomError::SchemaValidation(
            "run_id must not be empty".to_string(),
        ));
    }
    // Capped at 128 to keep the resulting <runs_dir>/<run_id>.json path
    // well under the 260-char Windows MAX_PATH limit even on deeply nested
    // tempdirs. Real run ids (UUIDs, slug+hash) are much shorter; the cap
    // is purely a defensive limit on caller-provided handles.
    if run_id.len() > 128 {
        return Err(LoomError::SchemaValidation(
            "run_id too long (max 128 chars)".to_string(),
        ));
    }
    if run_id.contains('/') || run_id.contains('\\') || run_id.contains('\0') {
        return Err(LoomError::SchemaValidation(format!(
            "run_id '{}' must not contain path separators or null bytes",
            run_id
        )));
    }
    if run_id == "." || run_id == ".." || run_id.starts_with('.') {
        return Err(LoomError::SchemaValidation(format!(
            "run_id '{}' must not be a special filename or start with a dot",
            run_id
        )));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn store() -> (RunStateStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let store = RunStateStore::new(dir.path()).unwrap();
        (store, dir)
    }

    #[test]
    fn record_started_writes_initial_state() {
        let (store, _dir) = store();
        let state = store
            .record_started("run-abc", Some("example/v2"), None)
            .unwrap();
        assert_eq!(state.run_id, "run-abc");
        assert_eq!(state.scenario_id.as_deref(), Some("example/v2"));
        assert_eq!(state.status, RunStatus::Started);
        assert_eq!(state.last_event_seq, 0);
        assert!(state.envelope.is_none());

        // round-trip via load
        let reloaded = store.load("run-abc").unwrap().unwrap();
        assert_eq!(reloaded.run_id, "run-abc");
        assert_eq!(reloaded.status, RunStatus::Started);
    }

    #[test]
    fn record_streaming_advances_seq_and_keeps_envelope() {
        let (store, _dir) = store();
        store.record_started("r1", None, None).unwrap();
        let envelope = json!({ "events": [{ "seq": 3 }] });
        let s1 = store
            .record_streaming("r1", Some(3), Some(&envelope))
            .unwrap();
        assert_eq!(s1.status, RunStatus::Streaming);
        assert_eq!(s1.last_event_seq, 3);
        assert!(s1.envelope.is_some());

        // seq does not regress
        let s2 = store.record_streaming("r1", Some(2), None).unwrap();
        assert_eq!(s2.last_event_seq, 3);
    }

    #[test]
    fn record_finished_marks_terminal_and_freezes_envelope() {
        let (store, _dir) = store();
        store.record_started("r1", None, None).unwrap();
        let env = json!({ "result": "pass" });
        let s = store.record_finished("r1", &env).unwrap();
        assert_eq!(s.status, RunStatus::Finished);
        assert!(s.status.is_terminal());
        assert_eq!(s.envelope.as_ref().unwrap()["result"], "pass");
    }

    #[test]
    fn record_lost_only_acts_when_record_exists() {
        let (store, _dir) = store();
        let no_op = store.record_lost("nonexistent", "subprocess died").unwrap();
        assert!(no_op.is_none(), "no record => no transition");

        store.record_started("r1", None, None).unwrap();
        let lost = store.record_lost("r1", "boom").unwrap().unwrap();
        assert_eq!(lost.status, RunStatus::Lost);
        assert_eq!(lost.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn record_lost_does_not_downgrade_finished_runs() {
        let (store, _dir) = store();
        store.record_started("r1", None, None).unwrap();
        store.record_finished("r1", &json!({ "result": "pass" })).unwrap();
        let kept = store.record_lost("r1", "post-hoc").unwrap().unwrap();
        assert_eq!(kept.status, RunStatus::Finished, "Finished must not regress to Lost");
    }

    #[test]
    fn list_in_flight_excludes_terminal_runs() {
        let (store, _dir) = store();
        store.record_started("a", None, None).unwrap();
        store.record_started("b", None, None).unwrap();
        store.record_finished("b", &json!({})).unwrap();
        store.record_started("c", None, None).unwrap();
        store.record_lost("c", "x").unwrap();

        let inflight = store.list_in_flight().unwrap();
        let ids: Vec<_> = inflight.iter().map(|s| s.run_id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
    }

    #[test]
    fn list_skips_corrupt_files_without_failing() {
        let (store, dir) = store();
        store.record_started("good", None, None).unwrap();
        // drop a malformed file directly into the runs dir
        std::fs::write(
            dir.path().join("runs").join("bad.json"),
            b"{ this is not valid json",
        )
        .unwrap();

        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].run_id, "good");
    }

    #[test]
    fn run_id_validation_rejects_path_traversal_and_separators() {
        let (store, _dir) = store();
        for bad in ["", "../escape", "..", ".", ".hidden", "a/b", "a\\b", "with\0null"] {
            let r = store.record_started(bad, None, None);
            assert!(r.is_err(), "expected rejection for run_id '{}'", bad);
        }
        for bad in [
            "../../etc/passwd",
            "/absolute",
            "C:\\Windows\\evil",
        ] {
            let r = store.load(bad);
            assert!(r.is_err(), "load('{}') should fail validation", bad);
        }
    }

    #[test]
    fn run_id_length_capped() {
        let (store, _dir) = store();
        let too_long = "a".repeat(129);
        assert!(store.record_started(&too_long, None, None).is_err());
        let max_ok = "a".repeat(128);
        assert!(store.record_started(&max_ok, None, None).is_ok());
    }

    #[test]
    fn atomic_write_leaves_no_tmp_files_on_success() {
        let (store, dir) = store();
        store.record_started("r1", None, None).unwrap();
        store.record_streaming("r1", Some(1), None).unwrap();
        store.record_finished("r1", &json!({})).unwrap();
        let runs_dir = dir.path().join("runs");
        let entries: Vec<_> = std::fs::read_dir(&runs_dir).unwrap().collect();
        let names: Vec<String> = entries
            .into_iter()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        for name in &names {
            assert!(
                !name.contains(".tmp."),
                "tmp file leaked: {} (full list: {:?})",
                name,
                names
            );
        }
    }

    #[test]
    fn forward_compat_loads_state_with_unknown_extra_fields() {
        let (store, dir) = store();
        // Hand-craft a state file with a field the current schema doesn't know.
        let raw = json!({
            "runId": "future-run",
            "startedAtMs": 1_700_000_000_000u64,
            "lastObservedAtMs": 1_700_000_000_001u64,
            "status": "started",
            "newFutureField": "xyz"
        });
        std::fs::write(
            dir.path().join("runs").join("future-run.json"),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        let loaded = store.load("future-run").unwrap().unwrap();
        assert_eq!(loaded.run_id, "future-run");
    }

    #[test]
    fn to_status_value_reflects_persisted_state() {
        let (store, _dir) = store();
        let s = store
            .record_started("r1", Some("scn"), Some("trace-xyz"))
            .unwrap();
        let v = s.to_status_value();
        assert_eq!(v["run_id"], "r1");
        assert_eq!(v["status"], "started");
        assert_eq!(v["scenario_id"], "scn");
        assert_eq!(v["trace_id"], "trace-xyz");
    }

    #[test]
    fn run_status_terminal_classification() {
        assert!(!RunStatus::Started.is_terminal());
        assert!(!RunStatus::Streaming.is_terminal());
        assert!(RunStatus::Finished.is_terminal());
        assert!(RunStatus::Lost.is_terminal());
        assert!(RunStatus::Stale.is_terminal());
    }
}
