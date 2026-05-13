/**
 * Differencing-disk provisioning primitive (v0.3.0-2).
 *
 * Wraps Hyper-V's `New-VHD -ParentPath <parent> -Path <child>
 * -Differencing` to materialise a child VHDX that branches off a
 * read-only base image. The orchestrator uses one differencing disk
 * per ephemeral scenario VM so the base VHDX stays clean and
 * teardown is "delete this single child file" instead of "revert a
 * shared VM's checkpoint, hope nothing leaked".
 *
 * # Locked design (do not re-litigate)
 *
 * - **Depth-1 chains only.** Parent must be a base VHDX, not another
 *   differencing disk. Hyper-V supports 13-level chains; we cap at 1
 *   for now because deeper chains complicate cleanup and offer no
 *   v0.3.0 win.
 * - **Same-volume parent/child.** Hyper-V's differencing-disk path
 *   resolution requires parent and child on the same volume on
 *   Server 2016+. Operators wanting "base on D:, scratch on faster E:"
 *   should copy the parent to E: first; that defeats the differencing
 *   point. Documented as a constraint, enforced here so the failure
 *   surface is "configuration error" not "opaque VHDX-create error".
 * - **No silent overwrite.** Child path must not exist on disk. We
 *   never replace an existing file — the caller has to delete it
 *   first if a re-create is intentional.
 * - **Injectable exec.** This module is pure: callers pass a
 *   PowerShell exec function. Production callers wire it to the
 *   real `powershell.exe`; tests pass a vi.fn. Keeps the module
 *   testable without spawning processes.
 *
 * The actual PowerShell invocation is:
 *
 *   New-VHD -ParentPath '<parent>' -Path '<child>' -Differencing
 *
 * No size argument: a differencing VHDX inherits its logical size
 * from the parent. Hyper-V allocates blocks lazily on first write.
 *
 * # Why a separate module?
 *
 * `host/src/hypervisors/hyperv.ts` already has VM-level operations
 * (createVM, deleteVM, copyFile). Disk provisioning is a separate
 * concern: the orchestrator may want to pre-build child VHDXs in a
 * setup phase before any VM exists, and cloud backends (AWS / Azure
 * in v0.3.0-5) will substitute AMI/managed-image branching for
 * differencing-disk without changing the VM-create path. Keeping
 * the primitive standalone lets both paths share its contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Inputs to {@link createDifferencingDisk}.
 *
 * Both paths must be absolute. The function validates them before
 * invoking PowerShell so misuses surface as descriptive TypeScript
 * errors rather than opaque PS stack traces.
 */
export interface CreateDifferencingDiskOptions {
  /**
   * Absolute path to an existing parent VHDX. The function checks it
   * exists before invoking `New-VHD`. The parent is opened
   * read-only by Hyper-V; multiple differencing children may share
   * the same parent concurrently.
   */
  parentVhdxPath: string;
  /**
   * Absolute path where the differencing child VHDX should be
   * written. Must NOT already exist — we never silently overwrite.
   * The parent directory must exist; we do not auto-create it.
   */
  childVhdxPath: string;
  /**
   * PowerShell exec callback. Receives the raw PS script (already
   * including `$ProgressPreference = 'SilentlyContinue'`) and
   * returns the stdout string. Production callers wire this to the
   * existing `ps()` helper in `host/src/hypervisors/hyperv.ts`;
   * tests inject a `vi.fn`.
   *
   * The exec MUST throw a descriptive error on non-zero PS exit.
   * This module does not parse PowerShell stderr.
   */
  exec: (script: string, timeoutMs?: number) => Promise<string>;
  /**
   * Optional per-call PS timeout. Defaults to 60s. `New-VHD` is
   * fast (no block allocation up front), but a contested host with
   * VHDX metadata locks held can stall the cmdlet briefly.
   */
  timeoutMs?: number;
}

/**
 * Outcome record returned by {@link createDifferencingDisk}.
 *
 * Returned on success only; failures throw. Captures the resolved
 * paths so callers can record them in their resource ledger without
 * recomputing the canonical form.
 */
