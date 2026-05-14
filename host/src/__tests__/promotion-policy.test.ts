/**
 * Unit tests for the promotion policy + approval repos and the pure
 * gate-decision helpers (v0.4.0-1 / Epic 1, WS3).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  approvalsDueForAutoApprove,
  decideGate,
  readDelaySeconds,
} from "../control-plane/promotion/index.js";
import type {
  Approval,
  Org,
  Product,
  PromotionPolicy,
  Target,
} from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;
let product: Product;
let target: Target;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-prom-"));
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

describe("PromotionPolicyRepo (sqlite)", () => {
  it("creates with sane defaults", async () => {
    const p = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    expect(p.gateKind).toBe("auto");
    expect(p.sourceTargetId).toBeNull();
    expect(p.active).toBe(true);
    expect(p.gateConfig).toEqual({});
  });

  it("listMatchingForProduct narrows by null source", async () => {
    const sourceTarget = await cp.targets.create({
      orgId: org.id,
      name: "test",
      kind: "vm_test",
      connection: { vmName: "vm-test" },
    });
    const initial = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: sourceTarget.id,
      destTargetId: target.id,
      gateKind: "manual",
    });
    const matching = await cp.promotionPolicies.listMatchingForProduct({
      productId: product.id,
      sourceTargetId: null,
    });
    expect(matching.map((p) => p.id)).toEqual([initial.id]);
  });

  it("listMatchingForProduct narrows by source target id", async () => {
    const sourceTarget = await cp.targets.create({
      orgId: org.id,
      name: "test",
      kind: "vm_test",
      connection: { vmName: "vm-test" },
    });
    const tiered = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      sourceTargetId: sourceTarget.id,
      destTargetId: target.id,
      gateKind: "manual",
    });
    const matching = await cp.promotionPolicies.listMatchingForProduct({
      productId: product.id,
      sourceTargetId: sourceTarget.id,
    });
    expect(matching.map((p) => p.id)).toEqual([tiered.id]);
  });

  it("inactive policies are skipped by listMatchingForProduct", async () => {
    await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
      active: false,
    });
    const matching = await cp.promotionPolicies.listMatchingForProduct({
      productId: product.id,
      sourceTargetId: null,
    });
    expect(matching).toEqual([]);
  });

  it("update toggles active", async () => {
    const p = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "auto",
    });
    const updated = await cp.promotionPolicies.update(p.id, { active: false });
    expect(updated.active).toBe(false);
  });
});

describe("ApprovalRepo (sqlite)", () => {
  let policy: PromotionPolicy;
  beforeEach(async () => {
    policy = await cp.promotionPolicies.create({
      orgId: org.id,
      productId: product.id,
      destTargetId: target.id,
      gateKind: "manual",
    });
  });

  it("creates pending approval", async () => {
    const release = await cp.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v0.0.1",
      commitSha: "c".repeat(40),
    });
    const a = await cp.approvals.create({
      orgId: org.id,
      policyId: policy.id,
      releaseId: release.id,
      destTargetId: target.id,
      status: "pending",
    });
    expect(a.status).toBe("pending");
    expect(a.autoApproveAt).toBeNull();
  });

  it("unique constraint blocks duplicate pending row per (release, dest)", async () => {
    const release = await cp.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v0.0.1",
      commitSha: "c".repeat(40),
    });
    await cp.approvals.create({
      orgId: org.id,
      policyId: policy.id,
      releaseId: release.id,
      destTargetId: target.id,
      status: "pending",
    });
    await expect(
      cp.approvals.create({
        orgId: org.id,
        policyId: policy.id,
        releaseId: release.id,
        destTargetId: target.id,
        status: "pending",
      }),
    ).rejects.toBeDefined();
  });

  it("listPendingAutoApprove returns time-due pending rows only", async () => {
    const release = await cp.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v0.0.1",
      commitSha: "c".repeat(40),
    });
    const past = await cp.approvals.create({
      orgId: org.id,
      policyId: policy.id,
      releaseId: release.id,
      destTargetId: target.id,
      status: "pending",
      autoApproveAt: "2020-01-01T00:00:00.000Z",
    });
    // Future: not due.
    const release2 = await cp.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v0.0.2",
      commitSha: "c".repeat(40),
    });
    await cp.approvals.create({
      orgId: org.id,
      policyId: policy.id,
      releaseId: release2.id,
      destTargetId: target.id,
      status: "pending",
      autoApproveAt: "2999-01-01T00:00:00.000Z",
    });
    const due = await cp.approvals.listPendingAutoApprove("2026-05-14T12:00:00.000Z");
    expect(due.map((a) => a.id)).toEqual([past.id]);
  });
});

describe("decideGate (pure)", () => {
  const stub: PromotionPolicy = {
    id: "p",
    orgId: "o",
    productId: "pp",
    sourceTargetId: null,
    destTargetId: "t",
    gateKind: "auto",
    gateConfig: {},
    active: true,
    description: null,
    createdAt: "x",
    updatedAt: "x",
    deletedAt: null,
  };
  it("maps auto → auto_deploy", () => {
    expect(decideGate({ ...stub, gateKind: "auto" })).toBe("auto_deploy");
  });
  it("maps manual → queue_manual", () => {
    expect(decideGate({ ...stub, gateKind: "manual" })).toBe("queue_manual");
  });
  it("maps time_delay → queue_time_delay", () => {
    expect(decideGate({ ...stub, gateKind: "time_delay" })).toBe("queue_time_delay");
  });
});

describe("readDelaySeconds (pure)", () => {
  const stub: PromotionPolicy = {
    id: "p",
    orgId: "o",
    productId: "pp",
    sourceTargetId: null,
    destTargetId: "t",
    gateKind: "time_delay",
    gateConfig: {},
    active: true,
    description: null,
    createdAt: "x",
    updatedAt: "x",
    deletedAt: null,
  };
  it("reads a numeric delay_seconds", () => {
    expect(readDelaySeconds({ ...stub, gateConfig: { delay_seconds: 600 } })).toBe(600);
  });
  it("rejects negative", () => {
    expect(() => readDelaySeconds({ ...stub, gateConfig: { delay_seconds: -1 } })).toThrow();
  });
  it("rejects non-numeric", () => {
    expect(() =>
      readDelaySeconds({ ...stub, gateConfig: { delay_seconds: "ten" } as unknown as Record<string, unknown> }),
    ).toThrow();
  });
});

describe("approvalsDueForAutoApprove (pure)", () => {
  const stub: Approval = {
    id: "a",
    orgId: "o",
    policyId: "p",
    releaseId: "r",
    destTargetId: "t",
    status: "pending",
    autoApproveAt: null,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deployAttemptedAt: null,
    deployOutcome: null,
    deployDeploymentId: null,
    createdAt: "x",
    updatedAt: "x",
    deletedAt: null,
  };
  const nowMs = Date.parse("2026-05-14T12:00:00.000Z");

  it("returns due rows", () => {
    const due = approvalsDueForAutoApprove(
      [{ ...stub, autoApproveAt: "2026-05-14T11:59:00.000Z" }],
      nowMs,
    );
    expect(due).toHaveLength(1);
  });

  it("skips future autoApproveAt", () => {
    const due = approvalsDueForAutoApprove(
      [{ ...stub, autoApproveAt: "2026-05-14T12:01:00.000Z" }],
      nowMs,
    );
    expect(due).toEqual([]);
  });

  it("skips approvals with null autoApproveAt", () => {
    const due = approvalsDueForAutoApprove([{ ...stub, autoApproveAt: null }], nowMs);
    expect(due).toEqual([]);
  });

  it("skips non-pending statuses", () => {
    const due = approvalsDueForAutoApprove(
      [{ ...stub, status: "approved", autoApproveAt: "2020-01-01T00:00:00Z" }],
      nowMs,
    );
    expect(due).toEqual([]);
  });

  it("skips broken timestamps", () => {
    const due = approvalsDueForAutoApprove(
      [{ ...stub, autoApproveAt: "not-a-date" }],
      nowMs,
    );
    expect(due).toEqual([]);
  });
});
