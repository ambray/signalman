//! Backend abstraction.
//!
//! The trait mirrors the surface of `host/src/hypervisors/interface.ts`
//! so the gRPC service handlers can dispatch through a single interface
//! and so unit tests can swap in a mock.
//!
//! v0.1.0 ships exactly one real implementation: `HyperVBackend`. The
//! second implementation lives only in tests (`MockBackend`).
//!
//! Each method is `async` and returns `BackendResult<_>` so failures
//! can carry a structured error code that the service layer can map
//! to the correct gRPC `Status`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::mpsc;

use crate::sanitize::{
    escape_powershell_arg, sanitize_command, sanitize_label, sanitize_path,
    sanitize_timeout_default, sanitize_url, sanitize_vm_name, SanitizeError,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VmHandle {
    pub id: String,
    pub name: String,
    pub backend: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub switch_name: Option<String>,
    pub static_ip: Option<String>,
    pub subnet_mask: Option<String>,
    pub gateway: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VmConfig {
    pub name: String,
    pub template: Option<String>,
    pub cpus: Option<u32>,
    pub memory_mb: Option<u32>,
    pub disk_gb: Option<u32>,
    pub network: Option<NetworkConfig>,
    pub guest_agent_port: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum VmState {
    Stopped,
    Running,
    Paused,
    Saved,
    Unknown,
}

impl VmState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Saved => "saved",
            Self::Unknown => "unknown",
        }
    }

    /// Maps the Hyper-V CIM `EnabledState` integers and Win32_VM
    /// `State` strings used by `Get-VM` into our enum.
    pub fn from_hyperv_state(s: &str) -> Self {
        match s {
            "2" | "Running" => Self::Running,
            "3" | "Off" => Self::Stopped,
            "6" | "Saved" => Self::Saved,
            "9" | "Paused" => Self::Paused,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmStatus {
    pub handle: VmHandle,
    pub state: VmState,
    pub ip_address: Option<String>,
    pub guest_agent_reachable: bool,
    pub uptime_seconds: Option<u64>,
    pub memory_used_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointInfo {
    pub id: String,
    pub label: String,
    /// RFC 3339 timestamp.
    pub created_at: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointHandle {
    pub id: String,
    pub vm_handle: VmHandle,
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// Errors a backend can raise. The service layer maps these onto
/// gRPC `Code`s in `service.rs`.
#[derive(Debug, Error)]
pub enum BackendError {
    /// Caller supplied input that the sanitizers rejected.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// PowerShell or another shell-out exited non-zero.
    #[error("shell failure: {0}")]
    ShellFailure(String),
    /// JSON returned by PowerShell didn't match the expected shape.
    #[error("decode failure: {0}")]
    DecodeFailure(String),
    /// The hypervisor reported the VM in a state we can't act on.
    #[error("invalid vm state: {0}")]
    InvalidVmState(String),
    /// Wrapper for `io::Error`.
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    /// Catch-all for unexpected internal failures.
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<SanitizeError> for BackendError {
    fn from(e: SanitizeError) -> Self {
        Self::InvalidArgument(e.to_string())
    }
}

pub type BackendResult<T> = Result<T, BackendError>;

/// Streamed run-command event. Carries either incremental output or
/// the terminal result.
#[derive(Debug, Clone)]
pub enum RunEvent {
    Started { started_at_unix_ms: u64 },
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Result(CommandResult),
}

/// Streamed copy-file progress event.
#[derive(Debug, Clone)]
pub enum CopyEvent {
    Progress { transferred: u64, total: u64 },
    Complete,
}

/// Streamed wait-agent event.
#[derive(Debug, Clone)]
pub enum WaitAgentEvent {
    Heartbeat { state: String, elapsed_ms: u64 },
    Ready,
    Timeout,
}

/// Backend trait — the trait the gRPC service handlers dispatch through.
///
/// Mirrors `HypervisorBackend` (TS) one-for-one. Methods that map to
/// streaming RPCs accept a `mpsc::Sender` so backends can push events
/// without baking gRPC types into the trait.
#[async_trait]
pub trait Backend: Send + Sync {
    /// Backend identifier (e.g. "hyperv").
    fn name(&self) -> &str;

    async fn is_available(&self) -> bool;

    // ── VM Lifecycle ──────────────────────────────────────────────
    async fn create_vm(&self, config: &VmConfig) -> BackendResult<VmHandle>;
    async fn start_vm(&self, handle: &VmHandle) -> BackendResult<()>;
    async fn stop_vm(&self, handle: &VmHandle, force: bool) -> BackendResult<()>;
    async fn pause_vm(&self, handle: &VmHandle) -> BackendResult<()>;
    async fn resume_vm(&self, handle: &VmHandle) -> BackendResult<()>;
    async fn delete_vm(&self, handle: &VmHandle) -> BackendResult<()>;
    async fn get_status(&self, handle: &VmHandle) -> BackendResult<VmStatus>;
    async fn list_vms(&self) -> BackendResult<Vec<VmHandle>>;

    // ── Checkpoints ───────────────────────────────────────────────
    async fn create_checkpoint(
        &self,
        handle: &VmHandle,
        label: &str,
    ) -> BackendResult<CheckpointHandle>;
    async fn restore_checkpoint(&self, cp: &CheckpointHandle) -> BackendResult<()>;
    async fn delete_checkpoint(&self, cp: &CheckpointHandle) -> BackendResult<()>;
    async fn list_checkpoints(&self, handle: &VmHandle) -> BackendResult<Vec<CheckpointInfo>>;

    // ── File Transfer ────────────────────────────────────────────
    async fn copy_file(
        &self,
        handle: &VmHandle,
        host_path: &str,
        guest_path: &str,
        from_guest: bool,
        events: mpsc::Sender<CopyEvent>,
    ) -> BackendResult<()>;

    // ── Command Execution ────────────────────────────────────────
    async fn execute_command(
        &self,
        handle: &VmHandle,
        command: &str,
        args: &[String],
        timeout_ms: u64,
        events: mpsc::Sender<RunEvent>,
    ) -> BackendResult<CommandResult>;

    // ── Extended Operations ──────────────────────────────────────
    async fn get_vm_ip(&self, handle: &VmHandle) -> BackendResult<String>;
    async fn wait_for_heartbeat(
        &self,
        handle: &VmHandle,
        timeout_ms: u64,
        events: mpsc::Sender<WaitAgentEvent>,
    ) -> BackendResult<bool>;
    async fn set_vm_memory(&self, handle: &VmHandle, memory_mb: u32) -> BackendResult<()>;
    async fn set_vm_processor(&self, handle: &VmHandle, count: u32) -> BackendResult<()>;
}

// ── Hyper-V backend ────────────────────────────────────────────────
//
// Builds PowerShell scripts using sanitized inputs and invokes
// `powershell.exe` directly via tokio::process::Command. Mirrors the
// patterns in `host/src/hypervisors/hyperv.ts` — including the event-
// driven CIM patterns: `-AsJob | Wait-Job` for state transitions, and
// `Register-CimIndicationEvent` on `Msvm_ComputerSystem` for the
// stable-state wait.
//
// The service runs elevated, so we never reach for gsudo. If the
// service somehow ends up running unelevated, Hyper-V cmdlets will
// fail with a clear "you must be Administrator" error and the
// dispatcher returns BackendError::ShellFailure. Don't try to recover
// — the install path puts us in Hyper-V Administrators.

pub struct HyperVBackend {
    runner: Arc<dyn PsRunner>,
}

impl HyperVBackend {
    /// Build a Hyper-V backend that shells out to `powershell.exe`.
    pub fn new() -> Self {
        Self {
            runner: Arc::new(RealPsRunner),
        }
    }

    /// Build a Hyper-V backend that uses an injected PowerShell runner.
    /// Used by unit tests to mock cmdlet output.
    pub fn with_runner(runner: Arc<dyn PsRunner>) -> Self {
        Self { runner }
    }
}

impl Default for HyperVBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// Trait for shelling out to PowerShell. Production uses `RealPsRunner`;
/// tests inject scripted responses.
#[async_trait]
pub trait PsRunner: Send + Sync {
    /// Run a PowerShell script with the supplied timeout. Returns the
    /// trimmed stdout. Errors map onto `BackendError::ShellFailure`.
    async fn run(&self, script: &str, timeout_ms: u64) -> BackendResult<String>;
}

pub struct RealPsRunner;

#[async_trait]
impl PsRunner for RealPsRunner {
    async fn run(&self, script: &str, timeout_ms: u64) -> BackendResult<String> {
        use std::time::Duration;
        use tokio::process::Command;
        use tokio::time::timeout;

        let wrapped = format!("$ProgressPreference = 'SilentlyContinue'; {script}");
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &wrapped]);
        cmd.kill_on_drop(true);

        let fut = cmd.output();
        let out = timeout(Duration::from_millis(timeout_ms), fut)
            .await
            .map_err(|_| {
                BackendError::ShellFailure(format!(
                    "PowerShell command timed out after {timeout_ms}ms"
                ))
            })?
            .map_err(|e| BackendError::ShellFailure(format!("PowerShell spawn failed: {e}")))?;

        if !out.status.success() {
            return Err(BackendError::ShellFailure(format!(
                "PowerShell exited with status {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// Decode a JSON-shaped PS response into the target type.
fn ps_json<T: serde::de::DeserializeOwned>(s: &str) -> BackendResult<T> {
    serde_json::from_str(s).map_err(|e| {
        BackendError::DecodeFailure(format!(
            "Failed to parse PowerShell JSON output: {e}\nstdout: {s}"
        ))
    })
}

#[async_trait]
impl Backend for HyperVBackend {
    fn name(&self) -> &str {
        "hyperv"
    }

    async fn is_available(&self) -> bool {
        self.runner
            .run("Get-Command Get-VM -ErrorAction Stop | Out-Null", 10_000)
            .await
            .is_ok()
    }

    async fn create_vm(&self, config: &VmConfig) -> BackendResult<VmHandle> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&config.name)?);
        let switch = config
            .network
            .as_ref()
            .and_then(|n| n.switch_name.as_deref())
            .unwrap_or("Default Switch");
        let safe_switch = escape_powershell_arg(sanitize_label(switch)?);
        let mem = config.memory_mb.unwrap_or(4096);
        let cpus = config.cpus.unwrap_or(2);
        let script = format!(
            "$vm = New-VM -Name '{safe_name}' -MemoryStartupBytes {mem}MB -Generation 2 -SwitchName '{safe_switch}'; \
             Set-VMProcessor -VM $vm -Count {cpus}; \
             $vm | Select-Object Id, Name | ConvertTo-Json -Compress"
        );
        let out = self.runner.run(&script, 60_000).await?;
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "Id")]
            id: String,
            #[serde(rename = "Name")]
            name: String,
        }
        let r: R = ps_json(&out)?;
        Ok(VmHandle {
            id: r.id,
            name: r.name,
            backend: self.name().to_string(),
        })
    }

    async fn start_vm(&self, handle: &VmHandle) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        wait_for_stable_state(&*self.runner, &safe_name).await?;
        // -AsJob + Wait-Job: event-driven completion (no polling).
        let script = format!(
            "$vm = Get-VM -Name '{safe_name}'; \
             if ($vm.State -eq 'Running') {{ return }}; \
             $job = Start-VM -Name '{safe_name}' -AsJob; \
             Wait-Job -Job $job | Out-Null; \
             if ($job.State -ne 'Completed') {{ \
               $err = ($job | Receive-Job 2>&1 | Out-String); \
               throw \"Start-VM job ended in state '$($job.State)': $err\" \
             }}; \
             Remove-Job -Job $job"
        );
        self.runner.run(&script, 600_000).await?;
        Ok(())
    }

    async fn stop_vm(&self, handle: &VmHandle, force: bool) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        wait_for_stable_state(&*self.runner, &safe_name).await?;
        let force_flag = if force { "-TurnOff" } else { "-Force" };
        let script = format!(
            "$vm = Get-VM -Name '{safe_name}'; \
             if ($vm.State -eq 'Off') {{ return }}; \
             $job = Stop-VM -Name '{safe_name}' {force_flag} -AsJob; \
             Wait-Job -Job $job | Out-Null; \
             if ($job.State -ne 'Completed') {{ \
               $err = ($job | Receive-Job 2>&1 | Out-String); \
               throw \"Stop-VM job ended in state '$($job.State)': $err\" \
             }}; \
             Remove-Job -Job $job"
        );
        self.runner.run(&script, 300_000).await?;
        Ok(())
    }

    async fn pause_vm(&self, handle: &VmHandle) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        self.runner
            .run(&format!("Suspend-VM -Name '{safe_name}'"), 30_000)
            .await?;
        Ok(())
    }

    async fn resume_vm(&self, handle: &VmHandle) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        self.runner
            .run(&format!("Resume-VM -Name '{safe_name}'"), 30_000)
            .await?;
        Ok(())
    }

    async fn delete_vm(&self, handle: &VmHandle) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let script = format!(
            "Stop-VM -Name '{safe_name}' -TurnOff -ErrorAction SilentlyContinue; \
             Remove-VM -Name '{safe_name}' -Force"
        );
        self.runner.run(&script, 60_000).await?;
        Ok(())
    }

    async fn get_status(&self, handle: &VmHandle) -> BackendResult<VmStatus> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        // [string] cast on $ip is essential: when the VM is in Saved/Off state
        // and has no IPv4 address, the pipeline returns $null OR an empty
        // PSObject (depending on PowerShell version). ConvertTo-Json serialises
        // both as `{}` rather than `null`, breaking the Rust deserialiser. The
        // explicit string cast collapses null/empty/object to "" reliably.
        let script = format!(
            "$vm = Get-VM -Name '{safe_name}'; \
             $ip = [string](($vm | Get-VMNetworkAdapter | Select-Object -ExpandProperty IPAddresses | \
               Where-Object {{ $_ -match '\\d+\\.\\d+\\.\\d+\\.\\d+' }} | Select-Object -First 1)); \
             @{{ State = $vm.State.ToString(); Uptime = [int]$vm.Uptime.TotalSeconds; \
                MemoryAssigned = [int]($vm.MemoryAssigned / 1MB); IPAddress = $ip }} | ConvertTo-Json -Compress"
        );
        let out = self.runner.run(&script, 30_000).await?;
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "State")]
            state: String,
            #[serde(rename = "Uptime")]
            uptime: u64,
            #[serde(rename = "MemoryAssigned")]
            memory_assigned: u64,
            // Defense in depth: deserialise IPAddress as a permissive
            // serde_json::Value, then collapse to Option<String>. Keeps the
            // service tolerant of any future PS-side regression that re-emits
            // the empty-object form.
            #[serde(rename = "IPAddress", default)]
            ip_address: serde_json::Value,
        }
        let r: R = ps_json(&out)?;
        let ip_address = match &r.ip_address {
            serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        Ok(VmStatus {
            handle: handle.clone(),
            state: VmState::from_hyperv_state(&r.state),
            ip_address,
            guest_agent_reachable: false,
            uptime_seconds: Some(r.uptime),
            memory_used_mb: Some(r.memory_assigned),
        })
    }

    async fn list_vms(&self) -> BackendResult<Vec<VmHandle>> {
        let out = self
            .runner
            .run(
                "$r = @(Get-VM | Select-Object Id, Name); if ($r.Count -eq 0) { '[]' } else { ConvertTo-Json -Compress $r }",
                30_000,
            )
            .await?;
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "Id")]
            id: String,
            #[serde(rename = "Name")]
            name: String,
        }
        // PowerShell collapses single-element arrays to a scalar.
        let parsed: Vec<R> = serde_json::from_str(&out)
            .or_else(|_| serde_json::from_str::<R>(&out).map(|one| vec![one]))
            .map_err(|e| {
                BackendError::DecodeFailure(format!("list_vms JSON: {e}\nstdout: {out}"))
            })?;
        Ok(parsed
            .into_iter()
            .map(|r| VmHandle {
                id: r.id,
                name: r.name,
                backend: self.name().to_string(),
            })
            .collect())
    }

    async fn create_checkpoint(
        &self,
        handle: &VmHandle,
        label: &str,
    ) -> BackendResult<CheckpointHandle> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let safe_label = escape_powershell_arg(sanitize_label(label)?);
        wait_for_stable_state(&*self.runner, &safe_name).await?;
        let script = format!(
            "$job = Checkpoint-VM -Name '{safe_name}' -SnapshotName '{safe_label}' -AsJob; \
             Wait-Job -Job $job | Out-Null; \
             if ($job.State -ne 'Completed') {{ \
               $err = ($job | Receive-Job 2>&1 | Out-String); \
               throw \"Checkpoint-VM job ended in state '$($job.State)': $err\" \
             }}; \
             Remove-Job -Job $job; \
             $cp = Get-VMCheckpoint -VMName '{safe_name}' -Name '{safe_label}'; \
             @{{ Id = $cp.Id.ToString(); Name = $cp.Name }} | ConvertTo-Json -Compress"
        );
        let out = self.runner.run(&script, 600_000).await?;
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "Id")]
            id: String,
            #[serde(rename = "Name")]
            name: String,
        }
        let r: R = ps_json(&out)?;
        Ok(CheckpointHandle {
            id: r.id,
            vm_handle: handle.clone(),
            label: r.name,
        })
    }

    async fn restore_checkpoint(&self, cp: &CheckpointHandle) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&cp.vm_handle.name)?);
        let safe_label = escape_powershell_arg(sanitize_label(&cp.label)?);
        wait_for_stable_state(&*self.runner, &safe_name).await?;
        // Stop the VM first to avoid the slow save-then-apply path.
        // Mirrors the TS comment: restoreCheckpoint on a Running VM
        // takes 2-4 minutes vs ~2s when Off.
        self.stop_vm(&cp.vm_handle, true).await?;
        let script = format!(
            "$cp = Get-VMCheckpoint -VMName '{safe_name}' -Name '{safe_label}'; \
             $job = Restore-VMCheckpoint -VMCheckpoint $cp -Confirm:$false -AsJob; \
             Wait-Job -Job $job | Out-Null; \
             if ($job.State -ne 'Completed') {{ \
               $err = ($job | Receive-Job 2>&1 | Out-String); \
               throw \"Restore-VMCheckpoint job ended in state '$($job.State)': $err\" \
             }}; \
             Remove-Job -Job $job"
        );
        self.runner.run(&script, 600_000).await?;
        Ok(())
    }

    async fn delete_checkpoint(&self, cp: &CheckpointHandle) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&cp.vm_handle.name)?);
        let safe_label = escape_powershell_arg(sanitize_label(&cp.label)?);
        let script = format!(
            "$cp = Get-VMCheckpoint -VMName '{safe_name}' -Name '{safe_label}'; \
             Remove-VMCheckpoint -VMCheckpoint $cp -Confirm:$false"
        );
        self.runner.run(&script, 60_000).await?;
        Ok(())
    }

    async fn list_checkpoints(&self, handle: &VmHandle) -> BackendResult<Vec<CheckpointInfo>> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let script = format!(
            "$r = @(Get-VMCheckpoint -VMName '{safe_name}' | \
                 Select-Object Id, Name, CreationTime, ParentCheckpointId); \
             if ($r.Count -eq 0) {{ '[]' }} else {{ ConvertTo-Json -Compress $r }}"
        );
        let out = self.runner.run(&script, 30_000).await?;
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "Id")]
            id: String,
            #[serde(rename = "Name")]
            name: String,
            #[serde(rename = "CreationTime")]
            creation_time: String,
            #[serde(rename = "ParentCheckpointId")]
            parent_checkpoint_id: Option<String>,
        }
        let parsed: Vec<R> = serde_json::from_str(&out)
            .or_else(|_| serde_json::from_str::<R>(&out).map(|one| vec![one]))
            .map_err(|e| {
                BackendError::DecodeFailure(format!("list_checkpoints JSON: {e}\nstdout: {out}"))
            })?;
        Ok(parsed
            .into_iter()
            .map(|r| CheckpointInfo {
                id: r.id,
                label: r.name,
                created_at: r.creation_time,
                parent_id: r.parent_checkpoint_id,
            })
            .collect())
    }

    async fn copy_file(
        &self,
        handle: &VmHandle,
        host_path: &str,
        guest_path: &str,
        from_guest: bool,
        events: mpsc::Sender<CopyEvent>,
    ) -> BackendResult<()> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let safe_host = escape_powershell_arg(sanitize_path(host_path)?);
        let safe_guest = escape_powershell_arg(sanitize_path(guest_path)?);

        // Hyper-V's Copy-VMFile + Copy-Item -FromSession don't expose
        // progress callbacks. v0.1.0 emits a single Complete event;
        // future versions can poll the destination size on a side
        // task.  The proto already supports streaming progress.
        let script = if from_guest {
            format!(
                "$session = New-PSSession -VMName '{safe_name}'; \
                 Copy-Item -FromSession $session -Path '{safe_guest}' -Destination '{safe_host}'; \
                 Remove-PSSession $session"
            )
        } else {
            format!(
                "Copy-VMFile -Name '{safe_name}' -SourcePath '{safe_host}' \
                 -DestinationPath '{safe_guest}' -FileSource Host -Force"
            )
        };

        self.runner.run(&script, 600_000).await?;
        let _ = events.send(CopyEvent::Complete).await;
        Ok(())
    }

    async fn execute_command(
        &self,
        handle: &VmHandle,
        command: &str,
        args: &[String],
        timeout_ms: u64,
        events: mpsc::Sender<RunEvent>,
    ) -> BackendResult<CommandResult> {
        let started_at_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let _ = events.send(RunEvent::Started { started_at_unix_ms }).await;

        let start = std::time::Instant::now();
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let safe_cmd = escape_powershell_arg(sanitize_command(command)?);
        let safe_timeout = sanitize_timeout_default(Some(timeout_ms));

        let mut arg_parts: Vec<String> = Vec::with_capacity(args.len());
        for a in args {
            // Defense in depth: each arg must be free of shell metas
            // AND escaped for the PS single-quoted string. Mirrors the
            // TS double-validation.
            let validated = sanitize_command(a)?;
            arg_parts.push(format!("'{}'", escape_powershell_arg(validated)));
        }
        let arg_str = arg_parts.join(", ");

        let script = format!(
            "$result = Invoke-Command -VMName '{safe_name}' -ScriptBlock {{ \
                $output = & '{safe_cmd}' {arg_str} 2>&1; \
                @{{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String) }} \
              }}; \
              $result | ConvertTo-Json -Compress"
        );

        let out = self.runner.run(&script, safe_timeout).await?;
        #[derive(Deserialize)]
        struct R {
            #[serde(rename = "ExitCode")]
            exit_code: Option<i32>,
            #[serde(rename = "Output")]
            output: String,
        }
        let r: R = ps_json(&out)?;
        let result = CommandResult {
            exit_code: r.exit_code.unwrap_or(0),
            stdout: r.output.clone(),
            stderr: String::new(),
            duration_ms: start.elapsed().as_millis() as u64,
        };
        if !result.stdout.is_empty() {
            let _ = events
                .send(RunEvent::Stdout(result.stdout.as_bytes().to_vec()))
                .await;
        }
        let _ = events.send(RunEvent::Result(result.clone())).await;
        Ok(result)
    }

    async fn get_vm_ip(&self, handle: &VmHandle) -> BackendResult<String> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let script = format!(
            "$ip = (Get-VM -Name '{safe_name}' | Get-VMNetworkAdapter).IPAddresses | \
               Where-Object {{ $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' }} | Select-Object -First 1; \
             if (-not $ip) {{ throw \"No IPv4 address found for VM '{safe_name}'\" }}; \
             $ip"
        );
        let ip = self.runner.run(&script, 30_000).await?;
        if ip.is_empty() {
            return Err(BackendError::ShellFailure(format!(
                "No IPv4 address found for VM '{}'",
                handle.name
            )));
        }
        Ok(ip)
    }

    async fn wait_for_heartbeat(
        &self,
        handle: &VmHandle,
        timeout_ms: u64,
        events: mpsc::Sender<WaitAgentEvent>,
    ) -> BackendResult<bool> {
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        let safe_timeout = sanitize_timeout_default(Some(timeout_ms));
        let start = std::time::Instant::now();
        let deadline = start + std::time::Duration::from_millis(safe_timeout);

        let poll_interval = std::time::Duration::from_millis(2_000);
        while std::time::Instant::now() < deadline {
            let script = format!("(Get-VM -Name '{safe_name}').Heartbeat.ToString()");
            match self.runner.run(&script, 10_000).await {
                Ok(state) => {
                    let elapsed_ms = start.elapsed().as_millis() as u64;
                    let _ = events
                        .send(WaitAgentEvent::Heartbeat {
                            state: state.clone(),
                            elapsed_ms,
                        })
                        .await;
                    if state == "OkApplicationsHealthy" {
                        let _ = events.send(WaitAgentEvent::Ready).await;
                        return Ok(true);
                    }
                }
                Err(_) => { /* VM may not be running yet; keep polling */ }
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::time::sleep(poll_interval.min(remaining)).await;
        }
        let _ = events.send(WaitAgentEvent::Timeout).await;
        Ok(false)
    }

    async fn set_vm_memory(&self, handle: &VmHandle, memory_mb: u32) -> BackendResult<()> {
        if !(32..=1_048_576).contains(&memory_mb) {
            return Err(BackendError::InvalidArgument(format!(
                "Invalid memory value: {memory_mb}MB. Must be 32-1048576."
            )));
        }
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        self.runner
            .run(
                &format!("Set-VMMemory -VMName '{safe_name}' -StartupBytes {memory_mb}MB"),
                30_000,
            )
            .await?;
        Ok(())
    }

    async fn set_vm_processor(&self, handle: &VmHandle, count: u32) -> BackendResult<()> {
        if !(1..=240).contains(&count) {
            return Err(BackendError::InvalidArgument(format!(
                "Invalid processor count: {count}. Must be 1-240."
            )));
        }
        let safe_name = escape_powershell_arg(sanitize_vm_name(&handle.name)?);
        self.runner
            .run(
                &format!("Set-VMProcessor -VMName '{safe_name}' -Count {count}"),
                30_000,
            )
            .await?;
        Ok(())
    }
}

