/**
 * v0.5 Win11 bootstrap — phase-journal state file (M1).
 *
 * Per the design doc §M1 step 13 and locked Q8/Q10, the
 * `bootstrap-win11` verb persists a per-VM phase journal at
 *   `.signalman/state/bootstrap-win11/<vm-name>.json`
 * so that a re-run resumes mid-pipeline rather than restarting from
 * `set-firmware`. The shape is intentionally explicit + versioned so
 * that v0.6 evolutions (e.g. unattended.xml seed-ISO bookkeeping in
 * M2, libvirt-specific firmware journaling in M4) can extend it
 * without breaking forward compatibility.
 *
 * Compatibility contract:
 *   - readers tolerate UNKNOWN fields (forward compat) and a missing
 *     state file (treated as "not started");
 *   - readers REJECT a file with a `stateVersion` larger than the
 *     reader's `MAX_SUPPORTED_STATE_VERSION` — that's an operator
 *     error ("the file was written by a newer signalman binary;
 *     upgrade or move the file aside");
 *   - `stateVersion` bumps when the wire-format becomes
 *     incompatible-by-default (i.e. a reader following the old shape
 *     would corrupt state by writing it back). Additive fields don't
 *     bump.
 *
 * The Phase enum mirrors the §M1 12-step pipeline. The journal stores
 * one entry per completed phase with the wall-clock timestamp so
 * `bootstrap-win11-status` (M3) can compute durations + diff against
 * the canonical phase order.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Wire-format version. Bump on breaking changes only. */
export const CURRENT_STATE_VERSION = 1 as const;

/** Max state file version this binary can READ safely. */
export const MAX_SUPPORTED_STATE_VERSION = 1 as const;

/**
 * The pipeline phases per design doc §M1 + M2. Order is canonical;
 * `nextPhase(p)` returns the successor.
 *
 * M2 (2026-05-17) inserts `compose_seed_iso` between `create_vm`
 * and `set_firmware`. The phase name is intentionally NOT `step_2_5`
 * — the spec calls for the phase to land BEFORE `set_firmware` and
 * AFTER `create_vm` so the create-VM call gets `extraCdroms`
 * populated, and `compose_seed_iso` is what the journal records.
 */
export type BootstrapPhase =
  | "resolve_template"
  | "acquire_lock"
  | "compose_seed_iso"
  | "create_vm"
  | "set_firmware"
  | "boot_vm"
  | "stage_certs"
  | "enable_testsigning"
  | "reboot_for_testsigning"
  | "verify_testsigning"
  | "resolve_msi"
  | "install_msi"
  | "checkpoint";

/** Canonical phase order; readers may rely on `indexOf` for ordering. */
export const PHASE_ORDER: readonly BootstrapPhase[] = [
  "resolve_template",
  "acquire_lock",
  "compose_seed_iso",
  "create_vm",
  "set_firmware",
  "boot_vm",
  "stage_certs",
  "enable_testsigning",
  "reboot_for_testsigning",
  "verify_testsigning",
  "resolve_msi",
  "install_msi",
  "checkpoint",
];

export interface PhaseRecord {
  /** Phase name (one of {@link BootstrapPhase}). */
  phase: BootstrapPhase;
  /** ISO-8601 timestamp at which the phase was marked complete. */
  completedAt: string;
  /**
   * Optional free-text detail. Useful for forensics on a "phase
   * passed but the operator wants to know what happened" probe.
   */
  detail?: string;
}

export interface BootstrapState {
  /** Wire-format version. See {@link CURRENT_STATE_VERSION}. */
  stateVersion: number;
  /** VM name this journal belongs to. */
  vmName: string;
  /** Template the pipeline was invoked with. */
  templateName: string;
  /** Checkpoint label the pipeline targets (default: agent-installed). */
  checkpointLabel: string;
  /** ISO-8601 timestamp at which the pipeline first started. */
  startedAt: string;
  /** ISO-8601 timestamp at which the last phase completed. */
  lastUpdatedAt: string;
  /**
   * Phase records keyed by phase name. Persisted as an array on disk
   * to preserve key insertion order for human inspection.
   */
  phases: PhaseRecord[];
  /**
   * The last phase that completed cleanly. Convenience for callers
   * that don't want to scan `phases` to derive the resume point. May
   * be omitted on a freshly-initialised journal where no phase has
   * run yet.
   */
  lastCompletedPhase?: BootstrapPhase;
  /**
   * If the last run failed, the phase at which it failed plus the
   * error message. Cleared by `markPhaseComplete` once that phase
   * succeeds on a subsequent run.
   */
  lastFailure?: {
    phase: BootstrapPhase;
    error: string;
    failedAt: string;
  };
  /**
   * M2 (2026-05-17) — absolute path to the seed ISO composed at
   * phase `compose_seed_iso`. Persisted so cleanup (phase
   * `checkpoint` or cleanup-on-failure) can detach + delete the
   * file even on a resume after partial failure. `null` when no
   * seed ISO was ever composed (legacy state files / pipelines
   * that opted out).
   */
  seedIsoPath?: string | null;
  /**
   * M2 (2026-05-17) — true once the seed ISO has been attached to
   * the VM (via `extraCdroms` passed to `createVM`). Required for
   * the cleanup contract: cleanup detaches via `removeIsoFromVm`
   * only when this flag is true (so a partial-failure path that
   * composed the ISO but never reached createVM doesn't try to
   * detach a non-attached media).
   */
  seedIsoAttached?: boolean;
}

