/**
 * Event types fired through the v0.4.0-2 dispatcher.
 *
 * The dispatched union is intentionally narrow — every kind in here
 * has a webhook driver layer that knows how to format it. Adding a
 * kind means updating the discriminator AND the Slack-payload
 * formatter (driver/slack.ts).
 *
 * `at` is the event firing time (ISO-8601 UTC). `orgId` is required
 * because subscriptions are org-scoped — the dispatcher will not
 * deliver events across orgs.
 */

export type SignalmanEventKind =
  | "release-built"
  | "release-deployed"
  | "deployment-rolled-back"
  | "health-failed"
  | "promotion-approved"
  | "promotion-rejected";

interface BaseSignalmanEvent {
  kind: SignalmanEventKind;
  orgId: string;
  at: string;
}

export interface ReleaseBuiltEvent extends BaseSignalmanEvent {
  kind: "release-built";
  releaseId: string;
  productName: string;
  tag: string;
  manifestSha256: string | null;
}

export interface ReleaseDeployedEvent extends BaseSignalmanEvent {
  kind: "release-deployed";
  deploymentId: string;
  releaseId: string;
  targetName: string;
  status: string;
  healthSummary?: {
    total: number;
    pass: number;
    fail: number;
  };
}

export interface DeploymentRolledBackEvent extends BaseSignalmanEvent {
  kind: "deployment-rolled-back";
  deploymentId: string;
  releaseId: string;
  targetName: string;
}

export interface HealthFailedEvent extends BaseSignalmanEvent {
  kind: "health-failed";
  scheduleId: string | null;
  targetId: string;
  /** Deployment the probes ran against, if any. */
  deploymentId: string | null;
  reachable: boolean;
  /** Probe-level results. */
  probes: Array<{ name: string; status: "pass" | "fail" | "degraded" }>;
}

export interface PromotionApprovedEvent extends BaseSignalmanEvent {
  kind: "promotion-approved";
  promotionId: string;
  /**
   * Where the approval lives in the model — Epic 1 calls this an
   * "approval row". `approvalId` is null for auto-promotions (no
   * approval row was created).
   */
  approvalId: string | null;
  policyId: string;
  releaseId: string;
  /** Resolved name of the destination target. */
  targetName: string;
}

export interface PromotionRejectedEvent extends BaseSignalmanEvent {
  kind: "promotion-rejected";
  promotionId: string;
  approvalId: string;
  policyId: string;
  releaseId: string;
  targetName: string;
  reason: string | null;
}

export type SignalmanEvent =
  | ReleaseBuiltEvent
  | ReleaseDeployedEvent
  | DeploymentRolledBackEvent
  | HealthFailedEvent
  | PromotionApprovedEvent
  | PromotionRejectedEvent;
