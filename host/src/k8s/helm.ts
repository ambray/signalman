/**
 * HelmDriver (v0.3.0-6 sub-task 1).
 *
 * Subprocess wrapper around the `helm` CLI for chart-shaped K8s
 * bundles. Mirrors `KubectlDriver` in surface (apply / rollback /
 * status) and error semantics (`helm_failed` / `helm_not_found`,
 * with `cluster_auth_failed` + `namespace_missing` re-classified
 * from stderr).
 *
 * Verb mapping:
 *   - apply()    → `helm upgrade --install <release> <chart>`
 *   - rollback() → `helm rollback <release> [<revision>]`
 *   - status()   → `helm status <release> -o json`
 *
 * Helm does not have an equivalent of `kubectl wait`, so health is
 * delegated to `KubectlDriver.health` in the executor — Helm
 * surfaces only the release/status mapping that's helm-specific.
 */

import * as path from "node:path";

import {
  K8sDriverError,
  K8S_DEFAULT_TIMEOUT_MS,
  K8S_STDOUT_TAIL_BYTES,
  DEFAULT_HELM_BIN,
  type K8sApplyOptions,
  type K8sApplyResult,
  type K8sExec,
  type K8sExecOptions,
  type K8sExecResult,
  type K8sRollbackOptions,
  type K8sRollbackResult,
  type K8sStatusOptions,
  type K8sStatusResult,
  type K8sWorkloadStatus,
} from "./types.js";
import { detectBundleKind } from "./bundle.js";
import { makeDefaultExec } from "./exec.js";
import { classifyStderr } from "./kubectl.js";

// ── Driver options ─────────────────────────────────────────────────

export interface HelmDriverOptions {
  helmBin?: string;
  exec?: K8sExec;
}

// ── Driver implementation ──────────────────────────────────────────

export class HelmDriver {
  private readonly helmBin: string;
  private readonly exec: K8sExec;

  constructor(opts: HelmDriverOptions = {}) {
    this.helmBin =
      opts.helmBin ?? process.env.SIGNALMAN_HELM_BIN ?? DEFAULT_HELM_BIN;
    this.exec = opts.exec ?? makeDefaultExec();
  }

  /**
   * Install or upgrade a Helm chart. Uses `helm upgrade --install`
   * so the same command handles first-deploy and update.
   *
   * `releaseName` defaults to the chart directory basename. Helm
   * release names are scoped to a namespace, so the (namespace,
   * release) pair is the durable identifier.
   */
  async apply(opts: K8sApplyOptions): Promise<K8sApplyResult> {
    const bundleKind = detectBundleKind(opts.bundleUri);
    if (bundleKind !== "helm_chart") {
      throw new K8sDriverError(
        "helm_failed",
        `HelmDriver cannot apply a ${bundleKind} bundle; ` +
          "dispatch through KubectlDriver instead.",
      );
    }
    const releaseName = opts.releaseName ?? deriveReleaseName(opts.bundleUri);
    const args = buildHelmApplyArgs({
      releaseName,
      chartPath: opts.bundleUri,
      namespace: opts.namespace,
      context: opts.context,
    });
    const start = Date.now();
    const result = await this.runHelm(args, {
      timeoutMs: opts.timeoutMs ?? K8S_DEFAULT_TIMEOUT_MS,
    });
    return {
      releaseName,
      namespace: opts.namespace,
      driver: "helm",
      bundleKind,
      stdoutTail: tailStdout(result.stdout),
      durationMs: Date.now() - start,
    };
  }

  /**
   * Roll a Helm release back to a prior revision. Without
   * `toRevision`, Helm picks the immediately preceding revision —
   * the common "undo last deploy" case.
   */
  async rollback(opts: K8sRollbackOptions): Promise<K8sRollbackResult> {
    const args = buildHelmRollbackArgs({
      releaseName: opts.releaseId,
      namespace: opts.namespace,
      context: opts.context,
      toRevision: opts.toRevision,
    });
    const start = Date.now();
    const result = await this.runHelm(args, {
      timeoutMs: opts.timeoutMs ?? K8S_DEFAULT_TIMEOUT_MS,
    });
    return {
      releaseId: opts.releaseId,
      namespace: opts.namespace,
      driver: "helm",
      toRevision: opts.toRevision ?? null,
      stdoutTail: tailStdout(result.stdout),
      durationMs: Date.now() - start,
    };
  }

