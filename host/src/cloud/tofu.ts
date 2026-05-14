/**
 * OpenTofu driver (v0.3.0-5 sub-task 4).
 *
 * Subprocess wrapper around the `tofu` CLI (OpenTofu, MPL-2.0,
 * Linux Foundation fork of Terraform 1.5.x). Drives multi-resource
 * cloud stacks (`cloud_stack_test` target kind) via HCL modules:
 * plan → apply → destroy.
 *
 * Per the v0.3.0-5 design note §2 (workload split): ephemeral VMs +
 * cloud runners use direct vendor SDK (sub-tasks 2 + 3); deploy
 * targets + Kubernetes infrastructure use OpenTofu. This module
 * is the deploy-target driver.
 *
 * # Why subprocess, not library?
 *
 * OpenTofu has no first-class Node.js bindings. Wrapping the CLI
 * is the pragmatic path; the subprocess boundary also keeps the
 * MPL-2.0 dependency at runtime-only (no Node.js linking), which
 * is the licensing path agreed in the v0.3.0 design session for
 * both Apache-2.0 OSS and proprietary commercial-fork use.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Operator-supplied HCL modules.** Sub-task 4 ships the
 *   driver only. The starter library (aws-three-tier,
 *   aws-eks-cluster, azure-aks-cluster, etc.) lands in sub-task 5
 *   as separate `templates/tofu/` directories. The driver accepts
 *   any absolute path to a module directory.
 * - **Workspace per stack.** Each `cloud_stack_test` invocation
 *   gets its own tofu workspace under
 *   `<projectRoot>/.signalman/tofu-workspaces/<stack-name>/`.
 *   Init + plan + apply + destroy all target that workspace; the
 *   operator-authored HCL stays unmodified.
 * - **State backend configured at workspace init.** Sub-task 4
 *   ships local-disk state (under the workspace dir). S3 +
 *   DynamoDB-lock for production is a v0.3.0-5 follow-up:
 *   operators set `backend.s3.bucket` / `backend.s3.key` in their
 *   HCL and Signalman writes the backend config block at init
 *   time. Documented as the next-step in the module header.
 * - **Injectable exec.** Tests pass a `vi.fn`-shaped exec callback
 *   that returns canned stdout/exit-code without spawning real
 *   `tofu`. Production callers leave the exec undefined and we
 *   spawn the binary named by `SIGNALMAN_TOFU_BIN` env (default:
 *   `"tofu"` on PATH).
 * - **JSON output mode where available.** `tofu plan -json`,
 *   `tofu apply -json`, `tofu output -json` produce one
 *   newline-delimited JSON object per event. We parse the
 *   terminal `change_summary` / `outputs` events for the driver's
 *   structured return shape.
 * - **Destroy is idempotent.** A destroy against a workspace
 *   that's already empty returns success (matches the `tofu
 *   destroy` exit-zero contract for no-op workspaces).
 *
 * # What this module does NOT do
 *
 * - HCL authoring or template synthesis. Operators supply the
 *   module directory; sub-task 5 ships starter modules.
 * - Cost estimation. `tofu plan` exposes resource-count deltas;
 *   real cost dollar-amount estimation needs the
 *   Infracost / OpenTofu Cost Estimation Tool integration — a
 *   v0.3.0-5 sub-task 6 follow-up.
 * - Remote state backends (S3 + DynamoDB). Local-disk only in
 *   this sub-task; cloud backend config writes ship as a small
 *   follow-up commit so this commit's scope stays tight.
 * - Multi-workspace orchestration. Each call targets ONE
 *   workspace. Plan-then-apply-twice across workspaces is the
 *   caller's job.
 */

