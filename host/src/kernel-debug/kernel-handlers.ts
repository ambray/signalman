/**
 * Kernel-debugger tool-block handlers.
 *
 * Handlers for `kernel_expect_bugcheck` and `kernel_break_on` — every
 * operation in here talks to the live `KdSession` and/or inspects the
 * `BreakLog` that tracks its events. No guest-agent calls; user-mode
 * driver operations live in `./driver-handlers.ts`.
 *
 * See module docstring on `./handlers.ts` (or the Phase 1 audit notes)
 * for the rationale behind splitting driver-handlers and
 * kernel-handlers apart: the dependency shapes differ
 * (`GuestAgentClient` vs `KdSession + BreakLog`) and one file per
 * ~300 LoC of handler code keeps each one comprehensible.
 */

import type { BreakLog, BreakLogEntry } from "./break-log.js";
import type { KdSession } from "./kd-session.js";

/**
 * Dependencies a kernel-debug handler needs. Separate from
 * {@link import("./driver-handlers.js").DriverHandlerContext} because
 * kernel handlers rely on the live `KdSession` and its break log —
 * user-mode handlers don't.
 *
 * The orchestrator constructs one of these per scenario VM when
 * `kernel_debug.enabled: true` is set in setup.yaml. Scenarios that
 * omit that config (the legacy path) never create kernel handlers,
 * so the context never needs null checks at the handler level.
 */
export interface KernelHandlerContext {
  readonly kdSession: KdSession;
  readonly breakLog: BreakLog;
  readonly vmName: string;
}

// ── kernel_expect_bugcheck ────────────────────────────────────────

export interface KernelExpectBugcheckParams {
  /**
   * Expected bugcheck code. Accepts `0xd1` / `"0xD1"` /
   * `"D1"` / `"0x000000d1"` — all normalize to the same value.
   */
  bugcheck_code: string;
  /**
   * Optional time window (milliseconds). The handler looks back this
   * far from `Date.now()`; a break older than that doesn't satisfy
   * the expectation. Default: search the entire log.
   */
  within_ms?: number;
  /**
   * When true, also run `!analyze -v` and `~*kn` against the session
   * at match time and include the output in the result. Defaults to
   * true for bugcheck matches — the whole point of catching a
   * bugcheck is to triage it.
   */
  capture_stack?: boolean;
  /**
   * When true, run `.dump /f <path>` to save a kernel dump at the
   * break. Path is passed verbatim to kd. Optional.
   */
  dump_path?: string;
  /** Per-command timeout for the capture + dump steps. Default 120s. */
  capture_timeout_ms?: number;
}

export interface KernelExpectBugcheckResult {
  /** True iff a matching bugcheck was found in the configured window. */
  matched: boolean;
  /** Bugcheck code of the matched entry, normalized `0x<hex>`. */
  bugcheck_code?: string;
  /** Epoch ms at which the match was recorded. */
  timestamp?: number;
  /** `kn` output captured at match time when `capture_stack` is true. */
  stack?: string;
  /** `~*kn` (all-thread stacks) when `capture_stack` is true. */
  all_stacks?: string;
  /** `!analyze -v` output when `capture_stack` is true. */
  analyze_v?: string;
  /** Where the kernel dump was saved, if `dump_path` was specified. */
  dump_saved_to?: string;
  /** Human-readable failure reason when `matched: false`. */
  message?: string;
}

/**
 * Assert that a bugcheck with the specified code happened during
 * the scenario.
 *
 * Reads the break log (populated asynchronously by {@link BreakLog}
 * from the session's `break` events). If a matching entry exists,
 * optionally captures stack / analyze / dump state at the current
 * debugger break-in. Does NOT resume the target — callers chain a
 * separate `resume` via their own tool if they want the scenario to
 * continue past the bugcheck (usually it shouldn't — a second
 * bugcheck from the same driver means the test is wandering).
 */
