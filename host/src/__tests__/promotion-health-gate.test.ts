// WS6 M7 — promotion health-gate tests.
//
// Closes the WS3↔WS2 integration gap from the wave-2 capability matrix:
// a tier-to-tier promotion policy can declare a `health_gate` in its
// gate_config that defers auto-firing until the source-tier deployment
// has accrued N consecutive recent health-check passes inside a
// window. Operator-driven manual approval ALWAYS overrides the gate.
//
// What this test pins:
//   Pure functions:
//     1. readHealthGate parses a valid shape
//     2. readHealthGate returns null when absent
//     3. readHealthGate returns null on invalid min_pass_count
//     4. readHealthGate returns null on invalid window_minutes
//     5. readHealthGate returns null on zero/negative values
//     6. isHealthGateOpen open when N pass within window
//     7. isHealthGateOpen closed when fewer than N
//     8. isHealthGateOpen closed when most-recent is fail/degraded
//     9. isHealthGateOpen closed when most-recent is older than window
//
//   Integration with the listener:
//    10. firePolicy with health_gate + sourceTargetId queues pending,
//        requiresHealthGate=true, no deploy fires
//    11. tick with no recent health checks: doesn't fire
//    12. tick with N passes within window: fires
//    13. tick with most-recent fail: doesn't fire
//    14. tick with most-recent stale (older than window): doesn't fire
//    15. AND condition: time_delay + health_gate requires both
//    16. manual + health_gate: gate IGNORED (operator owns the decision)
//    17. Initial-tier (sourceTargetId=null) + health_gate: gate IGNORED
//    18. Operator approve overrides health gate (deploy fires immediately)
//    19. Source-deployment-for-different-release: doesn't fire

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  firePolicy,
  isHealthGateOpen,
  onReleaseDeployed,
  readHealthGate,
  runPromotionTick,
  type DeployInvoker,
} from "../control-plane/promotion/index.js";
import {
  runPromotionApprove,
} from "../verbs/control-plane.js";
import type {
  Deployment,
  Org,
  Product,
  PromotionPolicy,
  Release,
  Target,
} from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;
let product: Product;
let testTarget: Target;
let demoTarget: Target;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-promo-hg-"));
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
  testTarget = await cp.targets.create({
    orgId: org.id,
    name: "test-tier",
    kind: "vm_test",
    connection: { vmName: "vm-test" },
  });
  demoTarget = await cp.targets.create({
    orgId: org.id,
    name: "demo-tier",
    kind: "vm_demo",
    connection: { vmName: "vm-demo" },
  });
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

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

async function makeActiveDeploymentOnSource(release: Release): Promise<Deployment> {
  const d = await cp.deployments.create({
    orgId: org.id,
    releaseId: release.id,
    targetId: testTarget.id,
  });
  return cp.deployments.update(d.id, { status: "active" });
}

async function appendHealthCheck(
  deploymentId: string,
  status: "pass" | "fail" | "degraded",
): Promise<void> {
  await cp.healthChecks.append({
    deploymentId,
    probeName: "default",
    status,
  });
}

// ────────────────────────────────────────────────────────────────────
// Pure functions
// ────────────────────────────────────────────────────────────────────

describe("readHealthGate (pure)", () => {
  function policy(gateConfig: Record<string, unknown>): PromotionPolicy {
    return {
      id: "p1",
      orgId: "o",
      productId: "prod",
      sourceTargetId: "src",
      destTargetId: "dst",
      gateKind: "auto",
      gateConfig,
      active: true,
      description: null,
      createdAt: "2026-05-14T00:00:00Z",
      updatedAt: "2026-05-14T00:00:00Z",
      deletedAt: null,
    };
  }

  it("returns null when absent", () => {
    expect(readHealthGate(policy({}))).toBeNull();
  });

  it("parses a valid shape", () => {
    const gate = readHealthGate(
      policy({ health_gate: { min_pass_count: 3, window_minutes: 30 } }),
    );
    expect(gate).toEqual({ min_pass_count: 3, window_minutes: 30 });
  });

  it("returns null on missing min_pass_count", () => {
    expect(readHealthGate(policy({ health_gate: { window_minutes: 30 } }))).toBeNull();
  });

  it("returns null on missing window_minutes", () => {
    expect(readHealthGate(policy({ health_gate: { min_pass_count: 3 } }))).toBeNull();
  });

  it("returns null on zero / negative min_pass_count", () => {
    expect(
      readHealthGate(policy({ health_gate: { min_pass_count: 0, window_minutes: 30 } })),
    ).toBeNull();
    expect(
      readHealthGate(policy({ health_gate: { min_pass_count: -1, window_minutes: 30 } })),
    ).toBeNull();
  });

  it("returns null on non-integer values", () => {
    expect(
      readHealthGate(policy({ health_gate: { min_pass_count: 1.5, window_minutes: 30 } })),
    ).toBeNull();
  });

  it("returns null when health_gate is not an object", () => {
    expect(readHealthGate(policy({ health_gate: "yes" }))).toBeNull();
    expect(readHealthGate(policy({ health_gate: [3, 30] }))).toBeNull();
  });
});

