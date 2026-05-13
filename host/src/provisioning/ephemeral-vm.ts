/**
 * Ephemeral VM provisioning pipeline (v0.3.0-2 sub-task 3).
 *
 * Per-scenario disposable VMs. Each scenario run gets a fresh VM
 * branched off a pre-baked template via a differencing disk:
 *
 *   base.vhdx (read-only)
 *      └── <scenarioSlug>-<vmName>-<runIdShort>.vhdx (per-run child)
 *           └── ephemeral VM (auto-destroyed at teardown)
 *
 * On scenario teardown the VM is stopped, deleted, and the child VHDX
 * is unlinked. The base VHDX stays untouched.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Template must be PRE-BAKED.** The base VHDX already has the
 *   guest agent installed and starts in a state the scenario can
 *   talk to. We do NOT run the P9.1 MSI-install pipeline per
 *   scenario run — that's multi-minutes of overhead. v0.3.0-5 ships
 *   the "build a pre-baked template via Packer" pipeline; v0.3.0-2
 *   just consumes the result.
 * - **Ephemeral name** format:
 *   `<scenarioSlug>-<vmName>-<runIdShort>`
 *   Sanitised for Hyper-V (alphanumeric + hyphen + underscore only,
 *   no `:`, `\`, `/`, `?`, `*`, `"`, `<`, `>`, `|`). Truncated to
 *   `EPHEMERAL_NAME_MAX_LEN`. The `runIdShort` slice guarantees
 *   uniqueness across concurrent runs.
 * - **Child VHDX path**: `<ephemeralDisksDir>/<ephemeralName>.vhdx`.
 *   The caller supplies `ephemeralDisksDir`; the orchestrator
 *   typically uses `<projectRoot>/.signalman/ephemeral-disks/`.
 * - **vm_lineage_hash computed at provision time.** Stored on the
 *   returned record so the orchestrator can attach it to the
 *   scenario-run envelope. v0.3.0-3 graduates this through the
 *   public envelope shape; v0.3.0-2 records it on the internal
 *   resource ledger.
 * - **Atomic-on-failure.** If `createDifferencingDisk` succeeds but
 *   `backend.createVM` fails, we unlink the orphaned child VHDX
 *   before re-raising. Callers don't need a cleanup handler — the
 *   function is responsible for its own atomicity.
 *
 * # What this module does NOT do
 *
 * - **Does not boot the VM.** That's the orchestrator's job (the
 *   existing `resolveVms` pipeline handles boot + heartbeat wait
 *   after the handle is in `vmMap`).
 * - **Does not restore a checkpoint.** Ephemeral VMs start fresh
 *   from the base; there is no per-run checkpoint to restore.
 * - **Does not install the guest agent.** Template must be
 *   pre-baked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type {
  HypervisorBackend,
  VMConfig,
  VMHandle,
} from "../hypervisors/interface.js";
import {
  resolveTemplateAsync,
  type VmTemplate,
  type ResolveTemplateOptions,
} from "../scenarios/templates.js";
import {
  createDifferencingDisk,
  DifferencingDiskError,
} from "./differencing-disk.js";
import {
  computeVmLineageHash,
  type InstalledEntry,
} from "./vm-lineage-hash.js";

// ── Public constants ──────────────────────────────────────────────

/** Maximum length of the ephemeral VM name. Hyper-V caps name length
 *  at 100 chars; we leave headroom for the `runIdShort` suffix and
 *  the eventual `.vhdx` filename. */
export const EPHEMERAL_NAME_MAX_LEN = 64;

/** Length of the runId short-suffix used in ephemeral names. */
export const RUN_ID_SHORT_LEN = 8;

// ── Types ──────────────────────────────────────────────────────────

/**
 * Inputs to {@link provisionEphemeralVm}.
 *
 * The caller is responsible for choosing `ephemeralDisksDir` —
 * typically `<projectRoot>/.signalman/ephemeral-disks/`. The
 * function does not auto-create the directory; the caller is
 * responsible for that (so a project-layout decision lives in one
 * place upstream).
 */