export async function handleKernelExpectBugcheck(
  ctx: KernelHandlerContext,
  params: KernelExpectBugcheckParams,
): Promise<KernelExpectBugcheckResult> {
  const sinceMs =
    params.within_ms !== undefined
      ? Date.now() - params.within_ms
      : undefined;

  const matches = ctx.breakLog.find({
    reason: "bugcheck",
    bugcheckCode: params.bugcheck_code,
    sinceMs,
  });

  if (matches.length === 0) {
    const recent = ctx.breakLog.find({ sinceMs });
    return {
      matched: false,
      message:
        recent.length === 0
          ? `No break events recorded${sinceMs !== undefined ? " in window" : ""}`
          : `No bugcheck with code ${params.bugcheck_code}; saw ${recent.length} other break event(s): ${summarizeBreaks(recent)}`,
    };
  }

  const hit = matches[0];
  const result: KernelExpectBugcheckResult = {
    matched: true,
    bugcheck_code: hit.bugcheckCode,
    timestamp: hit.timestamp,
  };

  const captureStack = params.capture_stack ?? true;
  const captureTimeoutMs = params.capture_timeout_ms ?? 120_000;

  if (captureStack) {
    // Capture best-effort — don't let a capture failure negate the
    // fact that we detected the bugcheck. Attach any captures we
    // got, note failures in `message`.
    const failures: string[] = [];
    try {
      result.stack = await ctx.kdSession.captureStack(captureTimeoutMs);
    } catch (e) {
      failures.push(`captureStack: ${errMsg(e)}`);
    }
    try {
      result.all_stacks = await ctx.kdSession.captureAllStacks(
        captureTimeoutMs,
      );
    } catch (e) {
      failures.push(`captureAllStacks: ${errMsg(e)}`);
    }
    try {
      result.analyze_v = await ctx.kdSession.captureAnalyze(captureTimeoutMs);
    } catch (e) {
      failures.push(`captureAnalyze: ${errMsg(e)}`);
    }
    if (failures.length > 0) {
      result.message = `Bugcheck matched but ${failures.length} capture step(s) failed: ${failures.join("; ")}`;
    }
  }

  if (params.dump_path) {
    try {
      await ctx.kdSession.saveDump(params.dump_path, captureTimeoutMs);
      result.dump_saved_to = params.dump_path;
    } catch (e) {
      const msg = `saveDump(${params.dump_path}): ${errMsg(e)}`;
      result.message = result.message ? `${result.message}; ${msg}` : msg;
    }
  }

  return result;
}

// ── kernel_break_on ───────────────────────────────────────────────

export interface KernelBreakOnParams {
  /**
   * Symbol or address to break on. Passed verbatim to kd as
   * `bp <symbol>`. Example: `"ospiri!HandleIoctl"`,
   * `"0xfffff807'abcdef00"`.
   */
  symbol: string;
  /**
   * Command to run once the breakpoint fires. Default `"kn"` —
   * captures the top stack frame. Multi-statement `"kn; r; !thread"`
   * also works.
   */
  capture?: string;
  /**
   * Total time in milliseconds to wait for the break after the
   * breakpoint is installed. If exceeded, the handler returns
   * `matched: false`. Default 30s.
   */
  timeout_ms?: number;
  /**
   * When true (default), `g` is sent after capture so the VM keeps
   * running. When false, the scenario is left with the debugger
   * broken-in — usually only useful for kernel_expect_bugcheck
   * follow-ups.
   */
  resume_after?: boolean;
}

export interface KernelBreakOnResult {
  /** True iff the breakpoint fired before the timeout. */
  matched: boolean;
  /** kd capture output from `capture` command. */
  capture_output?: string;
  /** Timestamp when the break event was observed. */
  timestamp?: number;
  /** Reason why matched is false — "timeout" or a kd error. */
  message?: string;
}