describe("isHealthGateOpen (pure)", () => {
  const gate = { min_pass_count: 3, window_minutes: 30 };
  const now = Date.parse("2026-05-14T12:00:00Z");

  it("open when N most-recent are pass within window", () => {
    const checks = [
      { status: "pass" as const, at: "2026-05-14T11:59:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:58:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:57:00Z" },
    ];
    expect(isHealthGateOpen(checks, gate, now)).toEqual({ open: true });
  });

  it("closed when fewer than N checks recorded", () => {
    const checks = [
      { status: "pass" as const, at: "2026-05-14T11:59:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:58:00Z" },
    ];
    const decision = isHealthGateOpen(checks, gate, now);
    expect(decision.open).toBe(false);
    if (!decision.open) {
      expect(decision.reason).toMatch(/only 2\/3/);
    }
  });

  it("closed when most-recent is fail", () => {
    const checks = [
      { status: "fail" as const, at: "2026-05-14T11:59:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:58:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:57:00Z" },
    ];
    const decision = isHealthGateOpen(checks, gate, now);
    expect(decision.open).toBe(false);
    if (!decision.open) {
      expect(decision.reason).toMatch(/fail/);
    }
  });

  it("closed when most-recent is degraded", () => {
    const checks = [
      { status: "degraded" as const, at: "2026-05-14T11:59:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:58:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:57:00Z" },
    ];
    expect(isHealthGateOpen(checks, gate, now).open).toBe(false);
  });

  it("closed when newest is older than window_minutes", () => {
    const checks = [
      { status: "pass" as const, at: "2026-05-14T11:00:00Z" }, // 60 min old
      { status: "pass" as const, at: "2026-05-14T10:59:00Z" },
      { status: "pass" as const, at: "2026-05-14T10:58:00Z" },
    ];
    const decision = isHealthGateOpen(checks, gate, now);
    expect(decision.open).toBe(false);
    if (!decision.open) {
      expect(decision.reason).toMatch(/older than window/);
    }
  });

  it("closed when newest has unparseable timestamp", () => {
    const checks = [
      { status: "pass" as const, at: "not-an-iso-date" },
      { status: "pass" as const, at: "2026-05-14T11:58:00Z" },
      { status: "pass" as const, at: "2026-05-14T11:57:00Z" },
    ];
    expect(isHealthGateOpen(checks, gate, now).open).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration with the listener + tick
// ────────────────────────────────────────────────────────────────────

describe("firePolicy with health_gate", () => {
  it("tier-to-tier auto + health_gate queues pending; requires_health_gate=true", async () => {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "auto",
      gateConfig: {
        health_gate: { min_pass_count: 3, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    const { invoker, calls } = recordingInvoker();
    const outcome = await firePolicy(
      { controlPlane: cp, deploy: invoker },
      policy,
      release,
    );
    expect(outcome.action).toBe("queued_health_gate");
    expect(calls).toEqual([]); // no deploy
    const approval = await cp.approvals.get(outcome.approvalId!);
    expect(approval?.status).toBe("pending");
    expect(approval?.requiresHealthGate).toBe(true);
  });

  it("manual + health_gate IGNORES the gate (operator-driven)", async () => {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "manual",
      gateConfig: {
        health_gate: { min_pass_count: 3, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    const { invoker, calls } = recordingInvoker();
    const outcome = await firePolicy(
      { controlPlane: cp, deploy: invoker },
      policy,
      release,
    );
    expect(outcome.action).toBe("queued_manual");
    expect(calls).toEqual([]);
    const approval = await cp.approvals.get(outcome.approvalId!);
    expect(approval?.requiresHealthGate).toBe(false);
  });

  it("initial-tier (sourceTargetId=null) + health_gate IGNORES the gate (no source to check)", async () => {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      // no sourceTargetId — initial-tier policy
      destTargetId: demoTarget.id,
      gateKind: "auto",
      gateConfig: {
        health_gate: { min_pass_count: 3, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    const { invoker, calls } = recordingInvoker();
    const outcome = await firePolicy(
      { controlPlane: cp, deploy: invoker },
      policy,
      release,
    );
    expect(outcome.action).toBe("auto_deployed");
    expect(calls).toHaveLength(1);
  });

  it("time_delay + health_gate queues with BOTH autoApproveAt and requires_health_gate=true", async () => {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "time_delay",
      gateConfig: {
        delay_seconds: 600,
        health_gate: { min_pass_count: 3, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    const { invoker } = recordingInvoker();
    const t0 = new Date("2026-05-14T12:00:00Z");
    const outcome = await firePolicy(
      { controlPlane: cp, deploy: invoker, now: () => t0 },
      policy,
      release,
    );
    expect(outcome.action).toBe("queued_health_gate");
    const approval = await cp.approvals.get(outcome.approvalId!);
    expect(approval?.requiresHealthGate).toBe(true);
    expect(approval?.autoApproveAt).toBe("2026-05-14T12:10:00.000Z");
  });
});

describe("runPromotionTick with health-gated approvals", () => {
  async function queueGatedApproval(opts: {
    gateConfig?: Record<string, unknown>;
  } = {}): Promise<{ release: Release; deployment: Deployment; approvalId: string }> {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "auto",
      gateConfig: opts.gateConfig ?? {
        health_gate: { min_pass_count: 3, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    const deployment = await makeActiveDeploymentOnSource(release);
    const { invoker } = recordingInvoker();
    const outcome = await firePolicy(
      { controlPlane: cp, deploy: invoker },
      policy,
      release,
    );
    return { release, deployment, approvalId: outcome.approvalId! };
  }

  it("fires when N pass within window", async () => {
    const { approvalId, deployment } = await queueGatedApproval();
    await appendHealthCheck(deployment.id, "pass");
    await appendHealthCheck(deployment.id, "pass");
    await appendHealthCheck(deployment.id, "pass");
    const { invoker, calls } = recordingInvoker();
    const dispatched = await runPromotionTick({ controlPlane: cp, deploy: invoker });
    expect(dispatched).toBe(1);
    expect(calls).toHaveLength(1);
    const approval = await cp.approvals.get(approvalId);
    expect(approval?.status).toBe("auto_approved");
    expect(approval?.reason).toMatch(/health_gate opened/);
  });

  it("does not fire when fewer than N passes recorded", async () => {
    const { approvalId, deployment } = await queueGatedApproval();
    await appendHealthCheck(deployment.id, "pass");
    await appendHealthCheck(deployment.id, "pass");
    // only 2 checks; gate requires 3
    const { invoker, calls } = recordingInvoker();
    const dispatched = await runPromotionTick({ controlPlane: cp, deploy: invoker });
    expect(dispatched).toBe(0);
    expect(calls).toEqual([]);
    const approval = await cp.approvals.get(approvalId);
    expect(approval?.status).toBe("pending");
  });

  it("does not fire when most-recent is fail", async () => {
    const { approvalId, deployment } = await queueGatedApproval();
    await appendHealthCheck(deployment.id, "pass");
    await appendHealthCheck(deployment.id, "pass");
    await appendHealthCheck(deployment.id, "fail");
    const { invoker, calls } = recordingInvoker();
    const dispatched = await runPromotionTick({ controlPlane: cp, deploy: invoker });
    expect(dispatched).toBe(0);
    expect(calls).toEqual([]);
    const approval = await cp.approvals.get(approvalId);
    expect(approval?.status).toBe("pending");
  });

  it("does not fire when no health checks recorded yet", async () => {
    await queueGatedApproval();
    const { invoker, calls } = recordingInvoker();
    const dispatched = await runPromotionTick({ controlPlane: cp, deploy: invoker });
    expect(dispatched).toBe(0);
    expect(calls).toEqual([]);
  });

  it("does not fire when source-deployment is for a different release", async () => {
    // Queue a gated approval for release v0.0.1
    const { approvalId } = await queueGatedApproval();
    // Now replace source's active deployment with one for v0.0.2
    const replacement = await makeReadyRelease("v0.0.2");
    const oldActive = await cp.deployments.getActiveForTarget(testTarget.id);
    if (oldActive) {
      await cp.deployments.update(oldActive.id, { status: "rolled_back" });
    }
    const newDep = await cp.deployments.create({
      orgId: org.id,
      releaseId: replacement.id,
      targetId: testTarget.id,
    });
    await cp.deployments.update(newDep.id, { status: "active" });
    // Even with passes, the gate doesn't open for v0.0.1 because
    // source is now on v0.0.2.
    await appendHealthCheck(newDep.id, "pass");
    await appendHealthCheck(newDep.id, "pass");
    await appendHealthCheck(newDep.id, "pass");
    const { invoker, calls } = recordingInvoker();
    const dispatched = await runPromotionTick({ controlPlane: cp, deploy: invoker });
    expect(dispatched).toBe(0);
    expect(calls).toEqual([]);
    const approval = await cp.approvals.get(approvalId);
    expect(approval?.status).toBe("pending");
  });

  it("AND condition: time_delay + health_gate — both must be satisfied", async () => {
    // Queue with delay_seconds: 600 + health_gate
    const t0 = new Date("2026-05-14T12:00:00Z");
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "time_delay",
      gateConfig: {
        delay_seconds: 600,
        health_gate: { min_pass_count: 1, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    const deployment = await makeActiveDeploymentOnSource(release);
    const { invoker } = recordingInvoker();
    await firePolicy({ controlPlane: cp, deploy: invoker, now: () => t0 }, policy, release);

    // Health passes immediately, but time delay isn't elapsed
    await appendHealthCheck(deployment.id, "pass");
    const tEarly = new Date("2026-05-14T12:05:00Z");
    const earlyDispatched = await runPromotionTick({
      controlPlane: cp,
      deploy: invoker,
      now: () => tEarly,
    });
    expect(earlyDispatched).toBe(0);

    // Now both: time elapsed + health passing → fires
    const tReady = new Date("2026-05-14T12:11:00Z");
    const readyDispatched = await runPromotionTick({
      controlPlane: cp,
      deploy: invoker,
      now: () => tReady,
    });
    expect(readyDispatched).toBe(1);
  });
});

describe("operator approve overrides health gate", () => {
  it("runPromotionApprove fires the deploy regardless of health-gate state", async () => {
    const policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "auto",
      gateConfig: {
        health_gate: { min_pass_count: 3, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    await makeActiveDeploymentOnSource(release);
    const { invoker, calls } = recordingInvoker();
    const out = await firePolicy(
      { controlPlane: cp, deploy: invoker },
      policy,
      release,
    );
    expect(out.action).toBe("queued_health_gate");
    expect(calls).toEqual([]);

    // No health checks recorded. Operator approves anyway.
    const result = await runPromotionApprove(
      cp,
      { id: out.approvalId!, decidedBy: "alice" },
      { deploy: invoker },
    );
    expect(result.deployOutcome).toBe("success");
    expect(calls).toHaveLength(1);
    const approval = await cp.approvals.get(out.approvalId!);
    expect(approval?.status).toBe("approved");
    expect(approval?.decidedBy).toBe("alice");
  });
});

describe("onReleaseDeployed integration with health_gate", () => {
  it("queues health-gated approval on tier-to-tier fire", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: testTarget.id,
      destTargetId: demoTarget.id,
      gateKind: "auto",
      gateConfig: {
        health_gate: { min_pass_count: 2, window_minutes: 30 },
      },
    });
    const release = await makeReadyRelease("v0.0.1");
    await makeActiveDeploymentOnSource(release);
    const { invoker, calls } = recordingInvoker();
    const outcomes = await onReleaseDeployed(
      { controlPlane: cp, deploy: invoker },
      release,
      testTarget.id,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("queued_health_gate");
    expect(calls).toEqual([]);
  });
});
