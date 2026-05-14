/**
 * Auto-promotion listener (v0.4.0-1 / Epic 1, WS3).
 *
 * Fired by the verb layer when `release-built` lands. For each
 * matching `promotion_policy`:
 *
 *   gate_kind=auto       — create an `auto_approved` approval row,
 *                          trigger deploy immediately.
 *   gate_kind=manual     — create a `pending` approval row; the
 *                          operator (or a separate workflow) flips
 *                          it via `runPromotionApprove` to fire the
 *                          deploy.
 *   gate_kind=time_delay — create a `pending` approval row with
 *                          `auto_approve_at = now + delay_seconds`.
 *                          The `runPromotionTick` pass discovers
 *                          due rows, flips them to `auto_approved`,
 *                          and triggers the deploy.
 *
 * The listener is idempotent on (release, dest_target): a duplicate
 * fire returns the existing approval row instead of creating a
 * second one. The schema's unique partial index backs this up at
 * the DB level.
 *
 * Deploy execution is an injected callback (`DeployInvoker`) so the
 * listener stays testable without the hypervisor stack. The verb
 * layer provides a default that wraps `runReleaseDeploy`.
 */

import type { ControlPlane } from "../index.js";
import type {
  Approval,
  PromotionPolicy,
  Release,
} from "../types.js";

export interface DeployInvocation {
  deploymentId: string | null;
  outcome: "success" | "failed";
  errorMessage?: string;
}

export type DeployInvoker = (input: {
  releaseId: string;
  destTargetId: string;
  approval: Approval;
  policy: PromotionPolicy;
}) => Promise<DeployInvocation>;

export interface PromotionListenerOptions {
  controlPlane: ControlPlane;
  /** Required: how to actually deploy when a gate opens. */
  deploy: DeployInvoker;
  /** Returns "now"; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface PromotionListenerOutcome {
  policyId: string;
  approvalId: string | null;
  /**
   * What happened for this policy:
   *   - 'auto_deployed' — gate=auto, deploy fired.
   *   - 'queued_manual' — gate=manual, approval is pending.
   *   - 'queued_time_delay' — gate=time_delay, approval pending until autoApproveAt.
   *   - 'duplicate' — an approval already existed for this (release, dest).
   *   - 'inactive_policy' — policy was inactive (shouldn't happen given the SQL filter).
   *   - 'deploy_failed' — auto gate fired but deploy threw.
   */
  action:
    | "auto_deployed"
    | "queued_manual"
    | "queued_time_delay"
    | "duplicate"
    | "deploy_failed";
  detail?: string;
}

/**
 * Fire the listener for a freshly-built release. Walks every active
 * policy that matches this product's initial tier (source_target_id
 * IS NULL) and creates / triggers each.
 */
export async function onReleaseBuilt(
  opts: PromotionListenerOptions,
  release: Release,
): Promise<PromotionListenerOutcome[]> {
  const matching = await opts.controlPlane.promotionPolicies.listMatchingForProduct(
    {
      productId: release.productId,
      sourceTargetId: null,
    },
  );
  const outcomes: PromotionListenerOutcome[] = [];
  for (const policy of matching) {
    outcomes.push(await firePolicy(opts, policy, release));
  }
  return outcomes;
}

/**
 * Fire the tier-to-tier listener for a release that just deployed
 * successfully to `sourceTargetId`. Walks every active policy whose
 * `source_target_id` matches and creates / triggers each.
 *
 * Caller is responsible for ensuring the deploy's status is `active`
 * (i.e., health probes passed). Failed / rolled-back deploys MUST NOT
 * invoke this — promotion across tiers should only fire when the
 * source tier is verified.
 */
export async function onReleaseDeployed(
  opts: PromotionListenerOptions,
  release: Release,
  sourceTargetId: string,
): Promise<PromotionListenerOutcome[]> {
  const matching = await opts.controlPlane.promotionPolicies.listMatchingForProduct(
    {
      productId: release.productId,
      sourceTargetId,
    },
  );
  const outcomes: PromotionListenerOutcome[] = [];
  for (const policy of matching) {
    outcomes.push(await firePolicy(opts, policy, release));
  }
  return outcomes;
}

/**
 * Apply a single policy. Exposed so v0.5+ can add a "promote a
 * previously-built release through this policy" path without the
 * listener fire-on-build dance.
 */
export async function firePolicy(
  opts: PromotionListenerOptions,
  policy: PromotionPolicy,
  release: Release,
): Promise<PromotionListenerOutcome> {
  if (!policy.active) {
    return { policyId: policy.id, approvalId: null, action: "duplicate", detail: "inactive policy" };
  }
  const existing = await opts.controlPlane.approvals.getForReleaseAndTarget({
    releaseId: release.id,
    destTargetId: policy.destTargetId,
  });
  if (existing) {
    return {
      policyId: policy.id,
      approvalId: existing.id,
      action: "duplicate",
      detail: `existing approval ${existing.id} (${existing.status})`,
    };
  }
  const nowDate = opts.now ? opts.now() : new Date();
  const nowIsoStr = nowDate.toISOString();

  if (policy.gateKind === "auto") {
    const approval = await opts.controlPlane.approvals.create({
      orgId: policy.orgId,
      policyId: policy.id,
      releaseId: release.id,
      destTargetId: policy.destTargetId,
      status: "auto_approved",
    });
    await markApprovalDecided(opts.controlPlane, approval.id, {
      decidedBy: "system",
      decidedAt: nowIsoStr,
      reason: "gate_kind=auto",
    });
    const fresh = await opts.controlPlane.approvals.get(approval.id);
    if (!fresh) throw new Error(`approval ${approval.id} vanished mid-fire`);
    return await dispatchDeploy(opts, policy, fresh, release);
  }

  if (policy.gateKind === "time_delay") {
    const delaySeconds = readDelaySeconds(policy);
    const autoApproveAt = new Date(nowDate.getTime() + delaySeconds * 1000).toISOString();
    const approval = await opts.controlPlane.approvals.create({
      orgId: policy.orgId,
      policyId: policy.id,
      releaseId: release.id,
      destTargetId: policy.destTargetId,
      status: "pending",
      autoApproveAt,
    });
    return {
      policyId: policy.id,
      approvalId: approval.id,
      action: "queued_time_delay",
      detail: `auto_approve_at=${autoApproveAt}`,
    };
  }

  // gate_kind === 'manual'
  const approval = await opts.controlPlane.approvals.create({
    orgId: policy.orgId,
    policyId: policy.id,
    releaseId: release.id,
    destTargetId: policy.destTargetId,
    status: "pending",
  });
  return {
    policyId: policy.id,
    approvalId: approval.id,
    action: "queued_manual",
  };
}