/**
 * Install a kd breakpoint, resume the target, wait for the break,
 * capture state, optionally resume. Intended for observability
 * scenarios ("prove this function got called") and lightweight
 * tracing rather than full-session debugging.
 *
 * Contract:
 *
 * 1. `bp <symbol>` is sent. If kd can't resolve the symbol, we still
 *    succeed in this step — kd prints a warning but installs the
 *    pending breakpoint. The subsequent wait times out if the symbol
 *    never loads.
 *
 * 2. If the session state is already `broken`, we send `g` to resume
 *    first. Otherwise the VM would never hit the new breakpoint.
 *
 * 3. On break, `capture` runs via `session.run()`. We grab the output.
 *
 * 4. If `resume_after`, `g` is sent and we return. Otherwise the
 *    session stays broken-in.
 *
 * One-shot: each call installs exactly one breakpoint for one hit.
 * The breakpoint is NOT automatically removed after the hit — that
 * would require `bc *` or similar, which might clobber unrelated
 * breakpoints set by earlier scenario steps. Scenarios that need to
 * un-set should do it explicitly.
 */
export async function handleKernelBreakOn(
  ctx: KernelHandlerContext,
  params: KernelBreakOnParams,
): Promise<KernelBreakOnResult> {
  const capture = params.capture ?? "kn";
  const timeoutMs = params.timeout_ms ?? 30_000;
  const resumeAfter = params.resume_after ?? true;

  const sinceMs = Date.now();

  // Install the breakpoint. bp always returns quickly; failure here
  // usually means kd's breakpoint address resolver is confused.
  try {
    await ctx.kdSession.run(`bp ${params.symbol}`, 10_000);
  } catch (e) {
    return {
      matched: false,
      message: `Failed to install breakpoint on ${params.symbol}: ${errMsg(e)}`,
    };
  }

  // If the session is currently broken, resume so the VM can hit
  // the new breakpoint.
  if (ctx.kdSession.state === "broken") {
    try {
      ctx.kdSession.resume();
    } catch (e) {
      return {
        matched: false,
        message: `Failed to resume session before breakpoint wait: ${errMsg(e)}`,
      };
    }
  }

  // Wait for the next break-instruction event with timestamp >= sinceMs.
  // (Bugcheck breaks count too — they'd be "the VM died while we were
  // waiting" which is a legitimate result to surface.)
  const brk = await waitForNextBreak(ctx, sinceMs, timeoutMs);
  if (!brk) {
    return {
      matched: false,
      message: `Timed out after ${timeoutMs}ms waiting for break on ${params.symbol}`,
    };
  }

  // Capture — session is broken-in now, so kd will execute the
  // commands immediately.
  let captureOutput: string;
  try {
    captureOutput = await ctx.kdSession.run(capture, timeoutMs);
  } catch (e) {
    return {
      matched: true,
      timestamp: brk.timestamp,
      message: `Break observed but capture failed: ${errMsg(e)}`,
    };
  }

  if (resumeAfter) {
    try {
      ctx.kdSession.resume();
    } catch {
      // Session may have disconnected; not worth failing the whole
      // result over. Caller can inspect session.state later.
    }
  }

  return {
    matched: true,
    capture_output: captureOutput,
    timestamp: brk.timestamp,
  };
}

// ── Internal helpers ──────────────────────────────────────────────

/**
 * Wait until the next break event is recorded in the log (with
 * timestamp >= `sinceMs`) or the timeout elapses. Polls the log at
 * 100 ms intervals — fine-grained enough for kd event rates, coarse
 * enough to not hammer the runtime.
 *
 * Polling rather than subscribing because `BreakLog` already
 * aggregates events from the session; subscribing here would
 * duplicate the wiring.
 */
async function waitForNextBreak(
  ctx: KernelHandlerContext,
  sinceMs: number,
  timeoutMs: number,
): Promise<BreakLogEntry | undefined> {
  const deadline = sinceMs + timeoutMs;
  while (Date.now() < deadline) {
    const next = ctx.breakLog.find({ sinceMs }).find(() => true);
    if (next) return next;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

function summarizeBreaks(entries: BreakLogEntry[]): string {
  const limit = 5;
  const formatted = entries
    .slice(0, limit)
    .map((e) => {
      if (e.reason === "bugcheck" && e.bugcheckCode) {
        return `bugcheck ${e.bugcheckCode}`;
      }
      return e.reason;
    })
    .join(", ");
  return entries.length > limit
    ? `${formatted}, ... (${entries.length - limit} more)`
    : formatted;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
