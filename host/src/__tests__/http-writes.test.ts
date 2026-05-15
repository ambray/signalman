/**
 * Tests for PR 7 write endpoints. All run against the loopback-bypass
 * server (default) so we exercise the route logic without dragging
 * auth-token plumbing into every assertion.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";

let dataDir: string;
let cp: ControlPlane;
let server: ServerHandle;
let baseUrl: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-writes-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  server = await startServer({ controlPlane: cp, host: "127.0.0.1", port: 0 });
  baseUrl = server.url;
});

afterEach(async () => {
  await server.stop();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = res.status === 204 ? null : await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

describe("products write surface", () => {
  it("POST → 201, GET, PATCH, DELETE → 204, GET → 404", async () => {
    const created = await api("POST", "/v1/products", {
      name: "example-product",
      repo_url: "https://example.invalid/example.git",
    });
    expect(created.status).toBe(201);
    const productId = (created.body as { product: { id: string } }).product.id;

    const fetched = await api("GET", `/v1/products/${productId}`);
    expect(fetched.status).toBe(200);

    const patched = await api("PATCH", `/v1/products/${productId}`, {
      build_yaml_path: "build/foo.yaml",
    });
    expect(patched.status).toBe(200);
    expect(
      (patched.body as { product: { buildYamlPath: string } }).product
        .buildYamlPath,
    ).toBe("build/foo.yaml");

    const deleted = await api("DELETE", `/v1/products/${productId}`);
    expect(deleted.status).toBe(204);

    const gone = await api("GET", `/v1/products/${productId}`);
    expect(gone.status).toBe(404);
  });

  it("POST without required fields → 400", async () => {
    const r = await api("POST", "/v1/products", { name: "missing-repo" });
    expect(r.status).toBe(400);
  });

  it("POST with duplicate name → 409", async () => {
    await api("POST", "/v1/products", { name: "x", repo_url: "https://example.invalid/r.git" });
    const dup = await api("POST", "/v1/products", { name: "x", repo_url: "https://example.invalid/r.git" });
    expect(dup.status).toBe(409);
  });

  // F4 regression: option-injection in `repo_url` must be rejected
  // before it can reach a `git clone` argument list. See
  // `host/src/control-plane/build/git.ts` for the validation rules.
  it("POST with leading-`-` repo_url → 400 (option-injection guard)", async () => {
    const r = await api("POST", "/v1/products", {
      name: "evil",
      repo_url: "--upload-pack=evil",
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );
  });

  it("POST with unknown-scheme repo_url → 400", async () => {
    const r = await api("POST", "/v1/products", {
      name: "weird",
      repo_url: "javascript:alert(1)",
    });
    expect(r.status).toBe(400);
  });

  it("PATCH cannot bypass the validator on repo_url", async () => {
    const created = await api("POST", "/v1/products", {
      name: "patch-target",
      repo_url: "https://example.invalid/r.git",
    });
    const id = (created.body as { product: { id: string } }).product.id;
    const patched = await api("PATCH", `/v1/products/${id}`, {
      repo_url: "--upload-pack=evil",
    });
    expect(patched.status).toBe(400);
  });
});

describe("releases + artifacts write surface", () => {
  let productId: string;
  beforeEach(async () => {
    const r = await api("POST", "/v1/products", {
      name: "p",
      repo_url: "https://example.invalid/r.git",
    });
    productId = (r.body as { product: { id: string } }).product.id;
  });

  it("POST /v1/releases creates with status=building", async () => {
    const r = await api("POST", "/v1/releases", {
      product_id: productId,
      tag: "v1",
      commit_sha: "deadbeef",
    });
    expect(r.status).toBe(201);
    const rel = (r.body as { release: { status: string; tag: string } }).release;
    expect(rel.status).toBe("building");
    expect(rel.tag).toBe("v1");
  });

  it("PATCH /v1/releases/:id updates status + manifest", async () => {
    const created = await api("POST", "/v1/releases", {
      product_id: productId,
      tag: "v2",
      commit_sha: "c",
    });
    const rid = (created.body as { release: { id: string } }).release.id;
    const patched = await api("PATCH", `/v1/releases/${rid}`, {
      status: "ready",
      manifest_sha256: "a".repeat(64),
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { release: { status: string } }).release.status).toBe(
      "ready",
    );
  });

  it("POST artifacts then GET returns them", async () => {
    const created = await api("POST", "/v1/releases", {
      product_id: productId,
      tag: "v3",
      commit_sha: "c",
    });
    const rid = (created.body as { release: { id: string } }).release.id;
    const a1 = await api("POST", `/v1/releases/${rid}/artifacts`, {
      component: "agent",
      kind: "blob",
      sha256: "a".repeat(64),
      size_bytes: 1000,
      blob_uri: "file:///x",
    });
    expect(a1.status).toBe(201);
    const a2 = await api("POST", `/v1/releases/${rid}/artifacts`, {
      component: "backend",
      kind: "image_ref",
      image_ref: "example-backend:v3",
    });
    expect(a2.status).toBe(201);

    const list = await api("GET", `/v1/releases/${rid}/artifacts`);
    const arts = (list.body as { artifacts: Array<{ component: string }> })
      .artifacts;
    expect(arts.map((a) => a.component).sort()).toEqual(["agent", "backend"]);
  });

  // F4 regression: option-injection in the release `tag` must be
  // rejected before it can reach `git clone --branch <tag>`.
  it("POST /v1/releases with leading-`-` tag → 400", async () => {
    const r = await api("POST", "/v1/releases", {
      product_id: productId,
      tag: "--upload-pack=evil",
      commit_sha: "c",
    });
    expect(r.status).toBe(400);
  });

  it("POST artifact with invalid kind → 400", async () => {
    const created = await api("POST", "/v1/releases", {
      product_id: productId,
      tag: "v4",
      commit_sha: "c",
    });
    const rid = (created.body as { release: { id: string } }).release.id;
    const bad = await api("POST", `/v1/releases/${rid}/artifacts`, {
      component: "x",
      kind: "bogus",
    });
    expect(bad.status).toBe(400);
  });
});

describe("targets + deployments write surface", () => {
  it("POST /v1/targets requires name + kind + connection", async () => {
    const ok = await api("POST", "/v1/targets", {
      name: "t",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    expect(ok.status).toBe(201);
    const bad = await api("POST", "/v1/targets", {
      name: "y",
      kind: "vm_test",
    });
    expect(bad.status).toBe(400);
  });

  it("POST /v1/deployments + PATCH status + POST health", async () => {
    const product = await api("POST", "/v1/products", { name: "p", repo_url: "https://example.invalid/r.git" });
    const productId = (product.body as { product: { id: string } }).product.id;
    const release = await api("POST", "/v1/releases", {
      product_id: productId,
      tag: "v1",
      commit_sha: "c",
    });
    const releaseId = (release.body as { release: { id: string } }).release.id;
    await api("PATCH", `/v1/releases/${releaseId}`, { status: "ready" });
    const target = await api("POST", "/v1/targets", {
      name: "t",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    const targetId = (target.body as { target: { id: string } }).target.id;

    const deployment = await api("POST", "/v1/deployments", {
      release_id: releaseId,
      target_id: targetId,
    });
    expect(deployment.status).toBe(201);
    const deploymentId = (deployment.body as { deployment: { id: string } })
      .deployment.id;

    const promoted = await api(
      "PATCH",
      `/v1/deployments/${deploymentId}`,
      { status: "active" },
    );
    expect(promoted.status).toBe(200);

    const check = await api("POST", `/v1/deployments/${deploymentId}/health`, {
      probe_name: "vm_reachable",
      status: "pass",
      detail: "ok",
    });
    expect(check.status).toBe(201);

    const list = await api("GET", `/v1/deployments/${deploymentId}/health`);
    expect(
      (list.body as { checks: unknown[] }).checks.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("POST /v1/deployments with cross-org release id → 404", async () => {
    const otherOrg = await cp.orgs.create({ name: "other" });
    const foreignRelease = await cp.releases.create({
      orgId: otherOrg.id,
      productId: (
        await cp.products.create({
          orgId: otherOrg.id,
          name: "p",
          repoUrl: "https://example.invalid/r.git",
        })
      ).id,
      tag: "v1",
      commitSha: "c",
    });
    const target = await api("POST", "/v1/targets", {
      name: "t",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    const targetId = (target.body as { target: { id: string } }).target.id;
    const r = await api("POST", "/v1/deployments", {
      release_id: foreignRelease.id,
      target_id: targetId,
    });
    expect(r.status).toBe(404);
  });
});

describe("audit log write surface", () => {
  it("POST /v1/audit appends then GET shows it", async () => {
    const r = await api("POST", "/v1/audit", {
      actor: "ci",
      action: "test.action",
      entity_type: "test",
      entity_id: "row-1",
      detail: { foo: "bar" },
    });
    expect(r.status).toBe(201);
    const list = await api("GET", "/v1/audit");
    const entries = (list.body as { entries: Array<{ action: string }> }).entries;
    expect(entries.some((e) => e.action === "test.action")).toBe(true);
  });
});

describe("api keys", () => {
  it("POST returns the plaintext token ONCE; subsequent reads strip the hash", async () => {
    const created = await api("POST", "/v1/api-keys", { name: "ci-runner" });
    expect(created.status).toBe(201);
    const body = created.body as {
      api_key: { id: string; prefix: string; hash?: unknown };
      token: string;
    };
    expect(body.token).toMatch(/^sk_[A-Z0-9]+_[A-Z0-9]+$/);
    expect(body.api_key.prefix).toMatch(/^sk_/);
    expect(body.api_key.hash).toBeUndefined();

    const list = await api("GET", "/v1/api-keys");
    const keys = (list.body as { api_keys: Array<{ id: string; hash?: unknown }> })
      .api_keys;
    expect(keys).toHaveLength(1);
    expect(keys[0].hash).toBeUndefined();
  });

  it("DELETE revokes the key", async () => {
    const created = await api("POST", "/v1/api-keys", { name: "tmp" });
    const id = (created.body as { api_key: { id: string } }).api_key.id;
    const del = await api("DELETE", `/v1/api-keys/${id}`);
    expect(del.status).toBe(204);
    const list = await api("GET", "/v1/api-keys");
    expect((list.body as { api_keys: unknown[] }).api_keys).toHaveLength(0);
  });
});

describe("runners — WS6 M3", () => {
  it("POST /v1/runners/heartbeat upserts and returns the row", async () => {
    const r1 = await api("POST", "/v1/runners/heartbeat", {
      name: "builder-1",
      meta: { hostname: "mac-01", version: "0.3.0" },
    });
    expect(r1.status).toBe(200);
    const first = (r1.body as { runner: { id: string; name: string; lastSeenAt: string } })
      .runner;
    expect(first.name).toBe("builder-1");

    // Second heartbeat should return the same id with a newer lastSeenAt.
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await api("POST", "/v1/runners/heartbeat", { name: "builder-1" });
    expect(r2.status).toBe(200);
    const second = (r2.body as { runner: { id: string; lastSeenAt: string } }).runner;
    expect(second.id).toBe(first.id);
    expect(second.lastSeenAt >= first.lastSeenAt).toBe(true);
  });

  it("GET /v1/runners lists active runners only", async () => {
    await api("POST", "/v1/runners/heartbeat", { name: "alpha" });
    await api("POST", "/v1/runners/heartbeat", { name: "beta" });
    const list = await api("GET", "/v1/runners");
    expect(list.status).toBe(200);
    const runners = (list.body as { runners: Array<{ name: string }> }).runners;
    expect(runners.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("DELETE /v1/runners/:id soft-deletes the row", async () => {
    const created = await api("POST", "/v1/runners/heartbeat", {
      name: "to-deregister",
    });
    const id = (created.body as { runner: { id: string } }).runner.id;
    const del = await api("DELETE", `/v1/runners/${id}`);
    expect(del.status).toBe(204);
    const list = await api("GET", "/v1/runners");
    expect((list.body as { runners: unknown[] }).runners).toHaveLength(0);
  });

  it("DELETE /v1/runners/:id returns 404 for unknown id", async () => {
    const del = await api("DELETE", "/v1/runners/01HNONEXISTENT0000000000000");
    expect(del.status).toBe(404);
  });
});
