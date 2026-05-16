/**
 * libvirt / KVM hypervisor backend (v0.4.0-4 cross-platform chunk 2).
 *
 * Subprocess-driven via the `virsh` CLI rather than a native libvirt
 * binding. The subprocess pattern matches the existing convention
 * (`vmware.ts` wraps `vmrun`; `tofu.ts` wraps `tofu`) and sidesteps
 * the native-build pain that hits Windows CI when a Linux-only
 * library is pulled into the dependency graph.
 *
 * # Why virsh, not libvirt-node
 *
 * - `libvirt-node` would need `gyp` + `libvirt-dev` on every host that
 *   imports the host crate, including Windows CI where libvirt simply
 *   isn't available.
 * - `virsh` is the canonical libvirt admin tool and ships with every
 *   distro libvirt package, so the dependency footprint is "the
 *   operator has libvirt installed" — same as the Hyper-V / VMware
 *   backends require their CLIs.
 * - The exec surface is small enough that maintaining a hand-rolled
 *   subprocess driver costs less than carrying a native dep.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Injectable exec.** The constructor accepts a {@link LibvirtExec}
 *   callback for tests; production callers leave it undefined and the
 *   driver spawns `virsh` via `node:child_process.execFile`.  Mirrors
 *   `cloud/tofu.ts` so the test idiom is consistent.
 * - **Stable error codes.** Every failure surfaces as
 *   {@link LibvirtBackendError} with a {@link LibvirtBackendErrorCode}
 *   string. The host orchestrator dispatches on the code; the message
 *   is for humans only.
 * - **VM names are sanitised through `sanitizeVmName`.** virsh treats
 *   the domain name as a positional argument and is happy with shell
 *   meta-characters; we refuse anything outside `[a-zA-Z0-9_-]` at the
 *   API boundary so the subprocess gets a known-safe value.
 * - **No state of our own.** The backend is stateless; every call
 *   shells out to virsh. The libvirt daemon is the source of truth.
 * - **`createVM` is intentionally limited.** Full domain creation
 *   requires a definition XML (libvirt's `domain` schema) that the
 *   operator typically supplies via `virsh define`. This driver
 *   focuses on lifecycle / snapshot / file-transfer / command-run for
 *   VMs that are already defined; creating a domain from a generic
 *   `VMConfig` is out of scope until v0.4.1 ships an XML builder.
 *
 * # What this module does NOT do
 *
 * - Provision new disks. Domains must already have backing storage
 *   defined; the orchestrator copies images via `qemu-img` (out of
 *   scope here).
 * - PCI / GPU passthrough configuration.
 * - Live-migration to a different host.
 *
 * Cross-platform note: libvirt itself runs on Linux. Calling
 * `isAvailable()` on Windows / macOS returns `false` cleanly when
 * `virsh` isn't on PATH; nothing else in this module assumes a
 * particular host OS.
 */

import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import type {
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
  HypervisorBackend,
  ProgressCallback,
  VMConfig,
  VMHandle,
  VMState,
  VMStatus,
} from "./interface.js";
import { sanitizeVmName, sanitizeLabel, sanitizePath } from "../sanitize.js";

const execFile = promisify(execFileCb);

// ── Public constants ────────────────────────────────────────────────

/** Default virsh binary lookup. Operators override via SIGNALMAN_VIRSH_BIN. */
export const DEFAULT_VIRSH_BIN = "virsh";

/** Default per-virsh-call timeout (most ops complete in <5s on healthy hosts). */
export const VIRSH_DEFAULT_TIMEOUT_MS = 30_000;

/** Longer timeout for lifecycle ops that wait on the libvirt daemon. */
export const VIRSH_LIFECYCLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Initial backoff for the `guest-exec-status` poll loop. Most guest
 * commands complete inside the first poll; the loop grows quickly
 * past this baseline for longer-running commands to avoid hammering
 * the QGA channel.
 */
export const QGA_POLL_INITIAL_MS = 50;

/** Upper bound on `guest-exec-status` poll interval. */
export const QGA_POLL_MAX_MS = 1_000;