/// Wait for a VM to be in a stable state. Mirrors the TS
/// `waitForStableState` helper which subscribes to the CIM
/// `__InstanceModificationEvent` indication on `Msvm_ComputerSystem`
/// and parks on `Wait-Event` (no polling).
async fn wait_for_stable_state(runner: &dyn PsRunner, safe_name: &str) -> BackendResult<()> {
    let script = format!(
        "$stable = @('Off','Running','Saved','Paused'); \
         $current = (Get-VM -Name '{safe_name}').State.ToString(); \
         if ($stable -contains $current) {{ return }}; \
         $query = \"SELECT * FROM __InstanceModificationEvent WITHIN 1 \
           WHERE TargetInstance ISA 'Msvm_ComputerSystem' \
             AND TargetInstance.ElementName = '{safe_name}'\"; \
         $sourceId = \"signalman-vmstate-$([guid]::NewGuid())\"; \
         Register-CimIndicationEvent -Query $query -Namespace 'root\\virtualization\\v2' -SourceIdentifier $sourceId | Out-Null; \
         try {{ \
           while ($true) {{ \
             Wait-Event -SourceIdentifier $sourceId | Out-Null; \
             Remove-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue; \
             $current = (Get-VM -Name '{safe_name}').State.ToString(); \
             if ($stable -contains $current) {{ return }} \
           }} \
         }} finally {{ \
           Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue \
         }}"
    );
    runner.run(&script, 900_000).await?;
    Ok(())
}

