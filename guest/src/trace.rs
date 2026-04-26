//! Trace correlation primitives (P3.d — closes audit C10-residual,
//! Rust guest-side half).
//!
//! The guest agent reads `signalman-trace-id`, `signalman-run-id`,
//! and `signalman-vm-name` headers off inbound gRPC requests. Logging
//! lives in the [`crate::AuthInterceptor`] (see `main.rs`) which
//! pulls the values via [`extract_from_metadata`] and emits a
//! `signalman::trace` event. Handlers can read the same values from
//! the request extensions via [`TraceContextExt`].
//!
//! Header names are stable and shared with the host TS module
//! ([`host/src/output/trace.ts`]) and the service crate
//! ([`signalman_service::trace`]). Renaming requires a coordinated
//! migration across all four sites.

pub const HEADER_TRACE_ID: &str = "signalman-trace-id";
pub const HEADER_RUN_ID: &str = "signalman-run-id";
pub const HEADER_VM_NAME: &str = "signalman-vm-name";

/// Trace context attached to a request via extensions. Handlers read
/// this with `request.extensions().get::<TraceContextExt>()`.
#[derive(Debug, Clone, Default)]
pub struct TraceContextExt {
    pub trace_id: Option<String>,
    pub run_id: Option<String>,
    pub vm_name: Option<String>,
}

impl TraceContextExt {
    /// True when at least one trace header was present on the inbound
    /// request — i.e. the caller propagated a trace context. False
    /// means an un-traced legacy call.
    pub fn is_traced(&self) -> bool {
        self.trace_id.is_some() || self.run_id.is_some()
    }
}

/// Extract trace headers from a tonic `Request` metadata map.
/// Missing or non-ASCII headers yield `None` for that field; the
/// function never errors. Used by [`crate::AuthInterceptor`].
pub fn extract_from_metadata<T>(request: &tonic::Request<T>) -> TraceContextExt {
    TraceContextExt {
        trace_id: read(request, HEADER_TRACE_ID),
        run_id: read(request, HEADER_RUN_ID),
        vm_name: read(request, HEADER_VM_NAME),
    }
}

fn read<T>(request: &tonic::Request<T>, key: &str) -> Option<String> {
    request
        .metadata()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::metadata::MetadataValue;

    #[test]
    fn extracts_all_three_headers_when_present() {
        let mut req = tonic::Request::new(());
        req.metadata_mut().insert(
            HEADER_TRACE_ID,
            MetadataValue::try_from("a".repeat(32)).unwrap(),
        );
        req.metadata_mut()
            .insert(HEADER_RUN_ID, MetadataValue::try_from("run_x").unwrap());
        req.metadata_mut().insert(
            HEADER_VM_NAME,
            MetadataValue::try_from("endpoint-1").unwrap(),
        );
        let ext = extract_from_metadata(&req);
        assert_eq!(ext.trace_id.as_deref(), Some(&"a".repeat(32)[..]));
        assert_eq!(ext.run_id.as_deref(), Some("run_x"));
        assert_eq!(ext.vm_name.as_deref(), Some("endpoint-1"));
        assert!(ext.is_traced());
    }

    #[test]
    fn missing_headers_yield_empty_context() {
        let req = tonic::Request::new(());
        let ext = extract_from_metadata(&req);
        assert!(ext.trace_id.is_none());
        assert!(ext.run_id.is_none());
        assert!(ext.vm_name.is_none());
        assert!(!ext.is_traced());
    }

    #[test]
    fn partial_headers_are_okay_for_service_level_calls() {
        // Health probes don't have a vm-name. is_traced still true.
        let mut req = tonic::Request::new(());
        req.metadata_mut().insert(
            HEADER_TRACE_ID,
            MetadataValue::try_from("a".repeat(32)).unwrap(),
        );
        let ext = extract_from_metadata(&req);
        assert!(ext.trace_id.is_some());
        assert!(ext.vm_name.is_none());
        assert!(ext.is_traced());
    }
}
