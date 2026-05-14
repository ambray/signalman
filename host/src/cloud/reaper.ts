/**
 * Cloud TTL reaper (v0.3.0-5 sub-task 5, control 1 of 3).
 *
 * Sweeps registered cloud backends for Signalman-managed instances
 * whose `signalman-ttl-expires-at` tag (epoch seconds) is in the
 * past, and terminates them via the backend's idempotent
 * `terminateInstance`. Mirrors the design in
 * `docs/design/meta-build-system.md` §13.5 control 1.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Tag-driven, not creation-time-driven.** The reaper does not
 *   need to remember when an instance was provisioned. Each
 *   instance carries its own deadline as a vendor tag set at
 *   provision time. Backends populate `CloudInstanceHandle.tags`
 *   in their `listInstances` response so the reaper stays
 *   vendor-agnostic.
 * - **Absent tag = "no TTL" = "do not reap".** Back-compat for
 *   instances provisioned before sub-task 5. Operators that want
 *   forced reaping of legacy instances re-tag them out-of-band.
 * - **Malformed tag = skip with warning, never mass-terminate.**
 *   A corrupted "signalman-ttl-expires-at" value (non-numeric,
 *   negative, NaN) is treated like absent: skipped + logged.
 *   This is the explicit guardrail against a single bad tag
 *   causing a sweep-mass-terminate.
 * - **Idempotent terminate is the backend's contract.** The
 *   reaper does not try to dedupe across concurrent sweeps;
 *   the backend's `terminateInstance` is required to be
 *   idempotent (see `CloudBackend.terminateInstance` doc).
 * - **runOnce is the unit of work.** `start()` and `stop()` wire
 *   an interval but every operationally-interesting boundary is
 *   `runOnce`: it is what the MCP tool calls, what the CLI verb
 *   calls, and what tests assert against. The interval scheduler
 *   is a thin wrapper around it.
 * - **No persisted state.** Last-run-result is in-process only.
 *   Operators who need durable audit trail wire the result into
 *   the audit log (see `runOnce` return shape). Sub-task 6/7 may
 *   land a persisted reaper-event table; out of scope here.
 *
 * # Default cadence
 *
 * Every 5 minutes per design §13.5. Configurable via
 * `intervalMs` for tests + operators that want a different
 * cadence (cron-driven invocations skip the scheduler entirely
 * and call `runOnce` directly).
 */

