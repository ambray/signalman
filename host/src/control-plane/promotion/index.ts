/**
 * Public surface of the promotion module (v0.4.0-1 / Epic 1).
 */

export {
  approvalsDueForAutoApprove,
  decideGate,
  firePolicy,
  isHealthGateOpen,
  onReleaseBuilt,
  onReleaseDeployed,
  readDelaySeconds,
  readHealthGate,
  runPromotionTick,
} from "./listener.js";
export type {
  DeployInvocation,
  DeployInvoker,
  PromotionListenerOptions,
  PromotionListenerOutcome,
} from "./listener.js";
