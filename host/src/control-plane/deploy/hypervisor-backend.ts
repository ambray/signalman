/**
 * Real DeployBackend backed by the project's HypervisorBackend.
 *
 * Resolves a `target.connection` to a VMHandle using the same lookup
 * the existing CLI verbs use, and forwards checkpoint/copy/status
 * calls verbatim.
 */

import type { CheckpointHandle, HypervisorBackend, VMHandle } from "../../hypervisors/interface.js";
import type { TargetConnection } from "../types.js";
import type { DeployBackend, DeployVmHandle, ExecResult } from "./backend.js";

export class HypervisorDeployBackend implements DeployBackend {
  constructor(private readonly hyp: HypervisorBackend) {}

  async resolveVm(connection: TargetConnection): Promise<DeployVmHandle> {
    const vmName = connection.vmName;
    if (typeof vmName !== "string" || vmName.length === 0) {
      throw new Error("target.connection.vmName is required for VM targets");
    }
    const vms = await this.hyp.listVMs();
    const handle = vms.find((v) => v.name === vmName);
    if (!handle) {
      throw new Error(
        `VM '${vmName}' not found on backend '${this.hyp.name}'. Known VMs: ${vms
          .map((v) => v.name)
          .join(", ") || "(none)"}`,
      );
    }
    return { handle, vmName };
  }

  createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle> {
    return this.hyp.createCheckpoint(handle, label);
  }

  restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    return this.hyp.restoreCheckpoint(checkpoint);
  }

  deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    return this.hyp.deleteCheckpoint(checkpoint);
  }

  copyFileToVM(handle: VMHandle, hostPath: string, guestPath: string): Promise<void> {
    return this.hyp.copyFileToVM(handle, hostPath, guestPath);
  }

  async isVmReachable(handle: VMHandle): Promise<{ reachable: boolean; detail?: string }> {
    const status = await this.hyp.getStatus(handle);
    if (status.state !== "running") {
      return { reachable: false, detail: `VM state=${status.state}` };
    }
    // Heartbeat + IP are softer signals; reachable = state==running is
    // the v0.2 floor. PR 4 adds component probes that target specific
    // services, composed from executeInGuest.
    return {
      reachable: true,
      detail: status.ipAddress ? `ip=${status.ipAddress}` : undefined,
    };
  }

  async executeInGuest(
    handle: VMHandle,
    command: string,
    args?: string[],
    timeoutMs?: number,
  ): Promise<ExecResult> {
    const result = await this.hyp.executeCommand(handle, command, args, timeoutMs);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
