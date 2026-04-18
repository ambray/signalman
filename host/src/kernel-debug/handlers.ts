/**
 * Scenario tool-block handlers for driver operations.
 *
 * These are pure functions of a {@link DriverHandlerContext} and a
 * parameters object — no hidden state, no orchestrator coupling. The
 * orchestrator's `executeToolBlock` dispatch calls into these handlers
 * after resolving the VM's guest client.
 *
 * Split into its own module (rather than inlined in orchestrator.ts)
 * for three reasons:
 *
 * 1. **Testability.** A fake `GuestClient` is ~30 lines; constructing a
 *    whole orchestrator with backend + docker + kd plumbing to test
 *    one handler is wasteful. Handlers-as-functions lets each test
 *    inject exactly what it needs.
 *
 * 2. **Dispatch flatness.** Sprint 60.7.5 adds multiple driver-related
 *    tool types; Sprint 60.8 will add more (WFP/registry-specific
 *    tools). Letting `orchestrator.ts` grow with every new case makes
 *    it unreadable. Handlers go here; orchestrator dispatches.
 *
 * 3. **Coverage.** The handler functions are pure enough to hit 100 %
 *    line coverage without spawning anything. The orchestrator's
 *    dispatch clauses are one-liners that can be smoke-tested.
 *
 * Handlers intentionally take a minimal context (`guestClient` +
 * `vmName`). Handlers that need a `KdSession` (`kernel_break_on`,
 * `kernel_expect_bugcheck`) are deferred to Phase 1e of this sprint,
 * where they pair naturally with the break-event capture flow.
 */

import type { GuestAgentClient } from "../guest/client.js";
import type { BreakLog, BreakLogEntry } from "./break-log.js";
import type { KdSession } from "./kd-session.js";

/**
 * Minimal dependencies a driver handler needs. Constructed per
 * tool-block invocation by the orchestrator; handlers don't cache it.
 */
export interface DriverHandlerContext {
  readonly guestClient: GuestAgentClient;
  readonly vmName: string;
}

/**
 * Dependencies a kernel-debug handler needs. Separate from
 * {@link DriverHandlerContext} because kernel handlers rely on the
 * live `KdSession` and its break log — user-mode handlers don't.
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

// ── driver_load ────────────────────────────────────────────────────

export interface DriverLoadParams {
  /** Service short name (as registered with `sc.exe create`). */
  service: string;
  /**
   * Expected exit code from `sc.exe start <service>`. Default `0`
   * (success). Set to `1056` for "service already running" scenarios,
   * or omit the check entirely by passing `undefined`.
   */
  expect_status?: number;
  /** Service-start timeout. Default 10 s. */
  timeout_ms?: number;
}

export interface DriverLoadResult {
  /** Exit code from `sc.exe start`. */
  status: number;
  /**
   * Human-readable service state after start: "Running", "Stopped",
   * "Start pending", etc. Parsed from `sc.exe query` output; falls
   * back to "Unknown" if parsing fails.
   */
  service_state: string;
  /** Raw stdout from `sc.exe start` (useful for failure diagnostics). */
  stdout: string;
  /** Raw stderr from `sc.exe start`. */
  stderr: string;
}

/**
 * Load a driver by starting its registered Windows service.
 *
 * Two-step: `sc.exe start <service>` then `sc.exe query <service>`
 * to report the live state. The expected-status check fires on the
 * `start` exit code, not the query — the query is strictly informational.
 *
 * Rationale for querying after start: `sc.exe start` returns `0` once
 * the service controller has accepted the start request, not once the
 * driver has finished initializing. A driver that loads but fails
 * `DriverEntry` will see `sc.exe start` succeed and then show "Stopped"
 * a moment later. Capturing the post-start state in the result lets
 * the scenario assertion catch that.
 */
export async function handleDriverLoad(
  ctx: DriverHandlerContext,
  params: DriverLoadParams,
): Promise<DriverLoadResult> {
  const timeoutMs = params.timeout_ms ?? 10_000;
  const expected = params.expect_status;

  const start = await ctx.guestClient.runCommand(
    "sc.exe",
    ["start", params.service],
    { timeoutMs },
  );

  if (expected !== undefined && start.exitCode !== expected) {
    throw new Error(
      `driver_load: sc.exe start ${params.service} exited ${start.exitCode}, expected ${expected}. ` +
        `stderr: ${start.stderr.slice(0, 200)}`,
    );
  }

  const query = await ctx.guestClient.runCommand(
    "sc.exe",
    ["query", params.service],
    { timeoutMs },
  );

  return {
    status: start.exitCode,
    service_state: parseScQueryState(query.stdout),
    stdout: start.stdout,
    stderr: start.stderr,
  };
}

