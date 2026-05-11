/**
 * DeployBackend — the slice of HypervisorBackend the deploy executor
 * needs, plus VM-handle resolution from a `target.connection` JSON.
 *
 * Why an interface and not a direct dep on HypervisorBackend:
 *   * Tests want to inject a fake without standing up Hyper-V.
 *   * Future target kinds (Docker, k8s, bare-metal) will implement the
 *     same shape with a different mechanism — checkpoint/restore for
 *     Hyper-V VMs becomes save-and-rollback-image for Docker, etc.
 *
 * The real implementation lives in deploy/hypervisor-backend.ts and
 * wraps the existing HypervisorBackend + resolveVmHandleByName.
 */

import type { CheckpointHandle, VMHandle } from "../../hypervisors/interface.js";
import type { TargetConnection } from "../types.js";

export interface DeployVmHandle {
  handle: VMHandle;
  vmName: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeployBackend {
  /** Resolve the VM handle for a target's stored connection. */
  resolveVm(connection: TargetConnection): Promise<DeployVmHandle>;

  /** Pre-deploy snapshot for atomic deploy. */
  createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle>;
  /** Restore on deploy failure. */
  restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void>;
  /** Drop the pre-deploy checkpoint after success. */
  deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void>;

  /** Stage a file from host into the guest. */
  copyFileToVM(handle: VMHandle, hostPath: string, guestPath: string): Promise<void>;

  /**
   * "VM is reachable" floor probe used by PR 3 deploy as a sanity gate
   * before any user-declared probe runs. Independent from PR 4's
   * declarative probes — those compose from `executeInGuest`.
   */
  isVmReachable(handle: VMHandle): Promise<{ reachable: boolean; detail?: string }>;

  /**
   * Execute a command inside the guest. Used by the PR 4 probe runner
   * (command, http_in_guest, file_in_guest probes all reduce to a
   * guest command + structured matcher).
   */
  executeInGuest(
    handle: VMHandle,
    command: string,
    args?: string[],
    timeoutMs?: number,
  ): Promise<ExecResult>;
}
