/**
 * Kubernetes driver abstraction (v0.3.0-6 sub-task 1).
 *
 * Mirrors the shape of `host/src/cloud/types.ts`: small, focused
 * types for the kubectl + helm subprocess drivers and a stable-code
 * error class. Production callers go through the higher-level entry
 * point `runK8sDeploy` in `executor.ts`; this module is the typed
 * surface the drivers expose to the executor and to tests.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Subprocess, not library.** `kubectl` and `helm` have no first-
 *   class Node bindings; wrapping the CLI keeps the subprocess
 *   licensing boundary clean and avoids pinning a specific client-go
 *   version. Matches the OpenTofu pattern in `cloud/tofu.ts`.
 * - **Bundle-kind autodetect.** A bundle that contains `Chart.yaml`
 *   at its root is treated as a Helm chart and dispatched to
 *   `HelmDriver`; everything else is `kubectl apply -k` (raw
 *   manifests or a Kustomize directory). The detection is in
 *   `bundle.ts` so both drivers and the executor share it.
 * - **Stable error codes.** Callers (MCP tool handlers, CLI verbs)
 *   pattern-match on `K8sDriverError.code` without parsing message
 *   strings. The code set is closed; new failure modes get new
 *   members of the union.
 * - **Injectable `exec`.** Tests pass a `vi.fn` shaped exec callback
 *   that returns canned `{ stdout, stderr, exitCode }`; production
 *   spawns the binary via `node:child_process.execFile`. Same shape
 *   as `TofuExec` so the existing test patterns apply.
 * - **Namespace + context are flags, not env.** Each driver call
 *   takes an explicit `namespace` (and optional `context`); we do
 *   NOT mutate `$KUBECONFIG` or rely on shell state. Tests and
 *   multi-tenant runs cohabit safely.
 */

// ── Bundle kind ────────────────────────────────────────────────────

/**
 * Discriminator for the input that the deploy driver dispatches on.
 *
 * - `helm_chart` — the bundle directory contains a `Chart.yaml` at
 *   its root. `HelmDriver.apply` runs `helm upgrade --install`.
 * - `manifest` — anything else under the bundle directory. The
 *   driver runs `kubectl apply -k <bundle>` (Kustomize), which also
 *   handles a plain directory of `.yaml` files when a
 *   `kustomization.yaml` is present, and falls back to
 *   `kubectl apply -f <bundle>` for a single raw manifest path.
 */
export type K8sBundleKind = "helm_chart" | "manifest";

// ── Driver call options ────────────────────────────────────────────

/** Inputs to `KubectlDriver.apply` / `HelmDriver.apply`. */
export interface K8sApplyOptions {
  /**
   * Absolute path to the manifest bundle directory (or a single
   * `.yaml` file for `kubectl apply -f`). Validated to exist before
   * the subprocess runs; missing paths surface as `bundle_path_missing`.
   */
  bundleUri: string;
  /**
   * Kubernetes namespace to deploy into. Required; the driver
   * neither defaults nor reads `$KUBE_NAMESPACE`. Caller pins the
   * tenant boundary explicitly.
   */
  namespace: string;
  /**
   * Optional kubectl context name (or kubeconfig path passed via
   * `--kubeconfig`). When omitted the driver leaves selection up to
   * the operator's `$KUBECONFIG`. Documented as the layered-auth
   * extension hook from §14.4 of the design.
   */
  context?: string;
  /**
   * Optional release name for Helm. Defaults to the bundle dir's
   * basename when omitted. Ignored by `KubectlDriver`.
   */
  releaseName?: string;
  /**
   * Per-call timeout in ms. Defaults to {@link K8S_DEFAULT_TIMEOUT_MS}.
   * Apply usually takes longer than status — the driver honours the
   * caller's choice rather than picking different defaults per verb.
   */
  timeoutMs?: number;
}

