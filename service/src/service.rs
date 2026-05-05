//! gRPC server implementation of the `ControlPlane` service.
//!
//! The handlers translate proto messages to the [`Backend`] trait and
//! back. They never construct PowerShell directly — sanitization +
//! cmdlet construction live in [`crate::backend::HyperVBackend`].

use std::pin::Pin;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use futures::Stream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::backend::{
    install_command_for, Backend, BackendError, CheckpointHandle as InternalCheckpointHandle,
    CopyEvent, GuestCredentials as InternalGuestCredentials,
    NetworkConfig as InternalNetworkConfig, RunEvent, VmConfig as InternalVmConfig,
    VmHandle as InternalVmHandle, WaitAgentEvent,
};
use crate::proto;

/// Entry point for the gRPC server.
///
/// Wraps an [`Arc<dyn Backend>`] so the same handler set can serve
/// either a real or a mocked backend. The struct itself is `Clone`
/// (cheap, just bumps the Arc) so `tonic` can fan out across requests.
#[derive(Clone)]
pub struct ControlPlaneService {
    backend: Arc<dyn Backend>,
    started_at: Instant,
}

impl ControlPlaneService {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            started_at: Instant::now(),
        }
    }

    /// Convenience helper: build a `Server`-ready router with this
    /// service registered. Call sites usually want this rather than
    /// the raw service.
    pub fn into_router(self) -> tonic::transport::server::Router {
        tonic::transport::Server::builder().add_service(self.into_server())
    }

    /// Build the server-side service with the trace-correlation
    /// interceptor wired in (P3.d). Trace headers off inbound requests
    /// land in `request.extensions()` as a [`crate::trace::TraceContextExt`]
    /// and emit a `signalman::trace` log line per request. Un-traced
    /// callers pass through unchanged.
    pub fn into_server(
        self,
    ) -> tonic::service::interceptor::InterceptedService<
        proto::signalman_service::control_plane_server::ControlPlaneServer<Self>,
        crate::trace::TraceInterceptor,
    > {
        use proto::signalman_service::control_plane_server::ControlPlaneServer;
        ControlPlaneServer::with_interceptor(self, crate::trace::TraceInterceptor)
    }
}

// ── Conversions ─────────────────────────────────────────────────────

fn map_err(e: BackendError) -> Status {
    match e {
        BackendError::InvalidArgument(m) => Status::invalid_argument(m),
        BackendError::ShellFailure(m) => Status::failed_precondition(m),
        BackendError::DecodeFailure(m) => Status::internal(m),
        BackendError::InvalidVmState(m) => Status::failed_precondition(m),
        BackendError::Io(e) => Status::internal(e.to_string()),
        BackendError::Internal(m) => Status::internal(m),
    }
}

fn require<T>(opt: Option<T>, field: &str) -> Result<T, Status> {
    opt.ok_or_else(|| Status::invalid_argument(format!("missing field: {field}")))
}

fn handle_to_proto(h: InternalVmHandle) -> proto::VmHandle {
    proto::VmHandle {
        id: h.id,
        name: h.name,
        backend: h.backend,
    }
}

fn handle_from_proto(h: proto::VmHandle) -> InternalVmHandle {
    InternalVmHandle {
        id: h.id,
        name: h.name,
        backend: h.backend,
    }
}

fn cp_handle_from_proto(
    h: proto::CheckpointHandleMessage,
) -> Result<InternalCheckpointHandle, Status> {
    let vm_handle = require(h.vm_handle, "vm_handle")?;
    Ok(InternalCheckpointHandle {
        id: h.id,
        vm_handle: handle_from_proto(vm_handle),
        label: h.label,
    })
}

fn cp_handle_to_proto(h: InternalCheckpointHandle) -> proto::CheckpointHandleMessage {
    proto::CheckpointHandleMessage {
        id: h.id,
        vm_handle: Some(handle_to_proto(h.vm_handle)),
        label: h.label,
    }
}

fn credentials_from_proto(c: Option<proto::GuestCredentials>) -> Option<InternalGuestCredentials> {
    c.map(|c| InternalGuestCredentials {
        username: c.username,
        password: c.password,
    })
}

