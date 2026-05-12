/**
 * Tests for the SQLite StorageDriver (PR 1 entities).
 *
 * Uses an in-memory database per test for full isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import {
  NotImplementedError,
  StorageConflictError,
  StorageNotFoundError,
} from "../control-plane/storage/driver.js";
import type { Org } from "../control-plane/types.js";

let driver: SqliteStorageDriver;
let org: Org;

beforeEach(async () => {
  driver = new SqliteStorageDriver({ path: ":memory:" });
  await driver.migrate();
  org = await driver.orgs.create({ name: "acme" });
});

afterEach(async () => {
  await driver.close();
});

describe("migrations", () => {
  it("apply on a fresh database and record in _migrations", () => {
    const rows = driver.db
      .prepare("SELECT version, name FROM _migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    // Schema should advance forward only — the first migration is
    // always `1: init`; subsequent ones append. Assert the prefix
    // so adding a new migration doesn't require touching this test.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toEqual({ version: 1, name: "init" });
  });

  it("are idempotent on second run", async () => {
    const before = (
      driver.db
        .prepare("SELECT count(*) AS c FROM _migrations")
        .get() as { c: number }
    ).c;
    await driver.migrate();
    const after = (
      driver.db
        .prepare("SELECT count(*) AS c FROM _migrations")
        .get() as { c: number }
    ).c;
    expect(after).toBe(before);
  });
});

describe("orgs", () => {
  it("creates with defaults", () => {
    expect(org.name).toBe("acme");
    expect(org.tier).toBe("free");
    expect(org.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(org.deletedAt).toBeNull();
  });

  it("rejects duplicate names", async () => {
    await expect(driver.orgs.create({ name: "acme" })).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });

  it("looks up by name", async () => {
    const found = await driver.orgs.getByName("acme");
    expect(found?.id).toBe(org.id);
    const missing = await driver.orgs.getByName("missing");
    expect(missing).toBeNull();
  });

  it("updates fields", async () => {
    const updated = await driver.orgs.update(org.id, { tier: "paid" });
    expect(updated.tier).toBe("paid");
    // updatedAt should be at or after createdAt; we can't assert strict
    // inequality because nowIso() is millisecond-quantized and the
    // create/update fall in the same tick on a fast machine.
    expect(updated.updatedAt >= org.createdAt).toBe(true);
  });

  it("soft-deletes and disappears from list", async () => {
    await driver.orgs.softDelete(org.id);
    expect(await driver.orgs.get(org.id)).toBeNull();
    expect(await driver.orgs.list()).toEqual([]);
    // Re-deleting throws (already gone).
    await expect(driver.orgs.softDelete(org.id)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it("allows the same name after soft-delete", async () => {
    await driver.orgs.softDelete(org.id);
    const fresh = await driver.orgs.create({ name: "acme" });
    expect(fresh.id).not.toBe(org.id);
  });
});

describe("products", () => {
  it("creates and lists per-org", async () => {
    const p = await driver.products.create({
      orgId: org.id,
      name: "example-product",
      repoUrl: "https://example.com/example.git",
    });
    expect(p.buildYamlPath).toBe("signalman.build.yaml");
    const list = await driver.products.listForOrg(org.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(p.id);
  });

  it("rejects duplicate name within an org", async () => {
    await driver.products.create({ orgId: org.id, name: "p1", repoUrl: "u" });
    await expect(
      driver.products.create({ orgId: org.id, name: "p1", repoUrl: "u" }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("permits the same name across orgs", async () => {
    const other = await driver.orgs.create({ name: "other" });
    await driver.products.create({ orgId: org.id, name: "p1", repoUrl: "u" });
    const p2 = await driver.products.create({
      orgId: other.id,
      name: "p1",
      repoUrl: "u",
    });
    expect(p2.id).toBeDefined();
  });

  it("updates a subset of fields", async () => {
    const p = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    const u = await driver.products.update(p.id, {
      buildYamlPath: "build/foo.yaml",
    });
    expect(u.buildYamlPath).toBe("build/foo.yaml");
    expect(u.name).toBe("p");
  });
});

describe("releases", () => {
  it("creates with default status=building", async () => {
    const product = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    const r = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1.0.0",
      commitSha: "abc123",
    });
    expect(r.status).toBe("building");
    expect(r.manifestSha256).toBeNull();
  });

  it("rejects duplicate tag within a product", async () => {
    const product = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "x",
    });
    await expect(
      driver.releases.create({
        orgId: org.id,
        productId: product.id,
        tag: "v1",
        commitSha: "y",
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("updates manifest + status on completion", async () => {
    const product = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    const r = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "x",
    });
    const u = await driver.releases.update(r.id, {
      status: "ready",
      manifestSha256: "f".repeat(64),
      builtAt: "2026-05-10T00:00:00.000Z",
    });
    expect(u.status).toBe("ready");
    expect(u.manifestSha256).toBe("f".repeat(64));
    expect(u.builtAt).toBe("2026-05-10T00:00:00.000Z");
  });

  it("filters list by status", async () => {
    const product = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    const a = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "x",
    });
    const b = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v2",
      commitSha: "y",
    });
    await driver.releases.update(a.id, { status: "ready" });
    const ready = await driver.releases.listForProduct(product.id, {
      status: "ready",
    });
    expect(ready.map((r) => r.tag)).toEqual(["v1"]);
    const all = await driver.releases.listForProduct(product.id);
    expect(all.map((r) => r.tag).sort()).toEqual(["v1", "v2"]);
    void b;
  });
});

describe("artifacts", () => {
  it("attaches to a release and lists by release", async () => {
    const product = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    const release = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "x",
    });
    await driver.artifacts.create({
      releaseId: release.id,
      component: "agent",
      kind: "blob",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      blobUri: "file:///tmp/a",
    });
    await driver.artifacts.create({
      releaseId: release.id,
      component: "backend",
      kind: "image_ref",
      imageRef: "example-backend:v1",
    });
    const list = await driver.artifacts.listForRelease(release.id);
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.component).sort()).toEqual(["agent", "backend"]);
  });

  it("rejects rows that violate the kind CHECK", async () => {
    const product = await driver.products.create({
      orgId: org.id,
      name: "p",
      repoUrl: "u",
    });
    const release = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "x",
    });
    await expect(
      driver.artifacts.create({
        releaseId: release.id,
        component: "x",
        // Cast through unknown to bypass the union type check at the call site.
        kind: "bogus" as unknown as "blob",
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });
});

describe("auditLog", () => {
  it("appends entries with detail JSON and lists newest first", async () => {
    await driver.auditLog.append({
      orgId: org.id,
      actor: "operator@local",
      action: "release.build",
      entityType: "release",
      entityId: "r-1",
      detail: { tag: "v1" },
    });
    await driver.auditLog.append({
      orgId: org.id,
      actor: "operator@local",
      action: "release.deploy",
      entityType: "release",
      entityId: "r-1",
    });
    const entries = await driver.auditLog.listForOrg(org.id);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("release.deploy");
    expect(entries[1].detail).toEqual({ tag: "v1" });
  });

  it("filters by entity", async () => {
    await driver.auditLog.append({
      orgId: org.id,
      actor: "op",
      action: "x",
      entityType: "release",
      entityId: "r-1",
    });
    await driver.auditLog.append({
      orgId: org.id,
      actor: "op",
      action: "y",
      entityType: "deployment",
      entityId: "d-1",
    });
    const releases = await driver.auditLog.listForOrg(org.id, {
      entityType: "release",
    });
    expect(releases).toHaveLength(1);
    expect(releases[0].entityType).toBe("release");
  });
});

// All five originally-reserved repos (target, deployment, healthCheck,
// scenario, run) landed in PRs 3–5. The "reserved repos" describe
// block from PR 1 has nothing left to assert; its safety property
// (proxies surface NotImplementedError instead of segfaulting) is
// preserved in unimplementedRepo() but no longer exercised by tests.