// ── Path composition ──────────────────────────────────────────────

/**
 * Return the absolute path to the state file for a given VM. Caller
 * is responsible for ensuring the parent directory exists when
 * writing (writeState() handles that).
 */
export function bootstrapStatePath(
  vmName: string,
  projectRoot: string = process.cwd(),
): string {
  return path.join(
    projectRoot,
    ".signalman",
    "state",
    "bootstrap-win11",
    `${sanitizeVmName(vmName)}.json`,
  );
}

/**
 * VM names round-trip onto the filesystem. Reject anything containing
 * path separators or NUL — those would let a hostile VM name escape
 * the state dir.
 */
function sanitizeVmName(vmName: string): string {
  if (vmName.includes("/") || vmName.includes("\\") || vmName.includes("\0")) {
    throw new Error(
      `Invalid VM name '${vmName}': must not contain path separators or NUL`,
    );
  }
  if (vmName === "" || vmName === "." || vmName === "..") {
    throw new Error(`Invalid VM name '${vmName}': reserved name`);
  }
  return vmName;
}

// ── I/O ────────────────────────────────────────────────────────────

/**
 * Load a state file. Returns `null` if the file doesn't exist.
 * Throws a descriptive error if the file is malformed or the
 * `stateVersion` is unsupported.
 */
export function readState(
  vmName: string,
  projectRoot: string = process.cwd(),
): BootstrapState | null {
  const p = bootstrapStatePath(vmName, projectRoot);
  if (!fs.existsSync(p)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read bootstrap-win11 state file ${p}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse bootstrap-win11 state file ${p} as JSON: ${(err as Error).message}`,
    );
  }
  return normalizeState(parsed, p);
}

/**
 * Atomically persist a state file. Writes to `<path>.tmp` then renames;
 * partially-written files won't be left behind on a crash.
 */
export function writeState(
  state: BootstrapState,
  projectRoot: string = process.cwd(),
): void {
  const p = bootstrapStatePath(state.vmName, projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
}

/**
 * Validate + normalise a parsed JSON payload. Tolerates additive
 * fields (forward compat). Rejects an unsupported stateVersion.
 */
function normalizeState(parsed: unknown, source: string): BootstrapState {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Malformed bootstrap-win11 state file ${source}: top level must be an object`,
    );
  }
  const o = parsed as Record<string, unknown>;
  const stateVersion = typeof o.stateVersion === "number" ? o.stateVersion : 0;
  if (stateVersion > MAX_SUPPORTED_STATE_VERSION) {
    throw new Error(
      `State file ${source} has stateVersion=${stateVersion}, ` +
        `but this signalman binary only supports up to ` +
        `${MAX_SUPPORTED_STATE_VERSION}. Upgrade signalman or move ` +
        `the state file aside (e.g. \`mv ${source} ${source}.bak\`).`,
    );
  }
  const vmName = typeof o.vmName === "string" ? o.vmName : "";
  if (!vmName) {
    throw new Error(`State file ${source} is missing required field 'vmName'`);
  }
  const templateName = typeof o.templateName === "string" ? o.templateName : "";
  const checkpointLabel =
    typeof o.checkpointLabel === "string" ? o.checkpointLabel : "agent-installed";
  const startedAt = typeof o.startedAt === "string" ? o.startedAt : new Date().toISOString();
  const lastUpdatedAt =
    typeof o.lastUpdatedAt === "string" ? o.lastUpdatedAt : startedAt;
  const phases = Array.isArray(o.phases)
    ? (o.phases as unknown[]).filter(isPhaseRecord)
    : [];
  const lastCompletedPhase =
    typeof o.lastCompletedPhase === "string" &&
    PHASE_ORDER.includes(o.lastCompletedPhase as BootstrapPhase)
      ? (o.lastCompletedPhase as BootstrapPhase)
      : undefined;
  const lastFailure = isLastFailure(o.lastFailure) ? o.lastFailure : undefined;
  // M2 additive fields. Forward-compat: missing/typo'd values become
  // null / false defaults so legacy state files keep loading.
  const seedIsoPath =
    typeof o.seedIsoPath === "string" ? o.seedIsoPath : null;
  const seedIsoAttached =
    typeof o.seedIsoAttached === "boolean" ? o.seedIsoAttached : false;
  return {
    stateVersion: CURRENT_STATE_VERSION,
    vmName,
    templateName,
    checkpointLabel,
    startedAt,
    lastUpdatedAt,
    phases,
    lastCompletedPhase,
    lastFailure,
    seedIsoPath,
    seedIsoAttached,
  };
}