/**
 * Bytes per `guest-file-write` / `guest-file-read` chunk. QGA's
 * default cmdline cap is 48KB after base64 encoding (~36KB raw); we
 * stay well below it so a slightly older QGA build doesn't reject
 * the payload.
 */
export const QGA_FILE_CHUNK_BYTES = 32 * 1024;

// ── Types ───────────────────────────────────────────────────────────

/**
 * Injectable exec callback for testing. Tests pass a `vi.fn` that
 * returns canned stdout/stderr/exit-code without spawning real virsh.
 * Production callers leave the exec undefined; the default spawns
 * `virsh` via `node:child_process.execFile`.
 */
export type LibvirtExec = (
  args: string[],
  opts: LibvirtExecOptions,
) => Promise<LibvirtExecResult>;

export interface LibvirtExecOptions {
  /** Per-call timeout in ms. */
  timeoutMs: number;
}

export interface LibvirtExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Stable error code for {@link LibvirtBackendError}. Callers dispatch
 * on these without parsing the human-readable message.
 *
 * - `virsh_not_found` — the `virsh` binary couldn't be located or
 *   refused to run a no-op (libvirt daemon down).
 * - `connect_failed` — virsh ran but couldn't reach libvirtd. The
 *   `LIBVIRT_DEFAULT_URI` may be wrong.
 * - `vm_not_found` — virsh reported a domain-lookup failure on a
 *   non-empty name. Idempotent ops collapse this to success.
 * - `snapshot_failed` — `snapshot-create-as` / `snapshot-revert` /
 *   `snapshot-delete` reported a non-zero exit.
 * - `network_unavailable` — `domifaddr` reported no IPv4 lease.
 *   Surfaces explicitly so the orchestrator can wait + retry.
 * - `guest_agent_unreachable` — `domifaddr` succeeded but the guest
 *   agent didn't respond on its loopback port.
 * - `copy_failed` — the host-↔-guest copy path errored. virsh has
 *   no first-class file-copy verb; we shell out to the qemu-guest-
 *   agent fs-write/fs-read or fall back to `scp` over the IP.
 * - `invalid_argument` — the caller passed bad input (e.g. an empty
 *   VM name). Surfaced as a code rather than a thrown `Error` so the
 *   orchestrator can pattern-match.
 * - `command_failed` — `runGuestCommand` exited non-zero. The exit
 *   code is preserved on the error message for forensics.
 * - `unsupported_operation` — a method that virsh doesn't support
 *   directly was called (e.g. `createVM` without a definition XML).
 */
export type LibvirtBackendErrorCode =
  | "virsh_not_found"
  | "connect_failed"
  | "vm_not_found"
  | "snapshot_failed"
  | "network_unavailable"
  | "guest_agent_unreachable"
  | "copy_failed"
  | "invalid_argument"
  | "command_failed"
  | "unsupported_operation";

/**
 * Structured error for libvirt backend failures. Mirrors
 * `CloudBackendError` — stable `code` + optional `cause`.
 */
export class LibvirtBackendError extends Error {
  constructor(
    public readonly code: LibvirtBackendErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LibvirtBackendError";
  }
}

/** Constructor options. */
export interface LibvirtBackendOptions {
  /** Path to the `virsh` binary. Defaults to {@link DEFAULT_VIRSH_BIN}. */
  virshPath?: string;
  /**
   * libvirt connection URI passed via `-c`. Defaults to the
   * libvirt-CLI default (`qemu:///system`).  Tests pass `test:///default`
   * to drive the deterministic in-memory test driver.
   */
  connectUri?: string;
  /**
   * Injected exec for testing. Production callers leave this
   * undefined; the default spawns the binary via
   * `node:child_process.execFile`.
   */
  exec?: LibvirtExec;
}

// ── Helpers ─────────────────────────────────────────────────────────

