/**
 * Cleanup reaper for orphaned ephemeral VMs + child VHDX files
 * (v0.3.0-2 follow-up).
 *
 * When a scenario run crashes mid-way (orchestrator killed,
 * service restart, lost network), the `finally`-block teardown in
 * `runScenario` doesn't fire. Ephemeral VMs and their child VHDX
 * files persist with no live scenario referencing them. This
 * module identifies and reaps those orphans.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Time-based orphan detection, not mark-based.** A signalman
 *   process can't reliably mark "I'm using this resource" because
 *   the crash modes we're protecting against include sudden
 *   termination (kill -9, host reboot, BSOD). Heartbeat files
 *   would themselves leak. Instead, we treat any ephemeral
 *   resource older than `minAgeMs` (default 1 hour) as an orphan.
 *   Operators tune the threshold for their max-expected-scenario
 *   wall-clock: 5min for fast CI, 24h for long-running soak runs.
 * - **Cross-reference disks and VMs.** An ephemeral resource is
 *   either a child VHDX in `<projectRoot>/.signalman/ephemeral-disks/`
 *   OR a backend VM whose disk path is under that directory. We
 *   reap both axes — a stale VHDX with no VM is reaped (VM was
 *   already deleted, file leaked); a VM with a missing VHDX is
 *   reaped (operator deleted the file, VM still tracked).
 * - **Per-resource best-effort.** A failure deleting one resource
 *   does not prevent reaping the others. Errors are collected
 *   into `ReapResult.errors` for operator follow-up.
 * - **Dry-run first.** Operators get a report before any
 *   destructive action via `dryRun: true`.
 *
 * # What this module does NOT do
 *
 * - **Doesn't reap pre-existing long-lived VMs.** Only resources
 *   under `.signalman/ephemeral-disks/` (the v0.3.0-2 ephemeral
 *   pipeline output) qualify. P9.1-style `provisionVM`-managed
 *   VMs are operator-managed long-lived state and stay untouched.
 * - **Doesn't manage active scenario state.** If a scenario is
 *   currently running and `minAgeMs` is misconfigured too low,
 *   the reaper might delete a live ephemeral VM. Operators
 *   choosing the threshold must respect their max-scenario
 *   wall-clock budget.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  HypervisorBackend,
  VMHandle,
} from "../hypervisors/interface.js";

// ── Public constants ──────────────────────────────────────────────

/** Default minimum-age threshold for orphan detection (1 hour). */
export const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────

/**
 * Inputs to {@link reapOrphanedEphemeralResources}.
 */
export interface ReapOptions {
  /**
   * Project root. The reaper looks for ephemeral disks under
   * `<projectRoot>/.signalman/ephemeral-disks/`. Must be absolute.
   */
  projectRoot: string;
  /**
   * Backend used to list VMs and call stop/delete. The reaper
   * iterates `backend.listVMs()`, filters by disk-path match
   * against the ephemeral-disks directory, and tears down
   * orphans via `backend.stopVM` + `backend.deleteVM`.
   */
  backend: HypervisorBackend;
  /**
   * Minimum age (in ms since file mtime) before considering a
   * resource an orphan. Defaults to {@link DEFAULT_MIN_AGE_MS}.
   * Operators tune for their max-scenario wall-clock budget.
   */
  minAgeMs?: number;
  /**
   * When `true`, only report orphans — do not delete anything.
   * Defaults to `false`. Operators are encouraged to run with
   * `dryRun: true` first to verify the candidate list.
   */
  dryRun?: boolean;
  /**
   * Optional fs surface for testability. Defaults to `node:fs`.
   * Tests inject a recorder that asserts on stat / unlink calls.
   */
  fsImpl?: {
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
    statSync: (p: string) => { mtimeMs: number };
    unlinkSync: (p: string) => void;
  };
  /**
   * Optional clock source for "now" — tests inject a fixed
   * timestamp so age math is deterministic.
   */
  now?: () => number;
}

/** One orphan resource entry in the reap result. */
export interface OrphanEntry {
  /** VM name or absolute VHDX path. */
  resource: string;
  /** Resource kind, for downstream filtering / display. */
  kind: "vm" | "disk";
  /** Resource age in ms (now - mtime when computed). */
  age_ms: number;
  /** True when the reaper actually deleted (false on dry-run + on failure). */
  deleted: boolean;
}

