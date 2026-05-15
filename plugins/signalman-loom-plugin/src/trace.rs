//! Trace-id helpers for the Loom plugin (P3.d, plugin-side close).
//!
//! When Loom invokes `loom.signalman.run`, the plugin either:
//!   - Accepts a `trace_id` from the input args (the upstream Loom
//!     workflow may want to share a trace across multiple Signalman
//!     runs that belong to one logical workflow), OR
//!   - Generates a fresh one when the caller omits it.
//!
//! Either way the value is forwarded to the Signalman CLI as
//! `--trace-id <hex>` and stored in the plugin's `RunState.trace_id`
//! so the agent can correlate Signalman log lines back to the Loom
//! task without parsing subprocess output.
//!
//! Format matches `host/src/output/trace.ts`: 32-char lowercase hex,
//! UUIDv4 with dashes stripped. Width is wire-compatible with W3C
//! `traceparent` `trace-id` for OTel-upgrade later.

use loom_core::{LoomError, LoomResult};

/// Width of a Signalman trace-id (matches W3C `trace-id` hex width).
pub const TRACE_ID_LENGTH: usize = 32;

/// Generate a fresh 32-char lowercase hex trace-id.
pub fn new_trace_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Validate that `value` is a well-formed Signalman trace-id, accepting
/// both the canonical hex form and a dashed UUID. Returns the
/// canonicalised lowercase-hex form on success, or a SchemaValidation
/// LoomError naming the field on failure. Mirrors the host TS
/// `parseTraceId` so a value that round-trips here also round-trips
/// through the CLI.
pub fn parse_trace_id(value: &str, field_label: &str) -> LoomResult<String> {
    let stripped: String = value
        .chars()
        .filter(|c| *c != '-')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if stripped.len() != TRACE_ID_LENGTH || !stripped.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(LoomError::SchemaValidation(format!(
            "{} must be a 32-char lowercase hex string (UUID without dashes); got '{}'",
            field_label, value
        )));
    }
    Ok(stripped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_trace_id_is_32_lowercase_hex() {
        let t = new_trace_id();
        assert_eq!(t.len(), TRACE_ID_LENGTH);
        assert!(t
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn new_trace_id_returns_distinct_values() {
        let a = new_trace_id();
        let b = new_trace_id();
        assert_ne!(a, b);
    }

    #[test]
    fn parse_trace_id_accepts_canonical_hex() {
        let id = "a".repeat(32);
        assert_eq!(parse_trace_id(&id, "trace_id").unwrap(), id);
    }

    #[test]
    fn parse_trace_id_strips_dashes_from_uuid_form() {
        let dashed = "550e8400-e29b-41d4-a716-446655440000";
        let canonical = parse_trace_id(dashed, "trace_id").unwrap();
        assert_eq!(canonical, "550e8400e29b41d4a716446655440000");
    }

    #[test]
    fn parse_trace_id_lowercases_uppercase_input() {
        let upper = "550E8400-E29B-41D4-A716-446655440000";
        let canonical = parse_trace_id(upper, "trace_id").unwrap();
        assert_eq!(canonical, "550e8400e29b41d4a716446655440000");
    }

    #[test]
    fn parse_trace_id_rejects_malformed_with_field_label() {
        let err = parse_trace_id("not-a-trace-id", "my_field").unwrap_err();
        let msg = format!("{}", err);
        assert!(msg.contains("my_field"));
    }

    #[test]
    fn parse_trace_id_rejects_empty_and_short() {
        assert!(parse_trace_id("", "f").is_err());
        assert!(parse_trace_id("a", "f").is_err());
        assert!(parse_trace_id(&"a".repeat(31), "f").is_err());
    }

    #[test]
    fn parse_trace_id_rejects_non_hex_characters() {
        assert!(parse_trace_id(&"g".repeat(32), "f").is_err());
        assert!(parse_trace_id(&"z".repeat(32), "f").is_err());
    }

    #[test]
    fn round_trip_freshly_generated_trace_id() {
        let id = new_trace_id();
        assert_eq!(parse_trace_id(&id, "trace_id").unwrap(), id);
    }
}
