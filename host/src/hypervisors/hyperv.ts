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

const exec = promisify(execFile);

/** Execute a PowerShell command and return parsed JSON output. */
async function psJson<T>(script: string, timeoutMs = 30_000): Promise<T> {
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim()) as T;
}

/** Execute a PowerShell command, return raw stdout. */
async function ps(script: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
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

    const script = `
      $vm = New-VM -Name '${config.name}' -MemoryStartupBytes ${memMB}MB -Generation 2 -SwitchName '${switchName}'
      Set-VMProcessor -VM $vm -Count ${cpus}
      $vm | Select-Object Id, Name | ConvertTo-Json
    `;

    const result = await psJson<{ Id: string; Name: string }>(script);
    return { id: result.Id, name: result.Name, backend: this.name };
  }

  async startVM(handle: VMHandle): Promise<void> {
    await ps(`Start-VM -Name '${handle.name}' -ErrorAction SilentlyContinue`);
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const forceFlag = force ? "-TurnOff" : "-Force";
    await ps(`Stop-VM -Name '${handle.name}' ${forceFlag} -ErrorAction SilentlyContinue`);
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    await ps(`Suspend-VM -Name '${handle.name}'`);
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    await ps(`Resume-VM -Name '${handle.name}'`);
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    await ps(`
      Stop-VM -Name '${handle.name}' -TurnOff -ErrorAction SilentlyContinue
      Remove-VM -Name '${handle.name}' -Force
    `);
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const script = `
      $vm = Get-VM -Name '${handle.name}'
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
    const script = `
      $cp = Checkpoint-VM -Name '${handle.name}' -SnapshotName '${label}' -Passthru
      @{ Id = $cp.Id.ToString(); Name = $cp.Name } | ConvertTo-Json
    `;
    const result = await psJson<{ Id: string; Name: string }>(script);
    return { id: result.Id, vmHandle: handle, label: result.Name };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    await ps(`
      $cp = Get-VMCheckpoint -VMName '${checkpoint.vmHandle.name}' -Name '${checkpoint.label}'
      Restore-VMCheckpoint -VMCheckpoint $cp -Confirm:$false
    `);
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    await ps(`
      $cp = Get-VMCheckpoint -VMName '${checkpoint.vmHandle.name}' -Name '${checkpoint.label}'
      Remove-VMCheckpoint -VMCheckpoint $cp -Confirm:$false
    `);
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const script = `
      Get-VMCheckpoint -VMName '${handle.name}' |
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
    // Copy-VMFile requires the VM to be running and have integration services
    await ps(`
      Copy-VMFile -Name '${handle.name}' -SourcePath '${hostPath}' -DestinationPath '${guestPath}' -FileSource Host -Force
    `);
  }

  async copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    // Use PowerShell Direct to copy file from guest
    await ps(`
      $session = New-PSSession -VMName '${handle.name}'
      Copy-Item -FromSession $session -Path '${guestPath}' -Destination '${hostPath}'
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
    const argStr = args.map((a) => `'${a}'`).join(", ");
    const script = `
      $result = Invoke-Command -VMName '${handle.name}' -ScriptBlock {
        $output = & '${command}' ${argStr} 2>&1
        @{
          ExitCode = $LASTEXITCODE
          Output = ($output | Out-String)
        }
      }
      $result | ConvertTo-Json
    `;

    try {
      const result = await psJson<{ ExitCode: number; Output: string }>(script, timeoutMs);
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
}
