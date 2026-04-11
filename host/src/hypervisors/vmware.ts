/**
 * VMware hypervisor backend.
 *
 * Uses vmrun (VMware Workstation/Fusion) or govc (vSphere) for VM management.
 * vmrun is used for local development; govc for enterprise/CI deployments.
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

/** Execute vmrun and return stdout. */
async function vmrun(
  vmrunPath: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const { stdout } = await exec(vmrunPath, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export class VmwareBackend implements HypervisorBackend {
  readonly name = "vmware";
  private vmrunPath: string;
  private useGovc: boolean;
  private guestUser: string;
  private guestPass: string;

  constructor(options?: {
    vmrunPath?: string;
    useGovc?: boolean;
    guestUser?: string;
    guestPass?: string;
  }) {
    this.vmrunPath = options?.vmrunPath ?? "vmrun";
    this.useGovc = options?.useGovc ?? false;
    this.guestUser = options?.guestUser ?? "guest";
    this.guestPass = options?.guestPass ?? "guest";
  }

  async isAvailable(): Promise<boolean> {
    try {
      await vmrun(this.vmrunPath, ["list"]);
      return true;
    } catch {
      return false;
    }
  }

  // ── VM Lifecycle ──────────────────────────────────────────────

  async createVM(_config: VMConfig): Promise<VMHandle> {
    // VMware VM creation requires vmx file manipulation or vSphere API.
    // For now, VMs must be pre-created — this is a placeholder.
    throw new Error(
      "VMware VM creation via vmrun is not supported. Pre-create VMs or use govc with vSphere.",
    );
  }

  async startVM(handle: VMHandle): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, ["start", vmxPath, "nogui"]);
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    const mode = force ? "hard" : "soft";
    await vmrun(this.vmrunPath, ["stop", vmxPath, mode]);
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, ["pause", vmxPath]);
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, ["unpause", vmxPath]);
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, ["deleteVM", vmxPath]);
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const state = await this.getVmState(handle);
    return {
      handle,
      state,
      guestAgentReachable: false, // TODO: gRPC health check
    };
  }

  async listVMs(): Promise<VMHandle[]> {
    if (this.useGovc) {
      return this.listVmsGovc();
    }

    const output = await vmrun(this.vmrunPath, ["list"]);
    const lines = output.split("\n").slice(1); // Skip "Total running VMs: N"
    return lines
      .filter((l) => l.trim())
      .map((vmxPath) => ({
        name:
          vmxPath
            .trim()
            .split(/[/\\]/)
            .pop()
            ?.replace(".vmx", "") ?? vmxPath.trim(),
        id: vmxPath.trim(),
        backend: this.name,
      }));
  }

  // ── Checkpoints ───────────────────────────────────────────────

  async createCheckpoint(
    handle: VMHandle,
    label: string,
  ): Promise<CheckpointHandle> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, ["snapshot", vmxPath, label]);
    return { id: label, vmHandle: handle, label };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const vmxPath = await this.resolveVmxPath(checkpoint.vmHandle);
    await vmrun(this.vmrunPath, [
      "revertToSnapshot",
      vmxPath,
      checkpoint.label,
    ]);
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const vmxPath = await this.resolveVmxPath(checkpoint.vmHandle);
    await vmrun(this.vmrunPath, [
      "deleteSnapshot",
      vmxPath,
      checkpoint.label,
    ]);
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const vmxPath = await this.resolveVmxPath(handle);
    const output = await vmrun(this.vmrunPath, [
      "listSnapshots",
      vmxPath,
    ]);
    const lines = output.split("\n").slice(1); // Skip "Total snapshots: N"
    return lines
      .filter((l) => l.trim())
      .map((name) => ({
        id: name.trim(),
        label: name.trim(),
        createdAt: new Date(), // vmrun doesn't expose creation time
      }));
  }

  // ── File Transfer ─────────────────────────────────────────────

  async copyFileToVM(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, [
      "-gu",
      this.guestUser,
      "-gp",
      this.guestPass,
      "copyFileFromHostToGuest",
      vmxPath,
      hostPath,
      guestPath,
    ]);
  }

  async copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const vmxPath = await this.resolveVmxPath(handle);
    await vmrun(this.vmrunPath, [
      "-gu",
      this.guestUser,
      "-gp",
      this.guestPass,
      "copyFileFromGuestToHost",
      vmxPath,
      guestPath,
      hostPath,
    ]);
  }

  // ── Command Execution ─────────────────────────────────────────

  async executeCommand(
    handle: VMHandle,
    command: string,
    args: string[] = [],
    timeoutMs = 60_000,
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const vmxPath = await this.resolveVmxPath(handle);
    const fullArgs = [
      "-gu",
      this.guestUser,
      "-gp",
      this.guestPass,
      "runProgramInGuest",
      vmxPath,
      "-activeWindow",
      command,
      ...args,
    ];

    try {
      const stdout = await vmrun(this.vmrunPath, fullArgs, timeoutMs);
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.code ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  private async getVmState(handle: VMHandle): Promise<VMState> {
    const vms = await this.listVMs();
    const vm = vms.find((v) => v.name === handle.name || v.id === handle.id);
    return vm ? "running" : "stopped";
  }

  private async resolveVmxPath(handle: VMHandle): Promise<string> {
    // If the id is already a .vmx path, use it
    if (handle.id.endsWith(".vmx")) {
      return handle.id;
    }

    // Try to find it in the running VM list
    const vms = await this.listVMs();
    const match = vms.find((v) => v.name === handle.name);
    if (match) {
      return match.id;
    }

    // Fall back to using the name as-is — caller must ensure correctness
    throw new Error(
      `Cannot resolve VMX path for '${handle.name}'. Provide a VMHandle with a .vmx path as id, or ensure the VM is running.`,
    );
  }

  private async listVmsGovc(): Promise<VMHandle[]> {
    const { stdout } = await exec("govc", ["vm.info", "-json", "*"], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const data = JSON.parse(stdout) as {
      virtualMachines?: Array<{ name: string }>;
    };
    return (data.virtualMachines ?? []).map((vm) => ({
      name: vm.name,
      id: vm.name,
      backend: this.name,
    }));
  }
}