/// Construct (command, args) for a package install. Mirrors the
/// dispatch logic in `host/src/tools/vm-operations.ts` so the service
/// can offer a one-shot `VmInstall` RPC instead of forcing every
/// client to duplicate the table.
pub fn install_command_for(source: &str, package_id: &str) -> BackendResult<(String, Vec<String>)> {
    match source {
        "winget" => Ok((
            "winget".to_string(),
            vec![
                "install".to_string(),
                "--id".to_string(),
                package_id.to_string(),
                "--accept-source-agreements".to_string(),
                "--accept-package-agreements".to_string(),
                "--silent".to_string(),
            ],
        )),
        "choco" => Ok((
            "choco".to_string(),
            vec![
                "install".to_string(),
                package_id.to_string(),
                "-y".to_string(),
            ],
        )),
        "direct" => {
            let safe_url = sanitize_url(package_id)?;
            // direct installs use powershell -Command. Build the script
            // as a single string the way the TS path does.
            Ok((
                "powershell".to_string(),
                vec![
                    "-Command".to_string(),
                    format!(
                        "Invoke-WebRequest -Uri '{}' -OutFile $env:TEMP\\installer.exe; \
                         Start-Process $env:TEMP\\installer.exe -Wait",
                        escape_powershell_arg(safe_url)
                    ),
                ],
            ))
        }
        other => Err(BackendError::InvalidArgument(format!(
            "Unknown package source: {other}"
        ))),
    }
}

