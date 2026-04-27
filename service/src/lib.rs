//! Signalman host control-plane service.
//!
//! Hosts a privileged daemon that performs Hyper-V (and, eventually,
//! libvirt / vmrun) operations on behalf of unelevated host clients.
//! Replaces per-call gsudo elevation with a single install-time grant.
//!
//! The crate is organised as:
//!   - [`sanitize`]      — TS sanitizers ported to Rust (defense in depth)
//!   - [`backend`]       — Backend trait + Hyper-V dispatcher
//!   - [`service`]       — gRPC server implementing the `ControlPlane` proto
//!   - [`transport`]     — Named-pipe + TCP (rustls) acceptors
//!   - [`tls`]           — Dev-cert generation and rustls config helpers
//!   - [`service_runtime`] — Windows service install/uninstall/run glue

#![warn(clippy::all)]
// `tonic::Status` is intentionally large (~176 bytes) but is the
// idiomatic gRPC error type. Boxing it in every helper signature
// would be more friction than the lint is worth.
#![allow(clippy::result_large_err)]

pub mod backend;
#[cfg(target_os = "windows")]
pub mod pipe_security;
pub mod proto;
pub mod sanitize;
pub mod service;
pub mod tls;
pub mod trace;
pub mod transport;

#[cfg(target_os = "windows")]
pub mod service_runtime;

/// Service name registered with the Windows SCM.
pub const SERVICE_NAME: &str = "Signalman";
/// Display name shown in services.msc.
pub const SERVICE_DISPLAY_NAME: &str = "Signalman Hyper-V Control Plane";
/// Service description shown in services.msc.
pub const SERVICE_DESCRIPTION: &str =
    "Privileged daemon that brokers Hyper-V management calls on behalf of unelevated Signalman clients.";

/// Default named-pipe address.
pub const PIPE_NAME: &str = r"\\.\pipe\signalman-service";

/// Default localhost gRPC port.
pub const DEFAULT_GRPC_PORT: u16 = 17777;

/// Hyper-V Administrators group SID. Membership in this group grants
/// the rights necessary to drive Hyper-V cmdlets without UAC.
pub const HYPERV_ADMINS_SID: &str = "S-1-5-32-578";
