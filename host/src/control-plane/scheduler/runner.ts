/**
 * Periodic health-check scheduler (v0.4.0-3 / Epic 3, WS3).
 *
 * Wakes once per `tickIntervalMs` (default 60s), enumerates active
 * `health_schedule` rows, picks the ones whose `last_run_at +
 * interval_seconds` is at or before `now`, and invokes the existing
 * probe runner against each target's current active deployment.
 * Results land in the existing `health_check` table so the health
 * history surface looks the same as operator-triggered runs, and an
 * audit-log entry is appended on each successful tick so flapping
 * health is queryable historically.
 *
 * The scheduler is intentionally **single-process and in-memory** —
 * the v0.4 design point is to layer onto the local-mode control plane
 * without standing up a job queue. v0.5+ may promote this to a job
 * kind handled by the runner-queue worker pool (PR 8) once the multi-
 * host story matures; the `dueSchedules` decision is already isolated
 * as a pure function so that promotion is mechanical.
 *
 * Event semantics:
 *   - "health-failed" — emitted whenever a tick produces a probe with
 *     status='fail' OR a 'vm_reachable' fail. Epic 2 will wire this
 *     into the event dispatcher; until then `emit` defaults to a
 *     structured JSON log on stderr so operators can still grep for
 *     it. Caller can pass an injected dispatcher.
 *
 * Determinism:
 *   - `now` is injected as a `() => Date` so tests can advance fake
 *     time without coupling to `Date.now`.
 *   - The probe invocation path is a typed callback (the verb-layer
 *     `runHealthCheck` injects the real implementation) so the
 *     scheduler can be tested with a stub that never touches a VM.
 */

import type { ControlPlane } from "../index.js";
import type { HealthSchedule } from "../types.js";

/**
 * Result shape returned by the probe-invocation callback. Mirrors
 * `runHealthCheck`'s return type but trimmed to what the scheduler
 * actually consumes (no need for the full target+release objects).
 */
export interface ScheduledProbeOutcome {
  /** Whether the floor `vm_reachable` probe passed. */
  reachable: boolean;
  /** Per-probe statuses for the user-declared probes. */
  probes: Array<{ name: string; status: "pass" | "fail" | "degraded" }>;
  /** Deployment id the probes ran against, if any. */
  deploymentId: string | null;
  /** Optional human detail (mostly used by failure paths). */
  detail?: string;
}

/**
 * The callback the scheduler invokes for each due schedule. The
 * production wiring constructs this around `runHealthCheck` from the
 * control-plane verbs; tests pass a fake.
 *
 * The callback must NOT throw on probe-level failures — it must
 * return a structured outcome with reachable=false / status='fail'.
 * It MAY throw on infrastructure errors (target deleted, backend
 * unavailable); the scheduler catches and logs those, advances
 * `last_run_at`, and continues with the next schedule.
 */
export type ProbeInvoker = (input: {
  schedule: HealthSchedule;
}) => Promise<ScheduledProbeOutcome>;

/** Event payloads emitted by the scheduler. Epic 2 plugs into these. */
export type SchedulerEvent =
  | {
      kind: "health-tick";
      scheduleId: string;
      targetId: string;
      outcome: ScheduledProbeOutcome;
      at: string;
    }
  | {
      kind: "health-failed";
      scheduleId: string;
      targetId: string;
      outcome: ScheduledProbeOutcome;
      at: string;
    }
  | {
      kind: "schedule-error";
      scheduleId: string;
      targetId: string;
      error: string;
      at: string;
    };

export type SchedulerEmit = (event: SchedulerEvent) => void;

export interface SchedulerOptions {
  controlPlane: ControlPlane;
  invoke: ProbeInvoker;
  /** Returns "now"; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Wake interval (ms). Default 60_000. */
  tickIntervalMs?: number;
  /** Optional event sink. Defaults to a stderr JSON logger. */
  emit?: SchedulerEmit;
}

/**
 * Pure decision: which schedules are due relative to `nowMs`?
 *
 * A schedule is due when:
 *   - it has never run (`lastRunAt === null`) AND it was created at
 *     least `intervalSeconds` ago — this keeps newly-added schedules
 *     from immediately firing during their grace window;
 *   - OR `lastRunAt + intervalSeconds * 1000 <= nowMs`.
 *
 * Soft-deleted and inactive schedules are filtered upstream; this
 * function trusts its input list.
 */
export function dueSchedules(
  schedules: HealthSchedule[],
  nowMs: number,
): HealthSchedule[] {
  const out: HealthSchedule[] = [];
  for (const s of schedules) {
    const anchor = s.lastRunAt ?? s.createdAt;
    const anchorMs = Date.parse(anchor);
    if (!Number.isFinite(anchorMs)) continue;
    if (anchorMs + s.intervalSeconds * 1000 <= nowMs) {
      out.push(s);
    }
  }
  return out;
}