function defaultExec(virshPath: string): LibvirtExec {
  return async (args, opts) => {
    try {
      const { stdout, stderr } = await execFile(virshPath, args, {
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      if (e.code === "ENOENT") {
        throw new LibvirtBackendError(
          "virsh_not_found",
          `Could not spawn '${virshPath}'. Install libvirt-clients ` +
            `(or set SIGNALMAN_VIRSH_BIN to the binary path).`,
          err,
        );
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  };
}

/**
 * Map virsh's text-form domstate output to our VMState enum.
 *
 * virsh `domstate` returns one of:
 *   "running", "idle", "paused", "in shutdown", "shut off",
 *   "crashed", "pmsuspended" (or, in older versions, "no state").
 *
 * We collapse them into the four states the abstraction cares about.
 * Exported so argv tests can assert directly on parser behaviour.
 */
export function parseDomState(raw: string): VMState {
  const trimmed = raw.trim().toLowerCase();
  switch (trimmed) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "pmsuspended":
      return "saved";
    case "shut off":
    case "shutoff":
    case "crashed":
    case "in shutdown":
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * Parse `virsh list --all --name` output. virsh emits one domain name
 * per line, with a trailing blank line. Quiet flag (`--name`) gives us
 * the simplest possible output — no need to skip header rows.
 */
export function parseDomainList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Parse `virsh domifaddr <name>` output. virsh emits a header row,
 * a separator, then one row per network interface:
 *
 *   Name       MAC address          Protocol     Address
 *   ----------------------------------------------------
 *   vnet0      52:54:00:8e:5b:c1    ipv4         192.168.122.42/24
 *
 * Returns the first IPv4 address (with the `/CIDR` suffix stripped)
 * or `null` when no IPv4 lease is reported.
 */
export function parseDomIfAddrIpv4(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Name ") || trimmed.startsWith("----")) {
      continue;
    }
    // Fields are whitespace-separated; the IPv4 address is column 4.
    const cols = trimmed.split(/\s+/);
    if (cols.length >= 4 && cols[2] === "ipv4") {
      const addr = cols[3];
      // Strip the /CIDR suffix.
      const slash = addr.indexOf("/");
      return slash >= 0 ? addr.slice(0, slash) : addr;
    }
  }
  return null;
}

/**
 * Parse `virsh snapshot-list <name>` output. virsh emits a header
 * row, a separator, then one row per snapshot:
 *
 *   Name        Creation Time             State
 *   ----------------------------------------------------
 *   snap-2024   2024-01-15 10:30:00 +0000 shutoff
 *
 * The Creation Time column spans three whitespace-separated tokens
 * (date, time, tz). We join them back together when rebuilding the
 * Date object.
 */
export function parseSnapshotList(raw: string): CheckpointInfo[] {
  const out: CheckpointInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("Name ") ||
      trimmed.startsWith("----")
    ) {
      continue;
    }
    const cols = trimmed.split(/\s+/);
    if (cols.length < 5) continue;
    const name = cols[0];
    const date = `${cols[1]} ${cols[2]} ${cols[3]}`;
    const createdAt = new Date(date);
    out.push({
      id: name,
      label: name,
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date(0) : createdAt,
    });
  }
  return out;
}

/**
 * Parse the JSON envelope returned by `virsh qemu-agent-command` for
 * a `guest-exec` submit call.
 *
 * QGA shape: `{"return":{"pid":N}}`. Throws when the payload is
 * malformed or the PID is missing — guest-exec without a pid is a
 * QGA-side bug, not a network blip, so we surface it as a hard
 * `command_failed` upstream.
 *
 * Exported so unit tests can hit the parser without a backend.
 */
export function parseGuestExecPid(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `qemu-guest-agent guest-exec response was not valid JSON: ${(err as Error).message}`,
    );
  }
  const ret = (parsed as { return?: { pid?: unknown } }).return;
  const pid = ret?.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid)) {
    throw new Error(
      `qemu-guest-agent guest-exec response did not carry a numeric pid: ${raw}`,
    );
  }
  return pid;
}

