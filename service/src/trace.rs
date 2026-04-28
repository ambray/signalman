//! Trace-correlation interceptor (P3.d — closes audit C10-residual,
//! Rust service-side half).
//!
//! Reads `signalman-trace-id`, `signalman-run-id`, and
//! `signalman-vm-name` from inbound gRPC metadata and:
//!   1. Logs an INFO `tracing` event under `signalman::trace` with the
//!      three IDs + the request method, so `grep $TRACE_ID` against the
//!      service log stream correlates to the host-side run.
//!   2. Stores the parsed [`TraceContextExt`] in the request extensions
//!      so handlers (and future per-call spans) can pick it up via
//!      `request.extensions().get::<TraceContextExt>()`.
//!
//! Missing headers are *not* an error — they mean the call came from
//! an un-traced caller (a legacy CLI invocation, the named-pipe smoke
//! test, etc.) and should pass through unchanged. The interceptor
//! never fails; it only enriches.
//!
//! # Header names
//!
//! These are stable across releases and shared with the host-side TS
//! [`host/src/output/trace.ts`] module. Renaming requires a coordinated
//! host + service + guest + plugin migration.

use tonic::service::Interceptor;
use tonic::Status;

pub const HEADER_TRACE_ID: &str = "signalman-trace-id";
pub const HEADER_RUN_ID: &str = "signalman-run-id";
pub const HEADER_VM_NAME: &str = "signalman-vm-name";

/// Trace context attached to a request via extensions. Handlers can
/// read this with `request.extensions().get::<TraceContextExt>()`.
/// Cloned on use; the interceptor stores one per request.
#[derive(Debug, Clone, Default)]
pub struct TraceContextExt {
    pub trace_id: Option<String>,
    pub run_id: Option<String>,
    pub vm_name: Option<String>,
}

impl TraceContextExt {
    /// Returns true when at least one header was present (i.e. the
    /// caller was traced). False means an un-traced legacy call.
    pub fn is_traced(&self) -> bool {
        self.trace_id.is_some() || self.run_id.is_some()
    }
}

/// gRPC interceptor that pulls trace headers off every inbound request.
/// Add via `with_interceptor(TraceInterceptor)` on the service builder.
#[derive(Debug, Default, Clone, Copy)]
pub struct TraceInterceptor;

impl Interceptor for TraceInterceptor {
    fn call(&mut self, mut request: tonic::Request<()>) -> Result<tonic::Request<()>, Status> {
        let trace_id = read_header(&request, HEADER_TRACE_ID);
        let run_id = read_header(&request, HEADER_RUN_ID);
        let vm_name = read_header(&request, HEADER_VM_NAME);

        if trace_id.is_some() || run_id.is_some() {
            tracing::info!(
                target: "signalman::trace",
                trace_id = trace_id.as_deref().unwrap_or(""),
                run_id = run_id.as_deref().unwrap_or(""),
                vm_name = vm_name.as_deref().unwrap_or(""),
                "control-plane request received",
            );
        }

        request.extensions_mut().insert(TraceContextExt {
            trace_id,
            run_id,
            vm_name,
        });

        Ok(request)
    }
}

/// Read a single header value as `String`. Returns `None` when the
/// header is absent or its value isn't valid ASCII.
fn read_header(request: &tonic::Request<()>, key: &str) -> Option<String> {
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

    /// Build a Request with the given trace headers populated. Using
    /// per-header `Option`s instead of a generic key/value loop avoids
    /// borrow-check trouble with non-`'static` keys: `MetadataMap::insert`
    /// needs a `&'static str` for its key arg.
    fn make_req(
        trace_id: Option<&str>,
        run_id: Option<&str>,
        vm_name: Option<&str>,
    ) -> tonic::Request<()> {
        let mut req = tonic::Request::new(());
        if let Some(v) = trace_id {
            req.metadata_mut()
                .insert(HEADER_TRACE_ID, MetadataValue::try_from(v).unwrap());
        }
        if let Some(v) = run_id {
            req.metadata_mut()
                .insert(HEADER_RUN_ID, MetadataValue::try_from(v).unwrap());
        }
        if let Some(v) = vm_name {
            req.metadata_mut()
                .insert(HEADER_VM_NAME, MetadataValue::try_from(v).unwrap());
        }
        req
    }

    #[test]
    fn extracts_all_three_headers_into_extension() {
        let mut interceptor = TraceInterceptor;
        let trace = "f".repeat(32);
        let req = make_req(Some(&trace), Some("run_abc"), Some("endpoint-1"));
        let out = interceptor.call(req).unwrap();
        let ext = out.extensions().get::<TraceContextExt>().unwrap();
        assert_eq!(ext.trace_id.as_deref(), Some(&trace[..]));
        assert_eq!(ext.run_id.as_deref(), Some("run_abc"));
        assert_eq!(ext.vm_name.as_deref(), Some("endpoint-1"));
        assert!(ext.is_traced());
    }

    #[test]
    fn missing_headers_attach_empty_extension_and_succeed() {
        let mut interceptor = TraceInterceptor;
        let req = tonic::Request::new(());
        let out = interceptor.call(req).unwrap();
        let ext = out.extensions().get::<TraceContextExt>().unwrap();
        assert!(ext.trace_id.is_none());
        assert!(ext.run_id.is_none());
        assert!(ext.vm_name.is_none());
        assert!(!ext.is_traced());
    }

    #[test]
    fn partial_headers_carry_through() {
        // Service-level probes (Health, etc.) have no vm-name; that's fine.
        let mut interceptor = TraceInterceptor;
        let trace = "a".repeat(32);
        let req = make_req(Some(&trace), Some("run_xyz"), None);
        let out = interceptor.call(req).unwrap();
        let ext = out.extensions().get::<TraceContextExt>().unwrap();
        assert!(ext.trace_id.is_some());
        assert!(ext.vm_name.is_none());
        assert!(ext.is_traced());
    }

    #[test]
    fn never_fails_on_unusual_metadata() {
        // The interceptor must not reject the request even when only
        // some headers are present — trace enrichment is best-effort,
        // never load-bearing.
        let mut interceptor = TraceInterceptor;
        let req = make_req(Some("legal-ascii"), None, None);
        let out = interceptor.call(req).unwrap();
        assert!(out.extensions().get::<TraceContextExt>().is_some());
    }
}