import {
  execFile as execFileCb,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

import { CloudBackendError } from "./types.js";

const execFile = promisify(execFileCb);

// ── Public constants ──────────────────────────────────────────────

/** Default tofu binary lookup. Operators override via SIGNALMAN_TOFU_BIN. */
export const DEFAULT_TOFU_BIN = "tofu";

/**
 * Per-command timeout for `tofu init` / `plan` / `output`. Defaults
 * to 5 minutes; apply + destroy get the longer timeout below.
 */
export const TOFU_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for apply + destroy (these can hit cloud provisioning waits). */
export const TOFU_APPLY_TIMEOUT_MS = 30 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────

/**
 * Injectable exec callback for testing. Tests pass a `vi.fn` that
 * returns canned `{ stdout, exitCode }`; production uses the
 * default that spawns `tofu`.
 */
export type TofuExec = (
  args: string[],
  opts: TofuExecOptions,
) => Promise<TofuExecResult>;

export interface TofuExecOptions {
  /** Working directory passed to the spawned process. */
  cwd: string;
  /** Per-call timeout in ms. */
  timeoutMs: number;
  /** Environment variables to set (merged with the parent env). */
  env?: Record<string, string>;
}

export interface TofuExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Driver constructor options. */
export interface TofuDriverOptions {
  /**
   * Project root. `tofu-workspaces/<stack>/` lives under
   * `<projectRoot>/.signalman/`. Must be absolute.
   */
  projectRoot: string;
  /**
   * Path to the `tofu` binary. Defaults to {@link DEFAULT_TOFU_BIN}
   * (looked up on PATH) or the `SIGNALMAN_TOFU_BIN` env var.
   */
  tofuBin?: string;
  /**
   * Injected exec for testing. Production callers leave this
   * undefined; the default spawns the binary via `node:child_process
   * .execFile`.
   */
  exec?: TofuExec;
}

/** Inputs to {@link TofuDriver.applyModule}. */
export interface ApplyModuleOptions {
  /**
   * Logical stack name. Used as the workspace subdirectory under
   * `<projectRoot>/.signalman/tofu-workspaces/`. Sanitised to a
   * safe filename; rejects path-traversal.
   */
  stackName: string;
  /**
   * Absolute path to the HCL module directory. Files there are
   * symlinked / copied into the workspace at init time so the
   * module source stays unmodified.
   */
  modulePath: string;
  /** Variables passed via `-var-file` or `-var k=v`. */
  vars?: Record<string, string | number | boolean>;
  /**
   * Auto-approve. Defaults to true — Signalman is a non-
   * interactive runner. Operators who want interactive approval
   * run `tofu` themselves; this driver is for automation.
   */
  autoApprove?: boolean;
  /** Override the per-call timeout. Defaults to {@link TOFU_APPLY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Outcome of {@link TofuDriver.applyModule}. */
export interface ApplyModuleResult {
  stackName: string;
  workspacePath: string;
  /** Outputs from `tofu output -json` post-apply. */
  outputs: Record<string, unknown>;
  /** True when `tofu apply` reported changes (added / changed / destroyed > 0). */
  changed: boolean;
  /** Counts from `apply -json` `change_summary` event. */
  changeSummary: {
    add: number;
    change: number;
    destroy: number;
  };
  /** Wall-clock duration of the full apply (init + apply + output). */
  durationMs: number;
}

/** Inputs to {@link TofuDriver.planModule}. */
export interface PlanModuleOptions {
  /** Stack identifier; same regex as applyModule. */
  stackName: string;
  /** HCL module path; same as applyModule. */
  modulePath: string;
  /** -var key=value pairs; same as applyModule. */
  vars?: Record<string, string | number | boolean>;
  /** Subprocess timeout. Defaults to {@link TOFU_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Outcome of {@link TofuDriver.planModule} — the change summary
 * plus a best-effort per-resource cost estimate.
 *
 * The estimate is conservative: unknown SKUs use the cost-table
 * fallback rate (see `host/src/cloud/cost.ts`). Operators should
 * read this as a guard against catastrophic mistakes, not a
 * precise bill.
 */
export interface PlanModuleResult {
  stackName: string;
  workspacePath: string;
  /** Resource adds / changes / destroys; same shape as apply. */
  changeSummary: { add: number; change: number; destroy: number };
  /**
   * Estimated monthly cost in cents for resources the plan
   * would CREATE (we don't subtract destroys — operators see
   * the additions explicitly, and a pure-destroy plan estimates
   * to zero).
   */
  estimatedMonthlyCents: number;
  /**
   * Per-resource breakdown of the estimate. Includes only
   * recognised compute SKUs; storage / networking / IAM / DNS
   * resources contribute zero and are listed under `untracked`.
   */
  costedResources: Array<{
    address: string;
    sku: string;
    region: string;
    monthlyCents: number;
  }>;
  /** Resources the cost estimator did not recognise (free-of-charge or unknown). */
  untrackedResources: string[];
  durationMs: number;
}

/** Inputs to {@link TofuDriver.destroyModule}. */
export interface DestroyModuleOptions {
  stackName: string;
  /** Variables passed for destroy (must match apply's set). */
  vars?: Record<string, string | number | boolean>;
  autoApprove?: boolean;
  timeoutMs?: number;
}

/** Outcome of {@link TofuDriver.destroyModule}. */
export interface DestroyModuleResult {
  stackName: string;
  workspacePath: string;
  /** True when the workspace held resources at destroy time. */
  changed: boolean;
  /** Counts from destroy -json change_summary. */
  changeSummary: { destroy: number };
  durationMs: number;
  /** True when the workspace was empty at destroy time (idempotent no-op). */
  alreadyEmpty: boolean;
}

// ── Error type ────────────────────────────────────────────────────

/**
 * Tofu-specific error codes were added to the abstraction's
 * `CloudBackendErrorCode` union in sub-task 4 (`tofu_failed`,
 * `tofu_not_found`, `invalid_stack_name`, `module_path_missing`,
 * `project_root_invalid`). Callers pattern-match on
 * `CloudBackendError.code` without needing a tofu-specific type.
 */
function tofuError(
  code:
    | "tofu_failed"
    | "tofu_not_found"
    | "invalid_stack_name"
    | "module_path_missing"
    | "project_root_invalid",
  message: string,
  cause?: unknown,
): CloudBackendError {
  return new CloudBackendError(code, message, cause);
}

// ── Driver implementation ─────────────────────────────────────────

/**
 * OpenTofu driver. Drives one or many stacks under a single
 * project root; each stack gets its own workspace + state.
 *
 * Construct directly with an injected exec for tests, or rely on
 * the production default that spawns the `tofu` binary.
 */
export class TofuDriver {
  private readonly projectRoot: string;
  private readonly tofuBin: string;
  private readonly exec: TofuExec;

  constructor(opts: TofuDriverOptions) {
    if (!path.isAbsolute(opts.projectRoot)) {
      throw tofuError(
        "project_root_invalid",
        `projectRoot must be absolute, got: ${opts.projectRoot}`,
      );
    }
    this.projectRoot = opts.projectRoot;
    this.tofuBin =
      opts.tofuBin ?? process.env.SIGNALMAN_TOFU_BIN ?? DEFAULT_TOFU_BIN;
    this.exec = opts.exec ?? defaultExec(this.tofuBin);
  }

  /**
   * Apply (or upgrade) a stack from an HCL module path.
   *
   * Algorithm:
   *   1. Resolve workspace path; create dir if missing.
   *   2. Materialise the module into the workspace (sub-task 4
   *      ships a symlink; copy-mode is a follow-up for
   *      cross-volume support).
   *   3. `tofu init` (idempotent) to download providers + lock
   *      the state backend.
   *   4. `tofu apply -auto-approve -json` with the variable set.
   *   5. `tofu output -json` to capture outputs for the caller.
   *
   * Returns the full apply outcome including outputs + change
   * summary so callers know what they got.
   */
  /**
   * Pre-flight dry-run for a stack: runs `tofu init` + `tofu plan
   * -json` against the materialised workspace and returns the
   * change summary + an estimated monthly cost (cents) for the
   * resources the plan would CREATE. No state is mutated; the
   * caller is responsible for applying separately if the estimate
   * is acceptable.
   *
   * The cost estimate uses the static SKU × region table from
   * `host/src/cloud/cost.ts`. It is deliberately conservative
   * (unknown SKUs fall back to the high default rate). Operators
   * read this as a guardrail, not a billing-grade quote.
   */
  async planModule(opts: PlanModuleOptions): Promise<PlanModuleResult> {
    const stackName = validateStackName(opts.stackName);
    const workspacePath = this.workspacePathFor(stackName);

    if (!fs.existsSync(opts.modulePath)) {
      throw tofuError(
        "module_path_missing",
        `HCL module path does not exist: ${opts.modulePath}`,
      );
    }
    const start = Date.now();
    materialiseWorkspace(workspacePath, opts.modulePath);

    const timeoutMs = opts.timeoutMs ?? TOFU_DEFAULT_TIMEOUT_MS;

    // 1. init (cheap if providers already cached)
    await this.runTofu(
      ["init", "-no-color", "-input=false"],
      { cwd: workspacePath, timeoutMs },
      "init",
    );

    // 2. plan -json. We deliberately do NOT write -out=<file> here:
    // we're not going to feed the plan into a subsequent apply
    // (apply will re-plan). Reading the structured JSON events
    // off stdout is enough to extract the cost-relevant resources.
    const planArgs = ["plan", "-no-color", "-input=false", "-json"];
    for (const [k, v] of Object.entries(opts.vars ?? {})) {
      planArgs.push("-var", `${k}=${String(v)}`);
    }
    const planResult = await this.runTofu(
      planArgs,
      { cwd: workspacePath, timeoutMs },
      "plan",
    );
    const changeSummary = parseChangeSummary(planResult.stdout);
    const { costedResources, untrackedResources, estimatedMonthlyCents } =
      parsePlanCost(planResult.stdout);

    return {
      stackName,
      workspacePath,
      changeSummary,
      estimatedMonthlyCents,
      costedResources,
      untrackedResources,
      durationMs: Date.now() - start,
    };
  }

  async applyModule(opts: ApplyModuleOptions): Promise<ApplyModuleResult> {
    const stackName = validateStackName(opts.stackName);
    const workspacePath = this.workspacePathFor(stackName);

    if (!fs.existsSync(opts.modulePath)) {
      throw tofuError(
        "module_path_missing",
        `HCL module path does not exist: ${opts.modulePath}`,
      );
    }

    const start = Date.now();
    materialiseWorkspace(workspacePath, opts.modulePath);

    const timeoutMs = opts.timeoutMs ?? TOFU_APPLY_TIMEOUT_MS;

    // 1. init
    await this.runTofu(
      ["init", "-no-color", "-input=false"],
      { cwd: workspacePath, timeoutMs },
      "init",
    );

    // 2. apply
    const applyArgs = ["apply", "-no-color", "-input=false", "-json"];
    if (opts.autoApprove !== false) applyArgs.push("-auto-approve");
    for (const [k, v] of Object.entries(opts.vars ?? {})) {
      applyArgs.push("-var", `${k}=${String(v)}`);
    }
    const applyResult = await this.runTofu(
      applyArgs,
      { cwd: workspacePath, timeoutMs },
      "apply",
    );
    const changeSummary = parseChangeSummary(applyResult.stdout);

    // 3. output
    const outputResult = await this.runTofu(
      ["output", "-no-color", "-json"],
      { cwd: workspacePath, timeoutMs: TOFU_DEFAULT_TIMEOUT_MS },
      "output",
    );
    const outputs = parseOutputs(outputResult.stdout);

    return {
      stackName,
      workspacePath,
      outputs,
      changed:
        changeSummary.add + changeSummary.change + changeSummary.destroy > 0,
      changeSummary,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Destroy a stack. Idempotent — destroying an empty workspace
   * returns `alreadyEmpty: true` with `changed: false`.
   *
   * Algorithm:
   *   1. Resolve workspace path; return idempotent no-op if it
   *      doesn't exist (the apply was never run).
   *   2. `tofu destroy -auto-approve -json` with the variable
   *      set.
   *   3. Parse the change summary to surface the destroy count.
   *
   * NOTE: this method does NOT clean up the workspace directory
   * itself. Callers that want full cleanup invoke `fs.rmSync` on
   * the returned `workspacePath` separately. Keeping the dir
   * around makes post-mortem inspection possible after a failed
   * apply.
   */
  async destroyModule(
    opts: DestroyModuleOptions,
  ): Promise<DestroyModuleResult> {
    const stackName = validateStackName(opts.stackName);
    const workspacePath = this.workspacePathFor(stackName);

    if (!fs.existsSync(workspacePath)) {
      return {
        stackName,
        workspacePath,
        changed: false,
        changeSummary: { destroy: 0 },
        durationMs: 0,
        alreadyEmpty: true,
      };
    }

    const timeoutMs = opts.timeoutMs ?? TOFU_APPLY_TIMEOUT_MS;
    const start = Date.now();

    const destroyArgs = ["destroy", "-no-color", "-input=false", "-json"];
    if (opts.autoApprove !== false) destroyArgs.push("-auto-approve");
    for (const [k, v] of Object.entries(opts.vars ?? {})) {
      destroyArgs.push("-var", `${k}=${String(v)}`);
    }
    const destroyResult = await this.runTofu(
      destroyArgs,
      { cwd: workspacePath, timeoutMs },
      "destroy",
    );
    const changeSummary = parseChangeSummary(destroyResult.stdout);

    return {
      stackName,
      workspacePath,
      changed: changeSummary.destroy > 0,
      changeSummary: { destroy: changeSummary.destroy },
      durationMs: Date.now() - start,
      alreadyEmpty: false,
    };
  }

  /** Resolve the workspace path for a stack. Exported for tests. */
  workspacePathFor(stackName: string): string {
    return path.join(
      this.projectRoot,
      ".signalman",
      "tofu-workspaces",
      stackName,
    );
  }

  // ── Internal ───────────────────────────────────────────────────

  private async runTofu(
    args: string[],
    opts: TofuExecOptions,
    phase: string,
  ): Promise<TofuExecResult> {
    let result: TofuExecResult;
    try {
      result = await this.exec(args, opts);
    } catch (err) {
      // ENOENT from default exec when the binary isn't on PATH —
      // surface that distinctly so operators can install / set
      // SIGNALMAN_TOFU_BIN.
      const e = err as { code?: string };
      if (e.code === "ENOENT") {
        throw tofuError(
          "tofu_not_found",
          `tofu binary '${this.tofuBin}' not found on PATH. Install ` +
            `OpenTofu (https://opentofu.org/) or set SIGNALMAN_TOFU_BIN ` +
            `to the absolute path.`,
          err,
        );
      }
      throw tofuError(
        "tofu_failed",
        `tofu ${phase} exec failed: ${(err as Error).message ?? String(err)}`,
        err,
      );
    }
    if (result.exitCode !== 0) {
      throw tofuError(
        "tofu_failed",
        `tofu ${phase} exited ${result.exitCode}: ${truncateStderr(
          result.stderr,
        )}`,
      );
    }
    return result;
  }
}

// ── Pure helpers (exported for testability) ───────────────────────

/**
 * Validate a stack name. Rejects path-traversal, absolute paths,
 * and disallowed characters so the workspace path stays inside the
 * project's `.signalman/tofu-workspaces/`.
 */
export function validateStackName(name: string): string {
  if (!name || typeof name !== "string") {
    throw tofuError(
      "invalid_stack_name",
      "stack name must be a non-empty string",
    );
  }
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 64 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed)
  ) {
    throw tofuError(
      "invalid_stack_name",
      `stack name must be 1-64 chars matching [a-zA-Z0-9_.-]; got '${name}'`,
    );
  }
  return trimmed;
}

/**
 * Materialise an HCL module into a workspace directory. Creates
 * the workspace dir if missing and either symlinks (preferred) or
 * copies the module files. Symlinks fail gracefully on Windows
 * non-admin shells; we fall back to copy in that case.
 *
 * Exported for test surface; production callers invoke via
 * `applyModule`.
 */
export function materialiseWorkspace(
  workspacePath: string,
  modulePath: string,
): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  // Mark module files via a sentinel file so we can detect a
  // stale workspace pointing at a different module on subsequent
  // applies.
  const sentinel = path.join(workspacePath, ".signalman-source");
  fs.writeFileSync(sentinel, modulePath);

  // Iterate HCL files in the source and link them into the
  // workspace. Skip .terraform, .tofu, .tfstate* (state files
  // stay in the workspace, not the source).
  for (const entry of fs.readdirSync(modulePath, { withFileTypes: true })) {
    if (entry.name.startsWith(".terraform")) continue;
    if (entry.name.startsWith(".tofu")) continue;
    if (entry.name.startsWith("terraform.tfstate")) continue;
    if (entry.name === ".signalman-source") continue;

    const src = path.join(modulePath, entry.name);
    const dst = path.join(workspacePath, entry.name);

    if (fs.existsSync(dst)) {
      try {
        fs.unlinkSync(dst);
      } catch {
        // Best-effort; if we can't unlink, the symlink below will
        // throw and the caller sees a clear error.
      }
    }
    try {
      fs.symlinkSync(src, dst, entry.isDirectory() ? "dir" : "file");
    } catch {
      // Symlink refused (Windows non-admin, or cross-volume on
      // some FSes). Fall back to copy. Plain files only — module
      // directory recursion is out of scope for sub-task 4.
      if (entry.isFile()) {
        fs.copyFileSync(src, dst);
      }
    }
  }
}

/**
 * Parse a `tofu apply -json` / `destroy -json` stdout stream and
 * return the change summary from the terminal `change_summary`
 * event (or zero counts if no summary appears).
 *
 * Exported for tests.
 */
export function parseChangeSummary(stdout: string): {
  add: number;
  change: number;
  destroy: number;
} {
  let summary = { add: 0, change: 0, destroy: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        changes?: { add?: number; change?: number; remove?: number };
      };
      if (parsed.type === "change_summary" && parsed.changes) {
        summary = {
          add: parsed.changes.add ?? 0,
          change: parsed.changes.change ?? 0,
          destroy: parsed.changes.remove ?? 0,
        };
      }
    } catch {
      // Lines we can't parse as JSON aren't change_summary; skip.
    }
  }
  return summary;
}