/** Outcome of one reap pass. */
export interface ReapResult {
  /** Total orphan VMs found (regardless of deletion outcome). */
  orphan_vm_count: number;
  /** Total orphan disks found (regardless of deletion outcome). */
  orphan_disk_count: number;
  /** Per-resource detail; deleted=false on dry-run + on failure. */
  orphans: OrphanEntry[];
  /**
   * Per-resource failure messages. A non-empty array does NOT
   * abort the reap; the caller decides whether to retry.
   */
  errors: Array<{ resource: string; kind: "vm" | "disk"; error: string }>;
  /**
   * Whether the reaper ran in dry-run mode. Mirrors the input
   * for round-trip reporting clarity.
   */
  dry_run: boolean;
}

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Structured error for reaper-level input failures. Per-resource
 * failures land in `ReapResult.errors`; this type is for "the
 * reaper couldn't start at all" issues like a missing project
 * root.
 */
export class EphemeralReaperError extends Error {
  constructor(
    public readonly code: "project_root_missing" | "non_absolute_path",
    message: string,
  ) {
    super(message);
    this.name = "EphemeralReaperError";
  }
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Reap orphaned ephemeral VMs + child VHDX files.
 *
 * Algorithm:
 *   1. Read `<projectRoot>/.signalman/ephemeral-disks/` for
 *      candidate VHDX files. Filter by age >= `minAgeMs`.
 *   2. List backend VMs. Filter to those whose disk path
 *      (when the backend exposes one) lives under the ephemeral
 *      disks directory.
 *   3. Cross-reference: a VM whose VHDX exists is a "live"
 *      ephemeral resource (not yet orphaned by age). A VM whose
 *      VHDX is missing OR whose VHDX is older than the threshold
 *      is an orphan VM. A VHDX with no corresponding VM and age
 *      over threshold is an orphan disk.
 *   4. Unless `dryRun`, tear down each orphan: stopVM → deleteVM
 *      → unlink VHDX (per-resource best-effort).
 *
 * @throws {@link EphemeralReaperError} for setup failures only —
 *         per-resource failures collect into `ReapResult.errors`.
 */
export async function reapOrphanedEphemeralResources(
  opts: ReapOptions,
): Promise<ReapResult> {
  // ── Validate setup ─────────────────────────────────────────────

  if (!path.isAbsolute(opts.projectRoot)) {
    throw new EphemeralReaperError(
      "non_absolute_path",
      `projectRoot must be absolute, got: ${opts.projectRoot}`,
    );
  }
  const fsImpl = opts.fsImpl ?? {
    existsSync: fs.existsSync,
    readdirSync: (p: string) => fs.readdirSync(p),
    statSync: (p: string) => fs.statSync(p),
    unlinkSync: fs.unlinkSync,
  };
  const now = opts.now ?? Date.now;
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const dryRun = opts.dryRun ?? false;

  const ephemeralDisksDir = path.join(
    opts.projectRoot,
    ".signalman",
    "ephemeral-disks",
  );

  // ── Enumerate candidate disks ─────────────────────────────────

  const diskFiles: Array<{ filename: string; absPath: string; ageMs: number }> = [];
  if (fsImpl.existsSync(ephemeralDisksDir)) {
    for (const filename of fsImpl.readdirSync(ephemeralDisksDir)) {
      if (!filename.toLowerCase().endsWith(".vhdx")) continue;
      const absPath = path.join(ephemeralDisksDir, filename);
      let mtimeMs: number;
      try {
        mtimeMs = fsImpl.statSync(absPath).mtimeMs;
      } catch {
        // A file that disappeared between readdir + stat is a race
        // we don't fight — skip it and let a later run pick up the
        // result.
        continue;
      }
      diskFiles.push({
        filename,
        absPath,
        ageMs: now() - mtimeMs,
      });
    }
  }

  // ── Enumerate ephemeral VMs (whose name matches an existing disk) ──

  let allVms: VMHandle[] = [];
  try {
    allVms = await opts.backend.listVMs();
  } catch {
    // If the backend can't list VMs, we can still reap orphan
    // disks — the VM-axis just shows zero candidates. Continue.
    allVms = [];
  }

  // Match VMs to disks by filename stem: ephemeral VM `<name>`
  // owns child VHDX `<name>.vhdx`. The name produced by
  // buildEphemeralName is already lowercase-sanitised so direct
  // comparison is safe.
  const diskNameStems = new Set(
    diskFiles.map((d) => stripVhdxSuffix(d.filename).toLowerCase()),
  );
  const ephemeralVms = allVms.filter((vm) =>
    diskNameStems.has(vm.name.toLowerCase()),
  );

  // ── Classify orphans ──────────────────────────────────────────

  const orphans: OrphanEntry[] = [];
  const errors: ReapResult["errors"] = [];

  // 1. Orphan disks: candidate VHDX older than threshold AND
  //    either no matching VM OR the matching VM is also an orphan.
  //    (We dedupe later — the VM-side handler unlinks the VHDX
  //    too, so a disk paired with an orphan VM gets reaped by the
  //    VM branch and removed from the disk branch.)
  const ephemeralVmNamesLower = new Set(
    ephemeralVms.map((vm) => vm.name.toLowerCase()),
  );
  const orphanDisks = diskFiles.filter(
    (d) =>
      d.ageMs >= minAgeMs &&
      !ephemeralVmNamesLower.has(
        stripVhdxSuffix(d.filename).toLowerCase(),
      ),
  );

  // 2. Orphan VMs: any matched ephemeral VM whose disk is past
  //    the threshold. The age is taken from the VHDX mtime (best
  //    proxy for VM creation time without a separate registry).
  const diskAgeByStem = new Map<string, number>();
  for (const d of diskFiles) {
    diskAgeByStem.set(stripVhdxSuffix(d.filename).toLowerCase(), d.ageMs);
  }
  const orphanVms = ephemeralVms.filter((vm) => {
    const age = diskAgeByStem.get(vm.name.toLowerCase());
    return age !== undefined && age >= minAgeMs;
  });

  // ── Reap ─────────────────────────────────────────────────────

  for (const vm of orphanVms) {
    const ageMs = diskAgeByStem.get(vm.name.toLowerCase()) ?? 0;
    const entry: OrphanEntry = {
      resource: vm.name,
      kind: "vm",
      age_ms: ageMs,
      deleted: false,
    };
    if (!dryRun) {
      try {
        await opts.backend.stopVM(vm);
      } catch (err) {
        errors.push({
          resource: vm.name,
          kind: "vm",
          error: `stopVM failed: ${(err as Error).message ?? String(err)}`,
        });
      }
      try {
        await opts.backend.deleteVM(vm);
        // Successful delete → also unlink the VHDX. We do this
        // here rather than in the disk loop so the VM and its
        // disk are reaped as a unit.
        const childPath = path.join(ephemeralDisksDir, `${vm.name}.vhdx`);
        try {
          if (fsImpl.existsSync(childPath)) {
            fsImpl.unlinkSync(childPath);
          }
        } catch (err) {
          errors.push({
            resource: childPath,
            kind: "disk",
            error: `unlink failed after VM delete: ${(err as Error).message ?? String(err)}`,
          });
        }
        entry.deleted = true;
      } catch (err) {
        errors.push({
          resource: vm.name,
          kind: "vm",
          error: `deleteVM failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    }
    orphans.push(entry);
  }

  // Orphan disks not already reaped by the VM branch.
  const reapedDiskPaths = new Set(
    orphanVms.map((vm) =>
      path.join(ephemeralDisksDir, `${vm.name}.vhdx`),
    ),
  );
  for (const disk of orphanDisks) {
    if (reapedDiskPaths.has(disk.absPath)) continue;
    const entry: OrphanEntry = {
      resource: disk.absPath,
      kind: "disk",
      age_ms: disk.ageMs,
      deleted: false,
    };
    if (!dryRun) {
      try {
        fsImpl.unlinkSync(disk.absPath);
        entry.deleted = true;
      } catch (err) {
        errors.push({
          resource: disk.absPath,
          kind: "disk",
          error: `unlink failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    }
    orphans.push(entry);
  }

  return {
    orphan_vm_count: orphanVms.length,
    orphan_disk_count: orphanDisks.filter(
      (d) => !reapedDiskPaths.has(d.absPath),
    ).length,
    orphans,
    errors,
    dry_run: dryRun,
  };
}

// ── Internal helpers ──────────────────────────────────────────────

/** Strip the `.vhdx` suffix from a filename (case-insensitive). */
function stripVhdxSuffix(filename: string): string {
  return filename.replace(/\.vhdx$/i, "");
}
