/**
 * VM cleanup (P9.1).
 *
 * `cleanupVM` is the explicit teardown path for VMs created by
 * `provisionVM`. The product decision (locked) is to leave a failed
 * provisioning attempt's VM around so an operator can inspect the
 * state — `--cleanup-on-failure` is opt-in. This module implements
 * the manual cleanup verb, plus the same teardown that
 * `provisionVM --force` calls before re-provisioning.
 *
 * Idempotency: calling `cleanupVM` on a name that doesn't resolve to
 * a backend handle is a no-op. The function never throws on
 * "already gone".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HypervisorBackend, VMHandle } from "../hypervisors/interface.js";
import { globalVmCache } from "../vm-cache.js";

// ── Public API ────────────────────────────────────────────────────

/**
 * Stop + delete a VM and remove any per-VM provisioning artifacts.
 *
 * Steps (each best-effort, errors logged but not thrown unless they'd
 * leave the system in an inconsistent state):
 *
 *   1. Resolve the VM by name. If it doesn't exist, no-op + return.
 *   2. Stop the VM (force=true; we don't care about graceful shutdown
 *      since we're about to delete).
 *   3. Delete the VM via backend.deleteVM (this also removes its
 *      virtual disks, per the HypervisorBackend contract).
 *   4. Remove the per-VM dev-cert tempdir if one was staged for this
 *      provision attempt (host/<TMP>/signalman-provision-<vmName>/).
 *   5. Invalidate the VM cache entry so subsequent listVMs refreshes
 *      from the backend rather than returning a dangling handle.
 *
 * @param backend - active hypervisor backend
 * @param vmName  - VM name (matches what was passed to provisionVM)
 */
export async function cleanupVM(
  backend: HypervisorBackend,
  vmName: string,
): Promise<void> {
  const handle = await tryResolve(backend, vmName);
  if (handle) {
    // Best-effort stop. If the VM is already off, stopVM throws on some
    // backends — we swallow.
    try {
      await backend.stopVM(handle, /* force */ true);
    } catch (err) {
      // Already-stopped is the most common cause; log + continue.
      console.error(
        `[provisioning] cleanupVM(${vmName}): stopVM failed (continuing): ${(err as Error).message}`,
      );
    }
    try {
      await backend.deleteVM(handle);
    } catch (err) {
      // If delete fails we want the operator to know — but we still
      // clear the cache so a follow-up provision doesn't reuse a
      // pointer to a half-dead handle. Re-throw so the caller can
      // surface the error.
      globalVmCache.invalidate(vmName);
      throw new Error(
        `cleanupVM: failed to delete VM '${vmName}': ${(err as Error).message}`,
      );
    }
  }

  // Per-VM cert tempdir cleanup. The provision pipeline writes dev
  // certs to a tempdir keyed on vmName so concurrent provisions don't
  // race — clean up the tempdir whether or not the VM existed.
  removePerVmCertDir(vmName);

  globalVmCache.invalidate(vmName);
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Resolve a VM name to a handle, returning null instead of throwing
 * when the VM doesn't exist. Used for idempotent "already gone" paths.
 */
async function tryResolve(
  backend: HypervisorBackend,
  name: string,
): Promise<VMHandle | null> {
  const cached = globalVmCache.get(name);
  if (cached) return cached;
  try {
    const vms = await backend.listVMs();
    return vms.find((vm) => vm.name === name) ?? null;
  } catch {
    return null;
  }
}

/**
 * The provision pipeline stages dev certs at
 * `<os.tmpdir()>/signalman-provision-<vmName>/`. Remove that tree.
 * No-op if it doesn't exist.
 */
function removePerVmCertDir(vmName: string): void {
  const certDir = path.join(os.tmpdir(), `signalman-provision-${vmName}`);
  if (!fs.existsSync(certDir)) return;
  try {
    fs.rmSync(certDir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[provisioning] cleanupVM(${vmName}): failed to remove cert tempdir ${certDir}: ${(err as Error).message}`,
    );
  }
}
