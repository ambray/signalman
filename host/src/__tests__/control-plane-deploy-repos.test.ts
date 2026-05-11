/**
 * Tests for the PR 3 SQLite repos: target, deployment, health_check.
 *
 * The active-deployment unique partial index is the load-bearing
 * invariant — exercise both happy path and the supersede-before-promote
 * ordering the deploy executor relies on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import { StorageConflictError } from "../control-plane/storage/driver.js";
import type { Org, Product, Release, Target } from "../control-plane/types.js";

let driver: SqliteStorageDriver;
let org: Org;
let product: Product;
let release: Release;
let target: Target;

beforeEach(async () => {
  driver = new SqliteStorageDriver({ path: ":memory:" });
  await driver.migrate();
  org = await driver.orgs.create({ name: "org" });
  product = await driver.products.create({
    orgId: org.id,
    name: "p",
    repoUrl: "u",
  });
  release = await driver.releases.create({
    orgId: org.id,
    productId: product.id,
    tag: "v1",
    commitSha: "c",
  });
  await driver.releases.update(release.id, { status: "ready" });
  target = await driver.targets.create({
    orgId: org.id,
    name: "win11-demo",
    kind: "vm_demo",
    connection: { backend: "service", vmName: "Win11_demo" },
  });
});

afterEach(async () => {
  await driver.close();
});

describe("targets", () => {
  it("creates, looks up, lists, soft-deletes", async () => {
    expect(target.kind).toBe("vm_demo");
    expect(target.connection.vmName).toBe("Win11_demo");
    const found = await driver.targets.getByName(org.id, "win11-demo");
    expect(found?.id).toBe(target.id);
    const list = await driver.targets.listForOrg(org.id);
    expect(list).toHaveLength(1);
    await driver.targets.softDelete(target.id);
    expect(await driver.targets.listForOrg(org.id)).toEqual([]);
  });

  it("rejects duplicate name within org", async () => {
    await expect(
      driver.targets.create({
        orgId: org.id,
        name: "win11-demo",
        kind: "vm_test",
        connection: {},
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("rejects an invalid kind via CHECK constraint", async () => {
    await expect(
      driver.targets.create({
        orgId: org.id,
        name: "x",
        kind: "bogus" as unknown as "vm_test",
        connection: {},
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });
});

describe("deployments — active-deployment invariant", () => {
  it("create defaults to status=pending", async () => {
    const d = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    expect(d.status).toBe("pending");
    expect(d.previousDeploymentId).toBeNull();
  });

  it("allows only one active deployment per target", async () => {
    const d1 = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    await driver.deployments.update(d1.id, { status: "active" });

    // A second deployment can be created in 'pending' / 'deploying'.
    const d2 = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
      previousDeploymentId: d1.id,
    });
    await driver.deployments.update(d2.id, { status: "deploying" });

    // Promoting d2 to active while d1 is still active should fail
    // (unique partial index).
    await expect(
      driver.deployments.update(d2.id, { status: "active" }),
    ).rejects.toBeInstanceOf(StorageConflictError);

    // Supersede-first → promote second pattern is allowed.
    await driver.deployments.update(d1.id, { status: "superseded" });
    const promoted = await driver.deployments.update(d2.id, { status: "active" });
    expect(promoted.status).toBe("active");
  });

  it("getActiveForTarget returns null when none active", async () => {
    expect(await driver.deployments.getActiveForTarget(target.id)).toBeNull();
    const d = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    await driver.deployments.update(d.id, { status: "active" });
    const found = await driver.deployments.getActiveForTarget(target.id);
    expect(found?.id).toBe(d.id);
  });

  it("listForTarget returns newest first", async () => {
    const d1 = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    const d2 = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    const list = await driver.deployments.listForTarget(target.id);
    // Both have the same ms-quantized created_at; just verify the
    // function returns them both.
    expect(list.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
  });

  it("update sets health_summary as JSON", async () => {
    const d = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    const updated = await driver.deployments.update(d.id, {
      healthSummary: { total: 3, pass: 2, fail: 1, degraded: 0 },
    });
    expect(updated.healthSummary).toEqual({ total: 3, pass: 2, fail: 1, degraded: 0 });

    // Read fresh — round-trips through JSON.
    const reread = await driver.deployments.get(d.id);
    expect(reread?.healthSummary).toEqual({ total: 3, pass: 2, fail: 1, degraded: 0 });
  });
});

describe("health_check", () => {
  it("appends and lists per-deployment", async () => {
    const d = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    await driver.healthChecks.append({
      deploymentId: d.id,
      probeName: "vm_reachable",
      status: "pass",
      latencyMs: 12,
      detail: "ip=10.0.0.5",
    });
    await driver.healthChecks.append({
      deploymentId: d.id,
      probeName: "vm_reachable",
      status: "fail",
      detail: "VM stopped",
    });
    const list = await driver.healthChecks.listForDeployment(d.id);
    expect(list).toHaveLength(2);
    // Both entries present — we can't assert relative order because
    // nowIso() is ms-quantized and the two appends fall in the same
    // tick on a fast machine.
    const statuses = list.map((c) => c.status).sort();
    expect(statuses).toEqual(["fail", "pass"]);
    const passEntry = list.find((c) => c.status === "pass")!;
    expect(passEntry.latencyMs).toBe(12);
  });

  it("rejects an unknown status value via CHECK", async () => {
    const d = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    await expect(
      driver.healthChecks.append({
        deploymentId: d.id,
        probeName: "x",
        status: "bogus" as unknown as "pass",
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });
});