export interface EphemeralVmConfig {
  /**
   * Scenario identifier, used as the first segment of the ephemeral
   * name. Typically the scenario's slug (e.g. `"smoke"`,
   * `"service-backend-smoke"`).
   */
  scenarioSlug: string;
  /**
   * Logical VM name from the scenario YAML (e.g. `"endpoint-1"`).
   * Second segment of the ephemeral name.
   */
  vmName: string;
  /**
   * Run identifier — typically the orchestrator's traceId / runId.
   * The first {@link RUN_ID_SHORT_LEN} characters are appended to
   * the ephemeral name. If omitted, a random hex suffix is
   * generated (e.g. ad-hoc CLI runs without trace context).
   */
  runId?: string;
  /**
   * Template name resolved by {@link resolveTemplateAsync}. Required.
   */
  templateName: string;
  /**
   * Absolute path to the directory that holds child VHDX files.
   * Must exist; not auto-created. Required.
   */
  ephemeralDisksDir: string;
  /**
   * Software installed on top of the base template, recorded for the
   * vm_lineage_hash. Defaults to `[]` (nothing extra installed).
   */
  installed?: InstalledEntry[];
  /**
   * OS label for the vm_lineage_hash. Defaults to a label derived
   * from the template name (`"win11-base"` → `"windows-11"`,
   * `"win10-base"` → `"windows-10"`). Override when the caller has
   * a more specific label.
   */
  osLabel?: string;
  /**
   * Override the backend `createVM` config. The function fills in
   * `name` and `template` (=child VHDX path); other VMConfig fields
   * (cpus, memoryMB, network, etc.) can be supplied here or fall
   * through to backend defaults.
   */
  vmConfigOverrides?: Partial<Omit<VMConfig, "name" | "template">>;
}

/**
 * Record produced by {@link provisionEphemeralVm}, consumed by
 * {@link teardownEphemeralVm}. Carries everything teardown needs.
 *
 * Persist this in the scenario's resource ledger so a crashed run's
 * orphans can be reclaimed by the cleanup reaper (out of scope for
 * v0.3.0-2; tracked as v0.3.0-2 follow-up).
 */
export interface EphemeralVmRecord {
  /** Backend handle (use for `startVM`, `getStatus`, etc.). */
  vmHandle: VMHandle;
  /** Final ephemeral name as registered with the backend. */
  ephemeralName: string;
  /** Absolute path of the differencing child VHDX. */
  childVhdxPath: string;
  /** Absolute path of the (read-only) base VHDX. */
  parentVhdxPath: string;
  /** SHA-256 hex of the canonical lineage record. */
  vmLineageHash: string;
  /** Template name as supplied. */
  templateName: string;
  /** Template version when the template carries one. */
  templateVersion?: string;
}

/**
 * Injectable dependencies for testing. Production callers leave
 * undefined.
 */
export interface EphemeralVmDeps {
  resolveTemplate?: (
    name: string,
    opts?: ResolveTemplateOptions,
  ) => Promise<VmTemplate>;
  createDifferencingDisk?: typeof createDifferencingDisk;
  unlinkChildDisk?: (childVhdxPath: string) => void;
  /**
   * PS exec used by {@link createDifferencingDisk}. Required when
   * the default `createDifferencingDisk` is used.
   */
  psExec?: (script: string, timeoutMs?: number) => Promise<string>;
  /**
   * Source of randomness for the runId suffix when `config.runId`
   * is omitted. Defaults to `crypto.randomBytes`.
   */
  randomBytes?: (size: number) => Buffer;
}

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Structured error for ephemeral provisioning failures. Carries a
 * stable `code` so callers can dispatch on the failure point.
 */
