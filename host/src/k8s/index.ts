/**
 * Kubernetes driver module (v0.3.0-6 sub-task 1).
 *
 * Public entry points for the kubectl + helm subprocess drivers.
 * Production callers go through `runK8sDeploy` / `runK8sRollback` /
 * `runK8sStatus` in `executor.ts`; this barrel exists so the MCP
 * server, CLI verbs, and tests can import the driver surface
 * without reaching into individual files.
 *
 * Commits land incrementally: commit 1 ships only the type +
 * bundle-detect surface; subsequent commits add `kubectl`, `helm`,
 * and `executor` exports.
 */

export {
  detectBundleKind,
  hasKustomization,
  HELM_CHART_FILE,
} from "./bundle.js";
export {
  K8sDriverError,
  type K8sDriverErrorCode,
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
  DEFAULT_KUBECTL_BIN,
  DEFAULT_HELM_BIN,
  K8S_DEFAULT_TIMEOUT_MS,
  K8S_DEFAULT_HEALTH_TIMEOUT_MS,
  K8S_STDOUT_TAIL_BYTES,
} from "./types.js";
export { makeDefaultExec } from "./exec.js";
