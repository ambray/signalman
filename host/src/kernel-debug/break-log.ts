/**
 * Break-event log — a queryable history of `KdSession` break events
 * for post-hoc assertions.
 *
 * ## Motivation
 *
 * The `kernel_expect_bugcheck` scenario tool block asserts that a
 * bugcheck happened with a specific code. kd's break events are
 * asynchronous — they arrive whenever the VM breaks in, not
 * synchronously with the workflow step that caused them. The step
 * that triggered the bugcheck (e.g. `driver_ioctl` that hit a bad
 * code path) may have completed and returned long before kd emits
 * the `break` event for the corresponding fault.
 *
 * A single time-ordered log lets assertions ask "was there a
 * bugcheck with code 0x139 since step-N started?" without needing
 * to synchronize around the kd event stream.
 *
 * ## Scope
 *
 * The log is deliberately minimal:
 *
 * - In-memory only; the scenario orchestrator owns the instance and
 *   drops it at teardown. Persistence across scenarios is not a goal.
 * - One log per `KdSession`. A multi-VM scenario has multiple logs,
 *   keyed by VM name in the orchestrator.
 * - Wall-clock timestamps via `Date.now()`. Good enough for
 *   "did it happen since this step started?" queries; not intended
 *   for latency measurement.
 *
 * ## Lifecycle
 *
 * ```text
 *   const session = new KdSession(...);
 *   const log = new BreakLog(session);  // subscribes to 'break'
 *   await session.start();
 *   // ... scenario runs, breaks accumulate ...
 *   const entries = log.since(stepStartMs);
 *   log.detach();  // unsubscribe; optional but polite
 * ```
 *
 * `BreakLog` does NOT own the session — it only wires listeners.
 * Callers keep ownership of the session and detach it separately.
 */

import type { KdSession, KdSessionEvent } from "./kd-session.js";

/**
 * A single recorded break event. Fields mirror the `break` event
 * payload emitted by {@link KdSession}, plus an ingestion timestamp.
 */
export interface BreakLogEntry {
  /** `Date.now()` at which the event was recorded. */
  readonly timestamp: number;
  /** Break reason as reported by the parser. */
  readonly reason: "bugcheck" | "break-instruction" | "module-load" | "manual";
  /** Lowercase `0x`-prefixed bugcheck code when `reason === "bugcheck"`. */
  readonly bugcheckCode?: string;
  /** Raw break-line detail when available (primarily for
   *  `break-instruction` / `manual` reasons). */
  readonly detail?: string;
}

/**
 * Query options for {@link BreakLog.find}.
 */
export interface BreakLogQuery {
  /** Ignore entries older than this epoch millisecond. */
  sinceMs?: number;
  /** Restrict to entries with this reason. */
  reason?: BreakLogEntry["reason"];
  /**
   * Match entries whose bugcheck code equals the given value.
   * Comparison is case-insensitive and tolerant of `0x`-prefix
   * differences (`0xd1` matches `0xD1` and `0x000000d1`).
   */
  bugcheckCode?: string;
}

/**
 * Normalize a bugcheck code for comparison — strips `0x` prefix,
 * drops leading zeros (keeping at least one digit), lowercases.
 * Duplicates `parser.normalizeBugcheckCode`'s logic because bringing
 * it in would create a trivial dependency loop in the barrel.
 */
function normalize(code: string): string {
  let c = code.trim().toLowerCase();
  if (c.startsWith("0x")) c = c.slice(2);
  c = c.replace(/^0+/, "") || "0";
  return `0x${c}`;
}

export class BreakLog {
  private readonly entries: BreakLogEntry[] = [];
  private readonly listener: (
    ev: Extract<KdSessionEvent, { type: "break" }>,
  ) => void;
  private attached = true;

  constructor(private readonly session: KdSession) {
    this.listener = (ev) => {
      this.entries.push({
        timestamp: Date.now(),
        reason: ev.reason,
        bugcheckCode: ev.bugcheckCode,
        detail: ev.detail,
      });
    };
    this.session.on("break", this.listener);
  }

  /**
   * Unsubscribe from the session. Safe to call multiple times.
   * After detach, existing entries remain queryable; no new entries
   * are recorded. Called from the orchestrator at scenario teardown.
   */
  detach(): void {
    if (!this.attached) return;
    this.session.off("break", this.listener as (...args: unknown[]) => void);
    this.attached = false;
  }

  /** Snapshot of every recorded entry in insertion order. */
  all(): BreakLogEntry[] {
    return this.entries.slice();
  }

  /** Count of entries currently in the log. */
  get size(): number {
    return this.entries.length;
  }

  /** Most recent entry, or `undefined` when the log is empty. */
  latest(): BreakLogEntry | undefined {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1]
      : undefined;
  }

  /**
   * All entries with `timestamp >= sinceMs`. Empty array if none.
   * Does not mutate the log.
   */
  since(sinceMs: number): BreakLogEntry[] {
    return this.entries.filter((e) => e.timestamp >= sinceMs);
  }

  /**
   * Find entries matching the given query. All fields are optional;
   * omitted fields match everything. Returns entries in insertion
   * order (matching `all()`).
   */
  find(query: BreakLogQuery = {}): BreakLogEntry[] {
    const wantCode =
      query.bugcheckCode !== undefined ? normalize(query.bugcheckCode) : undefined;
    return this.entries.filter((e) => {
      if (query.sinceMs !== undefined && e.timestamp < query.sinceMs) {
        return false;
      }
      if (query.reason !== undefined && e.reason !== query.reason) {
        return false;
      }
      if (wantCode !== undefined) {
        if (e.bugcheckCode === undefined) return false;
        if (normalize(e.bugcheckCode) !== wantCode) return false;
      }
      return true;
    });
  }

  /**
   * Convenience: the first entry matching the query, or `undefined`.
   * Identical to `find(q)[0]`.
   */
  first(query: BreakLogQuery = {}): BreakLogEntry | undefined {
    return this.find(query)[0];
  }

  /** Drop all recorded entries. Listener remains attached. */
  clear(): void {
    this.entries.length = 0;
  }

  /** Attachment state. Primarily for assertions in tests. */
  get isAttached(): boolean {
    return this.attached;
  }
}
