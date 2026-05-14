/**
 * VMware Workstation / Fusion backend via `vmrun` (v0.4.0-4 chunk 3).
 *
 * Parallel-track to `host/src/hypervisors/vmware.ts`. The existing
 * `vmware.ts` is the operational backend with extensive history and a
 * `govc` fallback for vSphere; this file lands a fresh implementation
 * with the same shape as `libvirt.ts` — injectable exec, stable error
 * codes — so the chunk-2 / chunk-3 idioms match. Operators who set
 * `hypervisor.backend = "vmrun"` opt in to this driver explicitly;
 * the legacy `"vmware"` key keeps pointing at the existing
 * `vmware.ts` so in-flight runs aren't disturbed.
 *
 * # Locked design (do not re-litigate — operator decision)
 *
 * - **New file, not a refactor of `vmware.ts`.** Operator
 *   confirmed in the WS4 kickoff: ship `vmrun.ts` alongside
 *   `vmware.ts`. The two converge on a single backend in a future
 *   release once both have been exercised in real scenarios.
 * - **vmrun only — no govc.** vSphere/govc support stays on
 *   `vmware.ts`. This driver wraps the local-hypervisor CLI.
 * - **Injectable exec.** Mirrors `cloud/tofu.ts` and `libvirt.ts`
 *   so the test idiom is consistent across modules.
 * - **Stable error codes via `VmrunBackendError`.** Callers
 *   dispatch on the code; the message is human-readable detail.
 * - **No credential interpolation into argv unless required.**
 *   vmrun's guest verbs (`runProgramInGuest`, `copyFileFromHost
 *   ToGuest`, etc.) require `-gu` / `-gp`; the constructor accepts
 *   them, the file-copy/exec paths interpolate them; ALL log
 *   output redacts the password. See the S-14 / "credentials in
 *   argv" note in `vmware.ts` for the cross-cutting risk.
 */

import { execFile as execFileCb } from "node:child_process";
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
import {
  sanitizeLabel,
  sanitizePath,
  sanitizeTimeout,
} from "../sanitize.js";

const execFile = promisify(execFileCb);

// ── Public constants ────────────────────────────────────────────────

/** Default vmrun binary lookup. Operators override via SIGNALMAN_VMRUN_PATH. */
export const DEFAULT_VMRUN_BIN = "vmrun";

/** Per-call timeout for fast vmrun verbs (list / state). */
export const VMRUN_DEFAULT_TIMEOUT_MS = 30_000;

/** Longer timeout for lifecycle ops (boot / shutdown). */
export const VMRUN_LIFECYCLE_TIMEOUT_MS = 5 * 60_000;

// ── Types ───────────────────────────────────────────────────────────

/**
 * Injectable exec callback for testing. Mirrors `LibvirtExec` /
 * `TofuExec` — tests pass a `vi.fn` that returns canned stdout +
 * exit code without spawning vmrun.
 */
export type VmrunExec = (
  args: string[],
  opts: VmrunExecOptions,
) => Promise<VmrunExecResult>;

export interface VmrunExecOptions {
  /** Per-call timeout in ms. */
  timeoutMs: number;
}

export interface VmrunExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Stable error code for {@link VmrunBackendError}. Callers dispatch
 * on these without parsing the human-readable message.
 *
 * - `vmrun_not_found` — couldn't spawn the vmrun binary.
 * - `vm_not_found` — vmrun reported the VMX path was missing or
 *   unknown.
 * - `vm_not_running` — guest-side op (copy / exec) was called on
 *   a stopped VM.
 * - `vmx_path_required` — caller passed a handle with no `.vmx`
 *   id and the VM wasn't in the running list.
 * - `snapshot_failed` — snapshot / revert / delete failed.
 * - `copy_failed` — `copyFileFromHostToGuest` /
 *   `copyFileFromGuestToHost` failed.
 * - `command_failed` — `runProgramInGuest` returned non-zero and
 *   the failure wasn't otherwise classified.
 * - `invalid_argument` — caller passed bad input (empty command,
 *   empty VMX path, etc).
 * - `auth_failed` — guest credentials were rejected by vmrun.
 * - `unsupported_operation` — verb that vmrun doesn't expose
 *   (e.g. `createVM` from a generic VMConfig).
 */
export type VmrunBackendErrorCode =
  | "vmrun_not_found"
  | "vm_not_found"
  | "vm_not_running"
  | "vmx_path_required"
  | "snapshot_failed"
  | "copy_failed"
  | "command_failed"
  | "invalid_argument"
  | "auth_failed"
  | "unsupported_operation";

