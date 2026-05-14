/**
 * K8s deploy executor (v0.3.0-6 sub-task 1).
 *
 * High-level entry points the MCP server, CLI verbs, and
 * `verbs/control-plane.ts` call instead of touching `KubectlDriver`
 * / `HelmDriver` directly. The executor:
 *
 *   1. Detects bundle kind (helm chart vs. manifest) and dispatches
 *      to the matching driver. Operators don't have to know which
 *      driver to invoke.
 *   2. Composes a health check on top of `KubectlDriver.health`
 *      after apply, so both drivers reuse the same pod-readiness
 *      probe. Helm doesn't have a native "wait for pods ready"
 *      equivalent, so unifying here keeps the surface simple.
 *   3. Returns a flat `Deployment`-shaped result that the deploy
 *      target dispatch in `verbs/control-plane.ts` can plumb into
 *      the existing audit-log / deployment-row plumbing.
 *
 * Tests inject both drivers (or a tuple shape via factory) so the
 * executor itself stays free of subprocess assumptions.
 */

import { KubectlDriver, type KubectlDriverOptions } from "./kubectl.js";
import { HelmDriver, type HelmDriverOptions } from "./helm.js";
import { detectBundleKind } from "./bundle.js";
import {
  K8sDriverError,
  type K8sApplyResult,
  type K8sBundleKind,
  type K8sHealthResult,
  type K8sRollbackResult,
  type K8sStatusResult,
} from "./types.js";

// ── Driver factory ─────────────────────────────────────────────────

/**
 * Shape returned by the driver factory. Tests pass a factory that
 * returns stub `KubectlDriver` / `HelmDriver` instances (typically
 * with injected `exec`); production callers use {@link defaultDriverFactory}.
 */
export interface K8sDriverPair {
  kubectl: KubectlDriver;
  helm: HelmDriver;
}

/**
 * Default factory: instantiates both drivers with their built-in
 * `defaultExec` + env-var binary lookup. Exposed so the executor
 * can be invoked without an explicit factory in production.
 */
export function defaultDriverFactory(
  opts: {
    kubectl?: KubectlDriverOptions;
    helm?: HelmDriverOptions;
  } = {},
): K8sDriverPair {
  return {
    kubectl: new KubectlDriver(opts.kubectl),
    helm: new HelmDriver(opts.helm),
  };
}

// ── Public option shapes ───────────────────────────────────────────

export interface RunK8sDeployOptions {
  /** Path to the manifest bundle or chart directory. */
  bundleUri: string;
  namespace: string;
  /** Optional kubectl/helm context. */
  context?: string;
  /** Optional release name (defaults to bundle basename). */
  releaseName?: string;
  /**
   * If true, run a `kubectl wait` after apply and surface the
   * result in `health`. Defaults to true; tests that don't care
   * about the wait stage can set it to false.
   */
  waitForHealth?: boolean;
  /** Wait timeout in ms (forwarded to {@link KubectlDriver.health}). */
  healthTimeoutMs?: number;
  /**
   * Injectable driver factory. Tests pass stubs; production callers
   * leave undefined to use {@link defaultDriverFactory}.
   */
  drivers?: K8sDriverPair;
}

export interface RunK8sDeployResult {
  apply: K8sApplyResult;
  /** Present only when `waitForHealth !== false`. */
  health: K8sHealthResult | null;
  bundleKind: K8sBundleKind;
}

export interface RunK8sRollbackOptions {
  releaseId: string;
  namespace: string;
  context?: string;
  toRevision?: number;
  /**
   * Driver to use. Operators usually know whether the release was
   * deployed via helm; we forward the choice rather than guessing.
   * Defaults to `"kubectl"` for backwards-compat with the docker-
   * compose flow's `rollout undo` shape.
   */
  driver?: "kubectl" | "helm";
  drivers?: K8sDriverPair;
}

export interface RunK8sStatusOptions {
  namespace: string;
  context?: string;
  selector?: string;
  /** Only meaningful when `driver: "helm"`. */
  releaseName?: string;
  driver?: "kubectl" | "helm";
  drivers?: K8sDriverPair;
}