// ── driver_unload ──────────────────────────────────────────────────

export interface DriverUnloadParams {
  service: string;
  /**
   * Expected exit code from `sc.exe stop <service>`. Default `0`. Note
   * that `1062` is returned when the service is already stopped — set
   * `expect_status: 1062` for scenarios that tolerate double-unload.
   */
  expect_status?: number;
  timeout_ms?: number;
}

export interface DriverUnloadResult {
  status: number;
  service_state: string;
  stdout: string;
  stderr: string;
}

/**
 * Unload a driver by stopping its service. Symmetric with
 * {@link handleDriverLoad}: stop, then query to confirm the state.
 */
export async function handleDriverUnload(
  ctx: DriverHandlerContext,
  params: DriverUnloadParams,
): Promise<DriverUnloadResult> {
  const timeoutMs = params.timeout_ms ?? 10_000;
  const expected = params.expect_status;

  const stop = await ctx.guestClient.runCommand(
    "sc.exe",
    ["stop", params.service],
    { timeoutMs },
  );

  if (expected !== undefined && stop.exitCode !== expected) {
    throw new Error(
      `driver_unload: sc.exe stop ${params.service} exited ${stop.exitCode}, expected ${expected}. ` +
        `stderr: ${stop.stderr.slice(0, 200)}`,
    );
  }

  const query = await ctx.guestClient.runCommand(
    "sc.exe",
    ["query", params.service],
    { timeoutMs },
  );

  return {
    status: stop.exitCode,
    service_state: parseScQueryState(query.stdout),
    stdout: stop.stdout,
    stderr: stop.stderr,
  };
}

// ── driver_ioctl ───────────────────────────────────────────────────

export interface DriverIoctlParams {
  /** Device path to open, e.g. "\\\\.\\ospiri". */
  device: string;
  /** IOCTL control code as a number. Generator emits these as named consts. */
  control_code: number;
  /**
   * Input buffer as a hex string. Whitespace is permitted (e.g.
   * "01 00 00 00 DE AD BE EF"). Mutually exclusive with `input_file`.
   */
  input_hex?: string;
  /** Alternative: path to a file on the guest whose bytes become input. */
  input_file?: string;
  /**
   * Expected NTSTATUS. Accepts both symbolic names ("STATUS_SUCCESS")
   * and numeric strings ("0x00000000"). The harness reports the
   * NTSTATUS symbolically when it can resolve one.
   */
  expect_status?: string;
  /** Expected output hex. Must match exactly if set. */
  expect_output_hex?: string;
  /** Minimum output size in bytes. */
  expect_output_size_min?: number;
  timeout_ms?: number;
  /**
   * Path to `silo-test-harness.exe` on the guest. Defaults to the
   * Ospiri install location; overridable for dev scenarios that keep
   * the harness elsewhere.
   */
  harness_path?: string;
}

export interface DriverIoctlResult {
  /**
   * NTSTATUS as the harness reported it. Either a symbolic name or
   * `0x<hex>` — the scenario assertion should match against whichever
   * form was used in `expect_status`.
   */
  status: string;
  /** Output buffer as a hex string (uppercase, space-separated bytes). */
  output_hex: string;
  /** Output size in bytes. */
  output_size: number;
  /** Whether the full assertion set (status + hex + size) passed inside the harness. */
  match: boolean;
  /** Harness exit code: 0 success, 1 mismatch, 2 syscall error. */
  exit_code: number;
}

/**
 * Send an IOCTL via the guest-side `silo-test-harness.exe`.
 *
 * The harness is a Rust user-mode binary (drv/test-harness/ — Phase 1d
 * of this sprint); this handler only knows its CLI surface and JSON
 * output contract. That separation keeps this handler stable across
 * harness rewrites.
 *
 * Even if the harness isn't deployed yet, this handler is testable —
 * the mock guest client can return a canned `{stdout: "...json..."}`
 * and the handler's parsing + result-shaping logic is exercised end
 * to end.
 */