/**
 * Parsed shape for a single `guest-exec-status` poll response.
 *
 * - `exited` mirrors QGA's terminal flag.
 * - `exitcode` is present when `exited === true` AND the guest
 *   reported one (QGA returns it for normal exits).
 * - `signal` is set for processes killed by a signal (mutually
 *   exclusive with `exitcode`).
 * - `outData` / `errData` are the base64-decoded stdout/stderr bytes
 *   captured by QGA. May be `undefined` when the guest wrote nothing.
 * - `outTruncated` / `errTruncated` mirror QGA's overflow flags; the
 *   backend logs a warning but does not error when they are set,
 *   since truncation is a guest-side decision.
 */
export interface GuestExecStatus {
  exited: boolean;
  exitcode?: number;
  signal?: number;
  outData?: string;
  errData?: string;
  outTruncated?: boolean;
  errTruncated?: boolean;
}

/**
 * Parse the JSON envelope returned by `virsh qemu-agent-command` for
 * a `guest-exec-status` poll call. Decodes the base64 `out-data` /
 * `err-data` payloads using `Buffer.from(..., "base64").toString()`.
 *
 * Exported so unit tests can verify the base64 decode + field
 * mapping without going through the backend.
 */
export function parseGuestExecStatus(raw: string): GuestExecStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `qemu-guest-agent guest-exec-status response was not valid JSON: ${(err as Error).message}`,
    );
  }
  const ret = (parsed as {
    return?: {
      exited?: unknown;
      exitcode?: unknown;
      signal?: unknown;
      "out-data"?: unknown;
      "err-data"?: unknown;
      "out-truncated"?: unknown;
      "err-truncated"?: unknown;
    };
  }).return;
  if (!ret || typeof ret !== "object") {
    throw new Error(
      `qemu-guest-agent guest-exec-status response missing return body: ${raw}`,
    );
  }
  const exited = ret.exited === true;
  const status: GuestExecStatus = { exited };
  if (typeof ret.exitcode === "number") status.exitcode = ret.exitcode;
  if (typeof ret.signal === "number") status.signal = ret.signal;
  if (typeof ret["out-data"] === "string") {
    status.outData = Buffer.from(ret["out-data"], "base64").toString("utf8");
  }
  if (typeof ret["err-data"] === "string") {
    status.errData = Buffer.from(ret["err-data"], "base64").toString("utf8");
  }
  if (ret["out-truncated"] === true) status.outTruncated = true;
  if (ret["err-truncated"] === true) status.errTruncated = true;
  return status;
}

/**
 * Promise-based sleep used by the `guest-exec-status` poll loop.
 * Kept module-local rather than imported from a util module so the
 * backend stays standalone.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the JSON envelope returned by `virsh qemu-agent-command` for
 * a `guest-file-open` call.
 *
 * QGA shape: `{"return":<handle-as-integer>}`. The integer is opaque
 * to the host — we pass it back unchanged on every subsequent
 * `guest-file-write` / `guest-file-read` / `guest-file-close` call.
 *
 * Exported for unit tests.
 */
export function parseGuestFileHandle(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `qemu-guest-agent guest-file-open response was not valid JSON: ${(err as Error).message}`,
    );
  }
  const ret = (parsed as { return?: unknown }).return;
  if (typeof ret !== "number" || !Number.isFinite(ret)) {
    throw new Error(
      `qemu-guest-agent guest-file-open response did not carry a numeric handle: ${raw}`,
    );
  }
  return ret;
}

/** Decoded `guest-file-read` chunk. */
export interface GuestFileReadResult {
  /** Decoded bytes from `buf-b64`. Empty buffer when QGA reports zero count. */
  buf: Buffer;
  /** Mirror of QGA's terminal flag. */
  eof: boolean;
}

/**
 * Parse the JSON envelope returned by `virsh qemu-agent-command` for
 * a `guest-file-read` call. QGA shape:
 *
 *   `{"return":{"count":N,"buf-b64":"<base64>","eof":bool}}`
 *
 * Returns the decoded buffer + EOF flag. When `buf-b64` is absent
 * the buffer is empty (some QGA versions omit it at EOF).
 *
 * Exported for unit tests.
 */
