/**
 * `signalman runner deploy-k8s` verb (v0.3.0-6 sub-task 2).
 *
 * Wraps `kubectl apply -f <manifest>` for a Signalman runner
 * manifest (`Job` or `Deployment`) and waits for the resulting pod
 * to reach `condition=Ready`. The wait phase is the "registered
 * with the control plane" signal — the runner binary calls
 * `signalman runner start` in its containers, which begins polling
 * `POST /v1/jobs/claim` immediately on Pod Running. Pod readiness
 * is the most precise registration signal the control plane
 * exposes today (there is no formal `/v1/runners` endpoint; the
 * runner is anonymous until it claims its first job).
 *
 * Tests inject a `K8sExec` stub (no real kubectl, no real
 * cluster). The verb is otherwise a thin orchestration over
 * `KubectlDriver.apply` + `KubectlDriver.health`.
 */

import * as fs from "node:fs";

import {
  KubectlDriver,
  type KubectlDriverOptions,
  type K8sApplyResult,
  type K8sHealthResult,
} from "../k8s/index.js";

// ── Public option shape ────────────────────────────────────────────

export interface RunnerDeployK8sOptions {
  /** Absolute path to a runner manifest (Job/Deployment yaml). */
  manifestPath: string;
  /** Kubernetes namespace to deploy the runner into. */
  namespace: string;
  /** Optional kubectl context name. */
  context?: string;
  /**
   * Label selector for the wait phase. Defaults to
   * `app.kubernetes.io/name=signalman-runner` — the label every
   * example manifest in `examples/k8s-runner/` sets.
   */
  selector?: string;
  /**
   * Wait timeout in ms (kubectl wait --timeout=Ns). Default 5 min.
   */
  waitTimeoutMs?: number;
  /**
   * If false, the verb runs `kubectl apply` but does not wait. The
   * operator does their own readiness gating. Defaults to true.
   */
  waitForReady?: boolean;
  /**
   * Optional driver options forwarded to `KubectlDriver` (mainly
   * `exec` for tests). Production callers leave undefined.
   */
  driverOptions?: KubectlDriverOptions;
  /** Optional progress sink. Default: process.stderr. */
  out?: NodeJS.WritableStream;
}

export interface RunnerDeployK8sResult {
  apply: K8sApplyResult;
  health: K8sHealthResult | null;
  ready: boolean;
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Apply a runner manifest and wait for its pods to be Ready.
 *
 * Failure modes (all surfaced as `K8sDriverError` from the driver):
 *   - `bundle_path_missing` — `manifestPath` does not exist
 *   - `kubectl_not_found` — kubectl binary not on PATH
 *   - `kubectl_failed` — kubectl apply / wait exited non-zero
 *   - `cluster_auth_failed` — 401/403 from the cluster
 *   - `namespace_missing` — target namespace does not exist
 *
 * On wait timeout (the pod never reached Ready), the verb returns
 * `ready: false` with `health.detail` populated — no exception, so
 * the CLI can map it to a structured exit code.
 */
export async function runRunnerDeployK8s(
  opts: RunnerDeployK8sOptions,
): Promise<RunnerDeployK8sResult> {
  if (!fs.existsSync(opts.manifestPath)) {
    // Defer this to the driver in production to keep all
    // path-existence checks in one place — but resolving here
    // makes the error message friendlier for the CLI shell.
    throw Object.assign(new Error(`manifest path does not exist: ${opts.manifestPath}`), {
      code: "bundle_path_missing",
    });
  }

  const driver = new KubectlDriver(opts.driverOptions);
  const out = opts.out ?? process.stderr;
  out.write(
    `[runner deploy-k8s] applying '${opts.manifestPath}' to namespace '${opts.namespace}'\n`,
  );
  const apply = await driver.apply({
    bundleUri: opts.manifestPath,
    namespace: opts.namespace,
    context: opts.context,
  });

  if (opts.waitForReady === false) {
    return { apply, health: null, ready: true };
  }

  out.write(
    `[runner deploy-k8s] waiting for pods (selector='${
      opts.selector ?? "app.kubernetes.io/name=signalman-runner"
    }') to reach Ready\n`,
  );
  const health = await driver.health({
    namespace: opts.namespace,
    context: opts.context,
    selector: opts.selector ?? "app.kubernetes.io/name=signalman-runner",
    timeoutMs: opts.waitTimeoutMs,
  });
  return { apply, health, ready: health.ready };
}
