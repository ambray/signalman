/**
 * Probe runner — executes a declarative probe against a target VM and
 * returns a structured result.
 *
 * Three probe kinds (declared in signalman.build.yaml, per
 * docs/design/meta-build-system.md §8 and the operator-owned probe set
 * for the product):
 *
 *   * `command`        — exec a command, match exit/stdout/stderr
 *   * `http_in_guest`  — exec PowerShell Invoke-WebRequest inside the
 *                        guest, match HTTP status + body
 *   * `file_in_guest`  — exec `cmd /c if exist <path>` inside the guest
 *
 * All three reduce to `DeployBackend.executeInGuest` plus a structured
 * matcher. Running probes from the host (rather than the guest) would
 * require network reachability + tunneling; loopback URLs and registry
 * checks demand the guest.
 *
 * Result mapping:
 *   * `pass`     — all matchers satisfied
 *   * `fail`     — matcher mismatch OR command exit != expected
 *   * `degraded` — reserved for partial-pass semantics; not emitted in
 *                  v0.2 (we use only pass/fail today).
 */

import type { VMHandle } from "../../hypervisors/interface.js";
import type { Probe } from "../build/yaml.js";
import type { DeployBackend, ExecResult } from "../deploy/backend.js";
import type { HealthStatus } from "../types.js";

export interface ProbeResult {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  detail: string;
}

export interface RunProbeOptions {
  probe: Probe;
  handle: VMHandle;
  backend: DeployBackend;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runProbe(opts: RunProbeOptions): Promise<ProbeResult> {
  const start = Date.now();
  const probe = opts.probe;
  try {
    if (probe.kind === "command") {
      return await runCommandProbe(opts, probe, start);
    }
    if (probe.kind === "http_in_guest") {
      return await runHttpProbe(opts, probe, start);
    }
    if (probe.kind === "file_in_guest") {
      return await runFileProbe(opts, probe, start);
    }
    const exhaustive: never = probe;
    throw new Error(`unknown probe kind: ${JSON.stringify(exhaustive)}`);
  } catch (err) {
    return {
      name: probe.name,
      status: "fail",
      latencyMs: Date.now() - start,
      detail: `probe execution threw: ${(err as Error).message}`,
    };
  }
}

/** Run a set of probes serially. Returns results in declaration order. */
export async function runProbes(
  probes: Probe[],
  handle: VMHandle,
  backend: DeployBackend,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const probe of probes) {
    out.push(await runProbe({ probe, handle, backend }));
  }
  return out;
}

// ── command ─────────────────────────────────────────────────────────

interface CommandProbeShape {
  kind: "command";
  name: string;
  command: string;
  args?: string[];
  expect_exit?: number;
  expect_stdout_contains?: string;
  expect_stderr_contains?: string;
  timeout_ms?: number;
}

async function runCommandProbe(
  opts: RunProbeOptions,
  probe: CommandProbeShape,
  start: number,
): Promise<ProbeResult> {
  const expectExit = probe.expect_exit ?? 0;
  const result = await opts.backend.executeInGuest(
    opts.handle,
    probe.command,
    probe.args,
    probe.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );
  return evaluateMatchers({
    name: probe.name,
    start,
    result,
    expectExit,
    expectStdoutContains: probe.expect_stdout_contains,
    expectStderrContains: probe.expect_stderr_contains,
  });
}

// ── http_in_guest ───────────────────────────────────────────────────

interface HttpProbeShape {
  kind: "http_in_guest";
  name: string;
  url: string;
  expect_status?: number;
  expect_body_contains?: string;
  timeout_ms?: number;
}