export class EphemeralVmError extends Error {
  constructor(
    public readonly code:
      | "template_resolve_failed"
      | "template_missing_vhdx"
      | "ephemeral_disks_dir_missing"
      | "diff_disk_failed"
      | "create_vm_failed"
      | "missing_ps_exec",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EphemeralVmError";
  }
}

// ── Pure helpers ───────────────────────────────────────────────────

/**
 * Sanitise a string for use as a Hyper-V VM name segment.
 *
 * Replaces every character outside `[A-Za-z0-9_-]` with `-`, then
 * collapses runs of `-` and trims leading/trailing hyphens. Lower-
 * cases the output (Hyper-V is case-insensitive, but a canonical
 * lowercase form makes name comparisons safe across platforms).
 */
export function sanitizeNameSegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the ephemeral VM name from the three identity inputs.
 *
 * Format: `<scenarioSlug>-<vmName>-<runIdShort>` after each segment
 * is sanitised. The result is truncated to {@link EPHEMERAL_NAME_MAX_LEN}
 * by chopping segments from the LEFT (so the runId-derived suffix
 * always survives, which is the part that guarantees uniqueness).
 */
export function buildEphemeralName(parts: {
  scenarioSlug: string;
  vmName: string;
  runIdShort: string;
}): string {
  const slug = sanitizeNameSegment(parts.scenarioSlug);
  const vm = sanitizeNameSegment(parts.vmName);
  const run = sanitizeNameSegment(parts.runIdShort);
  const full = `${slug}-${vm}-${run}`;
  if (full.length <= EPHEMERAL_NAME_MAX_LEN) return full;
  // Truncate from the left, preserving `-<vm>-<run>` (the unique part).
  const tail = `-${vm}-${run}`;
  const slugBudget = Math.max(0, EPHEMERAL_NAME_MAX_LEN - tail.length);
  const truncatedSlug = slug.slice(0, slugBudget).replace(/-+$/g, "");
  return truncatedSlug.length > 0
    ? `${truncatedSlug}${tail}`
    : tail.replace(/^-/, "");
}

/**
 * Compute the absolute child VHDX path for an ephemeral VM.
 *
 * The caller is responsible for ensuring `ephemeralDisksDir` exists.
 * This helper just composes the path string.
 */
export function computeEphemeralChildVhdxPath(
  ephemeralDisksDir: string,
  ephemeralName: string,
): string {
  return path.join(ephemeralDisksDir, `${ephemeralName}.vhdx`);
}

/**
 * Derive a best-effort OS label from a template name.
 *
 * Used as the default `osLabel` for `computeVmLineageHash` when the
 * caller doesn't supply one. Coverage is intentionally narrow — the
 * caller knows the OS better than we do; the default is just so
 * smoke tests work without configuring every field.
 */
export function defaultOsLabel(templateName: string): string {
  const lower = templateName.toLowerCase();
  if (lower.includes("win11") || lower.includes("windows-11")) return "windows-11";
  if (lower.includes("win10") || lower.includes("windows-10")) return "windows-10";
  if (lower.includes("ubuntu")) return "ubuntu";
  return "unknown";
}

// ── Main pipeline ──────────────────────────────────────────────────

/**
 * Provision an ephemeral VM end-to-end.
 *
 * Steps:
 *   1. Resolve the template (gets the base VHDX path).
 *   2. Derive ephemeral name + child VHDX path.
 *   3. Create the differencing disk.
 *   4. Create the VM with the child VHDX.
 *   5. Compute the vm_lineage_hash.
 *   6. Return the record.
 *
 * Atomic-on-failure: if step 4 fails, step 3's child VHDX is
 * unlinked before re-raising. If step 5 fails after the VM exists,
 * the VM is left around (callers may want to inspect; teardown is
 * cheap and can be invoked explicitly).
 *
 * @throws {@link EphemeralVmError} with `code` indicating the step
 *         that failed.
 */