/** Inputs to `KubectlDriver.rollback` / `HelmDriver.rollback`. */
export interface K8sRollbackOptions {
  /**
   * For `kubectl`: the workload resource name to undo (e.g.
   * `deployment/my-app`). For Helm: the release name.
   */
  releaseId: string;
  /** Same constraint as {@link K8sApplyOptions.namespace}. */
  namespace: string;
  /** Optional context, mirrors apply. */
  context?: string;
  /**
   * Optional revision number to roll back to. `kubectl rollout
   * undo --to-revision=<n>` / `helm rollback <release> <n>`. When
   * omitted, both tools pick the immediately preceding revision —
   * the common case for an "undo last deploy".
   */
  toRevision?: number;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

/** Inputs to `KubectlDriver.status` / `HelmDriver.status`. */
export interface K8sStatusOptions {
  namespace: string;
  context?: string;
  /**
   * Optional label selector to narrow the deployments returned.
   * `kubectl get deployments -l <selector>`. Mirrors the helm
   * selector by-release-name where applicable.
   */
  selector?: string;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

/** Inputs to `KubectlDriver.health`. */
export interface K8sHealthOptions {
  namespace: string;
  context?: string;
  /**
   * Optional label selector applied to `kubectl wait`. When
   * omitted the driver waits on every Pod in the namespace, which
   * is the right shape for the deploy-then-wait flow where a
   * release lands a coherent set of workloads under one namespace.
   */
  selector?: string;
  /**
   * Wait timeout in ms. Defaults to {@link K8S_DEFAULT_HEALTH_TIMEOUT_MS}.
   * Translated to `--timeout=<n>s` for `kubectl wait` (kubectl's
   * own timeout grammar; the parent process's per-call timeout is
   * always one second above this so the wait deadline expires
   * first and the driver returns a structured `not_ready` rather
   * than `kubectl_failed`).
   */
  timeoutMs?: number;
}

// ── Driver outputs ─────────────────────────────────────────────────

/** Single workload's status, normalised across kubectl + helm. */
export interface K8sWorkloadStatus {
  /** `Deployment.metadata.name` (or Helm release name for helm status). */
  name: string;
  /** Kind (e.g. "Deployment", "StatefulSet"). */
  kind: string;
  /** `Deployment.status.replicas` — total replicas declared. */
  replicas: number;
  /** `Deployment.status.readyReplicas` — replicas reporting ready. */
  readyReplicas: number;
  /** `Deployment.status.availableReplicas`. */
  availableReplicas: number;
  /**
   * Coarse-grained roll-up state, derived in the driver from the
   * three replica counts:
   *   - `healthy`: replicas > 0 && readyReplicas === replicas
   *   - `degraded`: replicas > 0 && readyReplicas < replicas
   *   - `unknown`: replicas === 0 or the JSON was missing fields
   */
  state: "healthy" | "degraded" | "unknown";
}

/** Return shape of `KubectlDriver.status` / `HelmDriver.status`. */
export interface K8sStatusResult {
  namespace: string;
  workloads: K8sWorkloadStatus[];
  /** True when every workload is `state: healthy`. */
  allHealthy: boolean;
}

/** Return shape of apply (kubectl + helm share this). */
export interface K8sApplyResult {
  /** Release name we used (helm) or workload primary name (kubectl). */
  releaseName: string;
  namespace: string;
  /** What we ran — `kubectl_apply`, `helm_upgrade`. */
  driver: "kubectl" | "helm";
  /** Bundle kind that drove dispatch. */
  bundleKind: K8sBundleKind;
  /** Stdout from the subprocess, capped to {@link K8S_STDOUT_TAIL_BYTES}. */
  stdoutTail: string;
  /** Wall-clock duration of the underlying subprocess(es) in ms. */
  durationMs: number;
}

/** Return shape of rollback. */
export interface K8sRollbackResult {
  releaseId: string;
  namespace: string;
  driver: "kubectl" | "helm";
  /** Revision the driver rolled back to (kubectl's `--to-revision` echo). */
  toRevision: number | null;
  stdoutTail: string;
  durationMs: number;
}

/** Return shape of health. */
export interface K8sHealthResult {
  namespace: string;
  /** True when `kubectl wait` exited 0 before the deadline. */
  ready: boolean;
  /** Detail string; for `ready: false` carries the kubectl stderr tail. */
  detail: string | null;
  durationMs: number;
}

// ── Public constants ───────────────────────────────────────────────

/** Default per-command timeout for kubectl / helm subprocess calls. */
export const K8S_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Default wait timeout for `KubectlDriver.health`. */
export const K8S_DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Cap on the stdout tail we surface back to callers. The full
 * subprocess output can be very large for big kubectl applies (one
 * "configured" line per resource) — the tail is plenty for
 * diagnostic context without flooding the JSON envelope.
 */
export const K8S_STDOUT_TAIL_BYTES = 4 * 1024;

/** Default binary names. Operators override via env vars. */
export const DEFAULT_KUBECTL_BIN = "kubectl";
export const DEFAULT_HELM_BIN = "helm";

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Stable error codes emitted by both `KubectlDriver` and
 * `HelmDriver`. Callers dispatch on these without parsing messages.
 *
 * - `kubectl_failed` / `helm_failed` — subprocess exited non-zero.
 * - `kubectl_not_found` / `helm_not_found` — binary not on PATH.
 * - `bundle_path_missing` — `bundleUri` does not exist on disk.
 * - `cluster_auth_failed` — kubectl reports 401 / forbidden / no
 *   such context. The drivers parse stderr for the canonical
 *   substrings and re-classify the failure.
 * - `namespace_missing` — kubectl reports `namespaces "foo" not
 *   found`. Distinct from generic `kubectl_failed` so callers can
 *   create the namespace on the operator's behalf if appropriate.
 */
export type K8sDriverErrorCode =
  | "kubectl_failed"
  | "kubectl_not_found"
  | "helm_failed"
  | "helm_not_found"
  | "bundle_path_missing"
  | "cluster_auth_failed"
  | "namespace_missing";

/**
 * Structured error emitted by both K8s drivers. The `cause` field
 * carries the underlying subprocess error or `ENOENT` exception for
 * post-mortem inspection; callers should pattern-match on `code`.
 */
export class K8sDriverError extends Error {
  constructor(
    public readonly code: K8sDriverErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "K8sDriverError";
  }
}

// ── Injectable exec contract ───────────────────────────────────────

/** Options for {@link K8sExec}. */
export interface K8sExecOptions {
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface K8sExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Injectable exec callback. Tests pass a stub that returns canned
 * results; production callers leave `KubectlDriverOptions.exec` /
 * `HelmDriverOptions.exec` unset and the drivers use their default
 * spawner.
 */
export type K8sExec = (
  bin: string,
  args: string[],
  opts: K8sExecOptions,
) => Promise<K8sExecResult>;
