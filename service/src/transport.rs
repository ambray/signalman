//! Server-side transport bindings for the gRPC service.
//!
//! Two listeners run side-by-side:
//!   1. Named pipe `\\.\pipe\signalman-service` (Windows only) —
//!      primary for local clients (the host MCP server).
//!   2. TCP `127.0.0.1:17777`, mTLS via rustls — secondary for tooling
//!      that doesn't speak pipes.
//!
//! Both serve the same `ControlPlaneService`. Pipe traffic is implicitly
//! authenticated by Windows ACL on the pipe; TCP traffic is authenticated
//! by mTLS using the cert bundle generated at install time.
//!
//! v0.1.0 only enforces mTLS on the TCP listener. Pipe ACL hardening
//! (limit to Hyper-V Administrators) is in `docs/p1-service.md` open
//! questions.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::watch;
use tonic::transport::{Server, ServerTlsConfig};

use crate::backend::Backend;
use crate::service::ControlPlaneService;
use crate::tls::CertBundle;

/// Listener addresses.
#[derive(Debug, Clone)]
pub struct TransportConfig {
    /// TCP socket address. None disables the TCP listener.
    pub tcp: Option<SocketAddr>,
    /// Named-pipe name (e.g. `\\.\pipe\signalman-service`). None disables.
    pub pipe: Option<String>,
    /// Cert bundle for mTLS (always required when `tcp` is set).
    pub certs: CertBundle,
}

impl TransportConfig {
    pub fn local_default(certs: CertBundle, port: u16) -> Self {
        Self {
            tcp: Some(format!("127.0.0.1:{port}").parse().expect("valid socket")),
            pipe: Some(crate::PIPE_NAME.to_string()),
            certs,
        }
    }
}

/// Run the service until `shutdown` flips to `true`.
///
/// `shutdown` is a `watch::Receiver<bool>` so multiple listeners can
/// observe the same signal. The function returns once every listener
/// has stopped accepting and drained its in-flight requests.
pub async fn serve(
    backend: Arc<dyn Backend>,
    config: TransportConfig,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let svc = ControlPlaneService::new(backend);

    let mut tasks: Vec<tokio::task::JoinHandle<Result<()>>> = Vec::new();

    if let Some(addr) = config.tcp {
        let svc_clone = svc.clone();
        let bundle = config.certs.clone();
        let mut shutdown_rx = shutdown.clone();
        let task = tokio::spawn(async move {
            tracing::info!(?addr, "starting TCP gRPC listener (mTLS)");
            let server_pem =
                std::fs::read_to_string(&bundle.server_cert).context("reading server cert")?;
            let server_key =
                std::fs::read_to_string(&bundle.server_key).context("reading server key")?;
            let ca_pem = std::fs::read_to_string(&bundle.ca_cert).context("reading CA cert")?;

            let identity = tonic::transport::Identity::from_pem(server_pem, server_key);
            let ca = tonic::transport::Certificate::from_pem(ca_pem);
            // Audit Sec F8 (Med) / B8: protocol-version policy lives in
            // `crate::tls::ALLOWED_PROTOCOL_VERSIONS` (TLS 1.3 + 1.2).
            // tonic 0.12's `ServerTlsConfig` does NOT expose a way to
            // inject a pre-built `rustls::ServerConfig`, so the pin
            // can't be pushed through this path today. rustls 0.23's
            // defaults match our policy (TLS 1.3 + 1.2 only — older
            // versions aren't even compiled in given our feature
            // set), so we are not actually wider than intended. When
            // tonic exposes `rustls_server_config(...)` (slated for
            // 0.13+), swap to `crate::tls::build_rustls_server_config`
            // and the pin becomes load-bearing. See `tls.rs` module
            // docs for full rationale.
            let tls = ServerTlsConfig::new().identity(identity).client_ca_root(ca);

            Server::builder()
                .tls_config(tls)
                .context("configuring TLS")?
                .add_service(svc_clone.into_server())
                .serve_with_shutdown(addr, async move {
                    let _ = shutdown_rx.changed().await;
                })
                .await
                .context("tcp serve")?;
            Ok(())
        });
        tasks.push(task);
    }

    #[cfg(target_os = "windows")]
    if let Some(pipe_name) = config.pipe {
        let svc_clone = svc.clone();
        let mut shutdown_rx = shutdown.clone();
        let task = tokio::spawn(async move {
            tracing::info!(pipe = %pipe_name, "starting named-pipe gRPC listener");
            pipe::serve_pipe(svc_clone, pipe_name, async move {
                let _ = shutdown_rx.changed().await;
            })
            .await
        });
        tasks.push(task);
    }

    #[cfg(not(target_os = "windows"))]
    if config.pipe.is_some() {
        tracing::warn!("named-pipe transport requested but only supported on Windows");
    }

    // Wait for shutdown.
    let _ = shutdown.changed().await;
    for h in tasks {
        let _ = h.await;
    }
    Ok(())
}

