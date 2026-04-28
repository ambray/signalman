//! P7 D2 — host↔service mTLS handshake integration test.
//!
//! Validates: server cert presented, client cert required + verified
//! against CA, TLS 1.3/1.2 handshake completes, gRPC roundtrip succeeds.
//!
//! Companion to `named_pipe_smoke.rs` (which covers the pipe transport).
//! Together these exercise both transports end-to-end.
//!
//! Windows-only because the service crate's transport stack is gated
//! to windows for v0.1.0.

#![cfg(target_os = "windows")]

use std::net::{SocketAddr, TcpListener};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use signalman_service::backend::{
    Backend, BackendResult, CheckpointHandle, CheckpointInfo, CommandResult, CopyEvent, RunEvent,
    VmConfig, VmHandle, VmState, VmStatus, WaitAgentEvent,
};
use signalman_service::proto::{self, signalman_service::control_plane_client::ControlPlaneClient};
use signalman_service::tls::{generate_certs, CertBundle};
use signalman_service::transport::{serve, TransportConfig};
use tokio::sync::{mpsc, watch};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity};

// ── Mock backend (mirrors named_pipe_smoke.rs) ──────────────────────

struct MockBackend;

#[async_trait]
impl Backend for MockBackend {
    fn name(&self) -> &str {
        "mock"
    }
    async fn is_available(&self) -> bool {
        true
    }
    async fn create_vm(&self, config: &VmConfig) -> BackendResult<VmHandle> {
        Ok(VmHandle {
            id: format!("id-{}", config.name),
            name: config.name.clone(),
            backend: "mock".to_string(),
        })
    }
    async fn start_vm(&self, _h: &VmHandle) -> BackendResult<()> {
        Ok(())
    }
    async fn stop_vm(&self, _h: &VmHandle, _force: bool) -> BackendResult<()> {
        Ok(())
    }
    async fn pause_vm(&self, _h: &VmHandle) -> BackendResult<()> {
        Ok(())
    }
    async fn resume_vm(&self, _h: &VmHandle) -> BackendResult<()> {
        Ok(())
    }
    async fn delete_vm(&self, _h: &VmHandle) -> BackendResult<()> {
        Ok(())
    }
    async fn get_status(&self, h: &VmHandle) -> BackendResult<VmStatus> {
        Ok(VmStatus {
            handle: h.clone(),
            state: VmState::Running,
            ip_address: Some("10.0.0.1".to_string()),
            guest_agent_reachable: true,
            uptime_seconds: Some(7),
            memory_used_mb: Some(2048),
        })
    }
    async fn list_vms(&self) -> BackendResult<Vec<VmHandle>> {
        Ok(vec![])
    }
    async fn create_checkpoint(
        &self,
        h: &VmHandle,
        label: &str,
    ) -> BackendResult<CheckpointHandle> {
        Ok(CheckpointHandle {
            id: "cp1".to_string(),
            vm_handle: h.clone(),
            label: label.to_string(),
        })
    }
    async fn restore_checkpoint(&self, _cp: &CheckpointHandle) -> BackendResult<()> {
        Ok(())
    }
    async fn delete_checkpoint(&self, _cp: &CheckpointHandle) -> BackendResult<()> {
        Ok(())
    }
    async fn list_checkpoints(&self, _h: &VmHandle) -> BackendResult<Vec<CheckpointInfo>> {
        Ok(vec![])
    }
    async fn copy_file(
        &self,
        _h: &VmHandle,
        _host_path: &str,
        _guest_path: &str,
        _from_guest: bool,
        _events: mpsc::Sender<CopyEvent>,
    ) -> BackendResult<()> {
        Ok(())
    }
    async fn execute_command(
        &self,
        _h: &VmHandle,
        _cmd: &str,
        _args: &[String],
        _timeout_ms: u64,
        _events: mpsc::Sender<RunEvent>,
    ) -> BackendResult<CommandResult> {
        Ok(CommandResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            duration_ms: 0,
        })
    }
    async fn get_vm_ip(&self, _h: &VmHandle) -> BackendResult<String> {
        Ok("10.0.0.1".to_string())
    }
    async fn wait_for_heartbeat(
        &self,
        _h: &VmHandle,
        _timeout_ms: u64,
        _events: mpsc::Sender<WaitAgentEvent>,
    ) -> BackendResult<bool> {
        Ok(true)
    }
    async fn set_vm_memory(&self, _h: &VmHandle, _memory_mb: u32) -> BackendResult<()> {
        Ok(())
    }
    async fn set_vm_processor(&self, _h: &VmHandle, _count: u32) -> BackendResult<()> {
        Ok(())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Pick a free TCP port on 127.0.0.1 by binding port 0 and reading
/// back the assigned port. Inherently racy (the OS may hand the same
/// port to another process between the bind and our subsequent
/// `serve` listen) but acceptable for an integration test on the
/// loopback interface.
fn pick_free_port() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind to ephemeral port");
    let addr = listener.local_addr().expect("local_addr");
    drop(listener);
    addr
}

