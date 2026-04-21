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
import { promisify } from "node:util";
import { existsSync } from "node:fs";
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
  escapePowerShellArg,
  sanitizeTimeout,
} from "../sanitize.js";

const exec = promisify(execFile);

// ── Elevation Helpers ─────────────────────────────────────────────

/** Well-known gsudo install locations on Windows. */
const GSUDO_PATHS = [
  "C:\\Program Files\\gsudo\\Current\\gsudo.exe",
  "C:\\Program Files (x86)\\gsudo\\Current\\gsudo.exe",
];

/** Cached elevation state — computed once on first use. */
let _isElevated: boolean | null = null;
let _gsudoPath: string | null = null;
let _elevationChecked = false;

/**
 * Check whether the current process is running elevated (Administrator).
 * Result is cached for the lifetime of the process.
 */
function isElevated(): boolean {
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
 * Find gsudo on the system. Checks well-known paths and PATH.
 * Returns the full path to gsudo.exe, or null if not found.
 * Result is cached.
 */
function findGsudo(): string | null {
  if (_elevationChecked) return _gsudoPath;
  _elevationChecked = true;

  // Check well-known install locations
  for (const p of GSUDO_PATHS) {
    if (existsSync(p)) {
      _gsudoPath = p;
      console.error(`[signalman] Found gsudo at: ${p}`);
      return _gsudoPath;
    }
  }

  // Check PATH
  try {
    const result = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["gsudo"],
      { stdio: "pipe", timeout: 5_000, windowsHide: true },
    );
    const found = result.toString().trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) {
      _gsudoPath = found;
      console.error(`[signalman] Found gsudo in PATH: ${found}`);
      return _gsudoPath;
    }
  } catch {
    // gsudo not in PATH
  }

  return null;
}

/**
 * Resolve the command and args to use for running a PowerShell script.
 *
 * If already elevated: runs powershell.exe directly.
 * If not elevated but gsudo is available: wraps via gsudo for transparent
 * elevation. gsudo caches credentials so only the first call prompts UAC.
 * If neither: runs powershell.exe directly (will fail on Hyper-V cmdlets
 * that require admin, but non-admin cmdlets still work).
 */
function resolvePsCommand(): { cmd: string; prefixArgs: string[] } {
  if (isElevated()) {
    return { cmd: "powershell.exe", prefixArgs: [] };
  }

  const gsudo = findGsudo();
  if (gsudo) {
    return {
      cmd: gsudo,
      prefixArgs: ["powershell.exe"],
    };
  }

  // Fall through — no elevation available, commands may fail
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

/** Execute a PowerShell command, return raw stdout. */
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

export class HyperVBackend implements HypervisorBackend {
  readonly name = "hyperv";

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

    const script = `
      $vm = New-VM -Name '${safeName}' -MemoryStartupBytes ${memMB}MB -Generation 2 -SwitchName '${safeSwitch}'
      Set-VMProcessor -VM $vm -Count ${cpus}
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

    return {
      handle,
      state: mapState(info.State),
      ipAddress: info.IPAddress ?? undefined,
      guestAgentReachable: false, // TODO: gRPC health check
      uptimeSeconds: info.Uptime,
      memoryUsedMB: info.MemoryAssigned,
    };
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
    _progress?: ProgressCallback,
  ): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeHostPath = escapePowerShellArg(sanitizePath(hostPath));
    const safeGuestPath = escapePowerShellArg(sanitizePath(guestPath));
    // Copy-VMFile requires the VM to be running and have integration services
    await ps(`
      Copy-VMFile -Name '${safeName}' -SourcePath '${safeHostPath}' -DestinationPath '${safeGuestPath}' -FileSource Host -Force
    `);
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
    // Defense-in-depth: each arg element is validated through sanitizeCommand
    // (rejects shell metacharacters) AND escaped for PowerShell single-quoted
    // strings.  The sanitizeCommand check guards against injection even if
    // the PowerShell escaping is somehow bypassed.
    const argStr = args
      .map((a) => `'${escapePowerShellArg(sanitizeCommand(a))}'`)
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
    const pollIntervalMs = 2_000;
    const deadline = Date.now() + safeTimeout;

    while (Date.now() < deadline) {
      try {
        const heartbeat = await ps(
          `(Get-VM -Name '${safeName}').Heartbeat.ToString()`,
          10_000,
        );
        if (heartbeat === "OkApplicationsHealthy") {
          return true;
        }
      } catch {
        // VM may not be running yet; keep polling
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
      );
    }
    return false;
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
}