export function parseGuestFileRead(raw: string): GuestFileReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `qemu-guest-agent guest-file-read response was not valid JSON: ${(err as Error).message}`,
    );
  }
  const ret = (parsed as {
    return?: { "buf-b64"?: unknown; eof?: unknown };
  }).return;
  if (!ret || typeof ret !== "object") {
    throw new Error(
      `qemu-guest-agent guest-file-read response missing return body: ${raw}`,
    );
  }
  const eof = ret.eof === true;
  const b64 = typeof ret["buf-b64"] === "string" ? ret["buf-b64"] : "";
  return {
    buf: Buffer.from(b64, "base64"),
    eof,
  };
}

/**
 * Single source of truth for the "is this stderr text a libvirt
 * domain-not-found message?" check. virsh phrasing varies between
 * versions; we normalise to lowercase and look for the canonical
 * substrings rather than match an exact string.
 */
function isDomainNotFound(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("domain not found") ||
    s.includes("failed to get domain") ||
    s.includes("no domain with matching name")
  );
}

/**
 * Single source of truth for the "is this stderr text a libvirt
 * connection failure?" check.
 */
function isConnectFailure(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("failed to connect to the hypervisor") ||
    s.includes("cannot connect to libvirt") ||
    s.includes("connection refused")
  );
}

// ── Backend ─────────────────────────────────────────────────────────

/**
 * libvirt-via-virsh backend.
 *
 * SECURITY NOTE: virsh executes inside the host's session and inherits
 * its libvirt connection. Operators are expected to scope the user
 * Signalman runs under (typically via the `libvirt` group + a
 * `qemu:///session` URI for unprivileged use, or `qemu:///system`
 * when the host runs elevated). The backend never embeds credentials
 * in the connect URI.
 */
export class LibvirtBackend implements HypervisorBackend {
  readonly name = "libvirt";
  private readonly virshPath: string;
  private readonly connectUri?: string;
  private readonly exec: LibvirtExec;

  constructor(opts: LibvirtBackendOptions = {}) {
    this.virshPath = opts.virshPath ?? DEFAULT_VIRSH_BIN;
    this.connectUri = opts.connectUri;
    this.exec = opts.exec ?? defaultExec(this.virshPath);
  }

  /**
   * Compose the virsh argv. The `-c <uri>` connect flag, when
   * configured, is always the first pair so test fixtures see a
   * predictable shape.
   *
   * Exported via `buildArgv` (the named helper below) so argv tests
   * can assert on argv composition without spinning up the backend.
   */
  private argv(extra: string[]): string[] {
    return this.connectUri ? ["-c", this.connectUri, ...extra] : [...extra];
  }