export async function provisionEphemeralVm(
  backend: HypervisorBackend,
  config: EphemeralVmConfig,
  deps: EphemeralVmDeps = {},
): Promise<EphemeralVmRecord> {
  // ── Step 1: resolve template ───────────────────────────────────

  const resolveTemplate = deps.resolveTemplate ?? resolveTemplateAsync;
  let template: VmTemplate;
  try {
    template = await resolveTemplate(config.templateName);
  } catch (err) {
    throw new EphemeralVmError(
      "template_resolve_failed",
      `Failed to resolve template '${config.templateName}': ` +
        ((err as Error).message ?? String(err)),
      err,
    );
  }

  if (!template.vhdxPath) {
    throw new EphemeralVmError(
      "template_missing_vhdx",
      `Template '${config.templateName}' has no vhdxPath populated. ` +
        `Ephemeral provisioning requires a concrete base VHDX — set ` +
        `base_image_path or base_image_url on the template.`,
    );
  }

  // ── Step 2: derive identity ────────────────────────────────────

  if (!fs.existsSync(config.ephemeralDisksDir)) {
    throw new EphemeralVmError(
      "ephemeral_disks_dir_missing",
      `Ephemeral disks directory does not exist: ` +
        `${config.ephemeralDisksDir}. The caller must create it ` +
        `before invoking provisionEphemeralVm.`,
    );
  }

  const runIdShort = computeRunIdShort(config.runId, deps.randomBytes);
  const ephemeralName = buildEphemeralName({
    scenarioSlug: config.scenarioSlug,
    vmName: config.vmName,
    runIdShort,
  });
  const childVhdxPath = computeEphemeralChildVhdxPath(
    config.ephemeralDisksDir,
    ephemeralName,
  );

  // ── Step 3: differencing disk ──────────────────────────────────

  const diffDiskImpl = deps.createDifferencingDisk ?? createDifferencingDisk;

  try {
    if (deps.createDifferencingDisk) {
      // Test path: caller injected their own. They handle `exec`
      // however they want (typically as a vi.fn that no-ops).
      await diffDiskImpl({
        parentVhdxPath: template.vhdxPath,
        childVhdxPath,
        exec: deps.psExec ?? (async () => ""),
      });
    } else {
      // Production path: real createDifferencingDisk requires a real
      // PS exec from the caller. We surface a clear error if it's
      // not provided rather than letting a `undefined.call(...)`
      // throw inside the cmdlet wrapper.
      if (!deps.psExec) {
        throw new EphemeralVmError(
          "missing_ps_exec",
          "deps.psExec is required when using the default " +
            "createDifferencingDisk. Pass a PowerShell exec function " +
            "(typically the existing ps() helper from " +
            "host/src/hypervisors/hyperv.ts).",
        );
      }
      await diffDiskImpl({
        parentVhdxPath: template.vhdxPath,
        childVhdxPath,
        exec: deps.psExec,
      });
    }
  } catch (err) {
    if (err instanceof EphemeralVmError) throw err;
    throw new EphemeralVmError(
      "diff_disk_failed",
      `Failed to create differencing disk ${childVhdxPath} ` +
        `(parent ${template.vhdxPath}): ` +
        ((err as Error).message ?? String(err)),
      err,
    );
  }

  // ── Step 4: create VM ──────────────────────────────────────────

  let vmHandle: VMHandle;
  try {
    const vmConfig: VMConfig = {
      ...(config.vmConfigOverrides ?? {}),
      name: ephemeralName,
      template: childVhdxPath,
      cpus: config.vmConfigOverrides?.cpus ?? template.processorCount,
      memoryMB: config.vmConfigOverrides?.memoryMB ?? template.memoryMB,
      network:
        config.vmConfigOverrides?.network ??
        (template.networkSwitch
          ? { switchName: template.networkSwitch }
          : undefined),
    };
    vmHandle = await backend.createVM(vmConfig);
  } catch (err) {
    // Roll back step 3 — orphaned child VHDX is the only resource
    // we leaked. Best-effort unlink; if it fails we surface the
    // original create-VM error, not the cleanup error.
    const unlink = deps.unlinkChildDisk ?? defaultUnlink;
    try {
      unlink(childVhdxPath);
    } catch {
      // Swallow — the original create-VM error is the actionable
      // one. A surviving orphan child VHDX will be reclaimed by
      // the cleanup reaper (v0.3.0-2 follow-up) or operator
      // intervention.
    }
    throw new EphemeralVmError(
      "create_vm_failed",
      `Failed to create ephemeral VM '${ephemeralName}': ` +
        ((err as Error).message ?? String(err)),
      err,
    );
  }

  // ── Step 5: vm_lineage_hash ───────────────────────────────────

  const osLabel = config.osLabel ?? defaultOsLabel(config.templateName);
  const lineageInput = {
    template_name: config.templateName,
    template_version: extractTemplateVersion(template),
    os: osLabel,
    installed: config.installed ?? [],
  };
  const vmLineageHash = computeVmLineageHash(lineageInput);

  return {
    vmHandle,
    ephemeralName,
    childVhdxPath,
    parentVhdxPath: template.vhdxPath,
    vmLineageHash,
    templateName: config.templateName,
    templateVersion: lineageInput.template_version,
  };
}