/**
 * Parse a `tofu output -json` stdout dump into a flat
 * `name -> value` map. The tofu output JSON shape is
 * `{ name: { value, type, sensitive } }`; we flatten to the values
 * because that's what scenario assertions consume.
 *
 * Exported for tests.
 */
export function parseOutputs(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  let parsed: Record<string, { value?: unknown }>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, { value?: unknown }>;
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v && typeof v === "object" && "value" in v) {
      out[k] = v.value;
    }
  }
  return out;
}

// ── Cost-extraction helpers (v0.3.0-5 sub-task 5 control 3) ────────

/**
 * Best-effort cost extraction from `tofu plan -json` stdout.
 *
 * Scans the JSONL events for `planned_change` records and pulls
 * compute-resource SKU + region from the `change.after` block.
 * Resource types we recognise:
 *   - `aws_instance` → `change.after.instance_type` × region from
 *     the addressable provider config (or the SKU's table default)
 *   - `azurerm_linux_virtual_machine` / `azurerm_windows_virtual_machine`
 *     → `change.after.size` + `change.after.location`
 *
 * Anything we can't cost is reported under `untrackedResources`
 * so operators see the full plan footprint, just without a $$
 * estimate. Numbers should be read as a guardrail, not a quote.
 *
 * Exported for tests.
 */