/** Default emit: structured JSON to stderr, one event per line. */
function defaultEmit(event: SchedulerEvent): void {
  process.stderr.write(JSON.stringify({ source: "signalman-scheduler", ...event }) + "\n");
}

/**
 * Run a single scheduler tick: enumerate active schedules, pick due
 * ones, run probes, persist `lastRunAt`, emit events. Returns the
 * count of schedules processed (useful for tests).
 */
export async function runSchedulerTick(opts: SchedulerOptions): Promise<number> {
  const emit = opts.emit ?? defaultEmit;
  const now = opts.now ?? (() => new Date());
  const nowDate = now();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();

  const active = await opts.controlPlane.healthSchedules.listActive();
  const due = dueSchedules(active, nowMs);

  for (const schedule of due) {
    try {
      const outcome = await opts.invoke({ schedule });
      // Advance the watermark FIRST so a flaky invoke that throws
      // halfway through doesn't burn cycles re-running the same
      // schedule on every tick. (We've already paid for the invoke.)
      await opts.controlPlane.healthSchedules.update(schedule.id, {
        lastRunAt: nowIso,
      });
      emit({
        kind: "health-tick",
        scheduleId: schedule.id,
        targetId: schedule.targetId,
        outcome,
        at: nowIso,
      });
      const probeFailed = outcome.probes.some((p) => p.status === "fail");
      if (!outcome.reachable || probeFailed) {
        emit({
          kind: "health-failed",
          scheduleId: schedule.id,
          targetId: schedule.targetId,
          outcome,
          at: nowIso,
        });
      }
      // Audit-log entry so flapping health is queryable historically.
      await opts.controlPlane.auditLog.append({
        orgId: schedule.orgId,
        actor: "scheduler",
        action: outcome.reachable && !probeFailed ? "health.scheduled.pass" : "health.scheduled.fail",
        entityType: "health_schedule",
        entityId: schedule.id,
        detail: {
          targetId: schedule.targetId,
          deploymentId: outcome.deploymentId,
          reachable: outcome.reachable,
          probes: outcome.probes,
        },
      });
    } catch (err) {
      // Infrastructure error: target deleted, backend unavailable,
      // probe runner exploded. Advance the watermark anyway so we
      // don't pin the loop on a permanently broken schedule, but
      // surface the problem so an operator can investigate.
      try {
        await opts.controlPlane.healthSchedules.update(schedule.id, {
          lastRunAt: nowIso,
        });
      } catch {
        // If even the watermark write fails, give up on this
        // schedule for now; next tick will retry.
      }
      emit({
        kind: "schedule-error",
        scheduleId: schedule.id,
        targetId: schedule.targetId,
        error: (err as Error).message,
        at: nowIso,
      });
      try {
        await opts.controlPlane.auditLog.append({
          orgId: schedule.orgId,
          actor: "scheduler",
          action: "health.scheduled.error",
          entityType: "health_schedule",
          entityId: schedule.id,
          detail: { error: (err as Error).message },
        });
      } catch {
        // Audit-log write fails on a closed DB during shutdown; not
        // worth crashing the whole tick.
      }
    }
  }

  return due.length;
}

/**
 * Long-running loop wrapper around `runSchedulerTick`. Returns a
 * `stop()` handle; the loop exits on the next `await` after `stop()`
 * is called. Errors from individual ticks are caught and emitted as
 * `schedule-error`; the loop continues running.
 */
export interface SchedulerHandle {
  stop: () => Promise<void>;
  /** Resolves when the loop exits cleanly. */
  done: Promise<void>;
}

export function startScheduler(opts: SchedulerOptions): SchedulerHandle {
  const tickMs = opts.tickIntervalMs ?? 60_000;
  let stopped = false;
  let resolveStop: () => void = () => undefined;
  const stopSignal = new Promise<void>((res) => {
    resolveStop = res;
  });
  const done = (async () => {
    while (!stopped) {
      try {
        await runSchedulerTick(opts);
      } catch (err) {
        const emit = opts.emit ?? defaultEmit;
        emit({
          kind: "schedule-error",
          scheduleId: "<tick>",
          targetId: "<tick>",
          error: (err as Error).message,
          at: new Date().toISOString(),
        });
      }
      // Race the next tick against `stop()` so cancellation is prompt.
      await Promise.race([new Promise((res) => setTimeout(res, tickMs)), stopSignal]);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      resolveStop();
      await done;
    },
    done,
  };
}
