//! Generated protobuf module.
//!
//! `tonic-build` emits one Rust module per proto package, named after
//! the package path with dots replaced by underscores. We re-export the
//! generated module under a stable name so the rest of the crate
//! doesn't have to know that detail.

#[allow(clippy::all, missing_docs, dead_code)]
pub mod signalman_service {
    tonic::include_proto!("signalman.service");
}

pub use signalman_service::*;
