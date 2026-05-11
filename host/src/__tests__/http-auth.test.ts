/**
 * Tests for PR 7 — bearer-token auth + loopback bypass + cross-org
 * scoping.
 *
 * Two server fixtures per test group:
 *   * `loopback` (default): bypass enabled. Loopback requests with no
 *     token resolve to the default org.
 *   * `strict`: bypass disabled. Every request needs a valid token.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";
import { generateApiKey } from "../http/auth.js";

let dataDir: string;
let cp: ControlPlane;
let strict: ServerHandle;
let bypass: ServerHandle;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-auth-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  bypass = await startServer({
    controlPlane: cp,
    host: "127.0.0.1",
    port: 0,
  });
  strict = await startServer({
    controlPlane: cp,
    host: "127.0.0.1",
    port: 0,
    disableLoopbackBypass: true,
  });
});

afterEach(async () => {
  await bypass.stop();
  await strict.stop();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("loopback bypass", () => {
  it("allows reads without a token when enabled (default)", async () => {
    const r = await fetchJson(`${bypass.url}/v1/products`);
    expect(r.status).toBe(200);
    expect((r.body as { products: unknown[] }).products).toEqual([]);
  });

  it("/v1/healthz is public regardless of bypass setting", async () => {
    const a = await fetchJson(`${bypass.url}/v1/healthz`);
    const b = await fetchJson(`${strict.url}/v1/healthz`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("strict mode rejects requests with no token", async () => {
    const r = await fetchJson(`${strict.url}/v1/products`);
    expect(r.status).toBe(401);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });

  it("strict mode rejects an invalid token", async () => {
    const r = await fetchJson(`${strict.url}/v1/products`, {
      headers: { Authorization: "Bearer sk_BAD_BADBADBAD" },
    });
    expect(r.status).toBe(401);
  });

  it("strict mode rejects a malformed Authorization header", async () => {
    const r = await fetchJson(`${strict.url}/v1/products`, {
      headers: { Authorization: "NotBearer foo" },
    });
    expect(r.status).toBe(401);
  });
});

describe("valid bearer token", () => {
  it("authenticates and lets the request through", async () => {
    const { defaultOrg } = await cp.init();
    const generated = generateApiKey();
    await cp.apiKeys.create({
      orgId: defaultOrg.id,
      name: "test",
      prefix: generated.prefix,
      hash: generated.hash,
    });

    const r = await fetchJson(`${strict.url}/v1/products`, {
      headers: { Authorization: `Bearer ${generated.token}` },
    });
    expect(r.status).toBe(200);
  });

  it("rejects an expired token", async () => {
    const { defaultOrg } = await cp.init();
    const generated = generateApiKey();
    await cp.apiKeys.create({
      orgId: defaultOrg.id,
      name: "expired",
      prefix: generated.prefix,
      hash: generated.hash,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const r = await fetchJson(`${strict.url}/v1/products`, {
      headers: { Authorization: `Bearer ${generated.token}` },
    });
    expect(r.status).toBe(401);
  });

  it("rejects a token whose secret has been tampered with (correct prefix, wrong tail)", async () => {
    const { defaultOrg } = await cp.init();
    const generated = generateApiKey();
    await cp.apiKeys.create({
      orgId: defaultOrg.id,
      name: "real",
      prefix: generated.prefix,
      hash: generated.hash,
    });
    // Swap the secret half.
    const split = generated.token.lastIndexOf("_");
    const tampered = generated.token.slice(0, split + 1) + "BADBADBADBADBADBADBADBADBA";
    const r = await fetchJson(`${strict.url}/v1/products`, {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(r.status).toBe(401);
  });
});

describe("org scoping", () => {
  it("a token in org A can't see org B's products", async () => {
    const orgB = await cp.orgs.create({ name: "org-b" });
    // Seed product in org B.
    await cp.products.create({
      orgId: orgB.id,
      name: "private-to-b",
      repoUrl: "u",
    });
    // Issue a token for the default org (NOT B).
    const { defaultOrg } = await cp.init();
    const gen = generateApiKey();
    await cp.apiKeys.create({
      orgId: defaultOrg.id,
      name: "default-org-key",
      prefix: gen.prefix,
      hash: gen.hash,
    });

    const r = await fetchJson(`${strict.url}/v1/products`, {
      headers: { Authorization: `Bearer ${gen.token}` },
    });
    expect(r.status).toBe(200);
    expect((r.body as { products: unknown[] }).products).toHaveLength(0);
  });

  it("a token in org A cannot GET a product belonging to org B by id", async () => {
    const orgB = await cp.orgs.create({ name: "org-b" });
    const bProduct = await cp.products.create({
      orgId: orgB.id,
      name: "b-product",
      repoUrl: "u",
    });
    const { defaultOrg } = await cp.init();
    const gen = generateApiKey();
    await cp.apiKeys.create({
      orgId: defaultOrg.id,
      name: "a",
      prefix: gen.prefix,
      hash: gen.hash,
    });
    const r = await fetchJson(`${strict.url}/v1/products/${bProduct.id}`, {
      headers: { Authorization: `Bearer ${gen.token}` },
    });
    expect(r.status).toBe(404);
  });
});
