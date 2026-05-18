/**
 * Hyper-V hypervisor backend.
 *
 * Uses PowerShell cmdlets to manage Hyper-V VMs:
 * - Get-VM, Start-VM, Stop-VM, Checkpoint-VM, Restore-VMCheckpoint
 * - Copy-VMFile for host-to-guest file transfer
 * - Invoke-Command for remote command execution (via PowerShell Direct)
 *
 * Requires: Hyper-V role enabled, running as Administrator.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import type {
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
  HypervisorBackend,
  ProgressCallback,
  VMConfig,
  VMHandle,
  VMState,
  VMStatus,
} from "./interface.js";
import {
  sanitizeVmName,
  sanitizeLabel,
  sanitizePath,
  sanitizeCommand,
  sanitizeCommandArg,
  escapePowerShellArg,
  sanitizeTimeout,
} from "../sanitize.js";
import type { TlsOptions } from "../guest/client.js";
import { runCopyWithProgress } from "../provisioning/copy-file-progress.js";

const exec = promisify(execFile);

export interface HyperVBackendOptions {
  /** Default guest-agent port used by getStatus health checks. */
  guestAgentPort?: number;
  /** TLS material for guest-agent health checks. */
  guestAgentTls?: TlsOptions;
  /** Bearer token for guest-agent health checks. */
  guestAgentAuthToken?: string;
  /** Per-health-check timeout. Defaults to 1500ms. */
  guestAgentHealthTimeoutMs?: number;
  /** Injectable health probe for tests and alternate transports. */
  guestAgentHealthCheck?: (
    ipAddress: string,
    port: number,
    tlsOptions: TlsOptions | undefined,
    authToken: string | undefined,
    timeoutMs: number,
  ) => Promise<boolean>;
}

// PowerShell command resolution
//
// signalman has its own SystemBackend service that runs as SYSTEM and
// covers the elevated PowerShell commands; the host CLI itself never
// needs to auto-elevate.  The previous gsudo-based auto-elevation
// silently failed under unattended runs (the UAC prompt has no human
// to click "Yes" and gsudo cancels after a timeout) — turning what
// should be a clear "you need to be elevated for this cmdlet" error
// into a 30 s hang followed by a cryptic "User cancelled" message.
//
// resolvePsCommand() now always returns plain `powershell.exe`.
// Cmdlets that genuinely require elevation surface their native
// access-denied error if the operator runs the host CLI unprivileged,
// and operators driving Hyper-V management directly (without the
// SYSTEM service) are expected to launch the CLI from an elevated
// shell themselves.

/** Cached elevation state — exposed only for the diagnostic helper
 *  in cli.ts; nothing in the orchestrator hot path consults it. */
let _isElevated: boolean | null = null;

/**
 * Check whether the current process is running elevated (Administrator).
 * Result is cached for the lifetime of the process.
 */
