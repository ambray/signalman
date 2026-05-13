/**
 * Copy-file progress wrapper (v0.3.0-2 / C8).
 *
 * Wraps a long-running `Copy-VMFile` PowerShell invocation in a
 * progress-callback surface so multi-GB host→guest transfers don't
 * appear hung to the operator. Closes ROADMAP item C8 ("streamed
 * `vm_copy_file` progress").
 *
 * # Locked design (do not re-litigate)
 *
 * - **Heartbeat-only, not true progress.** `Copy-VMFile` is a
 *   synchronous PowerShell cmdlet with no native progress hooks.
 *   Real byte-level progress requires guest-side cooperation (the
 *   service-backend path already supports this via the streaming
 *   `VmCopyFile` RPC). For the direct-PS path the best we can do is
 *   emit a "still working" event every N seconds. That's enough to
 *   close the "appears hung" UX issue without faking byte counts.
 * - **Sentinel `-1` for heartbeat events.** The callback signature
 *   is `(bytesTransferred, totalBytes) => void`. A heartbeat
 *   event sets `bytesTransferred = -1` so a consumer that wants to
 *   distinguish "real progress" from "still working" can branch on
 *   the sign. Consumers that just render the number will see "-1"
 *   which is mildly weird but not crash-y.
 * - **Heartbeat threshold of 100 MB.** Files under 100 MB copy fast
 *   enough that a heartbeat is noise. Threshold is on the source
 *   file size, sampled once at start.
 * - **Heartbeat interval 5s.** Short enough that the operator
 *   doesn't lose patience, long enough that we don't spam the
 *   event channel for the typical 1–2 minute copy.
 * - **Start + complete events always fire.** Independent of file
 *   size. Start carries `(0, totalBytes)`; complete carries
 *   `(totalBytes, totalBytes)`. Consumers can compute throughput
 *   from wall-clock between the two.
 *
 * # API shape rationale
 *
 * The function is parameterised over the actual copy operation
 * (`runCopy`) and the timer (`scheduleHeartbeat` / `clearHeartbeat`)
 * so tests don't need real PowerShell, real timers, or real file
 * I/O. Production callers wire `runCopy` to the existing `ps()`
 * helper in `hyperv.ts` and the timers to `setInterval` /
 * `clearInterval`.
 *
 * The `statSize` callback is similarly injected so tests can
 * declare the source-file size directly without writing fixtures.
 */

import * as fs from "node:fs";

// ── Public constants ──────────────────────────────────────────────

/** Files at or above this size get periodic heartbeat events. */
export const HEARTBEAT_SIZE_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Default heartbeat interval for files past the size threshold. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Sentinel value for `bytesTransferred` on heartbeat events.
 *
 * Consumers that want to distinguish "still working" from real
 * progress can branch on this. Consumers that don't know the
 * convention will render `-1` which is mildly weird but not crashy.
 */
export const HEARTBEAT_SENTINEL_BYTES = -1;

// ── Types ──────────────────────────────────────────────────────────

/** Subset of `ProgressCallback` we use; mirrors `hypervisors/interface.ts`. */
export type ProgressEvent = (bytesTransferred: number, totalBytes: number) => void;

/**
 * Inputs to {@link runCopyWithProgress}.
 *
 * `runCopy` is the actual transfer operation. The wrapper invokes it
 * exactly once and emits start / heartbeat / complete events around
 * it. If `runCopy` rejects, the wrapper cleans up the heartbeat
 * timer (no complete event fires) and re-throws.
 */
export interface RunCopyWithProgressOptions {
  /** Host-side absolute path to the source file. Must exist. */
  hostPath: string;
  /** The copy operation. Wrapper awaits it. */
  runCopy: () => Promise<void>;
  /** Optional progress callback. No-op when undefined. */
  progress?: ProgressEvent;
  /**
   * File-size sampler. Defaults to `fs.statSync(hostPath).size`.
   * Tests inject a constant.
   */
  statSize?: (path: string) => number;
  /**
   * Timer factory for heartbeats. Defaults to `setInterval`.
   * Tests inject a controllable timer.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /**
   * Timer canceler. Defaults to `clearInterval`. Tests pair it with
   * their injected `setInterval`.
   */
  clearInterval?: (handle: unknown) => void;
  /**
   * Override the heartbeat-size threshold. Defaults to
   * {@link HEARTBEAT_SIZE_THRESHOLD_BYTES}. Tests use a small value
   * to exercise the heartbeat path without huge fixtures.
   */
  heartbeatThresholdBytes?: number;
  /**
   * Override the heartbeat interval. Defaults to
   * {@link HEARTBEAT_INTERVAL_MS}.
   */
  heartbeatIntervalMs?: number;
}

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Structured error for copy-with-progress wrapper failures.
 *
 * Note that errors from `runCopy` itself are NOT wrapped — they
 * propagate unchanged so call sites that already handle PS errors
 * (`PowerShell command failed: ...`) don't need to update.
 */