export interface CreateDifferencingDiskResult {
  /** Absolute parent path as passed in (already canonicalised). */
  parentVhdxPath: string;
  /** Absolute child path as passed in (already canonicalised). */
  childVhdxPath: string;
}

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Structured error type for differencing-disk failures. Carries a
 * stable `code` so call sites can distinguish "the parent doesn't
 * exist" from "the PS cmdlet barfed" without string matching.
 */
export class DifferencingDiskError extends Error {
  constructor(
    public readonly code:
      | "parent_missing"
      | "child_exists"
      | "child_dir_missing"
      | "cross_volume"
      | "non_absolute_path"
      | "ps_failure",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DifferencingDiskError";
  }
}

// ── Implementation ─────────────────────────────────────────────────

/**
 * Create a differencing VHDX that branches off `parentVhdxPath`.
 *
 * @throws {@link DifferencingDiskError} with `code` set to one of:
 *   - `non_absolute_path` — either path was relative.
 *   - `parent_missing` — parent VHDX doesn't exist on disk.
 *   - `child_exists` — child path already exists; refusing to overwrite.
 *   - `child_dir_missing` — child's parent directory doesn't exist.
 *   - `cross_volume` — parent and child are on different volumes.
 *   - `ps_failure` — the `New-VHD` PowerShell call failed.
 */
export async function createDifferencingDisk(
  opts: CreateDifferencingDiskOptions,
): Promise<CreateDifferencingDiskResult> {
  const parent = opts.parentVhdxPath;
  const child = opts.childVhdxPath;

  // ── Validate inputs before touching PS ─────────────────────────

  if (!path.isAbsolute(parent)) {
    throw new DifferencingDiskError(
      "non_absolute_path",
      `parentVhdxPath must be absolute, got: ${parent}`,
    );
  }
  if (!path.isAbsolute(child)) {
    throw new DifferencingDiskError(
      "non_absolute_path",
      `childVhdxPath must be absolute, got: ${child}`,
    );
  }

  if (!fs.existsSync(parent)) {
    throw new DifferencingDiskError(
      "parent_missing",
      `Parent VHDX does not exist: ${parent}. ` +
        `Resolve the template (resolveTemplateAsync) before invoking this.`,
    );
  }

  if (fs.existsSync(child)) {
    throw new DifferencingDiskError(
      "child_exists",
      `Child VHDX path already exists: ${child}. ` +
        `Refusing to overwrite — delete it first if a re-create is intentional.`,
    );
  }

  const childDir = path.dirname(child);
  if (!fs.existsSync(childDir)) {
    throw new DifferencingDiskError(
      "child_dir_missing",
      `Child VHDX directory does not exist: ${childDir}. ` +
        `Create it before invoking this.`,
    );
  }

  // Same-volume check: Hyper-V's differencing-disk path resolution
  // requires parent and child to share a volume root. We compare the
  // resolved `path.parse(...).root` values, which on Windows is the
  // drive letter ("C:\\") and on POSIX is "/" (the latter being
  // irrelevant since this whole module is Hyper-V / Windows).
  const parentRoot = path.parse(parent).root;
  const childRoot = path.parse(child).root;
  if (parentRoot.toLowerCase() !== childRoot.toLowerCase()) {
    throw new DifferencingDiskError(
      "cross_volume",
      `Parent and child VHDX must be on the same volume. ` +
        `Parent root: ${parentRoot}, child root: ${childRoot}. ` +
        `Hyper-V requires same-volume differencing chains on Server 2016+.`,
    );
  }

  // ── Invoke New-VHD ─────────────────────────────────────────────

  // Escape single quotes in paths by doubling them — PowerShell's
  // single-quoted string convention. Paths from Hyper-V's resolver
  // shouldn't contain quotes, but defensive in case an operator's
  // template path has one.
  const escParent = parent.replace(/'/g, "''");
  const escChild = child.replace(/'/g, "''");
  const script =
    `New-VHD -ParentPath '${escParent}' -Path '${escChild}' -Differencing | Out-Null`;

  try {
    await opts.exec(script, opts.timeoutMs ?? 60_000);
  } catch (err) {
    throw new DifferencingDiskError(
      "ps_failure",
      `New-VHD failed creating differencing disk ${child} ` +
        `(parent: ${parent}): ${(err as Error).message ?? String(err)}`,
      err,
    );
  }

  return {
    parentVhdxPath: parent,
    childVhdxPath: child,
  };
}
