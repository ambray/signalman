//! Integration test: drive the gRPC server through a named pipe.
//!
//! Spins up a `ControlPlaneService` over a `\\.\pipe\signalman-svc-test-*`
//! pipe, connects a tonic client through that pipe, and exercises a
//! handful of unary + streaming RPCs. The backend is a [`MockBackend`]
//! that returns scripted responses — no PowerShell, no Hyper-V.

#![cfg(target_os = "windows")]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use signalman_service::backend::{
    Backend, BackendResult, CheckpointHandle, CheckpointInfo, CommandResult, CopyEvent, RunEvent,
    VmConfig, VmHandle, VmState, VmStatus, WaitAgentEvent,
};
use signalman_service::proto::{self, signalman_service::control_plane_client::ControlPlaneClient};
use signalman_service::service::ControlPlaneService;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
// AsyncRead/AsyncWrite are required by the *server-side* ServerConn
// wrapper below; the client side uses hyper::rt traits via TokioIo.
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tonic::transport::Endpoint;

// ── Mock backend ────────────────────────────────────────────────────

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
        Ok(vec![VmHandle {
            id: "1".to_string(),
            name: "test-vm".to_string(),
            backend: "mock".to_string(),
        }])
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
        events: mpsc::Sender<CopyEvent>,
    ) -> BackendResult<()> {
        let _ = events
            .send(CopyEvent::Progress {
                transferred: 50,
                total: 100,
            })
            .await;
        let _ = events.send(CopyEvent::Complete).await;
        Ok(())
    }
    async fn execute_command(
        &self,
        _h: &VmHandle,
        _cmd: &str,
        _args: &[String],
        _timeout_ms: u64,
        events: mpsc::Sender<RunEvent>,
    ) -> BackendResult<CommandResult> {
        let _ = events
            .send(RunEvent::Started {
                started_at_unix_ms: 1,
            })
            .await;
        let result = CommandResult {
            exit_code: 0,
            stdout: "hi\n".to_string(),
            stderr: String::new(),
            duration_ms: 5,
        };
        let _ = events.send(RunEvent::Result(result.clone())).await;
        Ok(result)
    }
    async fn get_vm_ip(&self, _h: &VmHandle) -> BackendResult<String> {
        Ok("10.0.0.1".to_string())
    }
    async fn wait_for_heartbeat(
        &self,
        _h: &VmHandle,
        _timeout_ms: u64,
        events: mpsc::Sender<WaitAgentEvent>,
    ) -> BackendResult<bool> {
        let _ = events.send(WaitAgentEvent::Ready).await;
        Ok(true)
    }
    async fn set_vm_memory(&self, _h: &VmHandle, _memory_mb: u32) -> BackendResult<()> {
        Ok(())
    }
    async fn set_vm_processor(&self, _h: &VmHandle, _count: u32) -> BackendResult<()> {
        Ok(())
    }
}

// ── Pipe wrapper for the client side ────────────────────────────────
//
// tonic clients connect through a custom connector. The connector's
// returned type must implement hyper's `rt::Read`/`rt::Write`. We use
// `hyper_util::rt::TokioIo` to adapt our tokio NamedPipeClient.

use hyper_util::rt::TokioIo;
use tokio::net::windows::named_pipe::NamedPipeClient;

/// Newtype around `TokioIo<NamedPipeClient>` so we can attach the
/// `Connection` impl required by hyper's legacy connect plumbing.
struct PipeStream(TokioIo<NamedPipeClient>);

impl hyper::rt::Read for PipeStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for PipeStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl hyper_util::client::legacy::connect::Connection for PipeStream {
    fn connected(&self) -> hyper_util::client::legacy::connect::Connected {
        hyper_util::client::legacy::connect::Connected::new()
    }
}

// Wrapper so tonic-style `Endpoint::connect_with_connector` can drive
// the pipe. We implement `tower::Service<Uri>` returning `PipeStream`.
#[derive(Clone)]
struct PipeConnector {
    pipe_name: String,
}