export interface RunK8sHealthOptions {
  namespace: string;
  context?: string;
  selector?: string;
  timeoutMs?: number;
  drivers?: K8sDriverPair;
}

// ── Entry points ───────────────────────────────────────────────────

/**
 * Apply a bundle to a namespace, with optional post-apply pod
 * readiness wait.
 *
 * Bundle dispatch is by `Chart.yaml` presence (see `detectBundleKind`).
 * Anything else routes through `KubectlDriver`.
 */
export async function runK8sDeploy(
  opts: RunK8sDeployOptions,
): Promise<RunK8sDeployResult> {
  const drivers = opts.drivers ?? defaultDriverFactory();
  const bundleKind = detectBundleKind(opts.bundleUri);

  const apply =
    bundleKind === "helm_chart"
      ? await drivers.helm.apply({
          bundleUri: opts.bundleUri,
          namespace: opts.namespace,
          context: opts.context,
          releaseName: opts.releaseName,
        })
      : await drivers.kubectl.apply({
          bundleUri: opts.bundleUri,
          namespace: opts.namespace,
          context: opts.context,
          releaseName: opts.releaseName,
        });

  let health: K8sHealthResult | null = null;
  if (opts.waitForHealth !== false) {
    health = await drivers.kubectl.health({
      namespace: opts.namespace,
      context: opts.context,
      timeoutMs: opts.healthTimeoutMs,
    });
  }

  return { apply, health, bundleKind };
}

/**
 * Roll back a release using the operator's chosen driver.
 *
 * No bundle-kind autodetect at rollback time because rollback
 * operates on cluster state (a release/workload name + namespace),
 * not on a local bundle. The caller knows whether the deploy went
 * through helm or kubectl and forwards `driver` accordingly.
 */
export async function runK8sRollback(
  opts: RunK8sRollbackOptions,
): Promise<K8sRollbackResult> {
  const drivers = opts.drivers ?? defaultDriverFactory();
  const driver = opts.driver ?? "kubectl";
  if (driver === "helm") {
    return drivers.helm.rollback({
      releaseId: opts.releaseId,
      namespace: opts.namespace,
      context: opts.context,
      toRevision: opts.toRevision,
    });
  }
  return drivers.kubectl.rollback({
    releaseId: opts.releaseId,
    namespace: opts.namespace,
    context: opts.context,
    toRevision: opts.toRevision,
  });
}

/**
 * Read deployment status. Driver selection mirrors {@link runK8sRollback}:
 * the caller forwards whichever driver applied the release.
 *
 * Throws if `driver: "helm"` is passed without `releaseName` —
 * `HelmDriver.status` requires it.
 */
export async function runK8sStatus(
  opts: RunK8sStatusOptions,
): Promise<K8sStatusResult> {
  const drivers = opts.drivers ?? defaultDriverFactory();
  const driver = opts.driver ?? "kubectl";
  if (driver === "helm") {
    if (!opts.releaseName) {
      throw new K8sDriverError(
        "helm_failed",
        "runK8sStatus(driver='helm') requires releaseName",
      );
    }
    return drivers.helm.status({
      namespace: opts.namespace,
      context: opts.context,
      releaseName: opts.releaseName,
    });
  }
  return drivers.kubectl.status({
    namespace: opts.namespace,
    context: opts.context,
    selector: opts.selector,
  });
}

/**
 * Wait for pods in the namespace to reach `condition=Ready`.
 * Convenience wrapper so callers don't have to instantiate a
 * driver just to run the health probe.
 */
export async function runK8sHealth(
  opts: RunK8sHealthOptions,
): Promise<K8sHealthResult> {
  const drivers = opts.drivers ?? defaultDriverFactory();
  return drivers.kubectl.health({
    namespace: opts.namespace,
    context: opts.context,
    selector: opts.selector,
    timeoutMs: opts.timeoutMs,
  });
}