fn config_from_proto(c: proto::VmConfig) -> InternalVmConfig {
    InternalVmConfig {
        name: c.name,
        template: empty_to_none(c.template),
        cpus: zero_to_none(c.cpus),
        memory_mb: zero_to_none(c.memory_mb),
        disk_gb: zero_to_none(c.disk_gb),
        network: c.network.map(|n| InternalNetworkConfig {
            switch_name: empty_to_none(n.switch_name),
            static_ip: empty_to_none(n.static_ip),
            subnet_mask: empty_to_none(n.subnet_mask),
            gateway: empty_to_none(n.gateway),
        }),
        guest_agent_port: zero_to_none(c.guest_agent_port),
    }
}

fn empty_to_none(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn zero_to_none(n: u32) -> Option<u32> {
    if n == 0 {
        None
    } else {
        Some(n)
    }
}

// ── Server impl ─────────────────────────────────────────────────────

#[tonic::async_trait]
impl proto::signalman_service::control_plane_server::ControlPlane for ControlPlaneService {
    async fn health(
        &self,
        _req: Request<proto::HealthRequest>,
    ) -> Result<Response<proto::HealthResponse>, Status> {
        let active = self.backend.name().to_string();
        let uptime_seconds = self.started_at.elapsed().as_secs();
        Ok(Response::new(proto::HealthResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_seconds,
            available_backends: vec![active.clone()],
            active_backend: active,
        }))
    }

    async fn get_active_backend(
        &self,
        _req: Request<proto::GetActiveBackendRequest>,
    ) -> Result<Response<proto::GetActiveBackendResponse>, Status> {
        Ok(Response::new(proto::GetActiveBackendResponse {
            name: self.backend.name().to_string(),
        }))
    }

    async fn vm_create(
        &self,
        req: Request<proto::VmCreateRequest>,
    ) -> Result<Response<proto::VmHandleResponse>, Status> {
        let req = req.into_inner();
        let config = config_from_proto(require(req.config, "config")?);
        let h = self.backend.create_vm(&config).await.map_err(map_err)?;
        Ok(Response::new(proto::VmHandleResponse {
            handle: Some(handle_to_proto(h)),
        }))
    }

    async fn vm_start(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        self.backend.start_vm(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn vm_stop(
        &self,
        req: Request<proto::VmStopRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        self.backend.stop_vm(&h, req.force).await.map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn vm_pause(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        self.backend.pause_vm(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn vm_resume(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        self.backend.resume_vm(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn vm_delete(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        self.backend.delete_vm(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn vm_get_status(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::VmStatusResponse>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        let status = self.backend.get_status(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::VmStatusResponse {
            handle: Some(handle_to_proto(status.handle)),
            state: status.state.as_str().to_string(),
            ip_address: status.ip_address.unwrap_or_default(),
            guest_agent_reachable: status.guest_agent_reachable,
            uptime_seconds: status.uptime_seconds.unwrap_or(0),
            memory_used_mb: status.memory_used_mb.unwrap_or(0),
        }))
    }

    async fn vm_list(
        &self,
        _req: Request<proto::VmListRequest>,
    ) -> Result<Response<proto::VmListResponse>, Status> {
        let vms = self.backend.list_vms().await.map_err(map_err)?;
        Ok(Response::new(proto::VmListResponse {
            handles: vms.into_iter().map(handle_to_proto).collect(),
        }))
    }

    async fn checkpoint_create(
        &self,
        req: Request<proto::CheckpointCreateRequest>,
    ) -> Result<Response<proto::CheckpointHandleResponse>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        let cp = self
            .backend
            .create_checkpoint(&h, &req.label)
            .await
            .map_err(map_err)?;
        Ok(Response::new(proto::CheckpointHandleResponse {
            handle: Some(cp_handle_to_proto(cp)),
        }))
    }

    async fn checkpoint_restore(
        &self,
        req: Request<proto::CheckpointHandleMessage>,
    ) -> Result<Response<proto::Empty>, Status> {
        let cp = cp_handle_from_proto(req.into_inner())?;
        self.backend
            .restore_checkpoint(&cp)
            .await
            .map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn checkpoint_delete(
        &self,
        req: Request<proto::CheckpointHandleMessage>,
    ) -> Result<Response<proto::Empty>, Status> {
        let cp = cp_handle_from_proto(req.into_inner())?;
        self.backend.delete_checkpoint(&cp).await.map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn checkpoint_list(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::CheckpointListResponse>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        let cps = self.backend.list_checkpoints(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::CheckpointListResponse {
            checkpoints: cps
                .into_iter()
                .map(|c| proto::CheckpointInfo {
                    id: c.id,
                    label: c.label,
                    created_at: c.created_at,
                    parent_id: c.parent_id.unwrap_or_default(),
                })
                .collect(),
        }))
    }

    type VmCopyFileStream =
        Pin<Box<dyn Stream<Item = Result<proto::VmCopyFileEvent, Status>> + Send + 'static>>;

    async fn vm_copy_file(
        &self,
        req: Request<proto::VmCopyFileRequest>,
    ) -> Result<Response<Self::VmCopyFileStream>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        let backend = self.backend.clone();
        let host_path = req.host_path;
        let guest_path = req.guest_path;
        let from_guest = req.from_guest;
        let credentials = credentials_from_proto(req.credentials);

        let (event_tx, mut event_rx) = mpsc::channel::<CopyEvent>(8);
        let (out_tx, out_rx) = mpsc::channel::<Result<proto::VmCopyFileEvent, Status>>(8);

        // Drive the backend on a worker task; bridge events into the
        // gRPC stream, then forward the terminal result.
        tokio::spawn(async move {
            let backend_fut = async {
                backend
                    .copy_file(
                        &h,
                        &host_path,
                        &guest_path,
                        from_guest,
                        credentials,
                        event_tx,
                    )
                    .await
            };

            // Forward events while the backend runs. We do this by
            // running the backend future to completion concurrently
            // with a per-event forwarder.
            let forwarder = async {
                while let Some(ev) = event_rx.recv().await {
                    let proto_ev = match ev {
                        CopyEvent::Progress { transferred, total } => proto::VmCopyFileEvent {
                            event: Some(proto::vm_copy_file_event::Event::Progress(
                                proto::CopyProgress {
                                    bytes_transferred: transferred,
                                    total_bytes: total,
                                },
                            )),
                        },
                        CopyEvent::Complete => proto::VmCopyFileEvent {
                            event: Some(proto::vm_copy_file_event::Event::Complete(
                                proto::CopyComplete {},
                            )),
                        },
                    };
                    if out_tx.send(Ok(proto_ev)).await.is_err() {
                        return;
                    }
                }
            };

            let (res, ()) = tokio::join!(backend_fut, forwarder);
            if let Err(e) = res {
                let _ = out_tx.send(Err(map_err(e))).await;
            }
        });

        Ok(Response::new(
            Box::pin(ReceiverStream::new(out_rx)) as Self::VmCopyFileStream
        ))
    }

    type VmRunCommandStream =
        Pin<Box<dyn Stream<Item = Result<proto::VmRunCommandEvent, Status>> + Send + 'static>>;

    async fn vm_run_command(
        &self,
        req: Request<proto::VmRunCommandRequest>,
    ) -> Result<Response<Self::VmRunCommandStream>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        let backend = self.backend.clone();
        let cmd = req.command;
        let args = req.args;
        let credentials = credentials_from_proto(req.credentials);
        let timeout_ms = if req.timeout_ms == 0 {
            30_000
        } else {
            req.timeout_ms as u64
        };

        let (event_tx, event_rx) = mpsc::channel::<RunEvent>(64);
        let (out_tx, out_rx) = mpsc::channel::<Result<proto::VmRunCommandEvent, Status>>(64);

        tokio::spawn(async move {
            let forwarder = run_event_forwarder(event_rx, out_tx.clone());
            let backend_fut =
                backend.execute_command(&h, &cmd, &args, timeout_ms, credentials, event_tx);
            let (res, ()) = tokio::join!(backend_fut, forwarder);
            if let Err(e) = res {
                let _ = out_tx.send(Err(map_err(e))).await;
            }
        });

        Ok(Response::new(
            Box::pin(ReceiverStream::new(out_rx)) as Self::VmRunCommandStream
        ))
    }

    async fn vm_get_ip(
        &self,
        req: Request<proto::VmHandleRequest>,
    ) -> Result<Response<proto::VmIpResponse>, Status> {
        let h = handle_from_proto(require(req.into_inner().handle, "handle")?);
        let ip = self.backend.get_vm_ip(&h).await.map_err(map_err)?;
        Ok(Response::new(proto::VmIpResponse { ip_address: ip }))
    }

    type VmWaitAgentStream =
        Pin<Box<dyn Stream<Item = Result<proto::VmWaitAgentEvent, Status>> + Send + 'static>>;

    async fn vm_wait_agent(
        &self,
        req: Request<proto::VmWaitAgentRequest>,
    ) -> Result<Response<Self::VmWaitAgentStream>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        let backend = self.backend.clone();
        let timeout_ms = if req.timeout_ms == 0 {
            300_000
        } else {
            req.timeout_ms as u64
        };

        let (event_tx, mut event_rx) = mpsc::channel::<WaitAgentEvent>(8);
        let (out_tx, out_rx) = mpsc::channel::<Result<proto::VmWaitAgentEvent, Status>>(8);

        tokio::spawn(async move {
            let backend_fut = backend.wait_for_heartbeat(&h, timeout_ms, event_tx);
            let forwarder = async {
                while let Some(ev) = event_rx.recv().await {
                    let proto_ev = match ev {
                        WaitAgentEvent::Heartbeat { state, elapsed_ms } => {
                            proto::VmWaitAgentEvent {
                                event: Some(proto::vm_wait_agent_event::Event::Heartbeat(
                                    proto::AgentHeartbeat {
                                        heartbeat_state: state,
                                        elapsed_ms,
                                    },
                                )),
                            }
                        }
                        WaitAgentEvent::Ready => proto::VmWaitAgentEvent {
                            event: Some(proto::vm_wait_agent_event::Event::Ready(
                                proto::AgentReady {},
                            )),
                        },
                        WaitAgentEvent::Timeout => proto::VmWaitAgentEvent {
                            event: Some(proto::vm_wait_agent_event::Event::Timeout(
                                proto::AgentTimeout {},
                            )),
                        },
                    };
                    if out_tx.send(Ok(proto_ev)).await.is_err() {
                        return;
                    }
                }
            };
            let (res, ()) = tokio::join!(backend_fut, forwarder);
            if let Err(e) = res {
                let _ = out_tx.send(Err(map_err(e))).await;
            }
        });

        Ok(Response::new(
            Box::pin(ReceiverStream::new(out_rx)) as Self::VmWaitAgentStream
        ))
    }

    async fn vm_set_memory(
        &self,
        req: Request<proto::VmSetMemoryRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        self.backend
            .set_vm_memory(&h, req.memory_mb)
            .await
            .map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    async fn vm_set_processor(
        &self,
        req: Request<proto::VmSetProcessorRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        self.backend
            .set_vm_processor(&h, req.count)
            .await
            .map_err(map_err)?;
        Ok(Response::new(proto::Empty {}))
    }

    type VmInstallStream =
        Pin<Box<dyn Stream<Item = Result<proto::VmRunCommandEvent, Status>> + Send + 'static>>;

    async fn vm_install(
        &self,
        req: Request<proto::VmInstallRequest>,
    ) -> Result<Response<Self::VmInstallStream>, Status> {
        let req = req.into_inner();
        let h = handle_from_proto(require(req.handle, "handle")?);
        let source = if req.source.is_empty() {
            "winget".to_string()
        } else {
            req.source
        };
        let (cmd, args) = install_command_for(&source, &req.package_id).map_err(map_err)?;
        let timeout_ms = if req.timeout_ms == 0 {
            300_000
        } else {
            req.timeout_ms as u64
        };
        let backend = self.backend.clone();

        let (event_tx, event_rx) = mpsc::channel::<RunEvent>(64);
        let (out_tx, out_rx) = mpsc::channel::<Result<proto::VmRunCommandEvent, Status>>(64);

        tokio::spawn(async move {
            let forwarder = run_event_forwarder(event_rx, out_tx.clone());
            let backend_fut = backend.execute_command(&h, &cmd, &args, timeout_ms, None, event_tx);
            let (res, ()) = tokio::join!(backend_fut, forwarder);
            if let Err(e) = res {
                let _ = out_tx.send(Err(map_err(e))).await;
            }
        });

        Ok(Response::new(
            Box::pin(ReceiverStream::new(out_rx)) as Self::VmInstallStream
        ))
    }
}

/// Forward backend `RunEvent`s to gRPC `VmRunCommandEvent`s.
async fn run_event_forwarder(
    mut event_rx: mpsc::Receiver<RunEvent>,
    out_tx: mpsc::Sender<Result<proto::VmRunCommandEvent, Status>>,
) {
    while let Some(ev) = event_rx.recv().await {
        let proto_ev = match ev {
            RunEvent::Started { started_at_unix_ms } => proto::VmRunCommandEvent {
                event: Some(proto::vm_run_command_event::Event::Start(proto::RunStart {
                    started_at_unix_ms,
                })),
            },
            RunEvent::Stdout(data) => proto::VmRunCommandEvent {
                event: Some(proto::vm_run_command_event::Event::StdoutChunk(
                    proto::RunOutput { data },
                )),
            },
            RunEvent::Stderr(data) => proto::VmRunCommandEvent {
                event: Some(proto::vm_run_command_event::Event::StderrChunk(
                    proto::RunOutput { data },
                )),
            },
            RunEvent::Result(r) => proto::VmRunCommandEvent {
                event: Some(proto::vm_run_command_event::Event::Result(
                    proto::RunResult {
                        exit_code: r.exit_code,
                        stdout: r.stdout,
                        stderr: r.stderr,
                        duration_ms: r.duration_ms,
                    },
                )),
            },
        };
        if out_tx.send(Ok(proto_ev)).await.is_err() {
            return;
        }
    }
}

/// Returns the current Unix epoch milliseconds. Exposed for tests.
pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::test_support::ScriptedRunner;
    use crate::backend::HyperVBackend;
    use crate::proto::signalman_service::control_plane_server::ControlPlane;
    use tokio_stream::StreamExt;

    fn service_with(responses: Vec<crate::backend::BackendResult<String>>) -> ControlPlaneService {
        let runner = Arc::new(ScriptedRunner::new(responses));
        let backend = Arc::new(HyperVBackend::with_runner(runner));
        ControlPlaneService::new(backend)
    }

    #[tokio::test]
    async fn health_returns_active_backend() {
        let svc = service_with(vec![]);
        let resp = svc
            .health(Request::new(proto::HealthRequest {}))
            .await
            .unwrap();
        let body = resp.into_inner();
        assert_eq!(body.active_backend, "hyperv");
        assert!(body.available_backends.contains(&"hyperv".to_string()));
        assert!(!body.version.is_empty());
    }

    #[tokio::test]
    async fn vm_list_returns_handles() {
        let svc = service_with(vec![Ok(r#"[{"Id":"1","Name":"vm1"}]"#.to_string())]);
        let resp = svc
            .vm_list(Request::new(proto::VmListRequest {}))
            .await
            .unwrap();
        let handles = resp.into_inner().handles;
        assert_eq!(handles.len(), 1);
        assert_eq!(handles[0].name, "vm1");
        assert_eq!(handles[0].backend, "hyperv");
    }

    #[tokio::test]
    async fn vm_create_validates_input() {
        let svc = service_with(vec![]);
        let req = Request::new(proto::VmCreateRequest {
            config: Some(proto::VmConfig {
                name: "bad name".to_string(),
                ..Default::default()
            }),
        });
        let err = svc.vm_create(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn vm_get_status_maps_state() {
        let svc = service_with(vec![Ok(
            r#"{"State":"Running","Uptime":42,"MemoryAssigned":2048,"IPAddress":"10.0.0.5"}"#
                .to_string(),
        )]);
        let req = Request::new(proto::VmHandleRequest {
            handle: Some(proto::VmHandle {
                id: "id1".to_string(),
                name: "vm1".to_string(),
                backend: "hyperv".to_string(),
            }),
        });
        let resp = svc.vm_get_status(req).await.unwrap().into_inner();
        assert_eq!(resp.state, "running");
        assert_eq!(resp.ip_address, "10.0.0.5");
        assert_eq!(resp.uptime_seconds, 42);
    }

    #[tokio::test]
    async fn vm_run_command_streams_events() {
        let svc = service_with(vec![Ok(r#"{"ExitCode":0,"Output":"hello\n"}"#.to_string())]);
        let req = Request::new(proto::VmRunCommandRequest {
            handle: Some(proto::VmHandle {
                id: "id1".to_string(),
                name: "vm1".to_string(),
                backend: "hyperv".to_string(),
            }),
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            timeout_ms: 30_000,
            credentials: None,
        });
        let mut stream = svc.vm_run_command(req).await.unwrap().into_inner();
        let mut got_start = false;
        let mut got_stdout = false;
        let mut got_result = false;
        while let Some(ev) = stream.next().await {
            let ev = ev.unwrap();
            match ev.event.unwrap() {
                proto::vm_run_command_event::Event::Start(_) => got_start = true,
                proto::vm_run_command_event::Event::StdoutChunk(chunk) => {
                    got_stdout = true;
                    assert_eq!(chunk.data, b"hello\n");
                }
                proto::vm_run_command_event::Event::Result(r) => {
                    got_result = true;
                    assert_eq!(r.exit_code, 0);
                    assert_eq!(r.stdout, "hello\n");
                }
                _ => {}
            }
        }
        assert!(got_start);
        assert!(got_stdout);
        assert!(got_result);
    }

    #[tokio::test]
    async fn vm_run_command_allows_powershell_command_arguments() {
        let svc = service_with(vec![Ok(
            r#"{"ExitCode":0,"Output":"service-backend-smoke:fixture\n"}"#.to_string(),
        )]);
        let req = Request::new(proto::VmRunCommandRequest {
            handle: Some(proto::VmHandle {
                id: "id1".to_string(),
                name: "vm1".to_string(),
                backend: "hyperv".to_string(),
            }),
            command: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "$value = Get-Content -Raw C:\\SignalmanSmoke\\input.txt; Set-Content -Path C:\\SignalmanSmoke\\output.txt -Value \"service-backend-smoke:$value\"; Get-Content -Raw C:\\SignalmanSmoke\\output.txt".to_string(),
            ],
            timeout_ms: 60_000,
            credentials: Some(proto::GuestCredentials {
                username: "test".to_string(),
                password: "secret".to_string(),
            }),
        });
        let mut stream = svc.vm_run_command(req).await.unwrap().into_inner();
        let mut got_result = false;
        while let Some(ev) = stream.next().await {
            let ev = ev.unwrap();
            if let Some(proto::vm_run_command_event::Event::Result(r)) = ev.event {
                got_result = true;
                assert_eq!(r.exit_code, 0);
                assert!(r.stdout.contains("service-backend-smoke:fixture"));
            }
        }
        assert!(got_result);
    }

    #[tokio::test]
    async fn vm_install_rejects_bad_url_for_direct() {
        let svc = service_with(vec![]);
        let req = Request::new(proto::VmInstallRequest {
            handle: Some(proto::VmHandle {
                id: "id1".to_string(),
                name: "vm1".to_string(),
                backend: "hyperv".to_string(),
            }),
            package_id: "javascript:alert(1)".to_string(),
            source: "direct".to_string(),
            timeout_ms: 0,
        });
        // The stream type isn't Debug, so use match rather than unwrap_err.
        match svc.vm_install(req).await {
            Ok(_) => panic!("expected InvalidArgument"),
            Err(e) => assert_eq!(e.code(), tonic::Code::InvalidArgument),
        }
    }

    #[tokio::test]
    async fn require_returns_invalid_arg_for_missing_handle() {
        let svc = service_with(vec![]);
        let req = Request::new(proto::VmHandleRequest { handle: None });
        let err = svc.vm_start(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn vm_set_memory_validates_range() {
        let svc = service_with(vec![]);
        let req = Request::new(proto::VmSetMemoryRequest {
            handle: Some(proto::VmHandle {
                id: "id1".to_string(),
                name: "vm1".to_string(),
                backend: "hyperv".to_string(),
            }),
            memory_mb: 16,
        });
        let err = svc.vm_set_memory(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }
}