/// Path for the cert bundle when running locally (used by `--foreground`).
pub fn default_cert_root() -> PathBuf {
    crate::tls::default_cert_dir()
}

#[cfg(target_os = "windows")]
mod pipe {
    //! Named-pipe gRPC bridge.
    //!
    //! `tonic` accepts any `Stream<Item = Result<impl Connected, _>>`
    //! via `serve_with_incoming_shutdown`. We run an accept loop in a
    //! background task and feed accepted `NamedPipeServer` instances
    //! into a channel that backs the stream.

    use std::pin::Pin;
    use std::task::{Context, Poll};

    use anyhow::Result;
    use futures::Stream;
    use std::io;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;
    use tonic::transport::server::Connected;

    use crate::service::ControlPlaneService;

    pub async fn serve_pipe<S>(
        svc: ControlPlaneService,
        pipe_name: String,
        shutdown: S,
    ) -> Result<()>
    where
        S: std::future::Future<Output = ()> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Result<PipeConn, io::Error>>(8);
        let pipe_name_for_loop = pipe_name.clone();
        // Accept loop: serially create pipe instances and connect.
        // Hyper-V control-plane workload is sequential anyway; if we
        // ever need parallel connections we can spin up multiple
        // accept tasks.
        //
        // P4.c / Sec F6: build a SECURITY_DESCRIPTOR ONCE and reuse
        // it for every pipe instance. Without this, the pipe inherits
        // the creating process's default ACL (LocalSystem +
        // BUILTIN\Administrators + creating user) — fine on a single-
        // admin dev box but on a server with many local Administrators
        // it broadens far past the intended operator surface. The
        // explicit SD pins access to {SYSTEM, BUILTIN\Administrators,
        // Hyper-V Administrators, current process user} only.
        //
        // Failure to build the SD is a fatal startup error rather
        // than falling back to default ACLs — we want the operator
        // to see the failure (likely a Win32 misconfig) loudly
        // rather than silently downgrade to the insecure default.
        let mut pipe_sd = match crate::pipe_security::PipeSecurityDescriptor::new() {
            Ok(sd) => sd,
            Err(e) => {
                return Err(e.context(
                    "building named-pipe SECURITY_DESCRIPTOR for signalman-service",
                ));
            }
        };

        let accept_task = tokio::spawn(async move {
            // The first instance MUST use `first_pipe_instance(true)`
            // so we claim ownership of the pipe namespace.
            let mut first = true;
            loop {
                let mut opts = ServerOptions::new();
                if first {
                    opts.first_pipe_instance(true);
                    first = false;
                }
                // SAFETY: `pipe_sd.as_raw()` returns a pointer that
                // remains valid for the lifetime of `pipe_sd`, which
                // is moved into this task and lives until the task
                // exits. tokio's API requires we hand it an unsafe
                // raw pointer because SECURITY_ATTRIBUTES is a Win32
                // C struct.
                let server = match unsafe {
                    opts.create_with_security_attributes_raw(
                        &pipe_name_for_loop,
                        pipe_sd.as_raw(),
                    )
                } {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                };
                if let Err(e) = server.connect().await {
                    let _ = tx.send(Err(e)).await;
                    return;
                }
                if tx.send(Ok(PipeConn { inner: server })).await.is_err() {
                    return; // receiver dropped; shutdown
                }
            }
        });

        let stream = ReceiverStream::new(rx);
        let res = tonic::transport::Server::builder()
            .add_service(svc.into_server())
            .serve_with_incoming_shutdown(stream, shutdown)
            .await;
        accept_task.abort();
        res.map_err(Into::into)
    }

    /// Adapter wrapping a `NamedPipeServer` so it satisfies tonic's
    /// `Connected` requirement.
    pub struct PipeConn {
        pub(crate) inner: NamedPipeServer,
    }

    impl AsyncRead for PipeConn {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for PipeConn {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.inner).poll_write(cx, buf)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    impl Connected for PipeConn {
        type ConnectInfo = PipeConnectInfo;
        fn connect_info(&self) -> Self::ConnectInfo {
            PipeConnectInfo {}
        }
    }

    #[derive(Clone, Default)]
    pub struct PipeConnectInfo {}

    // Suppress unused warnings on items that the integration test
    // relies on but the cfg-gated build path otherwise wouldn't see.
    #[allow(dead_code)]
    fn _stream_marker(_: Pin<&mut dyn Stream<Item = ()>>) {}
}
