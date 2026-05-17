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
import os from "node:os";
import path from "node:path";
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

/** Default libvirt storage pool createVM writes its qcow2 disk into. */
export const DEFAULT_STORAGE_POOL = "default";

/**
 * Default capacity (in GiB) for the qcow2 child disk produced by
 * `createVM` when the caller doesn't specify `config.diskGB`.
 *
 * Since the disk is a sparse copy-on-write child of the template,
 * physical-on-disk usage stays bounded by what the guest actually
 * writes. The capacity is the maximum size the guest may grow into.
 * 20 GiB suits cloud-image-style guests; oversized for tiny test
 * images (CirrOS, Alpine) but harmless thanks to sparse storage.
 */
export const DEFAULT_DISK_GB = 20;

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
   * libvirt storage pool name. createVM writes its new qcow2 disk
   * into this pool's target directory. Defaults to
   * {@link DEFAULT_STORAGE_POOL} (`"default"`). Operators with
   * non-default pools pass the pool name they want; the pool must
   * exist and be active before createVM is called.
   */
  storagePool?: string;
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
/**
 * Parse the `Used memory: <N> KiB` line from `virsh dominfo <name>`
 * output. Returns the memory in MiB (rounded down), or `null` when
 * the line is missing or malformed.
 *
 * `virsh dominfo` shape:
 *
 *   Id:             1
 *   Name:           test
 *   ...
 *   Used memory:    2097152 KiB
 *
 * Some libvirt versions emit `Used memory: -` or `0 KiB` for a
 * domain whose balloon driver isn't reporting yet; those parse as
 * `0` rather than `null` so the caller can distinguish "no data" from
 * "balloon hasn't ballooned yet".
 *
 * Exported for unit tests.
 */
export function parseDomInfoUsedMemoryMB(raw: string): number | null {
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^Used memory:\s+(-|\d+)\s*KiB/);
    if (m) {
      if (m[1] === "-") return 0;
      return Math.floor(parseInt(m[1], 10) / 1024);
    }
  }
  return null;
}

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
 * Extract the storage-pool target directory from `virsh pool-dumpxml
 * <name>` output. libvirt emits a stable XML envelope with a
 * `<target><path>...</path></target>` block; we parse that path.
 *
 * Returns `null` when no `<target><path>` is present (rare — usually
 * means the pool is of a type that doesn't have a filesystem path,
 * like an iSCSI target).
 *
 * Exported for unit tests.
 */
