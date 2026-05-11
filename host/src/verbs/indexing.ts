/**
 * Best-effort indexing of scenarios and runs into the control plane.
 *
 * Design constraint (docs/design/meta-build-system.md §9): existing
 * verbs (`list`, `run`, `status`) keep their shape; their execution
 * path "migrates to call the control plane" in a way that's invisible
 * in local mode.
 *
 * We implement that at the *boundary* (CLI / MCP entry points), not
 * inside the verb functions. Each entry point calls its verb as
 * before, then asks this module to mirror the result into the catalog.
 *
 * Every helper is best-effort: if the control plane can't init (e.g.
 * disk full, schema mismatch on an older db), the helper logs a single
 * warning to stderr and returns. The user-visible behaviour of the
 * verb is unchanged. This keeps an existing CLI workflow alive even
 * when the new persistence layer is unhealthy.
 */

import { ControlPlane } from "../control-plane/index.js";
import type { Scenario, Run } from "../control-plane/types.js";
import type { ListResult } from "./list.js";

let warned = false;
function warn(message: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[signalman] indexing warning: ${message}\n`);
}

/**
 * Open a one-shot control plane for an indexing operation. Caller is
 * responsible for awaiting + closing. Returns null on init failure
 * (with a one-time stderr warning) so callers can early-return.
 */
async function openControlPlane(): Promise<ControlPlane | null> {
  try {
    const cp = ControlPlane.fromConfig();
    await cp.init();
    return cp;
  } catch (err) {
    warn(`could not initialize control plane: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Upsert every entry from `signalman list` into the scenario catalog.
 * Skips entries that hit a YAML-parse error (they have `entry.error`
 * set; nothing to index until the operator fixes them).
 */
export async function indexListResult(list: ListResult): Promise<void> {
  const cp = await openControlPlane();
  if (!cp) return;
  try {
    const { defaultOrg } = await cp.init();
    for (const e of list.scenarios) {
      if (e.error || !e.scenario_hash || !e.name) continue;
      try {
        await cp.scenarios.upsertFromDisk({
          orgId: defaultOrg.id,
          path: e.path,
          scenarioHash: e.scenario_hash,
          name: e.name,
          tags: e.tags ?? [],
        });
      } catch (err) {
        warn(`failed to upsert scenario '${e.id}': ${(err as Error).message}`);
        // continue with the next scenario
      }
    }
  } finally {
    await cp.close();
  }
}

/**
 * Record that a scenario `run` was started. Idempotent: looks up the
 * scenario by path, creates the run row, returns its id (caller can
 * pass it back to `indexRunCompletion` later).
 *
 * Returns null when indexing fails — callers should treat it as
 * "couldn't record" and proceed.
 */
export async function indexRunStart(input: {
  scenarioPath: string;
  triggeredBy: Run["triggeredBy"];
  startedAt: string;
}): Promise<string | null> {
  const cp = await openControlPlane();
  if (!cp) return null;
  try {
    const { defaultOrg } = await cp.init();
    const scenario = await cp.scenarios.getByPath(defaultOrg.id, input.scenarioPath);
    if (!scenario) {
      // The user ran a scenario we haven't indexed yet — e.g. the
      // first run before any `signalman list`. Not worth blocking on.
      return null;
    }
    const run = await cp.runs.create({
      orgId: defaultOrg.id,
      scenarioId: scenario.id,
      triggeredBy: input.triggeredBy,
    });
    await cp.runs.update(run.id, { startedAt: input.startedAt });
    return run.id;
  } catch (err) {
    warn(`failed to record run start: ${(err as Error).message}`);
    return null;
  } finally {
    await cp.close();
  }
}

/**
 * Finalise a run row when the envelope arrives. Idempotent — if the
 * row is already completed we don't overwrite, so polling-style
 * callers can call this repeatedly.
 */
export async function indexRunCompletion(input: {
  runRowId: string;
  result: string;
  completedAt: string;
  envelopeBlobUri?: string;
}): Promise<void> {
  const cp = await openControlPlane();
  if (!cp) return;
  try {
    const existing = await cp.runs.get(input.runRowId);
    if (!existing) return;
    if (existing.completedAt) return; // already finalised
    await cp.runs.update(input.runRowId, {
      result: input.result,
      completedAt: input.completedAt,
      envelopeBlobUri: input.envelopeBlobUri,
    });
  } catch (err) {
    warn(`failed to record run completion: ${(err as Error).message}`);
  } finally {
    await cp.close();
  }
}

/** Convenience type re-export for callers. */
export type { Scenario, Run };
