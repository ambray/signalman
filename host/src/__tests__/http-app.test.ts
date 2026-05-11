/**
 * HTTP integration tests for the v0.3.0 control-plane API (read-only).
 *
 * Spins the real server on an ephemeral port (host: 127.0.0.1, port:
 * 0 → kernel-assigned) and hits it with `fetch`. Seed catalog state
 * through the in-process ControlPlane so we exercise the HTTP layer's
 * encoding/error-mapping, not the underlying repo correctness (that's
 * covered by the repo tests).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";
import type { Product, Release, Target } from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let server: ServerHandle;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-http-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  server = await startServer({ controlPlane: cp, host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await server.stop();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.url}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

describe("GET /v1/healthz", () => {
  it("returns ok + version", async () => {
    const r = await get("/v1/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
  });
});

describe("404 fallthrough", () => {
  it("unknown path returns 404 with structured error", async () => {
    const r = await get("/v1/does-not-exist");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("products", () => {
  let p: Product;
  beforeEach(async () => {
    const { defaultOrg } = await cp.init();
    p = await cp.products.create({
      orgId: defaultOrg.id,
      name: "example",
      repoUrl: "https://example.invalid/example.git",
    });
  });

  it("GET /v1/products returns the list", async () => {
    const r = await get("/v1/products");
    expect(r.status).toBe(200);
    const body = r.body as { products: Product[] };
    expect(body.products.map((x) => x.name)).toEqual(["example"]);
  });

  it("GET /v1/products/by-name/:name finds it", async () => {
    const r = await get("/v1/products/by-name/example");
    expect(r.status).toBe(200);
    expect((r.body as { product: Product }).product.id).toBe(p.id);
  });

  it("GET /v1/products/by-name/:name 404s on miss", async () => {
    const r = await get("/v1/products/by-name/nope");
    expect(r.status).toBe(404);
  });

  it("GET /v1/products/:id returns the row", async () => {
    const r = await get(`/v1/products/${p.id}`);
    expect(r.status).toBe(200);
    expect((r.body as { product: Product }).product.name).toBe("example");
  });

  it("GET /v1/products/:id 404s on unknown id", async () => {
    const r = await get("/v1/products/01ZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(r.status).toBe(404);
  });
});

describe("releases", () => {
  let product: Product;
  let release: Release;
  beforeEach(async () => {
    const { defaultOrg } = await cp.init();
    product = await cp.products.create({
      orgId: defaultOrg.id,
      name: "p",
      repoUrl: "u",
    });
    release = await cp.releases.create({
      orgId: defaultOrg.id,
      productId: product.id,
      tag: "v1",
      commitSha: "c",
    });
    await cp.releases.update(release.id, { status: "ready" });
    await cp.artifacts.create({
      releaseId: release.id,
      component: "agent",
      kind: "blob",
      sha256: "a".repeat(64),
      sizeBytes: 100,
      blobUri: "file:///x",
    });
  });

  it("GET /v1/releases lists across products", async () => {
    const r = await get("/v1/releases");
    expect(r.status).toBe(200);
    const body = r.body as {
      releases: Array<{ product: { name: string }; release: Release }>;
    };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0].release.tag).toBe("v1");
  });

  it("?product= filters by product name", async () => {
    const r = await get("/v1/releases?product=p");
    expect(r.status).toBe(200);
    expect((r.body as { releases: unknown[] }).releases).toHaveLength(1);
    const r2 = await get("/v1/releases?product=other");
    expect((r2.body as { releases: unknown[] }).releases).toHaveLength(0);
  });

  it("?status= filters; invalid value → 400", async () => {
    const ok = await get("/v1/releases?status=ready");
    expect(ok.status).toBe(200);
    expect((ok.body as { releases: unknown[] }).releases).toHaveLength(1);
    const bad = await get("/v1/releases?status=bogus");
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe(
      "bad_request",
    );
  });

  it("GET /v1/releases/:id returns the row", async () => {
    const r = await get(`/v1/releases/${release.id}`);
    expect(r.status).toBe(200);
    expect((r.body as { release: Release }).release.tag).toBe("v1");
  });

  it("GET /v1/releases/:id/artifacts returns the artifact list", async () => {
    const r = await get(`/v1/releases/${release.id}/artifacts`);
    expect(r.status).toBe(200);
    const body = r.body as { artifacts: Array<{ component: string }> };
    expect(body.artifacts.map((a) => a.component)).toEqual(["agent"]);
  });
});

describe("targets + deployments", () => {
  let target: Target;
  let releaseId: string;
  beforeEach(async () => {
    const { defaultOrg } = await cp.init();
    target = await cp.targets.create({
      orgId: defaultOrg.id,
      name: "win11-test",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    const product = await cp.products.create({
      orgId: defaultOrg.id,
      name: "p",
      repoUrl: "u",
    });
    const release = await cp.releases.create({
      orgId: defaultOrg.id,
      productId: product.id,
      tag: "v1",
      commitSha: "c",
    });
    await cp.releases.update(release.id, { status: "ready" });
    releaseId = release.id;
    const dep = await cp.deployments.create({
      orgId: defaultOrg.id,
      releaseId: release.id,
      targetId: target.id,
    });
    await cp.deployments.update(dep.id, { status: "active" });
    await cp.healthChecks.append({
      deploymentId: dep.id,
      probeName: "vm_reachable",
      status: "pass",
      detail: "ok",
    });
  });

  it("GET /v1/targets returns the list", async () => {
    const r = await get("/v1/targets");
    expect(r.status).toBe(200);
    expect((r.body as { targets: Target[] }).targets[0].name).toBe("win11-test");
  });

  it("GET /v1/targets/:id/deployments returns history", async () => {
    const r = await get(`/v1/targets/${target.id}/deployments`);
    expect(r.status).toBe(200);
    const body = r.body as {
      deployments: Array<{ status: string; releaseId: string }>;
    };
    expect(body.deployments).toHaveLength(1);
    expect(body.deployments[0].status).toBe("active");
    expect(body.deployments[0].releaseId).toBe(releaseId);
  });

  it("GET /v1/deployments/:id/health returns checks", async () => {
    const r = await get(`/v1/targets/${target.id}/deployments`);
    const deploymentId = (r.body as { deployments: Array<{ id: string }> })
      .deployments[0].id;
    const r2 = await get(`/v1/deployments/${deploymentId}/health`);
    expect(r2.status).toBe(200);
    const body = r2.body as { checks: Array<{ probeName: string }> };
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0].probeName).toBe("vm_reachable");
  });

  it("GET /v1/deployments/:id 404s on unknown id", async () => {
    const r = await get("/v1/deployments/01ZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(r.status).toBe(404);
  });
});

describe("scenarios + audit", () => {
  beforeEach(async () => {
    const { defaultOrg } = await cp.init();
    await cp.scenarios.upsertFromDisk({
      orgId: defaultOrg.id,
      path: ".signalman/scenarios/x",
      scenarioHash: "h",
      name: "X",
      tags: ["smoke"],
    });
    await cp.auditLog.append({
      orgId: defaultOrg.id,
      actor: "test",
      action: "test.action",
      entityType: "test",
      entityId: "abc",
    });
  });

  it("GET /v1/scenarios lists them", async () => {
    const r = await get("/v1/scenarios");
    expect(r.status).toBe(200);
    const body = r.body as { scenarios: Array<{ name: string }> };
    expect(body.scenarios.map((s) => s.name)).toEqual(["X"]);
  });

  it("GET /v1/audit returns log entries", async () => {
    const r = await get("/v1/audit");
    expect(r.status).toBe(200);
    const body = r.body as { entries: Array<{ action: string }> };
    const actions = body.entries.map((e) => e.action);
    expect(actions).toContain("test.action");
  });

  it("GET /v1/audit?limit=1 caps results", async () => {
    // Seed a second entry so the cap is meaningful.
    const { defaultOrg } = await cp.init();
    await cp.auditLog.append({
      orgId: defaultOrg.id,
      actor: "t",
      action: "second",
      entityType: "t",
      entityId: "y",
    });
    const r = await get("/v1/audit?limit=1");
    expect(r.status).toBe(200);
    expect((r.body as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("invalid integer query → 400", async () => {
    const r = await get("/v1/audit?limit=notanumber");
    expect(r.status).toBe(400);
  });
});