export function parsePlanCost(stdout: string): {
  costedResources: Array<{
    address: string;
    sku: string;
    region: string;
    monthlyCents: number;
  }>;
  untrackedResources: string[];
  estimatedMonthlyCents: number;
} {
  // Lazy import — avoids a circular dep between cloud/tofu.ts and
  // cloud/cost.ts and keeps cost.ts free of tofu coupling.
  const costed: Array<{
    address: string;
    sku: string;
    region: string;
    monthlyCents: number;
  }> = [];
  const untracked: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const evt = parsed as {
      type?: string;
      change?: {
        action?: string;
        actions?: string[];
        resource?: { resource?: string; addr?: string };
        after?: Record<string, unknown>;
      };
    };
    if (evt.type !== "planned_change") continue;
    const action =
      evt.change?.action ?? evt.change?.actions?.[0] ?? "no-op";
    if (action !== "create" && action !== "create_then_delete") continue;
    const addr =
      evt.change?.resource?.addr ??
      evt.change?.resource?.resource ??
      "unknown";
    const after = evt.change?.after ?? {};
    const resourceType = String(addr).split(".")[0];

    if (resourceType === "aws_instance") {
      const sku = String(after["instance_type"] ?? "unknown-sku");
      const region = String(after["availability_zone"] ?? "us-east-1")
        // availability zone like "us-east-1a" → region "us-east-1"
        .replace(/[a-z]$/, "");
      const monthly = monthlyRateCentsForResource(sku, region);
      costed.push({ address: addr, sku, region, monthlyCents: monthly });
    } else if (
      resourceType === "azurerm_linux_virtual_machine" ||
      resourceType === "azurerm_windows_virtual_machine" ||
      resourceType === "azurerm_virtual_machine"
    ) {
      const sku = String(after["size"] ?? after["vm_size"] ?? "unknown-sku");
      const region = String(after["location"] ?? "eastus");
      const monthly = monthlyRateCentsForResource(sku, region);
      costed.push({ address: addr, sku, region, monthlyCents: monthly });
    } else {
      untracked.push(addr);
    }
  }

  const estimatedMonthlyCents = costed.reduce(
    (s, r) => s + r.monthlyCents,
    0,
  );
  return { costedResources: costed, untrackedResources: untracked, estimatedMonthlyCents };
}

