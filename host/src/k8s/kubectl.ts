/**
 * KubectlDriver (v0.3.0-6 sub-task 1).
 *
 * Subprocess wrapper around the `kubectl` CLI. Mirrors the
 * `TofuDriver` pattern in `cloud/tofu.ts`: pure-function helpers
 * for argv composition + status JSON parsing, injectable exec for
 * tests, and a closed set of stable error codes that callers
 * dispatch on without parsing message strings.
 *
 * Scope:
 *   - `apply(bundleUri, namespace, context?)`: runs
 *     `kubectl apply -k <bundle>` for directories (kustomize-aware)
 *     and `kubectl apply -f <bundle>` for single files. The driver
 *     also accepts a directory without kustomization.yaml by passing
 *     `-f` instead of `-k` so the operator doesn't have to author
 *     one for simple manifest bundles.
 *   - `rollback(releaseId, namespace)`: `kubectl rollout undo
 *     deployment/<name>` (or any other rollout subject).
 *   - `status(namespace)`: `kubectl get deployments -o json`,
 *     parses replica counts, derives healthy/degraded/unknown.
 *   - `health(namespace, timeout)`: `kubectl wait
 *     --for=condition=ready pod --all` (or `-l <selector>`).
 *
 * The driver does NOT mutate `$KUBECONFIG` or shell state; the
 * context flag is always passed inline so multi-tenant runs and
 * tests cohabit safely.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  K8sDriverError,
  K8S_DEFAULT_HEALTH_TIMEOUT_MS,
  K8S_DEFAULT_TIMEOUT_MS,
  K8S_STDOUT_TAIL_BYTES,
  DEFAULT_KUBECTL_BIN,
  type K8sApplyOptions,
  type K8sApplyResult,
  type K8sBundleKind,
  type K8sExec,
  type K8sExecOptions,
  type K8sExecResult,
  type K8sHealthOptions,
  type K8sHealthResult,
  type K8sRollbackOptions,
  type K8sRollbackResult,
  type K8sStatusOptions,
  type K8sStatusResult,
  type K8sWorkloadStatus,
} from "./types.js";
import { detectBundleKind, hasKustomization } from "./bundle.js";
import { makeDefaultExec } from "./exec.js";

// ── Driver options ─────────────────────────────────────────────────

export interface KubectlDriverOptions {
  /**
   * Path to the kubectl binary. Defaults to {@link DEFAULT_KUBECTL_BIN}
   * (looked up on PATH) or the `SIGNALMAN_KUBECTL_BIN` env var.
   */
  kubectlBin?: string;
  /**
   * Injected exec for testing. Production callers leave undefined;
   * the default spawner from `exec.ts` is used.
   */
  exec?: K8sExec;
}

// ── Driver implementation ──────────────────────────────────────────

export class KubectlDriver {
  private readonly kubectlBin: string;
  private readonly exec: K8sExec;

  constructor(opts: KubectlDriverOptions = {}) {
    this.kubectlBin =
      opts.kubectlBin ??
      process.env.SIGNALMAN_KUBECTL_BIN ??
      DEFAULT_KUBECTL_BIN;
    this.exec = opts.exec ?? makeDefaultExec();
  }

