//! Hermetic-identity extraction for v0.3.0-4 Loom workflow contracts.
//!
//! v0.3.0-3 graduated `ScenarioResult` with four identity fields:
//! `scenario_hash`, `vm_lineage_hash`, `agent_version`, and
//! `network_class`. The plugin already returns the full envelope to
//! Loom; this module pulls the identity subset out so callers can
//! key cache lookups + task-evidence records on a stable top-level
//! object without descending into envelope JSON.
//!
//! # Locked design (do not re-litigate)
//!
//! - **Structural mirror, no derivation.** The extracted object has
//!   exactly the same field names and values as the envelope's
//!   identity fields. The v0.3.0-4 naming clash with the input
//!   field `network_class` on `loom.signalman.run` was resolved by
//!   the v0.3.0 follow-up rename — input is now
//!   `requested_network_class` (intent), output stays
//!   `network_class` (observation). The legacy input name is still
//!   accepted for backward compat with a DEPRECATED schema tag; see
//!   `schemas::run_input`.
//! - **Returns `None` when the envelope is missing all four fields.**
//!   Workflows that gate on `hermetic_identity` should treat
//!   `Some(_)` as "envelope is at least partially identifiable" and
//!   `None` as "no identity available — skip cache lookup".
//! - **Pre-v0.3.0-3 envelopes degrade gracefully.** An older
//!   signalman version producing an envelope without the four
//!   fields returns `None` from this extractor; callers continue to
//!   work without the cache key.

use serde_json::{json, Value};

/// Extract the hermetic-identity subset from a Signalman envelope.
///
/// Returns `Some(object)` when at least one of the four identity
/// fields is present and non-empty on the envelope; `None`
/// otherwise.
///
/// The returned object always carries all four keys (using JSON
/// null for absent ones) so downstream consumers can pattern-match
/// on a stable shape:
///
/// ```ignore
/// {
///   "scenario_hash":   "0a1b2c..." | null,
///   "vm_lineage_hash": "f4e5d6..." | null,
///   "agent_version":   "0.2.1"     | null,
///   "network_class":   "default-switch" | null
/// }
/// ```
///
/// This shape is part of the v0.3.0-4 contract; see
/// `docs/design/v0.3.0-4-loom-contract.md` §2.1.
pub fn extract_hermetic_identity(envelope: &Value) -> Option<Value> {
    let scenario_hash = string_or_null(envelope.get("scenario_hash"));
    let vm_lineage_hash = string_or_null(envelope.get("vm_lineage_hash"));
    let agent_version = string_or_null(envelope.get("agent_version"));
    let network_class = string_or_null(envelope.get("network_class"));

    // Return None when ALL four fields are absent. Workflow nodes
    // then know they're looking at a pre-v0.3.0-3 envelope (or a
    // run that failed too early to populate any identity) and
    // should skip cache lookup.
    if scenario_hash.is_null()
        && vm_lineage_hash.is_null()
        && agent_version.is_null()
        && network_class.is_null()
    {
        return None;
    }

    Some(json!({
        "scenario_hash": scenario_hash,
        "vm_lineage_hash": vm_lineage_hash,
        "agent_version": agent_version,
        "network_class": network_class,
    }))
}