import {
  type CloudBackend,
  type CloudBackendKind,
  type CloudInstanceHandle,
  SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────

/** Default reaper poll cadence per design §13.5. */
export const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000;

// ── Result shape ──────────────────────────────────────────────────

/**
 * Per-backend outcome of a single `runOnce` sweep.
 *
 * Stable shape — the MCP tool envelope exposes this verbatim, so
 * skill docs + agent automations depend on the field names.
 */
export interface ReaperBackendResult {
  /** Backend kind that was swept. */
  backend: CloudBackendKind;
  /** Instances inspected (i.e. returned by `listInstances`). */
  inspected: number;
  /** Instances whose TTL tag was malformed (skipped, not terminated). */
  malformed: number;
  /** Instances whose TTL tag was absent (skipped, not terminated). */
  noTtl: number;
  /** Instances past TTL that were terminated this sweep. */
  terminated: number;
  /**
   * If `listInstances` itself failed, the backend is recorded
   * here with the error message; the sweep proceeds to other
   * backends rather than aborting the whole cycle.
   */
  listError?: string;
  /**
   * Instances we attempted to terminate but the terminate call
   * threw. Reported per-instance so operators can investigate
   * vendor-side issues without re-listing.
   */
  terminateErrors: Array<{ id: string; message: string }>;
}

/** Aggregate result of a single `runOnce` sweep across all backends. */
export interface ReaperRunResult {
  /** ISO timestamp when this sweep started. */
  startedAt: string;
  /** ISO timestamp when this sweep finished. */
  finishedAt: string;
  /** Per-backend results in registration order. */
  backends: ReaperBackendResult[];
  /** Sum of `terminated` across backends — quick operator glance. */
  totalTerminated: number;
}

// ── Constructor options ──────────────────────────────────────────

export interface CloudReaperOptions {
  /**
   * Callback that returns the live backend list each sweep.
   * Wrapped as a function (not a static array) so backends
   * registered later are picked up automatically.
   */
  getBackends: () => CloudBackend[];
  /** Poll cadence. Defaults to {@link DEFAULT_REAPER_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable clock (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Optional logger for sweep events. Defaults to a no-op so the
   * MCP server doesn't spam stderr when reaper events are
   * uninteresting (every 5 minutes most sweeps reap nothing).
   */
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

// ── Reaper class ─────────────────────────────────────────────────

/**
 * The reaper. Construct one per host process; the MCP server
 * holds a module-level singleton (see `getReaper` below).
 */
export class CloudReaper {
  private readonly getBackends: () => CloudBackend[];
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly logger: NonNullable<CloudReaperOptions["logger"]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: ReaperRunResult | null = null;
  private inFlight: Promise<ReaperRunResult> | null = null;

  constructor(opts: CloudReaperOptions) {
    this.getBackends = opts.getBackends;
    this.intervalMs = opts.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? {
      info: () => {},
      error: () => {},
    };
  }

  /**
   * Run a single sweep. Concurrent calls share the in-flight
   * promise (so an MCP tool call while a scheduled sweep is
   * already running doesn't fire a second one).
   */
  async runOnce(): Promise<ReaperRunResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnceInner().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnceInner(): Promise<ReaperRunResult> {
    const startedAt = this.now().toISOString();
    const nowEpochSec = Math.floor(this.now().getTime() / 1000);
    const backends = this.getBackends();
    const results: ReaperBackendResult[] = [];

    for (const backend of backends) {
      const result: ReaperBackendResult = {
        backend: backend.name,
        inspected: 0,
        malformed: 0,
        noTtl: 0,
        terminated: 0,
        terminateErrors: [],
      };
      let handles: CloudInstanceHandle[];
      try {
        handles = await backend.listInstances();
      } catch (err) {
        result.listError = (err as Error)?.message ?? String(err);
        this.logger.error("reaper list failed", {
          backend: backend.name,
          error: result.listError,
        });
        results.push(result);
        continue;
      }
      result.inspected = handles.length;

      for (const handle of handles) {
        const tagValue = handle.tags?.[SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY];
        if (tagValue === undefined) {
          result.noTtl += 1;
          continue;
        }
        const expiresAt = Number(tagValue);
        if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
          result.malformed += 1;
          this.logger.error("reaper malformed ttl tag", {
            backend: backend.name,
            id: handle.id,
            tagValue,
          });
          continue;
        }
        if (expiresAt > nowEpochSec) {
          // Still alive. Not counted in malformed/noTtl/terminated;
          // operator-visible "alive" count is `inspected - others`.
          continue;
        }
        // Past TTL — terminate.
        try {
          await backend.terminateInstance(handle);
          result.terminated += 1;
          this.logger.info("reaper terminated past-ttl instance", {
            backend: backend.name,
            id: handle.id,
            name: handle.name,
            expiresAt,
            nowEpochSec,
          });
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          result.terminateErrors.push({ id: handle.id, message: msg });
          this.logger.error("reaper terminate failed", {
            backend: backend.name,
            id: handle.id,
            error: msg,
          });
        }
      }
      results.push(result);
    }

    const finishedAt = this.now().toISOString();
    const totalTerminated = results.reduce((s, r) => s + r.terminated, 0);
    const aggregate: ReaperRunResult = {
      startedAt,
      finishedAt,
      backends: results,
      totalTerminated,
    };
    this.lastResult = aggregate;
    return aggregate;
  }

  /**
   * Start the periodic sweep. Idempotent — calling twice is
   * a no-op so MCP server startup paths can call it
   * unconditionally.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        this.logger.error("reaper scheduled run failed", {
          error: (err as Error)?.message ?? String(err),
        });
      });
    }, this.intervalMs);
    // `unref` so the interval doesn't keep the process alive in
    // a one-shot context (CLI invocations). MCP server's stdio
    // loop holds the process open separately.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the periodic sweep. Idempotent. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Return the result of the most recent `runOnce`, or null if
   * the reaper has not yet swept in this process. The MCP
   * `signalman_reaper_status` tool surfaces this verbatim.
   */
  getLastResult(): ReaperRunResult | null {
    return this.lastResult;
  }

  /** True iff the periodic scheduler is currently active. */
  isRunning(): boolean {
    return this.timer !== null;
  }
}

// ── Module-level singleton (for MCP server use) ──────────────────

let singleton: CloudReaper | null = null;

/**
 * Get or lazily construct the process-wide reaper singleton.
 *
 * `factory` is invoked exactly once on first call. Subsequent
 * calls return the cached instance; the factory argument is
 * ignored. Tests use {@link resetReaperSingletonForTests} to
 * wipe the cache between cases.
 */
export function getOrCreateReaper(factory: () => CloudReaper): CloudReaper {
  if (singleton) return singleton;
  singleton = factory();
  return singleton;
}

/**
 * Wipe the singleton (tests only — production code uses
 * `getOrCreateReaper`).
 */
export function resetReaperSingletonForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