  /**
   * Apply a manifest bundle to a namespace.
   *
   * Algorithm:
   *   1. Validate `bundleUri` exists (via {@link detectBundleKind}).
   *   2. Reject helm-chart bundles — caller should dispatch to
   *      `HelmDriver`. The executor module enforces this; we
   *      defend in depth in case a caller bypasses it.
   *   3. Compose argv: `apply -k <dir>` if a `kustomization.yaml`
   *      is present, else `apply -f <bundleUri>` (file or dir).
   *   4. Run the subprocess, classify exit codes / stderr into
   *      structured K8sDriverError.
   */
  async apply(opts: K8sApplyOptions): Promise<K8sApplyResult> {
    const bundleKind = detectBundleKind(opts.bundleUri);
    if (bundleKind !== "manifest") {
      throw new K8sDriverError(
        "kubectl_failed",
        `KubectlDriver cannot apply a ${bundleKind} bundle; ` +
          "dispatch through HelmDriver instead.",
      );
    }

    const args = buildApplyArgs({
      bundleUri: opts.bundleUri,
      namespace: opts.namespace,
      context: opts.context,
    });

    const start = Date.now();
    const result = await this.runKubectl(args, {
      timeoutMs: opts.timeoutMs ?? K8S_DEFAULT_TIMEOUT_MS,
    });

    return {
      releaseName: opts.releaseName ?? deriveReleaseName(opts.bundleUri),
      namespace: opts.namespace,
      driver: "kubectl",
      bundleKind,
      stdoutTail: tailStdout(result.stdout),
      durationMs: Date.now() - start,
    };
  }

  /**
   * Roll back a workload. `releaseId` is the rollout subject the
   * operator wants reverted — `deployment/foo`, `daemonset/bar`,
   * etc. When `toRevision` is set, the driver forwards it as
   * `--to-revision=<n>`; otherwise kubectl picks the immediately-
   * preceding revision.
   */
  async rollback(opts: K8sRollbackOptions): Promise<K8sRollbackResult> {
    const args = buildRollbackArgs({
      releaseId: opts.releaseId,
      namespace: opts.namespace,
      context: opts.context,
      toRevision: opts.toRevision,
    });

    const start = Date.now();
    const result = await this.runKubectl(args, {
      timeoutMs: opts.timeoutMs ?? K8S_DEFAULT_TIMEOUT_MS,
    });

    return {
      releaseId: opts.releaseId,
      namespace: opts.namespace,
      driver: "kubectl",
      toRevision: opts.toRevision ?? null,
      stdoutTail: tailStdout(result.stdout),
      durationMs: Date.now() - start,
    };
  }

  /**
   * Read deployment statuses in a namespace and roll them up into
   * the normalised {@link K8sStatusResult} shape.
   */
  async status(opts: K8sStatusOptions): Promise<K8sStatusResult> {
    const args = buildStatusArgs({
      namespace: opts.namespace,
      context: opts.context,
      selector: opts.selector,
    });
    const result = await this.runKubectl(args, {
      timeoutMs: opts.timeoutMs ?? K8S_DEFAULT_TIMEOUT_MS,
    });
    const workloads = parseDeploymentsJson(result.stdout);
    return {
      namespace: opts.namespace,
      workloads,
      allHealthy:
        workloads.length > 0 && workloads.every((w) => w.state === "healthy"),
    };
  }

  /**
   * Wait for all pods (optionally filtered by selector) in a
   * namespace to reach `condition=ready`. Returns a structured
   * `not_ready` rather than throwing when kubectl exits non-zero
   * due to a timeout — callers want a boolean, not an exception.
   */
  async health(opts: K8sHealthOptions): Promise<K8sHealthResult> {
    const waitMs = opts.timeoutMs ?? K8S_DEFAULT_HEALTH_TIMEOUT_MS;
    const args = buildHealthArgs({
      namespace: opts.namespace,
      context: opts.context,
      selector: opts.selector,
      waitMs,
    });
    // Subprocess timeout slightly above the kubectl wait deadline so
    // the wait expires first and we can classify "not ready" from
    // "subprocess died".
    const subprocessTimeoutMs = waitMs + 5_000;

    const start = Date.now();
    let result: K8sExecResult;
    try {
      result = await this.exec(this.kubectlBin, args, {
        timeoutMs: subprocessTimeoutMs,
      });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") {
        throw new K8sDriverError(
          "kubectl_not_found",
          notFoundMessage("kubectl", this.kubectlBin, "SIGNALMAN_KUBECTL_BIN"),
          err,
        );
      }
      throw new K8sDriverError(
        "kubectl_failed",
        `kubectl wait exec failed: ${(err as Error).message ?? String(err)}`,
        err,
      );
    }

