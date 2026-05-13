/**
 * User-mode driver tool-block handlers.
 *
 * Handlers for `driver_load` / `driver_unload` / `driver_ioctl` —
 * every operation in here goes through the VM's guest agent
 * (`GuestAgentClient.runCommand`) to invoke `sc.exe` or the
 * `test-harness.exe` IOCTL runner. Nothing in this file opens a
 * kernel debugger; those paths live in `./kernel-handlers.ts`.
 *
 * See module docstring on `./handlers.ts` for why we split handlers
 * out of the orchestrator. Split further between driver-handlers and
 * kernel-handlers because the dependency shape differs
 * (`GuestAgentClient` vs `KdSession + BreakLog`) and one file per
 * ~300 LoC of handler code keeps each file comprehensible.
 */

import type { GuestAgentClient } from "../guest/client.js";

/**
 * Minimal dependencies a driver handler needs. Constructed per
 * tool-block invocation by the orchestrator; handlers don't cache it.
 */
export interface DriverHandlerContext {
  readonly guestClient: GuestAgentClient;
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
  /** Device path to open, e.g. "\\\\.\\my-driver". */
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
   * Path to the IOCTL test harness on the guest. Defaults to
   * `C:\Signalman\test-harness.exe`; scenarios that ship their own
   * harness override this.
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
 * Send an IOCTL via the guest-side `test-harness.exe`.
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

  const harness = params.harness_path ?? "C:\\Signalman\\test-harness.exe";
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
 *     SERVICE_NAME: my-driver
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
  const match = typeof obj.match === "boolean" ? obj.match : exitCode === 0;

  return {
    status,
    output_hex,
    output_size,
    match,
    exit_code: exitCode,
  };
}