export async function handleDriverIoctl(
  ctx: DriverHandlerContext,
  params: DriverIoctlParams,
): Promise<DriverIoctlResult> {
  if (params.input_hex && params.input_file) {
    throw new Error(
      "driver_ioctl: specify at most one of input_hex / input_file",
    );
  }

  const harness = params.harness_path ?? "C:\\Ospiri\\silo-test-harness.exe";
  const timeoutMs = params.timeout_ms ?? 5_000;

  const args: string[] = [
    "--device",
    params.device,
    "--ioctl",
    `0x${params.control_code.toString(16)}`,
  ];
  if (params.input_hex) {
    args.push("--input-hex", params.input_hex);
  }
  if (params.input_file) {
    args.push("--input-file", params.input_file);
  }
  if (params.expect_status !== undefined) {
    args.push("--expect-status", params.expect_status);
  }
  if (params.expect_output_hex !== undefined) {
    args.push("--expect-output-hex", params.expect_output_hex);
  }
  if (params.expect_output_size_min !== undefined) {
    args.push(
      "--expect-output-size-min",
      params.expect_output_size_min.toString(),
    );
  }
  args.push("--json-output");

  const result = await ctx.guestClient.runCommand(harness, args, {
    timeoutMs,
  });

  // The harness emits a single JSON object on stdout. Exit codes:
  // 0 = success (all expects matched), 1 = expect mismatch,
  // 2 = syscall error (device open failed, ioctl returned error,
  // etc.). On any non-zero exit, stdout still contains the JSON so
  // callers can see what the harness observed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(
      `driver_ioctl: harness emitted non-JSON output (exit=${result.exitCode}). ` +
        `stdout: ${result.stdout.slice(0, 200)}. stderr: ${result.stderr.slice(0, 200)}. ` +
        `parse error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return normalizeIoctlResult(parsed, result.exitCode);
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the `STATE` value from `sc.exe query <service>` output.
 *
 * Example output:
 *
 *     SERVICE_NAME: ospiri
 *             TYPE               : 1  KERNEL_DRIVER
 *             STATE              : 4  RUNNING
 *             WIN32_EXIT_CODE    : 0  (0x0)
 *             ...
 *
 * Returns the symbolic state name in title case ("Running", "Stopped",
 * "Start Pending", etc.) or "Unknown" if no STATE line is present.
 */
export function parseScQueryState(scOutput: string): string {
  // Match lines like `        STATE              : 4  RUNNING`. The
  // symbolic name is the last whitespace-separated token.
  const match = /STATE\s*:\s*\d+\s+(\S+(?:\s+\S+)*?)\s*$/m.exec(scOutput);
  if (!match) return "Unknown";
  return titleCaseServiceState(match[1]);
}

/**
 * Convert a service-state token ("RUNNING", "START_PENDING",
 * "STOP_PENDING") to title case with spaces ("Running", "Start
 * Pending", "Stop Pending").
 */
function titleCaseServiceState(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .split(/[\s_]+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Validate and normalize a parsed IOCTL JSON payload into a stable
 * shape the orchestrator can hand to assertions.
 */
function normalizeIoctlResult(
  raw: unknown,
  exitCode: number,
): DriverIoctlResult {
  if (raw === null || typeof raw !== "object") {
    throw new Error(
      `driver_ioctl: harness JSON must be an object, got ${typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const status =
    typeof obj.status === "string"
      ? obj.status
      : typeof obj.status === "number"
        ? `0x${obj.status.toString(16)}`
        : "UNKNOWN";

  const output_hex = typeof obj.output_hex === "string" ? obj.output_hex : "";
  const output_size =
    typeof obj.output_size === "number" && Number.isFinite(obj.output_size)
      ? obj.output_size
      : 0;

  // `match` defaults to `exitCode === 0` if the harness didn't set it
  // explicitly. That way callers can rely on `match` alone even for
  // older harness builds.
  const match =
    typeof obj.match === "boolean" ? obj.match : exitCode === 0;

  return {
    status,
    output_hex,
    output_size,
    match,
    exit_code: exitCode,
  };
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