/// Helper: read a JSON value as a non-empty string, or `null`.
///
/// Empty strings are treated as missing — the v0.3.0-3 envelope
/// helpers (`aggregateAgentVersions`, etc.) already filter empty
/// values, but defensive normalisation here means a mis-behaving
/// signalman build that emits `""` instead of omitting the field
/// doesn't pollute the cache key.
fn string_or_null(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Value::String(s.to_string()),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope_with(fields: &[(&str, Value)]) -> Value {
        let mut obj = serde_json::Map::new();
        for (k, v) in fields {
            obj.insert((*k).to_string(), v.clone());
        }
        Value::Object(obj)
    }

    // ── Pure-helper: string_or_null ──────────────────────────────────

    #[test]
    fn string_or_null_returns_null_for_absent() {
        assert_eq!(string_or_null(None), Value::Null);
    }

    #[test]
    fn string_or_null_returns_null_for_empty_string() {
        let v = json!("");
        assert_eq!(string_or_null(Some(&v)), Value::Null);
    }

    #[test]
    fn string_or_null_returns_null_for_non_string() {
        let v = json!(42);
        assert_eq!(string_or_null(Some(&v)), Value::Null);
        let v2 = json!(null);
        assert_eq!(string_or_null(Some(&v2)), Value::Null);
        let v3 = json!({});
        assert_eq!(string_or_null(Some(&v3)), Value::Null);
    }

    #[test]
    fn string_or_null_returns_string_for_non_empty_string() {
        let v = json!("hello");
        assert_eq!(string_or_null(Some(&v)), json!("hello"));
    }

    // ── extract_hermetic_identity: presence detection ───────────────

    #[test]
    fn returns_none_when_no_identity_fields_present() {
        let env = envelope_with(&[
            ("name", json!("smoke")),
            ("status", json!("passed")),
            ("duration_ms", json!(123)),
        ]);
        assert_eq!(extract_hermetic_identity(&env), None);
    }

    #[test]
    fn returns_none_when_all_four_fields_are_empty_strings() {
        let env = envelope_with(&[
            ("scenario_hash", json!("")),
            ("vm_lineage_hash", json!("")),
            ("agent_version", json!("")),
            ("network_class", json!("")),
        ]);
        assert_eq!(extract_hermetic_identity(&env), None);
    }

    #[test]
    fn returns_none_when_envelope_is_empty_object() {
        let env = json!({});
        assert_eq!(extract_hermetic_identity(&env), None);
    }

    // ── extract_hermetic_identity: happy paths ──────────────────────

    #[test]
    fn returns_full_identity_when_all_fields_present() {
        let env = envelope_with(&[
            ("scenario_hash", json!("aa" .repeat(32))),
            ("vm_lineage_hash", json!("bb".repeat(32))),
            ("agent_version", json!("0.2.1")),
            ("network_class", json!("default-switch")),
        ]);
        let id = extract_hermetic_identity(&env).expect("Some");
        assert_eq!(id["scenario_hash"].as_str(), Some("a".repeat(64).as_str()));
        assert_eq!(id["vm_lineage_hash"].as_str(), Some("b".repeat(64).as_str()));
        assert_eq!(id["agent_version"].as_str(), Some("0.2.1"));
        assert_eq!(id["network_class"].as_str(), Some("default-switch"));
    }

    #[test]
    fn returns_partial_identity_when_only_scenario_hash_present() {
        let env = envelope_with(&[
            ("scenario_hash", json!("a".repeat(64))),
            ("status", json!("passed")),
        ]);
        let id = extract_hermetic_identity(&env).expect("Some");
        assert_eq!(id["scenario_hash"].as_str(), Some("a".repeat(64).as_str()));
        assert!(id["vm_lineage_hash"].is_null());
        assert!(id["agent_version"].is_null());
        assert!(id["network_class"].is_null());
    }

    #[test]
    fn returns_partial_when_lineage_present_but_others_absent() {
        let env = envelope_with(&[
            ("vm_lineage_hash", json!("c".repeat(64))),
        ]);
        let id = extract_hermetic_identity(&env).expect("Some");
        assert!(id["scenario_hash"].is_null());
        assert_eq!(id["vm_lineage_hash"].as_str(), Some("c".repeat(64).as_str()));
        assert!(id["agent_version"].is_null());
        assert!(id["network_class"].is_null());
    }

    // ── extract_hermetic_identity: stable shape ─────────────────────

    #[test]
    fn returned_object_always_has_all_four_keys() {
        let env = envelope_with(&[("agent_version", json!("0.2.1"))]);
        let id = extract_hermetic_identity(&env).expect("Some");
        let obj = id.as_object().expect("object");
        assert!(obj.contains_key("scenario_hash"));
        assert!(obj.contains_key("vm_lineage_hash"));
        assert!(obj.contains_key("agent_version"));
        assert!(obj.contains_key("network_class"));
        assert_eq!(obj.len(), 4);
    }

    // ── extract_hermetic_identity: defensive normalisation ──────────

    #[test]
    fn non_string_field_values_treated_as_null() {
        // A misbehaving signalman build might emit numbers or
        // objects in fields the schema says are strings. Defensive
        // normalisation: surface as `null` rather than passing the
        // unexpected shape through.
        let env = envelope_with(&[
            ("scenario_hash", json!(42)),
            ("vm_lineage_hash", json!({"oops": true})),
            ("agent_version", json!(null)),
            ("network_class", json!([])),
        ]);
        assert_eq!(extract_hermetic_identity(&env), None);
    }

    #[test]
    fn mixed_valid_and_invalid_yields_partial_identity() {
        let env = envelope_with(&[
            ("scenario_hash", json!("a".repeat(64))),
            ("vm_lineage_hash", json!(42)), // non-string → null
            ("agent_version", json!("0.2.1")),
            ("network_class", json!("")), // empty → null
        ]);
        let id = extract_hermetic_identity(&env).expect("Some");
        assert_eq!(id["scenario_hash"].as_str(), Some("a".repeat(64).as_str()));
        assert!(id["vm_lineage_hash"].is_null());
        assert_eq!(id["agent_version"].as_str(), Some("0.2.1"));
        assert!(id["network_class"].is_null());
    }
}