/**
 * Tear down an ephemeral VM and its differencing disk.
 *
 * Order: stop → delete VM → unlink child VHDX. Each step is
 * best-effort; if `stopVM` fails we still try `deleteVM`. The first
 * error encountered is rethrown after all three steps have been
 * attempted, so a partial teardown leaves the most-actionable error
 * surfaced rather than masking it with later failures.
 *
 * `deps.unlinkChildDisk` defaults to `fs.unlinkSync`. Tests inject a
 * vi.fn.
 */
export async function teardownEphemeralVm(
  backend: HypervisorBackend,
  record: EphemeralVmRecord,
  deps: { unlinkChildDisk?: (path: string) => void } = {},
): Promise<void> {
  let firstError: unknown = null;

  // Step 1: stop the VM (idempotent — if not running, no-op).
  try {
    await backend.stopVM(record.vmHandle);
  } catch (err) {
    if (firstError === null) firstError = err;
  }

  // Step 2: delete the VM. This also reaps the VM-side metadata
  // (Hyper-V's per-VM XML config). It does NOT unlink the child
  // VHDX (Hyper-V leaves disk files in place unless asked).
  try {
    await backend.deleteVM(record.vmHandle);
  } catch (err) {
    if (firstError === null) firstError = err;
  }

  // Step 3: unlink the child VHDX. Skip if the file no longer
  // exists (e.g. an external reaper got there first).
  try {
    const unlink = deps.unlinkChildDisk ?? defaultUnlink;
    unlink(record.childVhdxPath);
  } catch (err) {
    if (firstError === null) firstError = err;
  }

  if (firstError !== null) {
    throw firstError;
  }
}

// ── Internal helpers ───────────────────────────────────────────────

function computeRunIdShort(
  runId: string | undefined,
  randomBytesImpl?: (n: number) => Buffer,
): string {
  if (runId && runId.length > 0) {
    return runId.slice(0, RUN_ID_SHORT_LEN);
  }
  const rng = randomBytesImpl ?? crypto.randomBytes;
  return rng(8).toString("hex").slice(0, RUN_ID_SHORT_LEN);
}

function extractTemplateVersion(template: VmTemplate): string | undefined {
  // Templates carry an optional `base_image_sha256` (P9.5) — when
  // present it's the most stable version identity we have. We use
  // the first 16 hex chars as a compact version marker.
  if (template.base_image_sha256 && template.base_image_sha256.length >= 16) {
    return template.base_image_sha256.slice(0, 16);
  }
  return undefined;
}

function defaultUnlink(p: string): void {
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}