#[cfg(test)]
pub mod test_support {
    //! Shared mock backend for service-layer and integration tests.

    use super::*;
    use std::sync::Mutex;

    /// Programmable mock PowerShell runner. Each call pops the front of
    /// `responses`. If it's empty, the runner returns an empty string.
    pub struct ScriptedRunner {
        pub calls: Mutex<Vec<(String, u64)>>,
        pub responses: Mutex<Vec<BackendResult<String>>>,
    }

    impl ScriptedRunner {
        pub fn new(responses: Vec<BackendResult<String>>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(responses),
            }
        }
    }

    #[async_trait]
    impl PsRunner for ScriptedRunner {
        async fn run(&self, script: &str, timeout_ms: u64) -> BackendResult<String> {
            self.calls
                .lock()
                .unwrap()
                .push((script.to_string(), timeout_ms));
            let mut r = self.responses.lock().unwrap();
            if r.is_empty() {
                return Ok(String::new());
            }
            r.remove(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::ScriptedRunner;
    use super::*;

    fn handle(name: &str) -> VmHandle {
        VmHandle {
            id: format!("id-{name}"),
            name: name.to_string(),
            backend: "hyperv".to_string(),
        }
    }

    #[tokio::test]
    async fn list_vms_parses_array() {
        let runner = Arc::new(ScriptedRunner::new(vec![Ok(
            r#"[{"Id":"a","Name":"vm1"},{"Id":"b","Name":"vm2"}]"#.to_string(),
        )]));
        let backend = HyperVBackend::with_runner(runner);
        let vms = backend.list_vms().await.unwrap();
        assert_eq!(vms.len(), 2);
        assert_eq!(vms[0].name, "vm1");
        assert_eq!(vms[1].name, "vm2");
        assert!(vms.iter().all(|v| v.backend == "hyperv"));
    }

    #[tokio::test]
    async fn list_vms_handles_single_object_not_array() {
        // PowerShell collapses 1-element ConvertTo-Json arrays.
        let runner = Arc::new(ScriptedRunner::new(vec![Ok(
            r#"{"Id":"a","Name":"vm1"}"#.to_string()
        )]));
        let backend = HyperVBackend::with_runner(runner);
        let vms = backend.list_vms().await.unwrap();
        assert_eq!(vms.len(), 1);
        assert_eq!(vms[0].name, "vm1");
    }

    #[tokio::test]
    async fn list_vms_handles_empty() {
        let runner = Arc::new(ScriptedRunner::new(vec![Ok("[]".to_string())]));
        let backend = HyperVBackend::with_runner(runner);
        let vms = backend.list_vms().await.unwrap();
        assert!(vms.is_empty());
    }

    #[tokio::test]
    async fn get_status_maps_state() {
        let runner = Arc::new(ScriptedRunner::new(vec![Ok(
            r#"{"State":"Running","Uptime":42,"MemoryAssigned":2048,"IPAddress":"10.0.0.5"}"#
                .to_string(),
        )]));
        let backend = HyperVBackend::with_runner(runner);
        let status = backend.get_status(&handle("vm1")).await.unwrap();
        assert_eq!(status.state, VmState::Running);
        assert_eq!(status.ip_address.as_deref(), Some("10.0.0.5"));
        assert_eq!(status.uptime_seconds, Some(42));
        assert_eq!(status.memory_used_mb, Some(2048));
    }

    #[tokio::test]
    async fn create_vm_returns_handle() {
        let runner = Arc::new(ScriptedRunner::new(vec![Ok(
            r#"{"Id":"vmid","Name":"newvm"}"#.to_string(),
        )]));
        let backend = HyperVBackend::with_runner(runner.clone());
        let h = backend
            .create_vm(&VmConfig {
                name: "newvm".to_string(),
                memory_mb: Some(4096),
                cpus: Some(4),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(h.name, "newvm");
        assert_eq!(h.backend, "hyperv");
        let calls = runner.calls.lock().unwrap();
        assert!(calls[0].0.contains("New-VM"));
        assert!(calls[0].0.contains("4096MB"));
        assert!(calls[0].0.contains("Set-VMProcessor"));
    }

    #[tokio::test]
    async fn create_vm_rejects_bad_name() {
        let runner = Arc::new(ScriptedRunner::new(vec![]));
        let backend = HyperVBackend::with_runner(runner);
        let err = backend
            .create_vm(&VmConfig {
                name: "bad name".to_string(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(matches!(err, BackendError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn execute_command_rejects_metacharacter_arg() {
        let runner = Arc::new(ScriptedRunner::new(vec![]));
        let backend = HyperVBackend::with_runner(runner);
        let (tx, _rx) = mpsc::channel(8);
        let err = backend
            .execute_command(
                &handle("vm1"),
                "powershell",
                &["whoami; rm -rf /".to_string()],
                30_000,
                tx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, BackendError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn set_vm_memory_rejects_out_of_range() {
        let runner = Arc::new(ScriptedRunner::new(vec![]));
        let backend = HyperVBackend::with_runner(runner);
        assert!(matches!(
            backend.set_vm_memory(&handle("vm1"), 16).await,
            Err(BackendError::InvalidArgument(_))
        ));
        assert!(matches!(
            backend.set_vm_memory(&handle("vm1"), 2_000_000).await,
            Err(BackendError::InvalidArgument(_))
        ));
    }

    #[test]
    fn install_command_for_winget() {
        let (cmd, args) = install_command_for("winget", "Cursor.Cursor").unwrap();
        assert_eq!(cmd, "winget");
        assert!(args.contains(&"--id".to_string()));
        assert!(args.contains(&"Cursor.Cursor".to_string()));
    }

    #[test]
    fn install_command_for_choco() {
        let (cmd, args) = install_command_for("choco", "vim").unwrap();
        assert_eq!(cmd, "choco");
        assert_eq!(args, vec!["install", "vim", "-y"]);
    }

    #[test]
    fn install_command_for_direct_validates_url() {
        let err = install_command_for("direct", "javascript:alert(1)").unwrap_err();
        assert!(matches!(err, BackendError::InvalidArgument(_)));
    }

    #[test]
    fn install_command_for_unknown_source_rejects() {
        assert!(matches!(
            install_command_for("apt", "vim"),
            Err(BackendError::InvalidArgument(_))
        ));
    }

    #[test]
    fn vm_state_from_hyperv_state() {
        assert_eq!(VmState::from_hyperv_state("Running"), VmState::Running);
        assert_eq!(VmState::from_hyperv_state("2"), VmState::Running);
        assert_eq!(VmState::from_hyperv_state("Off"), VmState::Stopped);
        assert_eq!(VmState::from_hyperv_state("Paused"), VmState::Paused);
        assert_eq!(VmState::from_hyperv_state("Saved"), VmState::Saved);
        assert_eq!(VmState::from_hyperv_state("garbage"), VmState::Unknown);
    }
}