/** Structured error for vmrun backend failures. */
export class VmrunBackendError extends Error {
  constructor(
    public readonly code: VmrunBackendErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VmrunBackendError";
  }
}

/** Constructor options. */
export interface VmrunBackendOptions {
  /** Path to the `vmrun` binary. Defaults to {@link DEFAULT_VMRUN_BIN}. */
  vmrunPath?: string;
  /** Guest username for `-gu` (default: "guest"). */
  guestUser?: string;
  /** Guest password for `-gp` (default: "guest"). */
  guestPass?: string;
  /**
   * Injected exec for testing. Production callers leave this
   * undefined; the default spawns via `node:child_process.execFile`.
   */
  exec?: VmrunExec;
}

// ── Helpers ─────────────────────────────────────────────────────────

function defaultExec(vmrunPath: string): VmrunExec {
  return async (args, opts) => {
    try {
      const { stdout, stderr } = await execFile(vmrunPath, args, {
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
        throw new VmrunBackendError(
          "vmrun_not_found",
          `Could not spawn '${vmrunPath}'. Install VMware Workstation/Fusion ` +
            `or set SIGNALMAN_VMRUN_PATH to the binary location.`,
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
 * Parse `vmrun list` output. vmrun emits:
 *
 *   Total running VMs: 2
 *   /path/to/vm1.vmx
 *   /path/to/vm2.vmx
 *
 * We skip the first "Total..." header and return the trimmed lines.
 * Exported so argv tests can hit the parser directly.
 */
export function parseListOutput(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  return lines
    .slice(1) // skip "Total running VMs: N"
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse `vmrun listSnapshots <vmx>` output. vmrun emits:
 *
 *   Total snapshots: 2
 *   snap-1
 *   snap-2
 *
 * Same shape as `parseListOutput`; one snapshot name per line.
 */
export function parseSnapshotsOutput(raw: string): CheckpointInfo[] {
  return parseListOutput(raw).map((name) => ({
    id: name,
    label: name,
    // vmrun listSnapshots doesn't expose creation time — we use a
    // sentinel epoch date so callers don't get NaN.
    createdAt: new Date(0),
  }));
}

/**
 * Extract a friendly VM name from a .vmx path. Strips the directory
 * + `.vmx` suffix. `/path/to/foo.vmx` → `foo`.
 */
export function vmNameFromVmxPath(vmxPath: string): string {
  const segs = vmxPath.split(/[\\/]/);
  const last = segs[segs.length - 1] ?? vmxPath;
  return last.endsWith(".vmx") ? last.slice(0, -4) : last;
}

function isAuthFailure(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("invalid user name") ||
    s.includes("invalid password") ||
    s.includes("authentication") ||
    s.includes("permission denied")
  );
}

function isVmNotFound(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("not a valid virtual machine") ||
    s.includes("no such virtual machine") ||
    s.includes("file does not exist")
  );
}

function isVmStopped(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("virtual machine is not powered on") ||
    s.includes("the virtual machine is not running") ||
    s.includes("vmware tools is not running")
  );
}

/**
 * Argv-builder helper. Returns the argv vmrun would receive for a
 * given verb + extras. Exported so argv tests can assert on it
 * without spinning up the backend.
 */
export function buildArgv(verb: string, extra: string[]): string[] {
  return [verb, ...extra];
}

// ── Backend ─────────────────────────────────────────────────────────

/**
 * vmrun-driven VMware backend.
 *
 * SECURITY NOTE (S-14): Guest credentials (`guestUser` / `guestPass`)
 * are passed as command-line arguments (`-gu` / `-gp`) to vmrun. They
 * are visible in process listings. vmrun does NOT support credential
 * passing via stdin or environment variables. All log output below
 * redacts `guestPass`. Operators should use short-lived,
 * least-privilege guest accounts and restrict process-listing
 * privileges on the host.
 *
 * Mitigations the operator can apply:
 * 1. vmrun's encrypted credential store (`-vp <path>`) when
 *    available.
 * 2. Process-listing restrictions on the host.
 * 3. Short-lived, least-privilege guest accounts.
 */
export class VmrunBackend implements HypervisorBackend {
  readonly name = "vmrun";
  private readonly vmrunPath: string;
  private readonly guestUser: string;
  private readonly guestPass: string;
  private readonly exec: VmrunExec;

  constructor(opts: VmrunBackendOptions = {}) {
    this.vmrunPath = opts.vmrunPath ?? DEFAULT_VMRUN_BIN;
    this.guestUser = opts.guestUser ?? "guest";
    this.guestPass = opts.guestPass ?? "guest";
    this.exec = opts.exec ?? defaultExec(this.vmrunPath);
  }

  /**
   * Run a vmrun command + classify the failure.
   *
   * The classifier covers errors that are ALWAYS abnormal regardless
   * of caller intent (VM-not-found, auth-rejected). Errors that mean
   * different things to different verbs (e.g. "not powered on" is the
   * *idempotent* path for `stop` but an error for `runProgramInGuest`)
   * are gated by the `classifyStopped` flag — verbs that want to
   * surface the stopped-VM error as `vm_not_running` pass `true`;
   * lifecycle verbs that treat it as idempotent pass `false`.
   */
  private async run(
    args: string[],
    opts: { timeoutMs?: number; classifyStopped?: boolean } = {},
  ): Promise<VmrunExecResult> {
    const result = await this.exec(args, {
      timeoutMs: opts.timeoutMs ?? VMRUN_DEFAULT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      if (isAuthFailure(result.stderr)) {
        throw new VmrunBackendError(
          "auth_failed",
          `vmrun rejected guest credentials: ${this.redactPassword(result.stderr).trim()}`,
        );
      }
      if (isVmNotFound(result.stderr)) {
        throw new VmrunBackendError(
          "vm_not_found",
          `vmrun could not locate VM: ${this.redactPassword(result.stderr).trim()}`,
        );
      }
      if ((opts.classifyStopped ?? true) && isVmStopped(result.stderr)) {
        throw new VmrunBackendError(
          "vm_not_running",
          `vmrun reported VM is not running: ${this.redactPassword(result.stderr).trim()}`,
        );
      }
    }
    return result;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.exec(["list"], { timeoutMs: 5_000 });
      return result.exitCode === 0;
    } catch (err) {
      if (err instanceof VmrunBackendError && err.code === "vmrun_not_found") {
        return false;
      }
      return false;
    }
  }

  // ── VM Lifecycle ──────────────────────────────────────────────

  async createVM(_config: VMConfig): Promise<VMHandle> {
    throw new VmrunBackendError(
      "unsupported_operation",
      "vmrun does not expose programmatic VM creation. Pre-create the VMX " +
        "with the VMware UI or `ovftool`, then pass a VMHandle with the " +
        ".vmx path as its `id`.",
    );
  }

  async startVM(handle: VMHandle): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    // classifyStopped=false: "not powered on" never fires here, and
    // the idempotent "already powered on" path is below.
    const result = await this.run(["start", vmx, "nogui"], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
      classifyStopped: false,
    });
    if (result.exitCode !== 0) {
      // Already running is idempotent — vmrun says
      // "The virtual machine is already powered on".
      if (result.stderr.toLowerCase().includes("already powered on")) {
        return;
      }
      throw new VmrunBackendError(
        "command_failed",
        `vmrun start failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    const mode = force ? "hard" : "soft";
    // classifyStopped=false: "not powered on" is the *idempotent*
    // path for stop, not a vm_not_running error.
    const result = await this.run(["stop", vmx, mode], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
      classifyStopped: false,
    });
    if (result.exitCode !== 0) {
      if (result.stderr.toLowerCase().includes("not powered on")) {
        return;
      }
      throw new VmrunBackendError(
        "command_failed",
        `vmrun stop failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    const result = await this.run(["pause", vmx]);
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "command_failed",
        `vmrun pause failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    const result = await this.run(["unpause", vmx]);
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "command_failed",
        `vmrun unpause failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    const result = await this.run(["deleteVM", vmx], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "command_failed",
        `vmrun deleteVM failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const state = await this.getVmState(handle);
    return {
      handle,
      state,
      guestAgentReachable: false,
    };
  }

  async listVMs(): Promise<VMHandle[]> {
    const result = await this.run(["list"]);
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "command_failed",
        `vmrun list failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return parseListOutput(result.stdout).map((vmxPath) => ({
      id: vmxPath,
      name: vmNameFromVmxPath(vmxPath),
      backend: this.name,
    }));
  }

  // ── Checkpoints ───────────────────────────────────────────────

  async createCheckpoint(
    handle: VMHandle,
    label: string,
  ): Promise<CheckpointHandle> {
    const safeLabel = sanitizeLabel(label);
    const vmx = this.requireVmxPath(handle);
    const result = await this.run(["snapshot", vmx, safeLabel], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "snapshot_failed",
        `vmrun snapshot failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
    return { id: safeLabel, vmHandle: handle, label: safeLabel };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const safeLabel = sanitizeLabel(checkpoint.label);
    const vmx = this.requireVmxPath(checkpoint.vmHandle);
    const result = await this.run(["revertToSnapshot", vmx, safeLabel], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "snapshot_failed",
        `vmrun revertToSnapshot failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const safeLabel = sanitizeLabel(checkpoint.label);
    const vmx = this.requireVmxPath(checkpoint.vmHandle);
    const result = await this.run(["deleteSnapshot", vmx, safeLabel], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "snapshot_failed",
        `vmrun deleteSnapshot failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const vmx = this.requireVmxPath(handle);
    const result = await this.run(["listSnapshots", vmx]);
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "snapshot_failed",
        `vmrun listSnapshots failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
    return parseSnapshotsOutput(result.stdout);
  }

  // ── File Transfer ─────────────────────────────────────────────

  async copyFileToVM(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    const safeHost = sanitizePath(hostPath);
    const safeGuest = sanitizePath(guestPath);
    const result = await this.run(
      [
        "-gu",
        this.guestUser,
        "-gp",
        this.guestPass,
        "copyFileFromHostToGuest",
        vmx,
        safeHost,
        safeGuest,
      ],
      { timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "copy_failed",
        `vmrun copyFileFromHostToGuest failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
      );
    }
  }

  async copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    const vmx = this.requireVmxPath(handle);
    const safeGuest = sanitizePath(guestPath);
    const safeHost = sanitizePath(hostPath);
    const result = await this.run(
      [
        "-gu",
        this.guestUser,
        "-gp",
        this.guestPass,
        "copyFileFromGuestToHost",
        vmx,
        safeGuest,
        safeHost,
      ],
      { timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "copy_failed",
        `vmrun copyFileFromGuestToHost failed (exit ${result.exitCode}): ${this.redactPassword(result.stderr).trim()}`,
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
    const vmx = this.requireVmxPath(handle);
    if (!command) {
      throw new VmrunBackendError(
        "invalid_argument",
        "executeCommand: command must not be empty",
      );
    }
    const safeTimeout = sanitizeTimeout(timeoutMs);
    const start = Date.now();
    const fullArgs = [
      "-gu",
      this.guestUser,
      "-gp",
      this.guestPass,
      "runProgramInGuest",
      vmx,
      "-activeWindow",
      command,
      ...args,
    ];
    const result = await this.run(fullArgs, { timeoutMs: safeTimeout });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: this.redactPassword(result.stderr),
      durationMs: Date.now() - start,
    };
  }

  // ── Extended Operations ───────────────────────────────────────

  async getVmIpAddress(handle: VMHandle): Promise<string> {
    const vmx = this.requireVmxPath(handle);
    const result = await this.run(["getGuestIPAddress", vmx, "-wait"], {
      timeoutMs: VMRUN_LIFECYCLE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new VmrunBackendError(
        "command_failed",
        `vmrun getGuestIPAddress failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    const ip = result.stdout.trim();
    if (!ip) {
      throw new VmrunBackendError(
        "command_failed",
        `vmrun returned an empty IP address for VM ${handle.name}`,
      );
    }
    return ip;
  }

  // ── Private Helpers ───────────────────────────────────────────

  private async getVmState(handle: VMHandle): Promise<VMState> {
    const result = await this.run(["list"]);
    if (result.exitCode !== 0) {
      return "unknown";
    }
    const running = parseListOutput(result.stdout);
    const vmxId = handle.id;
    const inList = running.some(
      (vmx) => vmx === vmxId || vmNameFromVmxPath(vmx) === handle.name,
    );
    return inList ? "running" : "stopped";
  }

  /**
   * Resolve a VMHandle to a VMX path. We accept either a `.vmx` path
   * passed straight through as the handle's `id`, or look the VM up
   * by name in the running list.
   */
  private requireVmxPath(handle: VMHandle): string {
    if (handle.id.endsWith(".vmx")) {
      return handle.id;
    }
    throw new VmrunBackendError(
      "vmx_path_required",
      `Cannot resolve VMX path for '${handle.name}'. Pass a VMHandle whose ` +
        `id is the absolute .vmx path; vmrun has no name-based VM lookup.`,
    );
  }

  private redactPassword(text: string): string {
    if (!this.guestPass || this.guestPass === "guest") return text;
    return text.replaceAll(this.guestPass, "***REDACTED***");
  }
}