function isPhaseRecord(x: unknown): x is PhaseRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.phase === "string" &&
    PHASE_ORDER.includes(r.phase as BootstrapPhase) &&
    typeof r.completedAt === "string"
  );
}

function isLastFailure(
  x: unknown,
): x is { phase: BootstrapPhase; error: string; failedAt: string } {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.phase === "string" &&
    PHASE_ORDER.includes(r.phase as BootstrapPhase) &&
    typeof r.error === "string" &&
    typeof r.failedAt === "string"
  );
}

// ── Mutators ──────────────────────────────────────────────────────

/**
 * Construct a fresh state object for a brand-new pipeline run.
 * Doesn't persist; caller invokes `writeState` after.
 */
export function newState(opts: {
  vmName: string;
  templateName: string;
  checkpointLabel: string;
}): BootstrapState {
  const now = new Date().toISOString();
  return {
    stateVersion: CURRENT_STATE_VERSION,
    vmName: opts.vmName,
    templateName: opts.templateName,
    checkpointLabel: opts.checkpointLabel,
    startedAt: now,
    lastUpdatedAt: now,
    phases: [],
    seedIsoPath: null,
    seedIsoAttached: false,
  };
}

/**
 * Mark a phase as complete on the in-memory state object. Removes any
 * pending failure record (because a successful phase clears the
 * stale-failure flag). Does NOT persist; caller invokes
 * `writeState` after.
 */
export function markPhaseComplete(
  state: BootstrapState,
  phase: BootstrapPhase,
  detail?: string,
): BootstrapState {
  const now = new Date().toISOString();
  // Replace any existing record for this phase (re-runs can repeat
  // idempotent phases; we keep the most recent timestamp).
  const filtered = state.phases.filter((p) => p.phase !== phase);
  filtered.push({ phase, completedAt: now, detail });
  return {
    ...state,
    phases: filtered,
    lastUpdatedAt: now,
    lastCompletedPhase: phase,
    lastFailure: undefined,
  };
}

/**
 * Mark a phase as failed. Caller invokes `writeState` after; the
 * pipeline then rethrows so the operator sees the error.
 */
export function markPhaseFailed(
  state: BootstrapState,
  phase: BootstrapPhase,
  error: string,
): BootstrapState {
  const now = new Date().toISOString();
  return {
    ...state,
    lastUpdatedAt: now,
    lastFailure: { phase, error, failedAt: now },
  };
}

/**
 * Check whether a given phase has already completed in the current
 * journal. Used by the pipeline for the per-phase idempotency probe.
 */
export function isPhaseComplete(
  state: BootstrapState | null,
  phase: BootstrapPhase,
): boolean {
  if (!state) return false;
  return state.phases.some((p) => p.phase === phase);
}

/**
 * Compute the next phase to execute given the current state. Returns
 * the first phase in PHASE_ORDER whose record is absent. Returns
 * `null` if every phase has completed (the pipeline is done).
 */
export function nextPhaseToRun(
  state: BootstrapState | null,
): BootstrapPhase | null {
  if (!state) return PHASE_ORDER[0];
  for (const phase of PHASE_ORDER) {
    if (!state.phases.some((p) => p.phase === phase)) return phase;
  }
  return null;
}

/**
 * Delete the state file (e.g. for `--force` cleanup). No-op if the
 * file doesn't exist.
 */
export function deleteState(
  vmName: string,
  projectRoot: string = process.cwd(),
): void {
  const p = bootstrapStatePath(vmName, projectRoot);
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
