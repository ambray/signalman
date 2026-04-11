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

import { execFile } from "node:child_process";
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
  escapePowerShellArg,
  sanitizeTimeout,
} from "../sanitize.js";

const exec = promisify(execFile);

/** Execute a PowerShell command and return parsed JSON output. */
async function psJson<T>(script: string, timeoutMs = 30_000): Promise<T> {
  try {
    const { stdout } = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
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
  try {
    const { stdout } = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
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
    await ps(`Start-VM -Name '${safeName}' -ErrorAction SilentlyContinue`);
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const forceFlag = force ? "-TurnOff" : "-Force";
    await ps(`Stop-VM -Name '${safeName}' ${forceFlag} -ErrorAction SilentlyContinue`);
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
    const script = `Get-VM | Select-Object Id, Name | ConvertTo-Json -AsArray`;
    const vms = await psJson<Array<{ Id: string; Name: string }>>(script);
    return vms.map((vm) => ({ id: vm.Id, name: vm.Name, backend: this.name }));
  }

  // ── Checkpoints ───────────────────────────────────────────────

  async createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle> {
    const safeName = escapePowerShellArg(sanitizeVmName(handle.name));
    const safeLabel = escapePowerShellArg(sanitizeLabel(label));
    const script = `
      $cp = Checkpoint-VM -Name '${safeName}' -SnapshotName '${safeLabel}' -Passthru
      @{ Id = $cp.Id.ToString(); Name = $cp.Name } | ConvertTo-Json
    `;
    const result = await psJson<{ Id: string; Name: string }>(script);
    return { id: result.Id, vmHandle: handle, label: result.Name };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const safeName = escapePowerShellArg(sanitizeVmName(checkpoint.vmHandle.name));
    const safeLabel = escapePowerShellArg(sanitizeLabel(checkpoint.label));
    await ps(`
      $cp = Get-VMCheckpoint -VMName '${safeName}' -Name '${safeLabel}'
      Restore-VMCheckpoint -VMCheckpoint $cp -Confirm:$false
    `);
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
      Get-VMCheckpoint -VMName '${safeName}' |
        Select-Object Id, Name, CreationTime, ParentCheckpointId |
        ConvertTo-Json -AsArray
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
    const argStr = args.map((a) => `'${escapePowerShellArg(a)}'`).join(", ");
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
