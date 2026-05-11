/**
 * Public surface of the deploy module.
 */

export type { DeployBackend, DeployVmHandle } from "./backend.js";
export { HypervisorDeployBackend } from "./hypervisor-backend.js";
export {
  DeployBlockedError,
  DeployHealthFailedError,
  runDeploy,
  runRollback,
} from "./executor.js";
export type {
  RunDeployOptions,
  RunDeployResult,
  RunRollbackOptions,
} from "./executor.js";