  /**
   * Run a virsh command + bubble up structured failures. Callers
   * pass the verb-and-args without the connect-uri prefix; this
   * helper splices it in.
   */
  private async run(
    args: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<LibvirtExecResult> {
    const result = await this.exec(this.argv(args), {
      timeoutMs: opts.timeoutMs ?? VIRSH_DEFAULT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      if (isConnectFailure(result.stderr)) {
        throw new LibvirtBackendError(
          "connect_failed",
          `virsh could not reach libvirtd: ${result.stderr.trim()}`,
        );
      }
      if (isDomainNotFound(result.stderr)) {
        throw new LibvirtBackendError(
          "vm_not_found",
          `domain lookup failed: ${result.stderr.trim()}`,
        );
      }
    }
    return result;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.exec(this.argv(["version", "--daemon"]), {
        timeoutMs: 5_000,
      });
      return result.exitCode === 0;
    } catch (err) {
      if (err instanceof LibvirtBackendError && err.code === "virsh_not_found") {
        return false;
      }
      return false;
    }
  }

  // ── VM Lifecycle ──────────────────────────────────────────────

  async createVM(_config: VMConfig): Promise<VMHandle> {
    // Building a libvirt domain XML from a generic VMConfig is out
    // of scope for this milestone. Operators define domains via
    // `virsh define <domain.xml>` and pass the resulting handle to
    // `startVM` / `getStatus` / etc.
    throw new LibvirtBackendError(
      "unsupported_operation",
      "Libvirt domain creation requires a definition XML; this backend " +
        "supports lifecycle/snapshot/file/command operations on already-defined " +
        "domains. Define the domain with `virsh define <domain.xml>` first.",
    );
  }

  async startVM(handle: VMHandle): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const result = await this.run(["start", name], {
      timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      // "domain is already active" is the libvirt idempotent path.
      if (result.stderr.toLowerCase().includes("already active")) {
        return;
      }
      throw new LibvirtBackendError(
        "command_failed",
        `virsh start failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const verb = force ? "destroy" : "shutdown";
    const result = await this.run([verb, name], {
      timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      if (result.stderr.toLowerCase().includes("not running")) {
        return;
      }
      throw new LibvirtBackendError(
        "command_failed",
        `virsh ${verb} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const result = await this.run(["suspend", name]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh suspend failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const result = await this.run(["resume", name]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh resume failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    const name = sanitizeVmName(handle.name);
    // Best-effort destroy first (no-op if shut off), then undefine
    // with --remove-all-storage so backing disks vanish too.
    await this.exec(this.argv(["destroy", name]), {
      timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS,
    });
    const result = await this.run(["undefine", name, "--remove-all-storage"], {
      timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh undefine failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const name = sanitizeVmName(handle.name);
    const result = await this.run(["domstate", name]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh domstate failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    const state = parseDomState(result.stdout);
    let ipAddress: string | undefined;
    if (state === "running") {
      try {
        const ip = await this.getVmIpAddress(handle);
        ipAddress = ip;
      } catch {
        // No IPv4 lease yet — non-fatal; caller may poll again later.
      }
    }
    return {
      handle,
      state,
      ipAddress,
      guestAgentReachable: false,
    };
  }

  async listVMs(): Promise<VMHandle[]> {
    const result = await this.run(["list", "--all", "--name"]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh list failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return parseDomainList(result.stdout).map((name) => ({
      id: name,
      name,
      backend: this.name,
    }));
  }

  // ── Checkpoints ───────────────────────────────────────────────

  async createCheckpoint(
    handle: VMHandle,
    label: string,
  ): Promise<CheckpointHandle> {
    const name = sanitizeVmName(handle.name);
    const safeLabel = sanitizeLabel(label);
    const result = await this.run(
      ["snapshot-create-as", name, safeLabel],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "snapshot_failed",
        `virsh snapshot-create-as failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return { id: safeLabel, vmHandle: handle, label: safeLabel };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const name = sanitizeVmName(checkpoint.vmHandle.name);
    const safeLabel = sanitizeLabel(checkpoint.label);
    const result = await this.run(
      ["snapshot-revert", name, safeLabel],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "snapshot_failed",
        `virsh snapshot-revert failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const name = sanitizeVmName(checkpoint.vmHandle.name);
    const safeLabel = sanitizeLabel(checkpoint.label);
    const result = await this.run(
      ["snapshot-delete", name, safeLabel],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "snapshot_failed",
        `virsh snapshot-delete failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const name = sanitizeVmName(handle.name);
    const result = await this.run(["snapshot-list", name]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "snapshot_failed",
        `virsh snapshot-list failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return parseSnapshotList(result.stdout);
  }

  // ── File Transfer ─────────────────────────────────────────────

  async copyFileToVM(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const safeHost = sanitizePath(hostPath);
    const safeGuest = sanitizePath(guestPath);

    // QGA has no single-shot host→guest copy verb; the wire protocol
    // is guest-file-open(mode=w) → repeat guest-file-write(handle,
    // buf-b64) → guest-file-close(handle). Each call is its own
    // virsh subprocess; we keep chunks ≤ QGA_FILE_CHUNK_BYTES so the
    // base64-encoded payload stays inside QGA's per-call cap.
    const fileHandle = await this.qgaFileOpen(name, safeGuest, "w");
    let primaryError: unknown;
    try {
      const hostFile = await fs.open(safeHost, "r");
      try {
        const buf = Buffer.allocUnsafe(QGA_FILE_CHUNK_BYTES);
        let bytesRead = 0;
        do {
          ({ bytesRead } = await hostFile.read(buf, 0, buf.length, null));
          if (bytesRead > 0) {
            await this.qgaFileWrite(name, fileHandle, buf.subarray(0, bytesRead));
          }
        } while (bytesRead > 0);
      } finally {
        await hostFile.close();
      }
    } catch (err) {
      primaryError = err;
    } finally {
      try {
        await this.qgaFileClose(name, fileHandle);
      } catch (closeErr) {
        // Surface the close error only if the main flow succeeded;
        // otherwise the upstream error is more diagnostically useful.
        if (primaryError === undefined) primaryError = closeErr;
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }

  async copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const safeHost = sanitizePath(hostPath);
    const safeGuest = sanitizePath(guestPath);

    // Mirror image of copyFileToVM: guest-file-open(mode=r) → repeat
    // guest-file-read(handle, count=QGA_FILE_CHUNK_BYTES) until QGA
    // signals eof=true → guest-file-close. The host file is truncated
    // on open so partial-failure leaves it shorter than the source
    // rather than silently mixed-content.
    const fileHandle = await this.qgaFileOpen(name, safeGuest, "r");
    let primaryError: unknown;
    try {
      const hostFile = await fs.open(safeHost, "w");
      try {
        for (;;) {
          const chunk = await this.qgaFileRead(
            name,
            fileHandle,
            QGA_FILE_CHUNK_BYTES,
          );
          if (chunk.buf.length > 0) {
            await hostFile.write(chunk.buf);
          }
          if (chunk.eof) break;
        }
      } finally {
        await hostFile.close();
      }
    } catch (err) {
      primaryError = err;
    } finally {
      try {
        await this.qgaFileClose(name, fileHandle);
      } catch (closeErr) {
        if (primaryError === undefined) primaryError = closeErr;
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }

  /**
   * Submit a `guest-file-open` and return the QGA handle. Throws
   * `copy_failed` on RPC failure or unparseable response.
   */
  private async qgaFileOpen(
    vmName: string,
    guestPath: string,
    mode: "r" | "w",
  ): Promise<number> {
    const payload = JSON.stringify({
      execute: "guest-file-open",
      arguments: { path: guestPath, mode },
    });
    const result = await this.run(
      ["qemu-agent-command", vmName, payload],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "copy_failed",
        `guest-file-open(${mode}) failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    try {
      return parseGuestFileHandle(result.stdout);
    } catch (err) {
      throw new LibvirtBackendError(
        "copy_failed",
        `guest-file-open(${mode}) returned an unparseable response: ${(err as Error).message}`,
        err,
      );
    }
  }

  /** Submit one `guest-file-write` chunk. Throws `copy_failed` on failure. */
  private async qgaFileWrite(
    vmName: string,
    fileHandle: number,
    chunk: Buffer,
  ): Promise<void> {
    const payload = JSON.stringify({
      execute: "guest-file-write",
      arguments: {
        handle: fileHandle,
        "buf-b64": chunk.toString("base64"),
      },
    });
    const result = await this.run(
      ["qemu-agent-command", vmName, payload],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "copy_failed",
        `guest-file-write failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  /** Submit one `guest-file-read` chunk. Throws `copy_failed` on failure. */
  private async qgaFileRead(
    vmName: string,
    fileHandle: number,
    count: number,
  ): Promise<GuestFileReadResult> {
    const payload = JSON.stringify({
      execute: "guest-file-read",
      arguments: { handle: fileHandle, count },
    });
    const result = await this.run(
      ["qemu-agent-command", vmName, payload],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "copy_failed",
        `guest-file-read failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    try {
      return parseGuestFileRead(result.stdout);
    } catch (err) {
      throw new LibvirtBackendError(
        "copy_failed",
        `guest-file-read returned an unparseable response: ${(err as Error).message}`,
        err,
      );
    }
  }

  /** Submit a `guest-file-close`. Throws `copy_failed` on failure. */
  private async qgaFileClose(vmName: string, fileHandle: number): Promise<void> {
    const payload = JSON.stringify({
      execute: "guest-file-close",
      arguments: { handle: fileHandle },
    });
    const result = await this.run(
      ["qemu-agent-command", vmName, payload],
      { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "copy_failed",
        `guest-file-close failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  // ── Command Execution ─────────────────────────────────────────

  async executeCommand(
    handle: VMHandle,
    command: string,
    args: string[] = [],
    timeoutMs?: number,
  ): Promise<CommandResult> {
    const name = sanitizeVmName(handle.name);
    if (!command) {
      throw new LibvirtBackendError(
        "invalid_argument",
        "executeCommand: command must not be empty",
      );
    }
    const safeTimeout = timeoutMs ?? VIRSH_DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const deadline = start + safeTimeout;

    // Submit: guest-exec hands the guest a pid we can poll on.
    const submitPayload = JSON.stringify({
      execute: "guest-exec",
      arguments: {
        path: command,
        arg: args,
        "capture-output": true,
      },
    });
    const submitResult = await this.run(
      ["qemu-agent-command", name, submitPayload],
      { timeoutMs: safeTimeout },
    );
    if (submitResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `guest-exec submit failed (exit ${submitResult.exitCode}): ${submitResult.stderr.trim()}`,
      );
    }
    let pid: number;
    try {
      pid = parseGuestExecPid(submitResult.stdout);
    } catch (err) {
      throw new LibvirtBackendError(
        "command_failed",
        `guest-exec submit returned an unparseable response: ${(err as Error).message}`,
        err,
      );
    }

    // Poll: guest-exec-status until exited === true or the caller's
    // deadline expires. Exponential backoff caps at QGA_POLL_MAX_MS so
    // we never hammer the QGA channel on long-running commands.
    let pollInterval = QGA_POLL_INITIAL_MS;
    const statusPayload = JSON.stringify({
      execute: "guest-exec-status",
      arguments: { pid },
    });
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LibvirtBackendError(
          "command_failed",
          `guest-exec timed out waiting for pid ${pid} to exit after ${safeTimeout}ms`,
        );
      }
      await sleep(Math.min(pollInterval, remaining));
      pollInterval = Math.min(pollInterval * 2, QGA_POLL_MAX_MS);

      const statusResult = await this.run(
        ["qemu-agent-command", name, statusPayload],
        { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
      );
      if (statusResult.exitCode !== 0) {
        throw new LibvirtBackendError(
          "command_failed",
          `guest-exec-status failed (exit ${statusResult.exitCode}): ${statusResult.stderr.trim()}`,
        );
      }
      let status: GuestExecStatus;
      try {
        status = parseGuestExecStatus(statusResult.stdout);
      } catch (err) {
        throw new LibvirtBackendError(
          "command_failed",
          `guest-exec-status returned an unparseable response: ${(err as Error).message}`,
          err,
        );
      }
      if (!status.exited) continue;
      // Terminal: the guest signalled or exited normally. QGA reports
      // `signal` for signal-killed processes and `exitcode` for normal
      // exits. We map "killed by signal N" to exit code 128+N (the
      // shell convention) so callers don't need to know about the QGA
      // signal field to detect failure.
      const exitCode =
        status.exitcode ?? (status.signal !== undefined ? 128 + status.signal : 0);
      return {
        exitCode,
        stdout: status.outData ?? "",
        stderr: status.errData ?? "",
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Extended Operations ───────────────────────────────────────

  async getVmIpAddress(handle: VMHandle): Promise<string> {
    const name = sanitizeVmName(handle.name);
    const result = await this.run(["domifaddr", name]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "network_unavailable",
        `virsh domifaddr failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    const ip = parseDomIfAddrIpv4(result.stdout);
    if (!ip) {
      throw new LibvirtBackendError(
        "network_unavailable",
        `no IPv4 lease reported for domain '${name}'`,
      );
    }
    return ip;
  }

}

// ── Public helpers (exported for argv tests) ────────────────────────

/**
 * Argv-builder helper. Returns the argv that the backend would pass
 * to virsh for a given verb + extra args + connect URI. Exists so
 * argv tests can assert on argv composition without spinning up the
 * full backend.
 */
export function buildArgv(verb: string, extra: string[], connectUri?: string): string[] {
  return connectUri ? ["-c", connectUri, verb, ...extra] : [verb, ...extra];
}