async function runHttpProbe(
  opts: RunProbeOptions,
  probe: HttpProbeShape,
  start: number,
): Promise<ProbeResult> {
  const expectStatus = probe.expect_status ?? 200;
  // PowerShell Invoke-WebRequest. We use a script that prints the
  // status code on stdout and the response body on stderr (so we can
  // parse them separately) and exits 0 on success, non-zero on a fetch
  // error. `-UseBasicParsing` keeps PS from needing IE-mode init.
  const psScript =
    `try { ` +
    `$resp = Invoke-WebRequest -UseBasicParsing -Uri ${quotePs(probe.url)} ` +
    `-TimeoutSec ${Math.ceil((probe.timeout_ms ?? DEFAULT_TIMEOUT_MS) / 1000)}; ` +
    `Write-Output $resp.StatusCode; ` +
    `[Console]::Error.Write($resp.Content) ` +
    `} catch { Write-Error $_.Exception.Message; exit 1 }`;

  const result = await opts.backend.executeInGuest(
    opts.handle,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    probe.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) {
    return {
      name: probe.name,
      status: "fail",
      latencyMs: Date.now() - start,
      detail: `Invoke-WebRequest failed: ${result.stderr.trim() || "non-zero exit"}`,
    };
  }
  const statusFromStdout = parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(statusFromStdout)) {
    return {
      name: probe.name,
      status: "fail",
      latencyMs: Date.now() - start,
      detail: `could not parse HTTP status from probe output: ${result.stdout.slice(0, 200)}`,
    };
  }
  if (statusFromStdout !== expectStatus) {
    return {
      name: probe.name,
      status: "fail",
      latencyMs: Date.now() - start,
      detail: `expected HTTP ${expectStatus}, got ${statusFromStdout}`,
    };
  }
  if (probe.expect_body_contains && !result.stderr.includes(probe.expect_body_contains)) {
    return {
      name: probe.name,
      status: "fail",
      latencyMs: Date.now() - start,
      detail: `body did not contain '${truncate(probe.expect_body_contains, 80)}'`,
    };
  }
  return {
    name: probe.name,
    status: "pass",
    latencyMs: Date.now() - start,
    detail: `status=${statusFromStdout}`,
  };
}

function quotePs(s: string): string {
  // Single-quoted PowerShell string with single-quote doubling.
  return `'${s.replace(/'/g, "''")}'`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ── file_in_guest ───────────────────────────────────────────────────

interface FileProbeShape {
  kind: "file_in_guest";
  name: string;
  path: string;
}

async function runFileProbe(
  opts: RunProbeOptions,
  probe: FileProbeShape,
  start: number,
): Promise<ProbeResult> {
  // `cmd /c if exist <path>` exits 0 when present, 1 when absent.
  // Quoting: cmd.exe doesn't support single-quote, only double-quote.
  // We refuse paths containing a double-quote so the construction is
  // safe — probe authors have no reason to embed " in a guest path.
  if (probe.path.includes('"')) {
    return {
      name: probe.name,
      status: "fail",
      latencyMs: Date.now() - start,
      detail: `file_in_guest path may not contain a double-quote: ${probe.path}`,
    };
  }
  const result = await opts.backend.executeInGuest(
    opts.handle,
    "cmd.exe",
    ["/c", `if exist "${probe.path}" (exit 0) else (exit 1)`],
    DEFAULT_TIMEOUT_MS,
  );
  const present = result.exitCode === 0;
  return {
    name: probe.name,
    status: present ? "pass" : "fail",
    latencyMs: Date.now() - start,
    detail: present ? `present` : `missing`,
  };
}

// ── shared ──────────────────────────────────────────────────────────

interface EvaluateMatchersInput {
  name: string;
  start: number;
  result: ExecResult;
  expectExit: number;
  expectStdoutContains?: string;
  expectStderrContains?: string;
}

function evaluateMatchers(input: EvaluateMatchersInput): ProbeResult {
  const latencyMs = Date.now() - input.start;
  if (input.result.exitCode !== input.expectExit) {
    return {
      name: input.name,
      status: "fail",
      latencyMs,
      detail: `exit=${input.result.exitCode}, expected ${input.expectExit}${
        input.result.stderr ? `; stderr: ${truncate(input.result.stderr, 200)}` : ""
      }`,
    };
  }
  if (
    input.expectStdoutContains &&
    !input.result.stdout.includes(input.expectStdoutContains)
  ) {
    return {
      name: input.name,
      status: "fail",
      latencyMs,
      detail: `stdout did not contain '${truncate(input.expectStdoutContains, 80)}'`,
    };
  }
  if (
    input.expectStderrContains &&
    !input.result.stderr.includes(input.expectStderrContains)
  ) {
    return {
      name: input.name,
      status: "fail",
      latencyMs,
      detail: `stderr did not contain '${truncate(input.expectStderrContains, 80)}'`,
    };
  }
  return {
    name: input.name,
    status: "pass",
    latencyMs,
    detail: `exit=${input.result.exitCode}`,
  };
}