    if (result.exitCode === 0) {
      return {
        namespace: opts.namespace,
        ready: true,
        detail: null,
        durationMs: Date.now() - start,
      };
    }
    // kubectl wait exits 1 on timeout. Surface as `ready: false`
    // instead of throwing so the caller can do its own health
    // bookkeeping. Hard failures (auth, missing namespace) still
    // turn into K8sDriverError via the shared classifier.
    const classified = classifyStderr(result.stderr);
    if (classified) {
      throw new K8sDriverError(classified, result.stderr.trim(), {
        exitCode: result.exitCode,
      });
    }
    return {
      namespace: opts.namespace,
      ready: false,
      detail: tailStdout(result.stderr || result.stdout),
      durationMs: Date.now() - start,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async runKubectl(
    args: string[],
    opts: K8sExecOptions,
  ): Promise<K8sExecResult> {
    let result: K8sExecResult;
    try {
      result = await this.exec(this.kubectlBin, args, opts);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") {
        throw new K8sDriverError(
          "kubectl_not_found",
          notFoundMessage("kubectl", this.kubectlBin, "SIGNALMAN_KUBECTL_BIN"),
          err,
        );
      }
      throw new K8sDriverError(
        "kubectl_failed",
        `kubectl exec failed: ${(err as Error).message ?? String(err)}`,
        err,
      );
    }
    if (result.exitCode !== 0) {
      const classified = classifyStderr(result.stderr);
      throw new K8sDriverError(
        classified ?? "kubectl_failed",
        `kubectl exited ${result.exitCode}: ${tailStdout(result.stderr)}`,
        { exitCode: result.exitCode, stderr: result.stderr },
      );
    }
    return result;
  }
}

// ── Pure helpers (exported for unit tests) ─────────────────────────

export interface BuildApplyArgsInput {
  bundleUri: string;
  namespace: string;
  context?: string;
}

/**
 * Compose the argv for `kubectl apply`. Pure and side-effect-free;
 * the only filesystem touch is the `hasKustomization` check on a
 * directory bundle. Exported so unit tests can pin the exact argv
 * without spawning kubectl.
 */
export function buildApplyArgs(input: BuildApplyArgsInput): string[] {
  const args = ["apply"];
  pushContextAndNamespace(args, input);
  if (
    fs.existsSync(input.bundleUri) &&
    fs.statSync(input.bundleUri).isDirectory() &&
    hasKustomization(input.bundleUri)
  ) {
    args.push("-k", input.bundleUri);
  } else {
    args.push("-f", input.bundleUri);
  }
  return args;
}

export interface BuildRollbackArgsInput {
  releaseId: string;
  namespace: string;
  context?: string;
  toRevision?: number;
}

export function buildRollbackArgs(input: BuildRollbackArgsInput): string[] {
  const args = ["rollout", "undo"];
  pushContextAndNamespace(args, input);
  args.push(input.releaseId);
  if (typeof input.toRevision === "number") {
    args.push(`--to-revision=${input.toRevision}`);
  }
  return args;
}

export interface BuildStatusArgsInput {
  namespace: string;
  context?: string;
  selector?: string;
}

export function buildStatusArgs(input: BuildStatusArgsInput): string[] {
  const args = ["get", "deployments"];
  pushContextAndNamespace(args, input);
  if (input.selector) args.push("-l", input.selector);
  args.push("-o", "json");
  return args;
}

export interface BuildHealthArgsInput {
  namespace: string;
  context?: string;
  selector?: string;
  /** Wait timeout in ms — converted to whole seconds for kubectl. */
  waitMs: number;
}

