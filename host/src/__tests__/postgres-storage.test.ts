/**
 * Tests for the PostgresStorageDriver using pg-mem (in-process,
 * Postgres-compatible in-memory engine). Covers migration application
 * + the full CRUD surface across all 12 entity repos, mirroring the
 * sqlite test suite.
 *
 * pg-mem has known fidelity gaps around concurrency primitives (e.g.
 * SELECT FOR UPDATE SKIP LOCKED semantics aren't exactly real
 * Postgres). The concurrent-claim test for the job repo is marked
 * `.skip` and documented as an integration-only check the operator
 * runs against a real Postgres at deploy time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newDb, type IMemoryDb } from "pg-mem";
import { PostgresStorageDriver } from "../control-plane/storage/postgres.js";
import {
  StorageConflictError,
  StorageNotFoundError,
} from "../control-plane/storage/driver.js";
import type {
  Org,
  Product,
  Release,
  Target,
} from "../control-plane/types.js";

let mem: IMemoryDb;
let driver: PostgresStorageDriver;
let org: Org;

beforeEach(async () => {
  mem = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem returns a `Pool` shaped like pg's, but its types aren't
  // shared with @types/pg. Cast is intentional + isolated.
  const { Pool } = mem.adapters.createPg();
  driver = new PostgresStorageDriver({ pool: new Pool() as any });
  await driver.migrate();
  org = await driver.orgs.create({ name: "acme" });
});

afterEach(async () => {
  await driver.close();
});

// ── Migrations ──────────────────────────────────────────────────────

describe("migrations", () => {
  it("apply on a fresh database and record in _migrations", async () => {
    const { Pool } = mem.adapters.createPg();
      const pool = new Pool() as any;
    const r = await pool.query(
      "SELECT version, name FROM _migrations ORDER BY version",
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    expect(r.rows[0]).toEqual({
      version: 1,
      name: "init",
    });
  });

  it("are idempotent on second run", async () => {
    const { Pool } = mem.adapters.createPg();
      const pool = new Pool() as any;
    const before = (await pool.query("SELECT count(*) AS c FROM _migrations"))
      .rows[0].c;
    await driver.migrate();
    const after = (await pool.query("SELECT count(*) AS c FROM _migrations"))
      .rows[0].c;
    expect(after).toBe(before);
  });
});

// ── orgs ────────────────────────────────────────────────────────────

describe("orgs", () => {
  it("creates with defaults", () => {
    expect(org.name).toBe("acme");
    expect(org.tier).toBe("free");
    expect(org.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("rejects duplicate names", async () => {
    await expect(driver.orgs.create({ name: "acme" })).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });

  it("getByName + soft-delete + reuse", async () => {
    const found = await driver.orgs.getByName("acme");
    expect(found?.id).toBe(org.id);
    await driver.orgs.softDelete(org.id);
    expect(await driver.orgs.getByName("acme")).toBeNull();
    // Soft-delete frees the name for reuse (partial unique index).
    const fresh = await driver.orgs.create({ name: "acme" });
    expect(fresh.id).not.toBe(org.id);
  });

  it("update changes tier", async () => {
    const updated = await driver.orgs.update(org.id, { tier: "paid" });
    expect(updated.tier).toBe("paid");
  });

  it("softDelete on unknown id throws", async () => {
    await expect(
      driver.orgs.softDelete("01ZZZZZZZZZZZZZZZZZZZZZZZZ"),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});

// ── products + releases + artifacts ─────────────────────────────────

describe("products / releases / artifacts", () => {
  let product: Product;
  beforeEach(async () => {
    product = await driver.products.create({
      orgId: org.id,
      name: "example",
      repoUrl: "https://example.invalid/example.git",
    });
  });

  it("products: list + duplicate-name conflict", async () => {
    const list = await driver.products.listForOrg(org.id);
    expect(list.map((p) => p.name)).toEqual(["example"]);
    await expect(
      driver.products.create({
        orgId: org.id,
        name: "example",
        repoUrl: "u",
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("releases: create + getByTag + status filter", async () => {
    const a = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "abc",
    });
    expect(a.status).toBe("building");
    await driver.releases.update(a.id, { status: "ready" });
    const ready = await driver.releases.listForProduct(product.id, {
      status: "ready",
    });
    expect(ready).toHaveLength(1);
    const byTag = await driver.releases.getByTag(product.id, "v1");
    expect(byTag?.id).toBe(a.id);
  });

  it("releases: duplicate tag conflict", async () => {
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

  it("releases: update persists manifest + build_yaml_json", async () => {
    const r = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "abc",
    });
    const yaml = JSON.stringify({ schema_version: 1, components: [] });
    const updated = await driver.releases.update(r.id, {
      status: "ready",
      manifestSha256: "f".repeat(64),
      buildYamlJson: yaml,
    });
    expect(updated.manifestSha256).toBe("f".repeat(64));
    expect(updated.buildYamlJson).toBe(yaml);
    const reread = await driver.releases.get(r.id);
    expect(reread?.buildYamlJson).toBe(yaml);
  });

  it("artifacts: blob + image_ref + listForRelease", async () => {
    const release = await driver.releases.create({
      orgId: org.id,
      productId: product.id,
      tag: "v1",
      commitSha: "abc",
    });
    await driver.artifacts.create({
      releaseId: release.id,
      component: "agent",
      kind: "blob",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      blobUri: "file:///x",
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
});

// ── targets / deployments / health_check ────────────────────────────

describe("targets / deployments / health_check", () => {
  let target: Target;
  let release: Release;
  beforeEach(async () => {
    const product = await driver.products.create({
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

  it("targets: connection round-trips as parsed JSON", async () => {
    const t = await driver.targets.getByName(org.id, "win11-demo");
    expect(t?.connection).toEqual({ backend: "service", vmName: "Win11_demo" });
  });

  it("deployments: one active per target invariant", async () => {
    const d1 = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    await driver.deployments.update(d1.id, { status: "active" });
    const d2 = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
      previousDeploymentId: d1.id,
    });
    // Promote d2 while d1 is still active → conflict on the partial
    // unique index.
    await expect(
      driver.deployments.update(d2.id, { status: "active" }),
    ).rejects.toBeInstanceOf(StorageConflictError);
    // Supersede d1 first, then d2 promotes cleanly.
    await driver.deployments.update(d1.id, { status: "superseded" });
    const promoted = await driver.deployments.update(d2.id, {
      status: "active",
    });
    expect(promoted.status).toBe("active");
  });

  it("deployments: getActiveForTarget", async () => {
    const d = await driver.deployments.create({
      orgId: org.id,
      releaseId: release.id,
      targetId: target.id,
    });
    expect(await driver.deployments.getActiveForTarget(target.id)).toBeNull();
    await driver.deployments.update(d.id, { status: "active" });
    const active = await driver.deployments.getActiveForTarget(target.id);
    expect(active?.id).toBe(d.id);
  });

  it("health_check: append + listForDeployment", async () => {
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
      probeName: "agent_service",
      status: "fail",
      detail: "service not found",
    });
    const list = await driver.healthChecks.listForDeployment(d.id);
    expect(list).toHaveLength(2);
    const statuses = list.map((c) => c.status).sort();
    expect(statuses).toEqual(["fail", "pass"]);
  });
});

// ── scenarios + runs ────────────────────────────────────────────────

describe("scenarios + runs", () => {
  it("scenarios: upsertFromDisk insert + update-in-place", async () => {
    const first = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h1",
      name: "Foo",
      tags: ["smoke"],
    });
    const second = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h2",
      name: "Foo (renamed)",
      tags: ["smoke", "extra"],
    });
    expect(second.id).toBe(first.id);
    expect(second.scenarioHash).toBe("h2");
    expect(second.tags).toEqual(["smoke", "extra"]);
  });

  it("runs: create + update lifecycle", async () => {
    const scenario = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/x",
      scenarioHash: "h",
      name: "X",
      tags: [],
    });
    const r = await driver.runs.create({
      orgId: org.id,
      scenarioId: scenario.id,
      triggeredBy: "cli",
    });
    const updated = await driver.runs.update(r.id, {
      result: "pass",
      completedAt: "2026-05-11T00:00:00.000Z",
      envelopeBlobUri: "file:///envelope",
    });
    expect(updated.result).toBe("pass");
  });
});

// ── jobs ────────────────────────────────────────────────────────────

describe("jobs", () => {
  it("create + listForOrg (non-claim path works against pg-mem)", async () => {
    const j = await driver.jobs.create({
      orgId: org.id,
      kind: "noop",
      input: { duration_ms: 5 },
    });
    expect(j.status).toBe("pending");
    expect(j.kind).toBe("noop");
    expect(j.input).toEqual({ duration_ms: 5 });
    const list = await driver.jobs.listForOrg(org.id);
    expect(list.map((x) => x.id)).toEqual([j.id]);
  });

  it("update transitions a pending job to succeeded", async () => {
    const j = await driver.jobs.create({ orgId: org.id, kind: "noop" });
    const done = await driver.jobs.update(j.id, {
      status: "succeeded",
      result: { ok: true },
      completedAt: "2026-05-11T00:00:00.000Z",
    });
    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ ok: true });
  });

  // pg-mem does not implement `FOR UPDATE SKIP LOCKED` (open issue;
  // it parses the AST but refuses to execute it). The claimNext SQL
  // is the standard Postgres claim-by-skip pattern documented in
  // postgres.ts; verify it against real Postgres at deploy time.
  // The concurrency invariant ("two parallel workers don't both see
  // the same pending row") is exercised in the sqlite suite, where
  // BEGIN IMMEDIATE provides equivalent semantics. Both drivers
  // satisfy the same JobRepo contract.
  it.skip(
    "[integration only] claimNext picks oldest pending, transitions to claimed",
    async () => {
      await driver.jobs.create({ orgId: org.id, kind: "noop" });
      const claimed = await driver.jobs.claimNext({
        orgId: org.id,
        claimedBy: "w1",
      });
      expect(claimed?.status).toBe("claimed");
    },
  );

  it.skip(
    "[integration only] two parallel claims return the job exactly once",
    async () => {
      await driver.jobs.create({ orgId: org.id, kind: "exclusive" });
      const [a, b] = await Promise.all([
        driver.jobs.claimNext({ orgId: org.id, claimedBy: "w1" }),
        driver.jobs.claimNext({ orgId: org.id, claimedBy: "w2" }),
      ]);
      const claimed = [a, b].filter((x) => x !== null);
      expect(claimed).toHaveLength(1);
    },
  );
});

// ── audit log ───────────────────────────────────────────────────────

describe("audit_log", () => {
  it("append + listForOrg with filters", async () => {
    await driver.auditLog.append({
      orgId: org.id,
      actor: "ci",
      action: "release.deploy",
      entityType: "release",
      entityId: "r-1",
      detail: { tag: "v1" },
    });
    await driver.auditLog.append({
      orgId: org.id,
      actor: "ci",
      action: "release.build",
      entityType: "release",
      entityId: "r-2",
    });
    const all = await driver.auditLog.listForOrg(org.id);
    expect(all).toHaveLength(2);
    const filtered = await driver.auditLog.listForOrg(org.id, {
      entityType: "release",
      entityId: "r-1",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].detail).toEqual({ tag: "v1" });
  });
});

// ── api_key ─────────────────────────────────────────────────────────

describe("api_key", () => {
  it("create + getByPrefix + softDelete", async () => {
    const k = await driver.apiKeys.create({
      orgId: org.id,
      name: "ci",
      prefix: "sk_AAAA1111",
      hash: "h".repeat(64),
    });
    const found = await driver.apiKeys.getByPrefix("sk_AAAA1111");
    expect(found?.id).toBe(k.id);
    await driver.apiKeys.softDelete(k.id);
    expect(await driver.apiKeys.getByPrefix("sk_AAAA1111")).toBeNull();
  });
});