export function isElevated(): boolean {
  if (_isElevated !== null) return _isElevated;
  try {
    execFileSync("net", ["session"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
    _isElevated = true;
  } catch {
    _isElevated = false;
  }
  return _isElevated;
}

/**
 * Resolve the command and args to use for running a PowerShell script.
 *
 * Always plain `powershell.exe` — see the doc-comment block above for
 * the rationale.  `prefixArgs` stays in the return type for API
 * compatibility with the older gsudo-based shape; it is always empty.
 */
function resolvePsCommand(): { cmd: string; prefixArgs: string[] } {
  return { cmd: "powershell.exe", prefixArgs: [] };
}

// ── PowerShell Execution ──────────────────────────────────────────

/**
 * Build the args array for running a PowerShell script.
 *
 * When gsudo is in the chain, using `-Command` causes `$` variables to be
 * stripped by the intermediate shell. We avoid this by encoding the script
 * as UTF-16LE Base64 and passing it via `-EncodedCommand`, which PowerShell
 * decodes internally with no shell interpolation.
 *
 * All scripts are prefixed with `$ProgressPreference = 'SilentlyContinue'`
 * to suppress CLIXML progress output on stderr, which would otherwise cause
 * Node's execFile to treat successful commands as failures.
 */
function buildPsArgs(prefixArgs: string[], script: string): string[] {
  const wrapped = `$ProgressPreference = 'SilentlyContinue'; ${script}`;
  const needsEncoding = prefixArgs.length > 0; // gsudo in chain
  if (needsEncoding) {
    const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
    return [...prefixArgs, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  }
  return [...prefixArgs, "-NoProfile", "-NonInteractive", "-Command", wrapped];
}

/** Execute a PowerShell command and return parsed JSON output. */
async function psJson<T>(script: string, timeoutMs = 30_000): Promise<T> {
  const { cmd, prefixArgs } = resolvePsCommand();
  const args = buildPsArgs(prefixArgs, script);
  try {
    const { stdout } = await exec(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as T;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const message = (err as Error).message ?? String(err);
    throw new Error(
      `PowerShell command failed: ${message}${stderr ? `\nPowerShell stderr: ${stderr}` : ""}`,
    );
  }
}

/**
 * Execute a PowerShell command, return raw stdout.
 *
 * Exported as {@link hyperVPsExec} below for callers outside this
 * module (e.g. the v0.3.0-2 ephemeral-VM pipeline). Internally we
 * keep using the short `ps` name to avoid touching every existing
 * call site.
 */
async function ps(script: string, timeoutMs = 30_000): Promise<string> {
  const { cmd, prefixArgs } = resolvePsCommand();
  const args = buildPsArgs(prefixArgs, script);
  try {
    const { stdout } = await exec(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const message = (err as Error).message ?? String(err);
    throw new Error(
      `PowerShell command failed: ${message}${stderr ? `\nPowerShell stderr: ${stderr}` : ""}`,
    );
  }
}

/**
 * Hyper-V-specific PowerShell exec for callers outside this module.
 *
 * Used by the v0.3.0-2 ephemeral-VM pipeline (provisionEphemeralVm)
 * to invoke `New-VHD -Differencing` via the same PS exec the rest
 * of the Hyper-V backend uses. Other backends (Tart, future libvirt)
 * don't have an analogous primitive yet — ephemeral provisioning is
 * Hyper-V-only in v0.3.0-2.
 */
export const hyperVPsExec = ps;

/** Map Hyper-V VM state integer to our VMState type. */
function mapState(hypervState: number | string): VMState {
  const stateMap: Record<string, VMState> = {
    "2": "running",
    "3": "stopped",
    "6": "saved",
    "9": "paused",
    Running: "running",
    Off: "stopped",
    Saved: "saved",
    Paused: "paused",
  };
  return stateMap[String(hypervState)] ?? "unknown";
}

async function defaultGuestAgentHealthCheck(
  ipAddress: string,
  port: number,
  tlsOptions: TlsOptions | undefined,
  authToken: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const { GuestAgentClient } = await import("../guest/client.js");
  const client = new GuestAgentClient(ipAddress, port, tlsOptions, {
    connectionTimeoutMs: timeoutMs,
    defaultTimeoutMs: timeoutMs,
    maxRetries: 0,
    authToken,
  });
  try {
    return await client.isConnected(timeoutMs);
  } finally {
    client.dispose();
  }
}

export class HyperVBackend implements HypervisorBackend {
  readonly name = "hyperv";
  private readonly options: Required<
    Pick<HyperVBackendOptions, "guestAgentPort" | "guestAgentHealthTimeoutMs">
  > &
    Omit<HyperVBackendOptions, "guestAgentPort" | "guestAgentHealthTimeoutMs">;

  constructor(options: HyperVBackendOptions = {}) {
    this.options = {
      guestAgentPort: options.guestAgentPort ?? 50051,
      guestAgentHealthTimeoutMs: options.guestAgentHealthTimeoutMs ?? 1_500,
      guestAgentTls: options.guestAgentTls,
      guestAgentAuthToken: options.guestAgentAuthToken,
      guestAgentHealthCheck: options.guestAgentHealthCheck,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await ps("Get-Command Get-VM -ErrorAction Stop | Out-Null");
      return true;
    } catch {
      return false;
    }
  }

  // ── Stable-state wait ──────────────────────────────────────────
  //
  // Hyper-V's state-change cmdlets (Restore-VMCheckpoint, Start-VM,
  // Stop-VM, Checkpoint-VM) refuse to run when the VM is in a
  // transition state (Starting, Stopping, Saving, Pausing, Resuming).
  // These transitions can be triggered externally (admin tools, other
  // test runs, Hyper-V's own housekeeping after a previous checkpoint
  // operation), so signalman may arrive at a mutation call with the
  // VM mid-transition.
  //
  // The event-driven primitive is the CIM indication on
  // `Msvm_ComputerSystem.EnabledState`. Subscribe first, read the
  // current state, and if it's already stable — we're done. Otherwise
  // wait for the next state-change indication and re-check.
  //
  // No polling, no fixed sleep — just a bounded event wait.

  private async waitForStableState(handle: VMHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    // Pure event-driven wait. Subscribe to the CIM state-change
    // indication for this VM, then block on Wait-Event with no
    // timeout — it parks until the CIM subsystem delivers an
    // indication. When the indication fires, re-check the state;
    // if stable, return; otherwise loop and wait for the next
    // indication.
    //
    // No Start-Sleep, no Get-Date deadline, no polling. The outer
    // ps() call has a generous dead-man process timeout to catch
    // truly-broken Hyper-V (kernel stuck, CIM broker dead); that
    // safety net is NOT part of the coordination protocol, it
    // exists only to prevent the Node process hanging forever on
    // infrastructure failures.
    await ps(`
      $stable = @('Off','Running','Saved','Paused')
      $current = (Get-VM -Name '${safeName}').State.ToString()
      if ($stable -contains $current) { return }

      $query = @"
SELECT * FROM __InstanceModificationEvent WITHIN 1
  WHERE TargetInstance ISA 'Msvm_ComputerSystem'
    AND TargetInstance.ElementName = '${safeName}'
"@
      $sourceId = "signalman-vmstate-$([guid]::NewGuid())"
      Register-CimIndicationEvent -Query $query -Namespace 'root\virtualization\v2' -SourceIdentifier $sourceId | Out-Null
      try {
        while ($true) {
          # Wait-Event with no -Timeout blocks until the CIM broker
          # delivers the next indication. Event-driven, no poll.
          Wait-Event -SourceIdentifier $sourceId | Out-Null
          Remove-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
          $current = (Get-VM -Name '${safeName}').State.ToString()
          if ($stable -contains $current) { return }
        }
      } finally {
        Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
      }
    `, 900_000);  // 15-min dead-man safety net on the PS process.
  }

  // ── VM Lifecycle ──────────────────────────────────────────────

  async createVM(config: VMConfig): Promise<VMHandle> {
    const memMB = config.memoryMB ?? 4096;
    const cpus = config.cpus ?? 2;
    const switchName = config.network?.switchName ?? "Default Switch";
    const safeName = escapePowerShellArg(sanitizeVmName(config.name));
    const safeSwitch = escapePowerShellArg(sanitizeLabel(switchName));

    // ── extraCdroms (M2 Story 3) ──
    // Each entry in config.extraCdroms must be an absolute path to an
    // existing ISO on the host. We validate up front so the PowerShell
    // invocation gets a clean argv and the operator sees a clear error
    // before any Hyper-V state changes. M0 Q7 locked default
    // (2026-05-17): add the ISO(s) as additional DVD drives via
    // `Add-VMDvdDrive`, without reordering or replacing existing media.
    const extraCdroms = config.extraCdroms ?? [];
    const safeIsoPaths: string[] = [];
    for (const isoPath of extraCdroms) {
      if (typeof isoPath !== "string" || isoPath.length === 0) {
        throw new Error(
          `Hyper-V createVM: extraCdroms entries must be non-empty ` +
            `strings (got ${typeof isoPath})`,
        );
      }
      if (!fs.existsSync(isoPath)) {
        throw new Error(
          `Hyper-V createVM: extraCdroms ISO not found at '${isoPath}'. ` +
            `Verify the path resolves on the host before re-running.`,
        );
      }
      safeIsoPaths.push(escapePowerShellArg(sanitizePath(isoPath)));
    }
    const addDvdDriveLines = safeIsoPaths
      .map(
        (safePath) =>
          `Add-VMDvdDrive -VMName '${safeName}' -Path '${safePath}'`,
      )
      .join("\n      ");

    const script = `
      $vm = New-VM -Name '${safeName}' -MemoryStartupBytes ${memMB}MB -Generation 2 -SwitchName '${safeSwitch}'
      Set-VMProcessor -VM $vm -Count ${cpus}
      ${addDvdDriveLines}
      $vm | Select-Object Id, Name | ConvertTo-Json
    `;

    const result = await psJson<{ Id: string; Name: string }>(script);
    return { id: result.Id, name: result.Name, backend: this.name };
  }

  async startVM(handle: VMHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await this.waitForStableState(handle);
    // -AsJob + Wait-Job: the job represents the full Starting → Running
    // transition; Wait-Job blocks on the job's completion event (event-
    // driven, no polling). Idempotent if already Running.
    // 10-min ceiling: covers Hyper-V's worst-case Starting transition
    // (cold boot with 4+ GB memory footprint on a contested host).
    await ps(`
      $vm = Get-VM -Name '${safeName}'
      if ($vm.State -eq 'Running') { return }
      $job = Start-VM -Name '${safeName}' -AsJob
      Wait-Job -Job $job | Out-Null
      if ($job.State -ne 'Completed') {
        $err = ($job | Receive-Job 2>&1 | Out-String)
        throw "Start-VM job ended in state '$($job.State)': $err"
      }
      Remove-Job -Job $job
    `, 600_000);
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await this.waitForStableState(handle);
    // force=true  ⇒ -TurnOff  (immediate power-off, simulates pulling power)
    // force=false ⇒ -Force    (skip confirmation but still graceful shutdown)
    const forceFlag = force ? "-TurnOff" : "-Force";
    await ps(`
      $vm = Get-VM -Name '${safeName}'
      if ($vm.State -eq 'Off') { return }
      $job = Stop-VM -Name '${safeName}' ${forceFlag} -AsJob
      Wait-Job -Job $job | Out-Null
      if ($job.State -ne 'Completed') {
        $err = ($job | Receive-Job 2>&1 | Out-String)
        throw "Stop-VM job ended in state '$($job.State)': $err"
      }
      Remove-Job -Job $job
    `, 300_000);  // 5 min graceful shutdown ceiling
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await ps(`Suspend-VM -Name '${safeName}'`);
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await ps(`Resume-VM -Name '${safeName}'`);
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await ps(`
      Stop-VM -Name '${safeName}' -TurnOff -ErrorAction SilentlyContinue
      Remove-VM -Name '${safeName}' -Force
    `);
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const script = `
      $vm = Get-VM -Name '${safeName}'
      $ip = ($vm | Get-VMNetworkAdapter | Select-Object -ExpandProperty IPAddresses | Where-Object { $_ -match '\\d+\\.\\d+\\.\\d+\\.\\d+' } | Select-Object -First 1)
      @{
        State = $vm.State.ToString()
        Uptime = [int]$vm.Uptime.TotalSeconds
        MemoryAssigned = [int]($vm.MemoryAssigned / 1MB)
        IPAddress = $ip
      } | ConvertTo-Json
    `;

    const info = await psJson<{
      State: string;
      Uptime: number;
      MemoryAssigned: number;
      IPAddress: string | null;
    }>(script);

    const state = mapState(info.State);
    const ipAddress = info.IPAddress ?? undefined;
    const guestAgentReachable =
      state === "running" && ipAddress
        ? await this.checkGuestAgentReachable(ipAddress)
        : false;

    return {
      handle,
      state,
      ipAddress,
      guestAgentReachable,
      uptimeSeconds: info.Uptime,
      memoryUsedMB: info.MemoryAssigned,
    };
  }

  private async checkGuestAgentReachable(ipAddress: string): Promise<boolean> {
    const check = this.options.guestAgentHealthCheck ?? defaultGuestAgentHealthCheck;
    try {
      return await check(
        ipAddress,
        this.options.guestAgentPort,
        this.options.guestAgentTls,
        this.options.guestAgentAuthToken,
        this.options.guestAgentHealthTimeoutMs,
      );
    } catch {
      return false;
    }
  }

  async listVMs(): Promise<VMHandle[]> {
    const script = `$r = @(Get-VM | Select-Object Id, Name); if ($r.Count -eq 0) { '[]' } else { ConvertTo-Json $r }`;
    const vms = await psJson<Array<{ Id: string; Name: string }>>(script);
    return vms.map((vm) => ({ id: vm.Id, name: vm.Name, backend: this.name }));
  }

  // ── Checkpoints ───────────────────────────────────────────────

  async createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeLabel = escapePowerShellArg(sanitizeLabel(label));
    await this.waitForStableState(handle);
    // Checkpoint-VM supports -AsJob, but its -Passthru + -AsJob
    // combination is fiddly. Use the two-step form: create via
    // job, then Get-VMCheckpoint to fetch the result. This avoids
    // returning before the state-transition tail completes.
    const script = `
      $job = Checkpoint-VM -Name '${safeName}' -SnapshotName '${safeLabel}' -AsJob
      Wait-Job -Job $job | Out-Null
      if ($job.State -ne 'Completed') {
        $err = ($job | Receive-Job 2>&1 | Out-String)
        throw "Checkpoint-VM job ended in state '$($job.State)': $err"
      }
      Remove-Job -Job $job
      $cp = Get-VMCheckpoint -VMName '${safeName}' -Name '${safeLabel}'
      @{ Id = $cp.Id.ToString(); Name = $cp.Name } | ConvertTo-Json
    `;
    // 10-min ceiling: checkpointing a Running VM flushes memory to
    // the .vsv file, which on Win11 with 4 GB memory is typically
    // 20-60s but can stretch to several minutes on a contested host.
    const result = await psJson<{ Id: string; Name: string }>(script, 600_000);
    return { id: result.Id, vmHandle: handle, label: result.Name };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(checkpoint.vmHandle.name));
    const safeLabel = escapePowerShellArg(sanitizeLabel(checkpoint.label));
    await this.waitForStableState(checkpoint.vmHandle);

    // Hyper-V's Restore-VMCheckpoint on a Running VM takes the slow
    // save-then-apply path (must dispose current running state before
    // applying the checkpoint — observed 2-4 min on a warm-checkpoint
    // restore, vs. ~2 s when VM is already Off). Stop the VM first;
    // Stop-VM -TurnOff is effectively instant. The caller's contract
    // for restoreCheckpoint doesn't require the current state to be
    // preserved (it's getting obliterated either way), so the stop is
    // functionally free.
    await this.stopVM(checkpoint.vmHandle, /* force */ true);

    // -AsJob + Wait-Job: Hyper-V's state-change cmdlets all expose
    // -AsJob, and the returned CIM job represents the FULL operation
    // including its state-transition tail. Wait-Job blocks on the job's
    // completion event (event-driven, no polling).
    //
    // The default synchronous form of Restore-VMCheckpoint returns
    // before the transition tail completes, so a subsequent Start-VM /
    // state query races the tail and hits
    //   "InvalidState: The operation cannot be performed while the
    //   object is in its current state".
    // -AsJob + Wait-Job closes that race.
    // 10-min ceiling: warm-checkpoint restore from Off is ~2s, but
    // restoring a large checkpoint on a contested host has been
    // observed at 3+ min. Leave generous headroom so the Wait-Job
    // isn't racing exec()'s process-level timeout.
    await ps(`
      $cp = Get-VMCheckpoint -VMName '${safeName}' -Name '${safeLabel}'
      $job = Restore-VMCheckpoint -VMCheckpoint $cp -Confirm:$false -AsJob
      Wait-Job -Job $job | Out-Null
      if ($job.State -ne 'Completed') {
        $err = ($job | Receive-Job 2>&1 | Out-String)
        throw "Restore-VMCheckpoint job ended in state '$($job.State)': $err"
      }
      Remove-Job -Job $job
    `, 600_000);
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(checkpoint.vmHandle.name));
    const safeLabel = escapePowerShellArg(sanitizeLabel(checkpoint.label));
    await ps(`
      $cp = Get-VMCheckpoint -VMName '${safeName}' -Name '${safeLabel}'
      Remove-VMCheckpoint -VMCheckpoint $cp -Confirm:$false
    `);
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const script = `
      $r = @(Get-VMCheckpoint -VMName '${safeName}' |
        Select-Object Id, Name, CreationTime, ParentCheckpointId);
      if ($r.Count -eq 0) { '[]' } else { ConvertTo-Json $r }
    `;
    const cps = await psJson<
      Array<{
        Id: string;
        Name: string;
        CreationTime: string;
        ParentCheckpointId: string | null;
      }>
    >(script);

    return cps.map((cp) => ({
      id: cp.Id,
      label: cp.Name,
      createdAt: new Date(cp.CreationTime),
      parentId: cp.ParentCheckpointId ?? undefined,
    }));
  }

  // ── File Transfer ─────────────────────────────────────────────

  async copyFileToVM(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    progress?: ProgressCallback,
  ): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeHostPath = escapePowerShellArg(sanitizePath(hostPath));
    const safeGuestPath = escapePowerShellArg(sanitizePath(guestPath));
    // Copy-VMFile requires the VM to be running and have integration services.
    // The cmdlet has no native progress hook, so for files past the heartbeat
    // threshold we emit a "still working" event every N seconds via
    // runCopyWithProgress (v0.3.0-2 / C8). Heartbeats keep the operator from
    // thinking a multi-GB copy is hung; true byte-level progress requires the
    // service-backed path (HyperVServiceBackend.copyFileToVM) which consumes
    // the streaming VmCopyFile RPC.
    await runCopyWithProgress({
      hostPath,
      progress,
      runCopy: async () => {
        await ps(`
          Copy-VMFile -Name '${safeName}' -SourcePath '${safeHostPath}' -DestinationPath '${safeGuestPath}' -FileSource Host -Force
        `);
      },
    });
  }

  async copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeGuestPath = escapePowerShellArg(sanitizePath(guestPath));
    const safeHostPath = escapePowerShellArg(sanitizePath(hostPath));
    // Use PowerShell Direct to copy file from guest
    await ps(`
      $session = New-PSSession -VMName '${safeName}'
      Copy-Item -FromSession $session -Path '${safeGuestPath}' -Destination '${safeHostPath}'
      Remove-PSSession $session
    `, 60_000);
  }

  // ── Command Execution ─────────────────────────────────────────

  async executeCommand(
    handle: VMHandle,
    command: string,
    args: string[] = [],
    timeoutMs = 60_000,
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeCommand = escapePowerShellArg(sanitizeCommand(command));
    const safeTimeout = sanitizeTimeout(timeoutMs);
    // Args are data passed to the executable, not command names. They may
    // legitimately contain PowerShell syntax for `powershell -Command`, so
    // reject only impossible string content and rely on single-quote escaping
    // for PowerShell interpolation safety.
    const argStr = args
      .map((a) => `'${escapePowerShellArg(sanitizeCommandArg(a))}'`)
      .join(", ");
    const script = `
      $result = Invoke-Command -VMName '${safeName}' -ScriptBlock {
        $output = & '${safeCommand}' ${argStr} 2>&1
        @{
          ExitCode = $LASTEXITCODE
          Output = ($output | Out-String)
        }
      }
      $result | ConvertTo-Json
    `;

    try {
      const result = await psJson<{ ExitCode: number; Output: string }>(script, safeTimeout);
      return {
        exitCode: result.ExitCode ?? 0,
        stdout: result.Output,
        stderr: "",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ── Extended Operations ───────────────────────────────────────────

  async getVmIpAddress(handle: VMHandle): Promise<string> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const script = `
      $ip = (Get-VM -Name '${safeName}' | Get-VMNetworkAdapter).IPAddresses | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | Select-Object -First 1
      if (-not $ip) { throw "No IPv4 address found for VM '${safeName}'" }
      $ip
    `;
    const ip = await ps(script);
    if (!ip) {
      throw new Error(`No IPv4 address found for VM '${handle.name}'`);
    }
    return ip;
  }

  async waitForHeartbeat(handle: VMHandle, timeoutMs: number): Promise<boolean> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeTimeout = sanitizeTimeout(timeoutMs);
    // Pure event-driven wait, modelled on `waitForStableState` above.
    // Subscribe to `Msvm_ComputerSystem` modification indications for
    // this VM (the heartbeat status surfaces as a property change on
    // the same VM CIM instance) and re-check `(Get-VM).Heartbeat`
    // each time the broker delivers an indication. No Start-Sleep,
    // no Get-Date deadline — the outer ps() process has the dead-man
    // ceiling, that's the only safety net needed and it exists only
    // for catastrophic CIM-broker failure, not for coordination.
    //
    // Ready means Hyper-V is receiving guest heartbeat traffic.
    // Windows commonly reports `OkApplicationsUnknown` when OS
    // heartbeat is healthy but application health is not supplied, so
    // accept it alongside `OkApplicationsHealthy`.
    //
    // Returns 'true' when ready, 'false' when the dead-man timeout
    // fires (no heartbeat indication delivered within the window).
    // Maps the PowerShell exit-code-style payload to a boolean here
    // so callers' contract is unchanged.
    const result = await ps(`
      $safeName = '${safeName}'
      $ready = @('OkApplicationsHealthy', 'OkApplicationsUnknown')
      $current = $null
      try { $current = (Get-VM -Name $safeName).Heartbeat.ToString() } catch {}
      if ($ready -contains $current) { 'READY'; return }

      $query = @"
SELECT * FROM __InstanceModificationEvent WITHIN 1
  WHERE TargetInstance ISA 'Msvm_ComputerSystem'
    AND TargetInstance.ElementName = '${safeName}'
"@
      $sourceId = "signalman-vmheartbeat-$([guid]::NewGuid())"
      Register-CimIndicationEvent -Query $query -Namespace 'root\\virtualization\\v2' -SourceIdentifier $sourceId | Out-Null
      try {
        while ($true) {
          # Wait-Event with no -Timeout blocks until the CIM broker
          # delivers the next indication. Event-driven, no poll. The
          # outer ps() ceiling is the dead-man on the whole call.
          Wait-Event -SourceIdentifier $sourceId | Out-Null
          Remove-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
          $current = $null
          try { $current = (Get-VM -Name $safeName).Heartbeat.ToString() } catch {}
          if ($ready -contains $current) { 'READY'; return }
        }
      } finally {
        Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
      }
    `, safeTimeout);
    return result.trim() === "READY";
  }

  async setVmMemory(handle: VMHandle, memoryMB: number): Promise<void> {
    if (!Number.isInteger(memoryMB) || memoryMB < 32 || memoryMB > 1_048_576) {
      throw new Error(`Invalid memory value: ${memoryMB}MB. Must be 32-1048576.`);
    }
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await ps(`Set-VMMemory -VMName '${safeName}' -StartupBytes ${memoryMB}MB`);
  }

  async setVmProcessor(handle: VMHandle, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 240) {
      throw new Error(`Invalid processor count: ${count}. Must be 1-240.`);
    }
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    await ps(`Set-VMProcessor -VMName '${safeName}' -Count ${count}`);
  }

  async setVmFirmware(
    handle: VMHandle,
    opts: { secureBootEnabled?: boolean },
  ): Promise<void> {
    // Empty request is an error rather than a silent no-op so a
    // CLI typo (forgetting --secure-boot) doesn't pretend to succeed.
    if (opts.secureBootEnabled === undefined) {
      throw new Error("setVmFirmware called with no fields to set");
    }
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const parts = [`-VMName '${safeName}'`];
    // Set-VMFirmware accepts the literal tokens On / Off; an
    // unrecognized value throws inside PowerShell.
    const val = opts.secureBootEnabled ? "On" : "Off";
    parts.push(`-EnableSecureBoot ${val}`);
    await ps(`Set-VMFirmware ${parts.join(" ")}`);
  }
}
