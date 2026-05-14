/**
 * Public surface of the promotion module (v0.4.0-1 / Epic 1).
 */

export {
  approvalsDueForAutoApprove,
  decideGate,
  firePolicy,
  onReleaseBuilt,
  readDelaySeconds,
  runPromotionTick,
} from "./listener.js";
export type {
  DeployInvocation,
  DeployInvoker,
  PromotionListenerOptions,
  PromotionListenerOutcome,
} from "./listener.js";
