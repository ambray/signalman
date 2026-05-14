/**
 * Integration + system tests for the auto-promotion listener
 * (v0.4.0-1 / Epic 1, WS3).
 *
 * Verifies the full build → ready → listener → deploy chain with a
 * stub deploy executor, plus the per-gate behaviour (auto deploys
 * immediately, manual queues a pending row, time_delay queues with
 * `autoApproveAt` set, the tick dispatches due rows).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  approvalsDueForAutoApprove,
  firePolicy,
  onReleaseBuilt,
  onReleaseDeployed,
  runPromotionTick,
  type DeployInvoker,
  type PromotionListenerOutcome,
} from "../control-plane/promotion/index.js";
import {
  checkApproverAllowlist,
  runPromotionApprove,
  runPromotionPolicyAdd,
  runPromotionReject,
} from "../verbs/control-plane.js";
import type { PromotionPolicy } from "../control-plane/types.js";
import type {
  Org,
  Product,
  Release,
  Target,
} from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;
let product: Product;
let target: Target;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-promo-e2e-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const init = await cp.init();
  org = init.defaultOrg;
  product = await cp.products.create({
    orgId: org.id,
    name: "p",
    repoUrl: "u",
  });
  target = await cp.targets.create({
    orgId: org.id,
    name: "demo",
    kind: "vm_demo",
    connection: { vmName: "vm-demo" },
  });
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function makeReadyRelease(tag: string): Promise<Release> {
  const r = await cp.releases.create({
    orgId: org.id,
    productId: product.id,
    tag,
    commitSha: "c".repeat(40),
    status: "building",
  });
  return cp.releases.update(r.id, { status: "ready" });
}

function recordingInvoker(): {
  invoker: DeployInvoker;
  calls: Array<{ releaseId: string; destTargetId: string }>;
} {
  const calls: Array<{ releaseId: string; destTargetId: string }> = [];
  const invoker: DeployInvoker = async ({ releaseId, destTargetId }) => {
    calls.push({ releaseId, destTargetId });
    return { deploymentId: `dep-${releaseId.slice(-4)}-${destTargetId.slice(-4)}`, outcome: "success" };
  };
  return { invoker, calls };
}

describe("onReleaseBuilt — gate kinds", () => {
  it("gate=auto fires the deploy invoker immediately", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const outcomes: PromotionListenerOutcome[] = await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker },
      release,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("auto_deployed");
    expect(calls).toEqual([{ releaseId: release.id, destTargetId: target.id }]);
    const approvalId = outcomes[0].approvalId!;
    const approval = await cp.approvals.get(approvalId);
    expect(approval?.status).toBe("auto_approved");
    expect(approval?.deployOutcome).toBe("success");
  });

  it("gate=manual queues a pending approval, no deploy", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "manual",
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const outcomes = await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker },
      release,
    );
    expect(outcomes[0].action).toBe("queued_manual");
    expect(calls).toEqual([]);
    const approval = await cp.approvals.get(outcomes[0].approvalId!);
    expect(approval?.status).toBe("pending");
    expect(approval?.autoApproveAt).toBeNull();
  });

  it("gate=time_delay queues with autoApproveAt set, no immediate deploy", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "time_delay",
      gateConfig: { delay_seconds: 600 },
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const t0 = new Date("2026-05-14T12:00:00Z");
    const outcomes = await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker, now: () => t0 },
      release,
    );
    expect(outcomes[0].action).toBe("queued_time_delay");
    expect(calls).toEqual([]);
    const approval = await cp.approvals.get(outcomes[0].approvalId!);
    expect(approval?.status).toBe("pending");
    expect(approval?.autoApproveAt).toBe("2026-05-14T12:10:00.000Z");
  });

  it("re-fire on the same release is idempotent (no duplicate row)", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "manual",
    });
    const { invoker } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const first = await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker },
      release,
    );
    const second = await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker },
      release,
    );
    expect(second[0].action).toBe("duplicate");
    expect(second[0].approvalId).toBe(first[0].approvalId);
  });

  it("deploy throw surfaces as deploy_failed without poisoning the listener", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    const release = await makeReadyRelease("v0.0.1");
    const outcomes = await onReleaseBuilt(
      {
        controlPlane: cp,
        deploy: async () => {
          throw new Error("backend down");
        },
      },
      release,
    );
    expect(outcomes[0].action).toBe("deploy_failed");
    expect(outcomes[0].detail).toContain("backend down");
    const approval = await cp.approvals.get(outcomes[0].approvalId!);
    expect(approval?.deployOutcome).toBe("failed");
  });

  it("multiple policies fire independently", async () => {
    const target2 = await cp.targets.create({
      orgId: org.id,
      name: "demo2",
      kind: "vm_demo",
      connection: { vmName: "vm-demo2" },
    });
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target2.id,
      gateKind: "manual",
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const outcomes = await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker },
      release,
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.action).sort()).toEqual(
      ["auto_deployed", "queued_manual"].sort(),
    );
    expect(calls).toHaveLength(1); // only the auto one fired the deploy
  });
});

describe("runPromotionTick — time-delay dispatch", () => {
  it("dispatches due time-delay approvals and skips future ones", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "time_delay",
      gateConfig: { delay_seconds: 60 },
    });
    const { invoker, calls } = recordingInvoker();
    const t0 = new Date("2026-05-14T12:00:00Z");
    const release = await makeReadyRelease("v0.0.1");
    await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker, now: () => t0 },
      release,
    );
    // Not due yet at +30s.
    const tooEarly = await runPromotionTick({
      controlPlane: cp,
      deploy: invoker,
      now: () => new Date("2026-05-14T12:00:30Z"),
    });
    expect(tooEarly).toBe(0);
    expect(calls).toEqual([]);
    // Due at +61s.
    const fired = await runPromotionTick({
      controlPlane: cp,
      deploy: invoker,
      now: () => new Date("2026-05-14T12:01:01Z"),
    });
    expect(fired).toBe(1);
    expect(calls).toHaveLength(1);
    const list = await cp.approvals.listForOrg(org.id);
    expect(list[0].status).toBe("auto_approved");
    expect(list[0].deployOutcome).toBe("success");
  });

  it("tolerates an approval whose policy was soft-deleted between queue and tick", async () => {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "time_delay",
      gateConfig: { delay_seconds: 60 },
    });
    const { invoker } = recordingInvoker();
    const t0 = new Date("2026-05-14T12:00:00Z");
    const release = await makeReadyRelease("v0.0.1");
    await onReleaseBuilt(
      { controlPlane: cp, deploy: invoker, now: () => t0 },
      release,
    );
    await cp.promotionPolicies.softDelete(policy.id);
    const fired = await runPromotionTick({
      controlPlane: cp,
      deploy: invoker,
      now: () => new Date("2026-05-14T13:00:00Z"),
    });
    expect(fired).toBe(0);
  });
});

describe("verb-layer approve / reject", () => {
  it("approve flips status, fires injected deploy, and records the outcome", async () => {
    const entry = await runPromotionPolicyAdd(cp, {
      productName: "p",
      destTargetName: "demo",
      gateKind: "manual",
    });
    expect(entry.policy.gateKind).toBe("manual");
    const release = await makeReadyRelease("v0.0.1");
    await firePolicy(
      { controlPlane: cp, deploy: async () => ({ deploymentId: null, outcome: "success" }) },
      entry.policy,
      release,
    );
    const pending = await cp.approvals.listForOrg(org.id, { status: "pending" });
    expect(pending).toHaveLength(1);
    const result = await runPromotionApprove(
      cp,
      { id: pending[0].id, decidedBy: "alice", reason: "smoke green" },
      {
        deploy: async () => ({ deploymentId: "dep-final", outcome: "success" }),
      },
    );
    expect(result.approval.status).toBe("approved");
    expect(result.deployOutcome).toBe("success");
    expect(result.deployedDeploymentId).toBe("dep-final");
    const audit = await cp.auditLog.listForOrg(org.id, {
      entityType: "approval",
    });
    expect(audit.some((a) => a.action === "approval.approved")).toBe(true);
  });

  it("approve refuses to re-approve a decided row", async () => {
    const entry = await runPromotionPolicyAdd(cp, {
      productName: "p",
      destTargetName: "demo",
      gateKind: "manual",
    });
    const release = await makeReadyRelease("v0.0.1");
    await firePolicy(
      { controlPlane: cp, deploy: async () => ({ deploymentId: null, outcome: "success" }) },
      entry.policy,
      release,
    );
    const pending = await cp.approvals.listForOrg(org.id, { status: "pending" });
    await runPromotionApprove(cp, { id: pending[0].id }, {
      deploy: async () => ({ deploymentId: null, outcome: "success" }),
    });
    await expect(
      runPromotionApprove(cp, { id: pending[0].id }, {
        deploy: async () => ({ deploymentId: null, outcome: "success" }),
      }),
    ).rejects.toThrow(/not pending/);
  });

  it("reject flips status to rejected and emits an audit row", async () => {
    const entry = await runPromotionPolicyAdd(cp, {
      productName: "p",
      destTargetName: "demo",
      gateKind: "manual",
    });
    const release = await makeReadyRelease("v0.0.1");
    await firePolicy(
      { controlPlane: cp, deploy: async () => ({ deploymentId: null, outcome: "success" }) },
      entry.policy,
      release,
    );
    const pending = await cp.approvals.listForOrg(org.id, { status: "pending" });
    const result = await runPromotionReject(cp, {
      id: pending[0].id,
      reason: "manual veto",
    });
    expect(result.status).toBe("rejected");
    const audit = await cp.auditLog.listForOrg(org.id, {
      entityType: "approval",
    });
    expect(audit.some((a) => a.action === "approval.rejected")).toBe(true);
  });

  it("approve refuses on unknown id", async () => {
    await expect(
      runPromotionApprove(cp, { id: "missing" }),
    ).rejects.toThrow(/approval not found/);
  });

  it("approvalsDueForAutoApprove + listPendingAutoApprove agree on cutoff", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "time_delay",
      gateConfig: { delay_seconds: 60 },
    });
    const release = await makeReadyRelease("v0.0.1");
    await onReleaseBuilt(
      { controlPlane: cp, deploy: async () => ({ deploymentId: null, outcome: "success" }), now: () => new Date("2026-05-14T12:00:00Z") },
      release,
    );
    const allPending = await cp.approvals.listForOrg(org.id, { status: "pending" });
    const pureView = approvalsDueForAutoApprove(allPending, Date.parse("2026-05-14T12:02:00Z"));
    const repoView = await cp.approvals.listPendingAutoApprove("2026-05-14T12:02:00.000Z");
    expect(pureView.map((a) => a.id).sort()).toEqual(repoView.map((a) => a.id).sort());
  });
});

describe("approver allow-list", () => {
  const baseStub: PromotionPolicy = {
    id: "pol",
    orgId: "org",
    productId: "p",
    sourceTargetId: null,
    destTargetId: "t",
    gateKind: "manual",
    gateConfig: {},
    active: true,
    description: null,
    createdAt: "x",
    updatedAt: "x",
    deletedAt: null,
  };

  describe("checkApproverAllowlist (pure)", () => {
    it("returns null when no allow-list is set", () => {
      expect(checkApproverAllowlist(baseStub, "alice")).toBeNull();
    });

    it("returns null when allow-list is empty", () => {
      const policy = { ...baseStub, gateConfig: { approvers: [] } };
      expect(checkApproverAllowlist(policy, "alice")).toBeNull();
    });

    it("requires decided_by when allow-list is non-empty", () => {
      const policy = { ...baseStub, gateConfig: { approvers: ["alice"] } };
      expect(checkApproverAllowlist(policy, undefined)).toMatch(/requires --decided-by/);
    });

    it("rejects a decided_by outside the allow-list", () => {
      const policy = { ...baseStub, gateConfig: { approvers: ["alice", "bob"] } };
      expect(checkApproverAllowlist(policy, "mallory")).toMatch(
        /'mallory' is not in the approver allow-list/,
      );
    });

    it("accepts a decided_by inside the allow-list", () => {
      const policy = { ...baseStub, gateConfig: { approvers: ["alice", "bob"] } };
      expect(checkApproverAllowlist(policy, "bob")).toBeNull();
    });

    it("rejects a malformed allow-list (not an array)", () => {
      const policy = {
        ...baseStub,
        gateConfig: { approvers: "alice" } as unknown as Record<string, unknown>,
      };
      expect(checkApproverAllowlist(policy, "alice")).toMatch(/malformed gate_config.approvers/);
    });
  });

  it("runPromotionApprove honours the allow-list", async () => {
    const entry = await runPromotionPolicyAdd(cp, {
      productName: "p",
      destTargetName: "demo",
      gateKind: "manual",
      gateConfig: { approvers: ["alice", "bob"] },
    });
    const release = await makeReadyRelease("v0.0.1");
    await firePolicy(
      { controlPlane: cp, deploy: async () => ({ deploymentId: null, outcome: "success" }) },
      entry.policy,
      release,
    );
    const [pending] = await cp.approvals.listForOrg(org.id, { status: "pending" });

    // Mallory is not in the list — refused.
    await expect(
      runPromotionApprove(cp, { id: pending.id, decidedBy: "mallory" }, {
        deploy: async () => ({ deploymentId: null, outcome: "success" }),
      }),
    ).rejects.toThrow(/approver allow-list/);

    // Approval row stays pending.
    const stillPending = await cp.approvals.get(pending.id);
    expect(stillPending?.status).toBe("pending");

    // Alice is in the list — allowed.
    const result = await runPromotionApprove(
      cp,
      { id: pending.id, decidedBy: "alice", reason: "ok" },
      { deploy: async () => ({ deploymentId: null, outcome: "success" }) },
    );
    expect(result.approval.status).toBe("approved");
    expect(result.approval.decidedBy).toBe("alice");
  });

  it("runPromotionApprove requires --decided-by when allow-list is non-empty", async () => {
    const entry = await runPromotionPolicyAdd(cp, {
      productName: "p",
      destTargetName: "demo",
      gateKind: "manual",
      gateConfig: { approvers: ["alice"] },
    });
    const release = await makeReadyRelease("v0.0.1");
    await firePolicy(
      { controlPlane: cp, deploy: async () => ({ deploymentId: null, outcome: "success" }) },
      entry.policy,
      release,
    );
    const [pending] = await cp.approvals.listForOrg(org.id, { status: "pending" });
    await expect(
      runPromotionApprove(cp, { id: pending.id }, {
        deploy: async () => ({ deploymentId: null, outcome: "success" }),
      }),
    ).rejects.toThrow(/requires --decided-by/);
  });
});

describe("tier-to-tier promotion (onReleaseDeployed)", () => {
  it("fires policies whose source matches the just-deployed target", async () => {
    const testTarget = target; // 'demo' — re-using as the source.
    const prodTarget = await cp.targets.create({
      orgId: org.id,
      name: "prod",
      kind: "vm_demo",
      connection: { vmName: "vm-prod" },
    });
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: prodTarget.id,
      gateKind: "auto",
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const outcomes = await onReleaseDeployed(
      { controlPlane: cp, deploy: invoker },
      release,
      testTarget.id,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("auto_deployed");
    expect(calls).toEqual([{ releaseId: release.id, destTargetId: prodTarget.id }]);
  });

  it("skips policies whose source doesn't match the deployed target", async () => {
    const otherSource = await cp.targets.create({
      orgId: org.id,
      name: "test",
      kind: "vm_test",
      connection: { vmName: "vm-test" },
    });
    const prodTarget = await cp.targets.create({
      orgId: org.id,
      name: "prod",
      kind: "vm_demo",
      connection: { vmName: "vm-prod" },
    });
    // Policy fires on test → prod.
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: otherSource.id,
      destTargetId: prodTarget.id,
      gateKind: "auto",
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    // Demo just got deployed, but the policy wants `test` as source.
    const outcomes = await onReleaseDeployed(
      { controlPlane: cp, deploy: invoker },
      release,
      target.id, // 'demo'
    );
    expect(outcomes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not fire initial-tier policies (source IS NULL) on deploy", async () => {
    // Initial-tier policy: source is null, dest=demo.
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    const { invoker, calls } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const outcomes = await onReleaseDeployed(
      { controlPlane: cp, deploy: invoker },
      release,
      target.id,
    );
    expect(outcomes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("re-fire on same (release, dest) is idempotent", async () => {
    const prodTarget = await cp.targets.create({
      orgId: org.id,
      name: "prod",
      kind: "vm_demo",
      connection: { vmName: "vm-prod" },
    });
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: target.id,
      destTargetId: prodTarget.id,
      gateKind: "manual",
    });
    const { invoker } = recordingInvoker();
    const release = await makeReadyRelease("v0.0.1");
    const first = await onReleaseDeployed(
      { controlPlane: cp, deploy: invoker },
      release,
      target.id,
    );
    const second = await onReleaseDeployed(
      { controlPlane: cp, deploy: invoker },
      release,
      target.id,
    );
    expect(first[0].action).toBe("queued_manual");
    expect(second[0].action).toBe("duplicate");
    expect(second[0].approvalId).toBe(first[0].approvalId);
  });
});