async function markApprovalDecided(
  controlPlane: ControlPlane,
  approvalId: string,
  decision: { decidedBy: string; decidedAt: string; reason: string },
): Promise<void> {
  await controlPlane.approvals.update(approvalId, {
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    reason: decision.reason,
  });
}

async function dispatchDeploy(
  opts: PromotionListenerOptions,
  policy: PromotionPolicy,
  approval: Approval,
  release: Release,
): Promise<PromotionListenerOutcome> {
  const nowIsoStr = (opts.now ? opts.now() : new Date()).toISOString();
  try {
    const result = await opts.deploy({
      releaseId: release.id,
      destTargetId: policy.destTargetId,
      approval,
      policy,
    });
    await opts.controlPlane.approvals.update(approval.id, {
      deployAttemptedAt: nowIsoStr,
      deployOutcome: result.outcome,
      deployDeploymentId: result.deploymentId,
    });
    if (result.outcome === "failed") {
      return {
        policyId: policy.id,
        approvalId: approval.id,
        action: "deploy_failed",
        detail: result.errorMessage,
      };
    }
    return {
      policyId: policy.id,
      approvalId: approval.id,
      action: "auto_deployed",
      detail: `deployment=${result.deploymentId ?? "(none)"}`,
    };
  } catch (err) {
    await opts.controlPlane.approvals.update(approval.id, {
      deployAttemptedAt: nowIsoStr,
      deployOutcome: "failed",
    });
    return {
      policyId: policy.id,
      approvalId: approval.id,
      action: "deploy_failed",
      detail: (err as Error).message,
    };
  }
}

/**
 * Decide on a gate. Pure function so unit tests can drive every
 * branch without standing up a control plane. Returns the action
 * the listener will take for a freshly created approval.
 */
export function decideGate(policy: PromotionPolicy): "auto_deploy" | "queue_manual" | "queue_time_delay" {
  switch (policy.gateKind) {
    case "auto":
      return "auto_deploy";
    case "time_delay":
      return "queue_time_delay";
    case "manual":
      return "queue_manual";
    default: {
      const exhaustive: never = policy.gateKind;
      throw new Error(`unknown gate kind: ${exhaustive as string}`);
    }
  }
}

/** Read `delay_seconds` from a time_delay policy. Validates >= 0. */
export function readDelaySeconds(policy: PromotionPolicy): number {
  const raw = (policy.gateConfig as { delay_seconds?: unknown }).delay_seconds;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `time_delay policy ${policy.id} has invalid delay_seconds: ${JSON.stringify(raw)}`,
    );
  }
  return Math.floor(n);
}

/**
 * Pure decision: of these pending approvals, which are due for
 * auto-flip based on `autoApproveAt`? Tests drive this directly.
 */
export function approvalsDueForAutoApprove(
  approvals: Approval[],
  nowMs: number,
): Approval[] {
  const out: Approval[] = [];
  for (const a of approvals) {
    if (a.status !== "pending") continue;
    if (!a.autoApproveAt) continue;
    const t = Date.parse(a.autoApproveAt);
    if (!Number.isFinite(t)) continue;
    if (t <= nowMs) out.push(a);
  }
  return out;
}

/**
 * Periodic tick: find pending approvals whose `autoApproveAt` has
 * elapsed, flip them to `auto_approved`, and trigger their deploys.
 * Returns the count of approvals dispatched.
 */
export async function runPromotionTick(
  opts: PromotionListenerOptions,
): Promise<number> {
  const nowDate = opts.now ? opts.now() : new Date();
  const nowIsoStr = nowDate.toISOString();
  const due = await opts.controlPlane.approvals.listPendingAutoApprove(nowIsoStr);
  let dispatched = 0;
  for (const approval of due) {
    const policy = await opts.controlPlane.promotionPolicies.get(approval.policyId);
    if (!policy) continue;
    const release = await opts.controlPlane.releases.get(approval.releaseId);
    if (!release) continue;
    await opts.controlPlane.approvals.update(approval.id, {
      status: "auto_approved",
      decidedBy: "system",
      decidedAt: nowIsoStr,
      reason: "gate_kind=time_delay elapsed",
    });
    const fresh = await opts.controlPlane.approvals.get(approval.id);
    if (!fresh) continue;
    await dispatchDeploy(opts, policy, fresh, release);
    dispatched += 1;
  }
  return dispatched;
}
