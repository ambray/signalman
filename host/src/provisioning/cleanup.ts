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

const PROVISION_TEMP_PREFIX = "signalman-provision-";
const PROVISION_MANIFEST_FILE = "provisioning.json";

export interface ProvisioningRunManifest {
  vmName: string;
  templateName: string;
  checkpointLabel: string;
  startedAt: string;
  createdVm: boolean;
}

export interface OrphanedProvisioningVmCandidate {
  vmName: string;
  manifestPath: string;
  checkpointLabel: string;
  createdVm: boolean;
  startedAt?: string;
  handle?: VMHandle;
  reason: "missing_checkpoint" | "manifest_without_vm";
}

export interface CleanupOrphanedProvisioningVmsOptions {
  tmpDir?: string;
  dryRun?: boolean;
  includeManifestOnly?: boolean;
}

export interface CleanupOrphanedProvisioningVmsResult {
  candidates: OrphanedProvisioningVmCandidate[];
  cleaned: string[];
  artifactDirsRemoved: string[];
}

export function provisioningManifestPath(
  vmName: string,
  tmpDir = os.tmpdir(),
): string {
  return path.join(provisioningTempDir(vmName, tmpDir), PROVISION_MANIFEST_FILE);
}

export function writeProvisioningManifest(
  manifest: ProvisioningRunManifest,
  tmpDir = os.tmpdir(),
): void {
  const dir = provisioningTempDir(manifest.vmName, tmpDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, PROVISION_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8" },
  );
}

/**
 * Find incomplete Signalman provisioning runs and optionally reap them.
 *
 * The reaper only targets VMs with a Signalman provisioning manifest,
 * createdVm=true, and no target post-install checkpoint. Without that
 * manifest it refuses to infer ownership from a VM name.
 */
export async function cleanupOrphanedProvisioningVms(
  backend: HypervisorBackend,
  options: CleanupOrphanedProvisioningVmsOptions = {},
): Promise<CleanupOrphanedProvisioningVmsResult> {
  const dryRun = options.dryRun ?? true;
  const includeManifestOnly = options.includeManifestOnly ?? true;
  const candidates = await findOrphanedProvisioningVms(backend, options.tmpDir);
  const scopedCandidates = candidates.filter(
    (candidate) => candidate.reason !== "manifest_without_vm" || includeManifestOnly,
  );
  const cleaned: string[] = [];
  const artifactDirsRemoved: string[] = [];

  if (dryRun) {
    return { candidates: scopedCandidates, cleaned, artifactDirsRemoved };
  }

  for (const candidate of scopedCandidates) {
    if (candidate.handle) {
      await cleanupVM(backend, candidate.vmName);
      cleaned.push(candidate.vmName);
      removePerVmCertDir(candidate.vmName, options.tmpDir);
      artifactDirsRemoved.push(path.dirname(candidate.manifestPath));
      continue;
    }
    removePerVmCertDir(candidate.vmName, options.tmpDir);
    artifactDirsRemoved.push(path.dirname(candidate.manifestPath));
  }

  return { candidates: scopedCandidates, cleaned, artifactDirsRemoved };
}

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

async function findOrphanedProvisioningVms(
  backend: HypervisorBackend,
  tmpDir = os.tmpdir(),
): Promise<OrphanedProvisioningVmCandidate[]> {
  const manifests = readProvisioningManifests(tmpDir);
  const candidates: OrphanedProvisioningVmCandidate[] = [];

  for (const { manifest, manifestPath } of manifests) {
    if (!manifest.createdVm) continue;

    const handle = await tryResolve(backend, manifest.vmName);
    if (!handle) {
      candidates.push({
        vmName: manifest.vmName,
        manifestPath,
        checkpointLabel: manifest.checkpointLabel,
        createdVm: manifest.createdVm,
        startedAt: manifest.startedAt,
        reason: "manifest_without_vm",
      });
      continue;
    }

    if (!(await checkpointExists(backend, handle, manifest.checkpointLabel))) {
      candidates.push({
        vmName: manifest.vmName,
        manifestPath,
        checkpointLabel: manifest.checkpointLabel,
        createdVm: manifest.createdVm,
        startedAt: manifest.startedAt,
        handle,
        reason: "missing_checkpoint",
      });
    }
  }

  return candidates;
}

function readProvisioningManifests(
  tmpDir: string,
): Array<{ manifest: ProvisioningRunManifest; manifestPath: string }> {
  if (!fs.existsSync(tmpDir)) return [];

  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  const manifests: Array<{
    manifest: ProvisioningRunManifest;
    manifestPath: string;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROVISION_TEMP_PREFIX)) {
      continue;
    }
    const manifestPath = path.join(tmpDir, entry.name, PROVISION_MANIFEST_FILE);
    const manifest = readProvisioningManifest(manifestPath);
    if (manifest) manifests.push({ manifest, manifestPath });
  }

  return manifests;
}

function readProvisioningManifest(
  manifestPath: string,
): ProvisioningRunManifest | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as Partial<ProvisioningRunManifest>;
    if (
      typeof parsed.vmName === "string" &&
      typeof parsed.templateName === "string" &&
      typeof parsed.checkpointLabel === "string" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.createdVm === "boolean"
    ) {
      return parsed as ProvisioningRunManifest;
    }
  } catch {
    return null;
  }
  return null;
}

async function checkpointExists(
  backend: HypervisorBackend,
  handle: VMHandle,
  label: string,
): Promise<boolean> {
  try {
    const checkpoints = await backend.listCheckpoints(handle);
    return checkpoints.some((checkpoint) => checkpoint.label === label);
  } catch {
    return false;
  }
}

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
function removePerVmCertDir(vmName: string, tmpDir = os.tmpdir()): void {
  const certDir = provisioningTempDir(vmName, tmpDir);
  if (!fs.existsSync(certDir)) return;
  try {
    fs.rmSync(certDir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[provisioning] cleanupVM(${vmName}): failed to remove cert tempdir ${certDir}: ${(err as Error).message}`,
    );
  }
}

function provisioningTempDir(vmName: string, tmpDir = os.tmpdir()): string {
  return path.join(tmpDir, `${PROVISION_TEMP_PREFIX}${vmName}`);
}