impl tower::Service<tonic::transport::Uri> for PipeConnector {
    type Response = PipeStream;
    type Error = std::io::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
    >;
    fn poll_ready(
        &mut self,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn call(&mut self, _: tonic::transport::Uri) -> Self::Future {
        let pipe_name = self.pipe_name.clone();
        Box::pin(async move {
            let client = ClientOptions::new().open(&pipe_name)?;
            Ok(PipeStream(TokioIo::new(client)))
        })
    }
}

// ── Test ───────────────────────────────────────────────────────────

#[tokio::test]
async fn pipe_smoke() {
    // Use a unique pipe name per test run so concurrent runs don't collide.
    let pipe_name = format!(r"\\.\pipe\signalman-svc-test-{}", uuid_like());

    let backend: Arc<dyn Backend> = Arc::new(MockBackend);
    let svc = ControlPlaneService::new(backend);

    // Server: accept-loop.
    let pipe_for_server = pipe_name.clone();
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let (conn_tx, conn_rx) = mpsc::channel::<Result<ServerConn, std::io::Error>>(8);
        let pipe_for_loop = pipe_for_server.clone();
        tokio::spawn(async move {
            let mut first = true;
            loop {
                let mut opts = ServerOptions::new();
                if first {
                    opts.first_pipe_instance(true);
                    first = false;
                }
                let server = match opts.create(&pipe_for_loop) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = conn_tx.send(Err(e)).await;
                        return;
                    }
                };
                if let Err(e) = server.connect().await {
                    let _ = conn_tx.send(Err(e)).await;
                    return;
                }
                if conn_tx
                    .send(Ok(ServerConn { inner: server }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });

        let _ = ready_tx.send(());
        let stream = ReceiverStream::new(conn_rx);
        let _ = tonic::transport::Server::builder()
            .add_service(svc.into_server())
            .serve_with_incoming_shutdown(stream, async {
                tokio::time::sleep(Duration::from_secs(30)).await;
            })
            .await;
    });

    ready_rx.await.unwrap();
    // Tiny pause so the first ServerOptions::create has run.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Build a tonic client whose connector opens the pipe.
    let connector = PipeConnector {
        pipe_name: pipe_name.clone(),
    };
    let endpoint = Endpoint::from_static("http://signalman-pipe");
    let channel = endpoint
        .connect_with_connector(connector)
        .await
        .expect("connect via pipe");
    let mut client = ControlPlaneClient::new(channel);

    // ── Health ──────────────────────────────────────────────
    let health = client
        .health(proto::HealthRequest {})
        .await
        .expect("health rpc")
        .into_inner();
    assert_eq!(health.active_backend, "mock");

    // ── VmList ──────────────────────────────────────────────
    let list = client
        .vm_list(proto::VmListRequest {})
        .await
        .expect("vm_list rpc")
        .into_inner();
    assert_eq!(list.handles.len(), 1);
    assert_eq!(list.handles[0].name, "test-vm");

    // ── VmRunCommand (streaming) ───────────────────────────
    let mut stream = client
        .vm_run_command(proto::VmRunCommandRequest {
            handle: Some(proto::VmHandle {
                id: "id".into(),
                name: "vm".into(),
                backend: "mock".into(),
            }),
            command: "echo".into(),
            args: vec!["hi".into()],
            timeout_ms: 30_000,
        })
        .await
        .expect("run rpc")
        .into_inner();
    let mut got_result = false;
    while let Some(ev) = stream.next().await {
        let ev = ev.expect("stream event");
        if let Some(proto::vm_run_command_event::Event::Result(r)) = ev.event {
            assert_eq!(r.exit_code, 0);
            assert_eq!(r.stdout, "hi\n");
            got_result = true;
        }
    }
    assert!(got_result, "expected RunResult terminal event");

    server_task.abort();
}

// Pipe connection wrapper for the server side (mirrors the production
// PipeConn in transport.rs).
struct ServerConn {
    inner: NamedPipeServer,
}

impl AsyncRead for ServerConn {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for ServerConn {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl tonic::transport::server::Connected for ServerConn {
    type ConnectInfo = ();
    fn connect_info(&self) -> Self::ConnectInfo {}
}

/// Pseudo-unique suffix to avoid pipe-name collisions across parallel
/// test runs. Avoids pulling in the `uuid` crate just for this.
fn uuid_like() -> String {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{}", std::process::id())
}