/// Generate a fresh dev-cert bundle in a tempdir using the same
/// cert-generation entry point the service uses internally
/// (`tls::generate_certs`). We deliberately bypass `ensure_certs`
/// here because `ensure_certs` also shells out to `icacls` to harden
/// the directory's ACLs — fine for production on Windows, but flaky
/// in CI where the runner may not have privilege to rewrite ACLs.
/// The PEM material is identical either way; the only difference is
/// the post-write ACL step.
///
/// Returns the bundle plus the tempdir guard so the caller can keep
/// the directory alive for the test's duration.
fn fresh_bundle() -> (CertBundle, tempfile::TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bundle = CertBundle::at(tmp.path().to_path_buf());
    generate_certs(&bundle).expect("generate_certs");
    (bundle, tmp)
}

/// Build the transport config for a TCP-only mTLS listener bound to
/// `addr` and signed by `bundle`.
fn tcp_only_config(addr: SocketAddr, bundle: CertBundle) -> TransportConfig {
    TransportConfig {
        tcp: Some(addr),
        pipe: None,
        certs: bundle,
    }
}

/// Read the bytes of every PEM/key file in `bundle` into memory.
/// Used to build the client-side `Identity` and CA trust root.
struct BundleBytes {
    ca: Vec<u8>,
    client_cert: Vec<u8>,
    client_key: Vec<u8>,
}

impl BundleBytes {
    fn from(bundle: &CertBundle) -> Self {
        Self {
            ca: std::fs::read(&bundle.ca_cert).expect("read ca"),
            client_cert: std::fs::read(&bundle.client_cert).expect("read client cert"),
            client_key: std::fs::read(&bundle.client_key).expect("read client key"),
        }
    }
}

/// Build a `ClientTlsConfig` from the same CA + a client identity.
/// `identity` is None for the "no client cert" negative case.
fn client_tls(ca: &[u8], identity: Option<Identity>) -> ClientTlsConfig {
    let mut cfg = ClientTlsConfig::new()
        .domain_name("localhost")
        .ca_certificate(Certificate::from_pem(ca));
    if let Some(id) = identity {
        cfg = cfg.identity(id);
    }
    cfg
}

// ── Tests ───────────────────────────────────────────────────────────