  /**
   * Read the helm release's status JSON and roll it up into the
   * shared {@link K8sStatusResult} shape so callers don't need to
   * branch on driver. We materialise a single "workload" per helm
   * release with state derived from `status.info.status` —
   * "deployed" → healthy, everything else → degraded/unknown.
   *
   * For finer-grained pod-level health, callers compose with
   * `KubectlDriver.status` over the same namespace; this method
   * intentionally stays helm-shaped.
   */
  async status(
    opts: K8sStatusOptions & { releaseName?: string },
  ): Promise<K8sStatusResult> {
    if (!opts.releaseName) {
      throw new K8sDriverError(
        "helm_failed",
        "HelmDriver.status requires a releaseName",
      );
    }
    const args = buildHelmStatusArgs({
      releaseName: opts.releaseName,
      namespace: opts.namespace,
      context: opts.context,
    });
    const result = await this.runHelm(args, {
      timeoutMs: opts.timeoutMs ?? K8S_DEFAULT_TIMEOUT_MS,
    });
    const workload = parseHelmStatusJson(result.stdout, opts.releaseName);
    return {
      namespace: opts.namespace,
      workloads: workload ? [workload] : [],
      allHealthy: workload?.state === "healthy",
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async runHelm(
    args: string[],
    opts: K8sExecOptions,
  ): Promise<K8sExecResult> {
    let result: K8sExecResult;
    try {
      result = await this.exec(this.helmBin, args, opts);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") {
        throw new K8sDriverError(
          "helm_not_found",
          notFoundMessage("helm", this.helmBin, "SIGNALMAN_HELM_BIN"),
          err,
        );
      }
      throw new K8sDriverError(
        "helm_failed",
        `helm exec failed: ${(err as Error).message ?? String(err)}`,
        err,
      );
    }
    if (result.exitCode !== 0) {
      // Reuse the kubectl classifier — helm surfaces the same
      // upstream auth + namespace errors when it can't reach the
      // cluster, since helm-go uses client-go under the hood.
      const classified = classifyStderr(result.stderr);
      throw new K8sDriverError(
        classified ?? "helm_failed",
        `helm exited ${result.exitCode}: ${tailStdout(result.stderr)}`,
        { exitCode: result.exitCode, stderr: result.stderr },
      );
    }
    return result;
  }
}

// ── Pure helpers (exported for unit tests) ─────────────────────────

export interface BuildHelmApplyArgsInput {
  releaseName: string;
  chartPath: string;
  namespace: string;
  context?: string;
}

export function buildHelmApplyArgs(input: BuildHelmApplyArgsInput): string[] {
  const args = ["upgrade", "--install", input.releaseName, input.chartPath];
  pushContextAndNamespace(args, input);
  args.push("--create-namespace");
  return args;
}

export interface BuildHelmRollbackArgsInput {
  releaseName: string;
  namespace: string;
  context?: string;
  toRevision?: number;
}

export function buildHelmRollbackArgs(
  input: BuildHelmRollbackArgsInput,
): string[] {
  const args = ["rollback", input.releaseName];
  if (typeof input.toRevision === "number") {
    args.push(String(input.toRevision));
  }
  pushContextAndNamespace(args, input);
  return args;
}

export interface BuildHelmStatusArgsInput {
  releaseName: string;
  namespace: string;
  context?: string;
}

export function buildHelmStatusArgs(input: BuildHelmStatusArgsInput): string[] {
  const args = ["status", input.releaseName];
  pushContextAndNamespace(args, input);
  args.push("-o", "json");
  return args;
}

/**
 * Parse `helm status <release> -o json` into a single normalised
 * {@link K8sWorkloadStatus} entry. Returns null when the JSON is
 * unparseable so callers can show an empty workload list rather
 * than crash.
 *
 * Helm's status JSON is `{ name, namespace, info: { status: ... } }`.
 * We map `status === "deployed"` to `healthy`, any in-flight
 * state (pending-install / pending-upgrade / pending-rollback) to
 * `unknown`, and anything else (failed, superseded) to `degraded`.
 *
 * Exported for unit tests.
 */
export function parseHelmStatusJson(
  stdout: string,
  releaseName: string,
): K8sWorkloadStatus | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    name?: string;
    info?: { status?: string };
  };
  const status = (obj.info?.status ?? "").toLowerCase();
  let state: K8sWorkloadStatus["state"];
  if (status === "deployed") state = "healthy";
  else if (status.startsWith("pending")) state = "unknown";
  else state = "degraded";
  return {
    name: obj.name ?? releaseName,
    kind: "HelmRelease",
    // Helm doesn't surface pod-level replica counts at the release
    // level — leave the counts at zero so callers know to compose
    // KubectlDriver.status for fine-grained data.
    replicas: 0,
    readyReplicas: 0,
    availableReplicas: 0,
    state,
  };
}

// ── Internal helpers ───────────────────────────────────────────────

interface ContextNamespaceFlags {
  namespace: string;
  context?: string;
}

function pushContextAndNamespace(
  args: string[],
  input: ContextNamespaceFlags,
): void {
  if (input.context) args.push("--kube-context", input.context);
  args.push("--namespace", input.namespace);
}

function deriveReleaseName(bundleUri: string): string {
  const base = path.basename(bundleUri);
  return base.length > 0 ? base : "signalman-release";
}

function tailStdout(stdout: string): string {
  if (stdout.length <= K8S_STDOUT_TAIL_BYTES) return stdout;
  return `…(truncated)${stdout.slice(stdout.length - K8S_STDOUT_TAIL_BYTES)}`;
}

function notFoundMessage(tool: string, bin: string, envVar: string): string {
  return (
    `${tool} binary '${bin}' not found on PATH. Install ${tool} ` +
    `(https://helm.sh/docs/intro/install/) or set ${envVar} to an absolute path.`
  );
}
