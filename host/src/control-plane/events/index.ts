/**
 * Public surface of the events / dispatcher module (v0.4.0-2).
 */

export {
  EventDispatcher,
  resetSmtpTransportForTests,
  subscriptionWantsEvent,
} from "./dispatcher.js";
export type {
  DispatchOutcome,
  DispatchResult,
  DispatcherOptions,
  EmailSender,
  HttpFetcher,
} from "./dispatcher.js";
export { signBody, verifySignature, SIGNALMAN_SIGNATURE_HEADER } from "./hmac.js";
export { formatEventForSlack } from "./slack.js";
export type { SlackBlock, SlackPayload } from "./slack.js";
export type {
  DeploymentRolledBackEvent,
  HealthFailedEvent,
  PromotionApprovedEvent,
  PromotionRejectedEvent,
  ReleaseBuiltEvent,
  ReleaseDeployedEvent,
  SignalmanEvent,
  SignalmanEventKind,
} from "./types.js";