#[tokio::test]
async fn mtls_valid_client_succeeds() {
    let (bundle, _tmp) = fresh_bundle();
    let addr = pick_free_port();
    let config = tcp_only_config(addr, bundle.clone());

    let backend: Arc<dyn Backend> = Arc::new(MockBackend);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let serve_task = tokio::spawn(serve(backend, config, shutdown_rx));

    // Brief delay so the TCP listener is actually bound before we
    // dial. 200ms is generous on loopback.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let bytes = BundleBytes::from(&bundle);
    let identity = Identity::from_pem(&bytes.client_cert, &bytes.client_key);
    let tls = client_tls(&bytes.ca, Some(identity));

    let endpoint = Endpoint::from_shared(format!("https://{addr}"))
        .expect("endpoint")
        .tls_config(tls)
        .expect("client tls config")
        .connect_timeout(Duration::from_secs(5));

    let channel = endpoint.connect().await.expect("mTLS connect");
    let mut client = ControlPlaneClient::new(channel);

    let resp = client
        .health(proto::HealthRequest {})
        .await
        .expect("health rpc over mTLS")
        .into_inner();
    assert_eq!(resp.active_backend, "mock");

    // Clean shutdown.
    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), serve_task).await;
}

#[tokio::test]
async fn mtls_wrong_ca_rejected() {
    // Server is signed by bundle A. Client presents a cert signed by
    // bundle B (a totally separate CA). The handshake MUST fail —
    // either at connect time or on the first RPC, depending on how
    // tonic surfaces the rustls verification error.
    let (server_bundle, _tmp_a) = fresh_bundle();
    let (foreign_bundle, _tmp_b) = fresh_bundle();
    let addr = pick_free_port();
    let config = tcp_only_config(addr, server_bundle.clone());

    let backend: Arc<dyn Backend> = Arc::new(MockBackend);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let serve_task = tokio::spawn(serve(backend, config, shutdown_rx));

    tokio::time::sleep(Duration::from_millis(200)).await;

    let server_bytes = BundleBytes::from(&server_bundle);
    let foreign_bytes = BundleBytes::from(&foreign_bundle);

    // Trust the real server's CA (so server-auth succeeds), but
    // present a client cert from the OTHER CA (so client-auth fails).
    let foreign_identity =
        Identity::from_pem(&foreign_bytes.client_cert, &foreign_bytes.client_key);
    let tls = client_tls(&server_bytes.ca, Some(foreign_identity));

    let endpoint = Endpoint::from_shared(format!("https://{addr}"))
        .expect("endpoint")
        .tls_config(tls)
        .expect("client tls config")
        .connect_timeout(Duration::from_secs(5));

    // Some platforms surface the rejection at connect; others defer
    // until the first RPC. Treat either as a pass.
    let outcome: Result<(), ()> = match endpoint.connect().await {
        Err(_) => Err(()),
        Ok(channel) => {
            let mut client = ControlPlaneClient::new(channel);
            match tokio::time::timeout(
                Duration::from_secs(5),
                client.health(proto::HealthRequest {}),
            )
            .await
            {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    };
    assert!(
        outcome.is_err(),
        "client cert signed by an untrusted CA must be rejected by the mTLS handshake"
    );

    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), serve_task).await;
}

#[tokio::test]
async fn mtls_no_client_cert_rejected() {
    // Server requires a client cert. Client offers none. Handshake
    // (or first RPC) must fail.
    let (bundle, _tmp) = fresh_bundle();
    let addr = pick_free_port();
    let config = tcp_only_config(addr, bundle.clone());

    let backend: Arc<dyn Backend> = Arc::new(MockBackend);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let serve_task = tokio::spawn(serve(backend, config, shutdown_rx));

    tokio::time::sleep(Duration::from_millis(200)).await;

    let bytes = BundleBytes::from(&bundle);
    let tls = client_tls(&bytes.ca, None);

    let endpoint = Endpoint::from_shared(format!("https://{addr}"))
        .expect("endpoint")
        .tls_config(tls)
        .expect("client tls config")
        .connect_timeout(Duration::from_secs(5));

    let outcome: Result<(), ()> = match endpoint.connect().await {
        Err(_) => Err(()),
        Ok(channel) => {
            let mut client = ControlPlaneClient::new(channel);
            match tokio::time::timeout(
                Duration::from_secs(5),
                client.health(proto::HealthRequest {}),
            )
            .await
            {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    };
    assert!(
        outcome.is_err(),
        "client without any certificate must be rejected by the mTLS handshake"
    );

    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), serve_task).await;
}