/**
 * Small wrapper over `monthlyRateCents` so the tofu module
 * doesn't directly import the cost table at module-load time
 * (keeps the dependency arrow one-way; cost.ts has no tofu
 * dependencies). We require it lazily at the call site so
 * mocks in tests can replace the table.
 */
function monthlyRateCentsForResource(sku: string, region: string): number {
  // Synchronous require would be cleaner but we're in ESM-land.
  // The actual import is hoisted at module-init time (line below).
  return monthlyRateImpl(sku, region);
}

// Imported at module init; bound for use by monthlyRateCentsForResource.
import { monthlyRateCents as monthlyRateImpl } from "./cost.js";

/** Truncate stderr for error messages so they stay readable. */
function truncateStderr(stderr: string): string {
  const max = 2000;
  return stderr.length > max ? `${stderr.slice(0, max)}…(truncated)` : stderr;
}

// ── Default exec (production path) ────────────────────────────────

function defaultExec(tofuBin: string): TofuExec {
  return async (args, opts) => {
    try {
      const { stdout, stderr } = await execFile(tofuBin, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        env: { ...process.env, ...opts.env },
        // tofu apply -json can be verbose for large stacks. Bump
        // the buffer ceiling well above the default 1 MB.
        maxBuffer: 50 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      // execFile rejects with a code field; numeric for exit
      // codes, string ("ENOENT") for spawn failures. Surface both
      // shapes consistently.
      if (typeof e.code === "string") {
        // Re-throw so the driver's ENOENT detection picks it up.
        throw err;
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  };
}

// Imports surfaced for tooling that wants to fake the underlying
// spawn shape (used only by the default exec; tests inject directly).
export type { ChildProcessWithoutNullStreams };