export function buildHealthArgs(input: BuildHealthArgsInput): string[] {
  const args = ["wait", "--for=condition=Ready", "pod"];
  pushContextAndNamespace(args, input);
  if (input.selector) {
    args.push("-l", input.selector);
  } else {
    args.push("--all");
  }
  const seconds = Math.max(1, Math.ceil(input.waitMs / 1000));
  args.push(`--timeout=${seconds}s`);
  return args;
}

/**
 * Parse `kubectl get deployments -o json` into normalised
 * {@link K8sWorkloadStatus} entries. Tolerates an unexpected JSON
 * shape by returning an empty list rather than throwing — kubectl
 * is the source of truth, and a shape mismatch is treated as
 * `state: unknown` by the executor.
 *
 * Exported for unit tests.
 */
export function parseDeploymentsJson(stdout: string): K8sWorkloadStatus[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    return [];
  }
  const items = (parsed as { items: unknown[] }).items;
  const out: K8sWorkloadStatus[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as {
      kind?: string;
      metadata?: { name?: string };
      status?: {
        replicas?: number;
        readyReplicas?: number;
        availableReplicas?: number;
      };
    };
    const name = obj.metadata?.name ?? "";
    const kind = obj.kind ?? "Deployment";
    const replicas = obj.status?.replicas ?? 0;
    const readyReplicas = obj.status?.readyReplicas ?? 0;
    const availableReplicas = obj.status?.availableReplicas ?? 0;
    let state: K8sWorkloadStatus["state"];
    if (replicas === 0) state = "unknown";
    else if (readyReplicas === replicas) state = "healthy";
    else state = "degraded";
    out.push({
      name,
      kind,
      replicas,
      readyReplicas,
      availableReplicas,
      state,
    });
  }
  return out;
}

/**
 * Walk a stderr blob from kubectl and return a more specific stable
 * code when one of the well-known phrases matches. Returns `null`
 * when no specific classification applies — the caller falls back
 * to `kubectl_failed`.
 *
 * Exported for unit tests so the classifier can evolve without
 * breaking the driver in non-obvious ways.
 */
export function classifyStderr(stderr: string): "cluster_auth_failed" | "namespace_missing" | null {
  if (!stderr) return null;
  const lower = stderr.toLowerCase();
  // Match kubectl's most common auth-failure idioms. The trailing
  // codes (401, 403) are also matched as substrings so we catch
  // "the server has asked for the client to provide credentials"
  // (no explicit code) alongside "Unauthorized: 401".
  if (
    lower.includes("unable to load credentials") ||
    lower.includes("forbidden") ||
    lower.includes("unauthorized") ||
    lower.includes("the server has asked for the client to provide credentials") ||
    lower.includes("error: you must be logged in to the server")
  ) {
    return "cluster_auth_failed";
  }
  // `Error from server (NotFound): namespaces "foo" not found`
  // is kubectl's stable phrase for a missing namespace. Match
  // case-insensitively; some kubectl versions capitalise differently.
  if (/namespaces?\s+"[^"]+"\s+not\s+found/i.test(stderr)) {
    return "namespace_missing";
  }
  return null;
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
  if (input.context) args.push("--context", input.context);
  args.push("--namespace", input.namespace);
}

function deriveReleaseName(bundleUri: string): string {
  const base = path.basename(bundleUri).replace(/\.(ya?ml)$/i, "");
  return base.length > 0 ? base : "signalman-release";
}

function tailStdout(stdout: string): string {
  if (stdout.length <= K8S_STDOUT_TAIL_BYTES) return stdout;
  return `…(truncated)${stdout.slice(stdout.length - K8S_STDOUT_TAIL_BYTES)}`;
}

function notFoundMessage(
  tool: string,
  bin: string,
  envVar: string,
): string {
  return (
    `${tool} binary '${bin}' not found on PATH. Install ${tool} ` +
    `(https://kubernetes.io/docs/tasks/tools/) or set ${envVar} to ` +
    "an absolute path."
  );
}