export function parsePoolTargetPath(xml: string): string | null {
  const m = xml.match(/<target>[\s\S]*?<path>\s*([^<]+?)\s*<\/path>[\s\S]*?<\/target>/);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Escape a string for safe inclusion in an XML text node or
 * attribute value. We don't accept user input here — sanitizeVmName
 * + sanitizePath already gate the values — but defense in depth
 * costs nothing.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Supported guest-OS profile names. Mirrors `VMConfig.osProfile`
 * from `interface.ts`; kept here too so backend-internal callers
 * don't have to import the full VMConfig type.
 */
export type OsProfile =
  | "linux"
  | "linux-uefi"
  | "windows-10"
  | "windows-11";

/**
 * Resolved per-OS defaults consumed by {@link buildDomainXml}. The
 * top-level `createVM` flow resolves an {@link OsProfile} (plus
 * operator overrides) down to this shape before rendering.
 */
export interface OsProfileDefaults {
  firmware: "bios" | "efi";
  secureBoot: boolean;
  tpm: "none" | "tpm-2.0";
  diskBus: "virtio" | "sata" | "scsi";
  nicModel: "virtio" | "e1000e" | "rtl8139";
  /**
   * Clock offset. Windows hardware-clock convention is localtime;
   * Linux is UTC. Mismatch causes time skew + log timestamp confusion.
   */
  clockOffset: "utc" | "localtime";
  /**
   * Whether to add Windows-friendly device defaults: USB tablet
   * input (so the cursor tracks the guest pointer instead of
   * needing capture/release), QXL video adapter (Windows expects a
   * graphics device), and a localhost VNC graphics endpoint
   * (operator attaches a viewer during install).
   */
  windowsExtras: boolean;
}

/**
 * Return the canonical defaults for a given {@link OsProfile}.
 *
 * Defaults are operator-friendly: every profile chooses the
 * fastest-known-good combination for that OS family. v0.5 baseline
 * (BIOS + virtio + UTC) corresponds to the 'linux' profile so
 * existing callers that omit `osProfile` get unchanged behavior.
 *
 * - linux       — BIOS, virtio disk/NIC, no TPM, no Secure Boot, UTC.
 * - linux-uefi  — UEFI but no Secure Boot / TPM (faster boot for
 *                 distros that require UEFI without enforcing keys).
 * - windows-10  — UEFI, virtio disk/NIC, no TPM/SecureBoot (operator
 *                 may opt in), localtime, Windows extras on.
 * - windows-11  — UEFI + Secure Boot + TPM 2.0, virtio devices,
 *                 localtime, Windows extras on. All three security
 *                 features mandatory — Windows 11 refuses to boot
 *                 without them; `createVM` raises invalid_argument
 *                 if the operator tries to override.
 *
 * Exported for unit tests + for the skill / docs to reference the
 * canonical defaults without re-encoding them.
 */
export function resolveOsProfileDefaults(profile: OsProfile): OsProfileDefaults {
  switch (profile) {
    case "linux":
      return {
        firmware: "bios",
        secureBoot: false,
        tpm: "none",
        diskBus: "virtio",
        nicModel: "virtio",
        clockOffset: "utc",
        windowsExtras: false,
      };
    case "linux-uefi":
      return {
        firmware: "efi",
        secureBoot: false,
        tpm: "none",
        diskBus: "virtio",
        nicModel: "virtio",
        clockOffset: "utc",
        windowsExtras: false,
      };
    case "windows-10":
      return {
        firmware: "efi",
        secureBoot: false,
        tpm: "none",
        diskBus: "virtio",
        nicModel: "virtio",
        clockOffset: "localtime",
        windowsExtras: true,
      };
    case "windows-11":
      return {
        firmware: "efi",
        secureBoot: true,
        tpm: "tpm-2.0",
        diskBus: "virtio",
        nicModel: "virtio",
        clockOffset: "localtime",
        windowsExtras: true,
      };
  }
}

/** Map a disk bus to its conventional device-letter prefix. */
function diskDevForBus(bus: "virtio" | "sata" | "scsi"): string {
  return bus === "virtio" ? "vda" : "sda";
}

/** Options for {@link buildDomainXml}. All required — caller fills defaults. */
export interface BuildDomainXmlOptions {
  name: string;
  memoryMB: number;
  cpus: number;
  diskPath: string;
  networkName: string;
  /** Resolved profile + override stack. See {@link resolveOsProfileDefaults}. */
  os: OsProfileDefaults;
  /**
   * Absolute paths to additional ISO files to attach as read-only
   * CDROMs. Each entry produces one `<disk device='cdrom'>` element.
   * Empty / unset means "no extras" (still produces a fully valid
   * domain).
   */
  extraCdroms?: string[];
}

/**
 * Render a libvirt domain XML from `VMConfig` fields + a resolved
 * OS profile. The profile dictates firmware (BIOS vs UEFI), security
 * (Secure Boot, TPM 2.0), device models (virtio vs SATA/e1000e),
 * clock offset, and Windows-friendly extras (tablet input + QXL
 * video + VNC graphics).
 *
 * Opinionated shape (constant across profiles):
 *  - `type='kvm'` (no qemu-tcg fallback — operators on KVM-incapable
 *    hosts use a different backend).
 *  - `machine='q35'`, `arch='x86_64'`, `cpu mode='host-passthrough'`
 *    — fastest baseline for modern guests.
 *  - qcow2 backing-file disk at `opts.diskPath` (created by
 *    `vol-create-as` in createVM).
 *  - `<channel name='org.qemu.guest_agent.0'>` wires the QGA
 *    unix-socket so executeCommand / copyFileTo/FromVM /
 *    guestAgentReachable work end-to-end *when QGA is installed in
 *    the guest*. Linux distros ship QGA; Windows needs the
 *    virtio-win package's qemu-ga.msi.
 *
 * Operators with bespoke topology continue to `virsh define` their
 * own XML and skip createVM.
 *
 * Exported for unit tests (XML snapshot assertions).
 */
export function buildDomainXml(opts: BuildDomainXmlOptions): string {
  const name = xmlEscape(opts.name);
  const diskPath = xmlEscape(opts.diskPath);
  const networkName = xmlEscape(opts.networkName);
  const { os } = opts;
  const diskDev = diskDevForBus(os.diskBus);

  // ── <os> block ────────────────────────────────────────────────
  //
  // libvirt's `firmware='efi'` attribute on <os> turns on the
  // "managed firmware" path: libvirt selects the right OVMF binary
  // automatically based on the <firmware><feature/> hints below.
  // No explicit <loader>/<nvram> paths — the host's
  // /usr/share/qemu/firmware/ JSON descriptors do the matching.
  let osBlock: string;
  if (os.firmware === "efi") {
    const sbValue = os.secureBoot ? "yes" : "no";
    osBlock =
      `  <os firmware='efi'>\n` +
      `    <type arch='x86_64' machine='q35'>hvm</type>\n` +
      `    <firmware>\n` +
      `      <feature enabled='${sbValue}' name='secure-boot'/>\n` +
      `      <feature enabled='${sbValue}' name='enrolled-keys'/>\n` +
      `    </firmware>\n` +
      `    <boot dev='hd'/>\n` +
      `  </os>\n`;
  } else {
    osBlock =
      `  <os>\n` +
      `    <type arch='x86_64' machine='q35'>hvm</type>\n` +
      `    <boot dev='hd'/>\n` +
      `  </os>\n`;
  }

  // ── <features> block ──────────────────────────────────────────
  //
  // <smm state='on'/> is required by OVMF to enforce Secure Boot;
  // without it OVMF silently degrades to "secure-boot off". Always
  // include acpi+apic — modern guests assume them.
  const features = os.secureBoot
    ? `  <features>\n    <acpi/>\n    <apic/>\n    <smm state='on'/>\n  </features>\n`
    : `  <features>\n    <acpi/>\n    <apic/>\n  </features>\n`;

  // ── <clock> block ─────────────────────────────────────────────
  //
  // Windows uses RTC=localtime; Linux uses RTC=UTC. The Windows
  // timer hints (catchup/delay + hpet off) match libvirt's
  // virt-install recommendations and silence the W10/11 boot-time
  // clock-skew warning.
  const clock =
    os.clockOffset === "localtime"
      ? `  <clock offset='localtime'>\n    <timer name='rtc' tickpolicy='catchup'/>\n    <timer name='pit' tickpolicy='delay'/>\n    <timer name='hpet' present='no'/>\n  </clock>\n`
      : `  <clock offset='utc'/>\n`;

  // ── <tpm> block ───────────────────────────────────────────────
  //
  // The CRB ("Command Response Buffer") interface is what Windows
  // expects for TPM 2.0 on q35. libvirt auto-spawns swtpm on the
  // host side; no per-VM TPM seed needs to live in our XML.
  const tpmBlock =
    os.tpm === "tpm-2.0"
      ? `    <tpm model='tpm-crb'>\n      <backend type='emulator' version='2.0'/>\n    </tpm>\n`
      : "";

  // ── Windows extras ────────────────────────────────────────────
  //
  // USB tablet input gives synchronized cursor in the SPICE/VNC
  // viewer (no capture/release dance). QXL video is the standard
  // Windows-friendly emulated card; cirrus is too old, virtio-gpu
  // needs Windows drivers that don't ship out of the box. Listen
  // on 127.0.0.1 only — operator port-forwards if they need
  // remote access during install.
  const windowsExtras = os.windowsExtras
    ? `    <input type='tablet' bus='usb'/>\n` +
      `    <video>\n      <model type='qxl'/>\n    </video>\n` +
      `    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>\n`
    : "";

  // ── Extra CDROM media ─────────────────────────────────────────
  //
  // Each entry produces one read-only <disk device='cdrom'> on the
  // implicit q35 SATA controller. We use sda/sdb/... starting after
  // the primary disk's SATA slot (when the primary is virtio it
  // doesn't consume any sd* letter, so CDROMs start at sda).
  //
  // Operators with virtio-as-primary (the default) get:
  //   primary disk: vda (virtio)
  //   extraCdroms[0]: sda (sata, cdrom)
  //   extraCdroms[1]: sdb (sata, cdrom)
  //
  // Operators with sata-as-primary (e.g. Windows install path):
  //   primary disk: sda (sata)
  //   extraCdroms[0]: sdb (sata, cdrom)
  //   extraCdroms[1]: sdc (sata, cdrom)
  const cdroms = opts.extraCdroms ?? [];
  const cdromOffset = os.diskBus === "sata" ? 1 : 0;
  let cdromBlock = "";
  for (let i = 0; i < cdroms.length; i += 1) {
    const dev = `sd${String.fromCharCode("a".charCodeAt(0) + cdromOffset + i)}`;
    const isoPath = xmlEscape(cdroms[i]);
    cdromBlock +=
      `    <disk type='file' device='cdrom'>\n` +
      `      <driver name='qemu' type='raw'/>\n` +
      `      <source file='${isoPath}'/>\n` +
      `      <target dev='${dev}' bus='sata'/>\n` +
      `      <readonly/>\n` +
      `    </disk>\n`;
  }

  return (
    `<domain type='kvm'>\n` +
    `  <name>${name}</name>\n` +
    `  <memory unit='MiB'>${opts.memoryMB}</memory>\n` +
    `  <currentMemory unit='MiB'>${opts.memoryMB}</currentMemory>\n` +
    `  <vcpu placement='static'>${opts.cpus}</vcpu>\n` +
    osBlock +
    features +
    `  <cpu mode='host-passthrough'/>\n` +
    clock +
    `  <devices>\n` +
    `    <disk type='file' device='disk'>\n` +
    `      <driver name='qemu' type='qcow2'/>\n` +
    `      <source file='${diskPath}'/>\n` +
    `      <target dev='${diskDev}' bus='${os.diskBus}'/>\n` +
    `    </disk>\n` +
    cdromBlock +
    `    <interface type='network'>\n` +
    `      <source network='${networkName}'/>\n` +
    `      <model type='${os.nicModel}'/>\n` +
    `    </interface>\n` +
    `    <channel type='unix'>\n` +
    `      <source mode='bind'/>\n` +
    `      <target type='virtio' name='org.qemu.guest_agent.0'/>\n` +
    `    </channel>\n` +
    tpmBlock +
    windowsExtras +
    `    <console type='pty'/>\n` +
    `  </devices>\n` +
    `</domain>\n`
  );
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
  private readonly storagePool: string;
  private readonly connectUri?: string;
  private readonly exec: LibvirtExec;

  constructor(opts: LibvirtBackendOptions = {}) {
    this.virshPath = opts.virshPath ?? DEFAULT_VIRSH_BIN;
    this.storagePool = opts.storagePool ?? DEFAULT_STORAGE_POOL;
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

  async createVM(config: VMConfig): Promise<VMHandle> {
    // 1. Validate. We refuse to fabricate disks from thin air — the
    //    operator must point us at an existing qcow2 template image
    //    (Ubuntu cloud-image, custom golden image, etc.) that we use
    //    as the backing file for the new disk.
    const safeName = sanitizeVmName(config.name);
    const memoryMB = config.memoryMB ?? 2048;
    const cpus = config.cpus ?? 2;
    if (!Number.isInteger(memoryMB) || memoryMB < 32 || memoryMB > 1_048_576) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: memoryMB must be an integer between 32 and 1048576 (got ${memoryMB}).`,
      );
    }
    if (!Number.isInteger(cpus) || cpus < 1 || cpus > 240) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: cpus must be an integer between 1 and 240 (got ${cpus}).`,
      );
    }
    const template = config.template;
    if (!template || !path.isAbsolute(template)) {
      throw new LibvirtBackendError(
        "invalid_argument",
        "createVM: config.template must be an absolute path to an existing " +
          "qcow2 image used as the backing file. To pre-create the VM disk " +
          "yourself and skip qcow2 backing-file mode, define the domain " +
          "with `virsh define <domain.xml>` directly.",
      );
    }
    const networkName = sanitizeLabel(
      config.network?.switchName ?? "default",
    );
    const diskGB = config.diskGB ?? DEFAULT_DISK_GB;
    if (!Number.isFinite(diskGB) || diskGB <= 0) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: diskGB must be a positive number (got ${diskGB}).`,
      );
    }

    // ── OS profile resolution ────────────────────────────────────
    //
    // macOS is rejected up front: Apple's EULA constrains macOS to
    // Apple hardware, and even technical workarounds (OSX-KVM) are
    // legally murky on non-Apple hosts. Operators who need macOS
    // testing use the Tart backend on real Apple Silicon.
    const rawProfile = (
      config.osProfile ?? "linux"
    ) as string;
    if (rawProfile.toLowerCase().startsWith("macos")) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: osProfile '${rawProfile}' is not supported on the libvirt ` +
          `backend. macOS guests require Apple hardware per Apple's EULA; use the ` +
          `Tart backend on Apple Silicon for macOS testing.`,
      );
    }
    if (
      rawProfile !== "linux" &&
      rawProfile !== "linux-uefi" &&
      rawProfile !== "windows-10" &&
      rawProfile !== "windows-11"
    ) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: osProfile '${rawProfile}' is not recognized. Supported: ` +
          `linux, linux-uefi, windows-10, windows-11.`,
      );
    }
    const profile = rawProfile as OsProfile;
    const profileDefaults = resolveOsProfileDefaults(profile);
    // Operator overrides for firmware / secureBoot / tpm are
    // refused on windows-11 because Windows 11 refuses to install
    // or boot without all three of UEFI + Secure Boot + TPM 2.0.
    // We'd rather fail loudly at createVM than silently produce a
    // VM that refuses to finish setup.
    if (profile === "windows-11") {
      if (
        (config.firmware !== undefined && config.firmware !== "efi") ||
        (config.secureBoot !== undefined && config.secureBoot !== true) ||
        (config.tpm !== undefined && config.tpm !== "tpm-2.0")
      ) {
        throw new LibvirtBackendError(
          "invalid_argument",
          `createVM: osProfile 'windows-11' requires UEFI + Secure Boot + TPM 2.0; ` +
            `operator overrides for firmware / secureBoot / tpm are not permitted ` +
            `for this profile. Use 'windows-10' if you need a Windows guest without ` +
            `those requirements.`,
        );
      }
    }
    const resolvedOs: OsProfileDefaults = {
      ...profileDefaults,
      ...(config.firmware !== undefined ? { firmware: config.firmware } : {}),
      ...(config.secureBoot !== undefined ? { secureBoot: config.secureBoot } : {}),
      ...(config.tpm !== undefined ? { tpm: config.tpm } : {}),
      ...(config.diskBus !== undefined ? { diskBus: config.diskBus } : {}),
      ...(config.nicModel !== undefined ? { nicModel: config.nicModel } : {}),
    };
    // Secure Boot only makes sense on UEFI. Same for TPM (libvirt
    // accepts TPM on BIOS but the Windows install workflow we
    // support expects UEFI + TPM together).
    if (resolvedOs.secureBoot && resolvedOs.firmware !== "efi") {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: secureBoot requires firmware='efi' (got firmware='${resolvedOs.firmware}').`,
      );
    }
    if (resolvedOs.tpm !== "none" && resolvedOs.firmware !== "efi") {
      throw new LibvirtBackendError(
        "invalid_argument",
        `createVM: tpm='${resolvedOs.tpm}' requires firmware='efi' (got firmware='${resolvedOs.firmware}').`,
      );
    }

    // 2. Verify the storage pool exists (the volume create + path
    //    lookup below will surface a clearer error than the raw
    //    pool-not-found stderr).
    await this.resolveStoragePoolPath(this.storagePool);

    // 3. Create the backing-file qcow2 *as a libvirt-managed volume*
    //    via `virsh vol-create-as`. This is the critical difference
    //    vs. raw `qemu-img create`: libvirt tracks the volume in the
    //    pool, so `virsh undefine --remove-all-storage` at `deleteVM`
    //    time actually deletes the disk. Raw qemu-img orphans it.
    //    The new volume is sparse and copy-on-write; the template is
    //    untouched.
    const diskPath = await this.libvirtCreateVolume(
      `${safeName}.qcow2`,
      this.storagePool,
      template,
      diskGB,
    );

    // 4. Validate any extra CDROM media. We don't fs.stat (libvirt
    //    will fail loudly at start time if the path is wrong); we
    //    just refuse non-absolute paths up front so the operator
    //    gets a clear error instead of an obscure libvirt one.
    const extraCdroms = config.extraCdroms ?? [];
    for (const isoPath of extraCdroms) {
      if (typeof isoPath !== "string" || !path.isAbsolute(isoPath)) {
        throw new LibvirtBackendError(
          "invalid_argument",
          `createVM: extraCdroms entries must be absolute paths (got '${isoPath}').`,
        );
      }
    }

    // 5. Render the domain XML and hand it to `virsh define` via a
    //    tempfile.
    const xml = buildDomainXml({
      name: safeName,
      memoryMB,
      cpus,
      diskPath,
      networkName,
      os: resolvedOs,
      extraCdroms,
    });
    const xmlDir = await fs.mkdtemp(path.join(os.tmpdir(), "libvirt-define-"));
    const xmlFile = path.join(xmlDir, `${safeName}.xml`);
    try {
      await fs.writeFile(xmlFile, xml, "utf8");
      const defineResult = await this.run(["define", xmlFile], {
        timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS,
      });
      if (defineResult.exitCode !== 0) {
        throw new LibvirtBackendError(
          "command_failed",
          `virsh define failed (exit ${defineResult.exitCode}): ${defineResult.stderr.trim()}`,
        );
      }
    } finally {
      // The XML is now in libvirt's state dir; the tempfile is no
      // longer needed.
      await fs.rm(xmlDir, { recursive: true, force: true }).catch(() => undefined);
    }

    return { id: safeName, name: safeName, backend: this.name };
  }

  /**
   * Resolve the target directory for a named libvirt storage pool.
   * Throws `invalid_argument` with a copy-pasteable repair command
   * when the pool doesn't exist — first-time operators on a fresh
   * libvirtd often haven't created `default` yet.
   */
  private async resolveStoragePoolPath(poolName: string): Promise<string> {
    const result = await this.run(["pool-dumpxml", poolName]);
    if (result.exitCode !== 0) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `libvirt storage pool '${poolName}' not found. Create it with:\n` +
          `  virsh pool-define-as ${poolName} dir --target /var/lib/libvirt/images\n` +
          `  virsh pool-build ${poolName}\n` +
          `  virsh pool-start ${poolName}\n` +
          `  virsh pool-autostart ${poolName}\n` +
          `Original error: ${result.stderr.trim()}`,
      );
    }
    const targetPath = parsePoolTargetPath(result.stdout);
    if (!targetPath) {
      throw new LibvirtBackendError(
        "command_failed",
        `Could not parse <target><path> from storage pool '${poolName}' XML; ` +
          `is the pool a filesystem-backed pool (type 'dir')?`,
      );
    }
    return targetPath;
  }

  /**
   * Create a libvirt-managed qcow2 volume in `poolName` whose backing
   * store is `templatePath`. Returns the absolute on-disk path of the
   * new volume via `virsh vol-path`.
   *
   * The volume is registered with libvirt's storage manager — that's
   * the whole point of preferring `vol-create-as` over raw `qemu-img
   * create`: at `deleteVM` time, `virsh undefine
   * --remove-all-storage` walks the domain's volume references and
   * deletes them. A raw qemu-img-produced file is invisible to that
   * walker and orphans on the filesystem.
   *
   * `capacityGiB` is the maximum size the guest may grow into. Since
   * the qcow2 is copy-on-write over the backing template, actual
   * physical consumption stays bounded by guest writes; over-sizing
   * is harmless.
   */
  private async libvirtCreateVolume(
    volumeName: string,
    poolName: string,
    templatePath: string,
    capacityGiB: number,
  ): Promise<string> {
    const createResult = await this.run(
      [
        "vol-create-as",
        poolName,
        volumeName,
        `${capacityGiB}G`,
        "--format",
        "qcow2",
        "--backing-vol",
        templatePath,
        "--backing-vol-format",
        "qcow2",
      ],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
    if (createResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh vol-create-as failed (exit ${createResult.exitCode}): ${createResult.stderr.trim()}`,
      );
    }
    const pathResult = await this.run(
      ["vol-path", "--pool", poolName, volumeName],
      { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
    );
    if (pathResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh vol-path failed (exit ${pathResult.exitCode}): ${pathResult.stderr.trim()}`,
      );
    }
    const diskPath = pathResult.stdout.trim();
    if (!diskPath) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh vol-path returned an empty path for volume '${volumeName}' in pool '${poolName}'.`,
      );
    }
    return diskPath;
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
    // with the full cleanup-flag set so backing disks + snapshot
    // metadata + checkpoint metadata + nvram all vanish together.
    // Without --snapshots-metadata libvirt refuses to undefine
    // domains that have any snapshots ("cannot delete inactive
    // domain with N snapshots"), which surprised the 2026-05-16
    // demo when `vm checkpoint` had been called.
    //
    // We do NOT pass --delete-storage-volume-snapshots: libvirt's
    // directory-pool storage backend (the common case) returns
    // `unsupported flags (0x2) in function
    // virStorageBackendVolDeleteLocal` when the flag is present,
    // and the undefine half-completes (domain gone, qcow2 left).
    // For external-snapshot setups on pool drivers that *do*
    // support the flag (some iSCSI / ZFS backends), operators can
    // run `virsh undefine ... --delete-storage-volume-snapshots`
    // by hand after a regular `vm delete`. See the v0.5 deferred
    // list in `.workstream-status-ws11.md`.
    await this.exec(this.argv(["destroy", name]), {
      timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS,
    });
    const result = await this.run(
      [
        "undefine",
        name,
        "--remove-all-storage",
        "--snapshots-metadata",
        "--checkpoints-metadata",
        "--nvram",
      ],
      { timeoutMs: VIRSH_LIFECYCLE_TIMEOUT_MS },
    );
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
    let memoryUsedMB: number | undefined;
    let guestAgentReachable = false;
    if (state === "running") {
      try {
        const ip = await this.getVmIpAddress(handle);
        ipAddress = ip;
      } catch {
        // No IPv4 lease yet — non-fatal; caller may poll again later.
      }
      // Probe the QGA channel directly. Cheap (`guest-ping` returns
      // immediately) and replaces the previous always-false default
      // so the orchestrator's parallel guest-readiness waits can
      // actually succeed on libvirt.
      guestAgentReachable = await this.qgaPing(name);
      // `virsh dominfo` exposes the balloon driver's "Used memory"
      // value; we surface it as memoryUsedMB so scenario reports +
      // health checks don't need to shell out separately. virsh
      // failures here are non-fatal (the field stays undefined).
      //
      // Note: libvirt does not expose wall-clock domain uptime
      // through `virsh dominfo` or `virsh domstats`; `CPU time` is
      // accumulated CPU work, not boot time. We leave
      // `VMStatus.uptimeSeconds` undefined for libvirt and document
      // the limitation rather than synthesizing a misleading value.
      try {
        const info = await this.run(["dominfo", name]);
        if (info.exitCode === 0) {
          const used = parseDomInfoUsedMemoryMB(info.stdout);
          if (used !== null) memoryUsedMB = used;
        }
      } catch {
        // Best-effort; leave memoryUsedMB undefined.
      }
    }
    return {
      handle,
      state,
      ipAddress,
      guestAgentReachable,
      memoryUsedMB,
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
    progress?: ProgressCallback,
  ): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const safeHost = sanitizePath(hostPath);
    const safeGuest = sanitizePath(guestPath);

    // Pre-stat the host file so we know the total bytes up front;
    // the progress callback contract is `(bytesTransferred,
    // totalBytes)`, and operators rely on `totalBytes` for progress
    // bar widths. fs.stat failure here is fatal (we'd be unable to
    // read the file anyway).
    const totalBytes = (await fs.stat(safeHost)).size;

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
        let bytesTransferred = 0;
        // Emit a `(0, totalBytes)` callback before the first write
        // so callers see a starting frame for their progress UI.
        progress?.(bytesTransferred, totalBytes);
        do {
          ({ bytesRead } = await hostFile.read(buf, 0, buf.length, null));
          if (bytesRead > 0) {
            await this.qgaFileWrite(name, fileHandle, buf.subarray(0, bytesRead));
            bytesTransferred += bytesRead;
            progress?.(bytesTransferred, totalBytes);
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
    progress?: ProgressCallback,
  ): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const safeHost = sanitizePath(hostPath);
    const safeGuest = sanitizePath(guestPath);

    // Mirror image of copyFileToVM: guest-file-open(mode=r) → repeat
    // guest-file-read(handle, count=QGA_FILE_CHUNK_BYTES) until QGA
    // signals eof=true → guest-file-close. The host file is truncated
    // on open so partial-failure leaves it shorter than the source
    // rather than silently mixed-content.
    //
    // Progress callback caveat: for guest→host transfers we don't
    // know the total size in advance — QGA doesn't expose
    // guest-file-stat, and the data only arrives as it streams.
    // We pass `bytesTransferred` for *both* arguments of the
    // callback so progress UIs render as "N bytes (size unknown)"
    // rather than mis-claiming completion at an arbitrary `total`.
    const fileHandle = await this.qgaFileOpen(name, safeGuest, "r");
    let primaryError: unknown;
    try {
      const hostFile = await fs.open(safeHost, "w");
      try {
        let bytesTransferred = 0;
        progress?.(bytesTransferred, bytesTransferred);
        for (;;) {
          const chunk = await this.qgaFileRead(
            name,
            fileHandle,
            QGA_FILE_CHUNK_BYTES,
          );
          if (chunk.buf.length > 0) {
            await hostFile.write(chunk.buf);
            bytesTransferred += chunk.buf.length;
            progress?.(bytesTransferred, bytesTransferred);
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

  /**
   * Probe the qemu-guest-agent channel via `guest-ping`. Returns
   * `true` when the agent answered, `false` for any failure mode
   * (channel not wired, agent down, RPC timeout, parse error).
   * Used by {@link getStatus} to populate `guestAgentReachable`
   * without throwing — the caller wants a boolean, not an exception.
   */
  private async qgaPing(vmName: string): Promise<boolean> {
    try {
      const result = await this.run(
        [
          "qemu-agent-command",
          vmName,
          JSON.stringify({ execute: "guest-ping" }),
        ],
        { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
      );
      return result.exitCode === 0;
    } catch {
      return false;
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
    // Try sources in increasing order of operator-disruption cost:
    //   1. lease  — libvirt's own DHCP record; instant, only works
    //               for VMs on libvirt-managed networks (typical
    //               `default` virbr0).
    //   2. agent  — asks qemu-guest-agent over the virtio channel;
    //               works for static-IP VMs but requires QGA to be
    //               installed and the channel to be wired.
    //   3. arp    — sniffs the host ARP table; works for bridged
    //               VMs but only after some traffic has flowed.
    //
    // We surface the first IPv4 from any source. Each source error is
    // suppressed so the next can try; only when all three return no
    // IPv4 do we throw network_unavailable.
    const sources = ["lease", "agent", "arp"] as const;
    for (const source of sources) {
      const result = await this.run(
        ["domifaddr", name, "--source", source],
        { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        // virsh non-zero on this source — try the next one. The most
        // common case here is `--source agent` against a VM without
        // qemu-guest-agent; that's not a real error, just "no answer
        // from this source."
        continue;
      }
      const ip = parseDomIfAddrIpv4(result.stdout);
      if (ip) return ip;
    }
    throw new LibvirtBackendError(
      "network_unavailable",
      `no IPv4 address reported for domain '${name}' from any source (lease/agent/arp)`,
    );
  }

  /**
   * Wait for the qemu-guest-agent to respond on the virtio channel.
   *
   * Polls `guest-ping` with the same exponential-backoff cadence as
   * {@link executeCommand}'s status loop (50ms → 1s cap). Returns
   * `true` on the first ping that comes back; returns `false` when
   * `timeoutMs` expires.
   *
   * libvirt analogue of Hyper-V's `waitForHeartbeat` — both surface a
   * boolean rather than throwing so callers (orchestrator's parallel
   * readiness wait) can fan out + collect cleanly.
   */
  async waitForHeartbeat(handle: VMHandle, timeoutMs: number): Promise<boolean> {
    const name = sanitizeVmName(handle.name);
    const safeTimeout = Math.max(0, timeoutMs);
    const deadline = Date.now() + safeTimeout;
    let pollInterval = QGA_POLL_INITIAL_MS;
    // Probe immediately — the most common case is "the VM is already
    // up by the time the orchestrator gets here", and the test stubs
    // expect a check before any delay.
    if (await this.qgaPing(name)) return true;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollInterval, remaining));
      pollInterval = Math.min(pollInterval * 2, QGA_POLL_MAX_MS);
      if (await this.qgaPing(name)) return true;
    }
    return false;
  }

  /**
   * Set the configured memory allocation for a domain. Updates both
   * the maximum and the current size in the persisted XML; callers
   * who need a live resize on a running domain should stop the
   * domain first (libvirt enforces maxmem on running domains).
   *
   * Memory is in MiB to match the {@link HypervisorBackend}
   * interface. We translate to KiB at the virsh boundary because
   * virsh's `setmem` / `setmaxmem` default unit is KiB.
   */
  async setVmMemory(handle: VMHandle, memoryMB: number): Promise<void> {
    if (!Number.isInteger(memoryMB) || memoryMB < 32 || memoryMB > 1_048_576) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `Invalid memory value: ${memoryMB}MB. Must be an integer between 32 and 1048576.`,
      );
    }
    const name = sanitizeVmName(handle.name);
    const memKB = `${memoryMB * 1024}K`;
    // setmaxmem first: setmem cannot exceed the configured max, so
    // when the operator is growing the VM we have to raise the
    // ceiling before setting the new size.
    const maxResult = await this.run(
      ["setmaxmem", name, memKB, "--config"],
      { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
    );
    if (maxResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh setmaxmem failed (exit ${maxResult.exitCode}): ${maxResult.stderr.trim()}`,
      );
    }
    const memResult = await this.run(
      ["setmem", name, memKB, "--config"],
      { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
    );
    if (memResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh setmem failed (exit ${memResult.exitCode}): ${memResult.stderr.trim()}`,
      );
    }
  }

  /**
   * Set the configured vCPU count for a domain. Updates both the
   * maximum and the active count in the persisted XML; callers who
   * need a live resize on a running domain should stop the domain
   * first (libvirt enforces the maximum on running domains).
   */
  async setVmProcessor(handle: VMHandle, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 240) {
      throw new LibvirtBackendError(
        "invalid_argument",
        `Invalid processor count: ${count}. Must be an integer between 1 and 240.`,
      );
    }
    const name = sanitizeVmName(handle.name);
    const countStr = String(count);
    // setvcpus --maximum --config raises the configured ceiling. The
    // second setvcpus --config sets the active count up to that
    // ceiling.
    const maxResult = await this.run(
      ["setvcpus", name, countStr, "--maximum", "--config"],
      { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
    );
    if (maxResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh setvcpus --maximum failed (exit ${maxResult.exitCode}): ${maxResult.stderr.trim()}`,
      );
    }
    const setResult = await this.run(
      ["setvcpus", name, countStr, "--config"],
      { timeoutMs: VIRSH_DEFAULT_TIMEOUT_MS },
    );
    if (setResult.exitCode !== 0) {
      throw new LibvirtBackendError(
        "command_failed",
        `virsh setvcpus failed (exit ${setResult.exitCode}): ${setResult.stderr.trim()}`,
      );
    }
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