export class CopyFileProgressError extends Error {
  constructor(
    public readonly code:
      | "non_absolute_path"
      | "source_missing",
    message: string,
  ) {
    super(message);
    this.name = "CopyFileProgressError";
  }
}

// ── Implementation ─────────────────────────────────────────────────

/**
 * Wrap a `Copy-VMFile`-shaped operation in progress events.
 *
 * Behaviour:
 *   1. Validates `hostPath` is absolute and exists.
 *   2. Samples source-file size once.
 *   3. Emits `progress(0, totalBytes)`.
 *   4. If total ≥ heartbeat threshold, starts a heartbeat timer that
 *      emits `progress(HEARTBEAT_SENTINEL_BYTES, totalBytes)` every
 *      `heartbeatIntervalMs`.
 *   5. Awaits `runCopy()`. On rejection: clears the timer, re-throws.
 *      No complete event fires on failure.
 *   6. On success: clears the timer, emits
 *      `progress(totalBytes, totalBytes)`.
 *
 * Heartbeat-callback errors are swallowed; we don't want a misbehaving
 * progress consumer to take down a multi-GB copy mid-flight.
 *
 * @throws {@link CopyFileProgressError} when `hostPath` is invalid.
 *         Other errors come from `runCopy` and propagate verbatim.
 */
export async function runCopyWithProgress(
  opts: RunCopyWithProgressOptions,
): Promise<void> {
  // ── Validate the host path before doing anything else ─────────

  if (!opts.hostPath || opts.hostPath.length === 0) {
    throw new CopyFileProgressError(
      "non_absolute_path",
      "hostPath must be a non-empty absolute path",
    );
  }

  // Use Node's path.isAbsolute via a lightweight check — we don't
  // want to import `path` just for one call.  On Windows
  // `C:\foo` and `\\server\share\foo` are absolute; on POSIX
  // `/foo` is. Quick test: starts with `/`, `\\`, or `<letter>:\`.
  const isAbs =
    opts.hostPath.startsWith("/") ||
    opts.hostPath.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(opts.hostPath);
  if (!isAbs) {
    throw new CopyFileProgressError(
      "non_absolute_path",
      `hostPath must be absolute, got: ${opts.hostPath}`,
    );
  }

  // ── Sample size ───────────────────────────────────────────────

  const statSize = opts.statSize ?? defaultStatSize;
  let totalBytes: number;
  try {
    totalBytes = statSize(opts.hostPath);
  } catch (err) {
    throw new CopyFileProgressError(
      "source_missing",
      `cannot stat source file '${opts.hostPath}': ` +
        ((err as Error).message ?? String(err)),
    );
  }

  const progress = opts.progress;
  const threshold = opts.heartbeatThresholdBytes ?? HEARTBEAT_SIZE_THRESHOLD_BYTES;
  const interval = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const setIntervalImpl = opts.setInterval ?? defaultSetInterval;
  const clearIntervalImpl = opts.clearInterval ?? defaultClearInterval;

  // ── Start event ───────────────────────────────────────────────

  safeInvoke(progress, 0, totalBytes);

  // ── Heartbeat timer (large files only) ────────────────────────

  let timerHandle: unknown = null;
  if (progress && totalBytes >= threshold) {
    timerHandle = setIntervalImpl(() => {
      safeInvoke(progress, HEARTBEAT_SENTINEL_BYTES, totalBytes);
    }, interval);
  }

  // ── Run the copy + clean up ──────────────────────────────────

  try {
    await opts.runCopy();
  } catch (err) {
    if (timerHandle !== null) {
      clearIntervalImpl(timerHandle);
    }
    // Re-throw verbatim; we don't wrap PS errors.
    throw err;
  }

  if (timerHandle !== null) {
    clearIntervalImpl(timerHandle);
  }

  // ── Complete event ────────────────────────────────────────────

  safeInvoke(progress, totalBytes, totalBytes);
}

// ── Defaults ───────────────────────────────────────────────────────

function defaultStatSize(p: string): number {
  return fs.statSync(p).size;
}

function defaultSetInterval(fn: () => void, ms: number): unknown {
  return setInterval(fn, ms);
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

/**
 * Invoke the progress callback if it's set, swallowing any error.
 *
 * Rationale: a buggy progress consumer must NOT take down a
 * multi-GB copy mid-flight. The contract is "best-effort event
 * emission". If the consumer throws, that's its problem.
 */
function safeInvoke(
  progress: ProgressEvent | undefined,
  bytes: number,
  total: number,
): void {
  if (!progress) return;
  try {
    progress(bytes, total);
  } catch {
    // Intentional swallow — see function doc.
  }
}
