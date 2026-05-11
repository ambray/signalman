/**
 * HTTP tests for PR 8b blob endpoints.
 *
 *   POST /v1/blobs        — streaming upload, content-addressed
 *   GET  /v1/blobs/:sha256 — streaming download, org-scoped
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";

let dataDir: string;
let cp: ControlPlane;
let server: ServerHandle;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-http-blobs-"));
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

async function postBlob(
  body: Buffer | Readable,
): Promise<{ status: number; body: { uri: string; sha256: string; size: number } }> {
  const res = await fetch(`${server.url}/v1/blobs`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: body as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/blobs", () => {
  it("stores a Buffer body and returns sha256 + size + URI", async () => {
    const payload = Buffer.from("hello world");
    const expected = crypto.createHash("sha256").update(payload).digest("hex");
    const r = await postBlob(payload);
    expect(r.status).toBe(201);
    expect(r.body.sha256).toBe(expected);
    expect(r.body.size).toBe(payload.length);
    expect(r.body.uri).toMatch(/^file:\/\//);
  });

  it("stores a Readable stream", async () => {
    const payload = crypto.randomBytes(8 * 1024);
    const expected = crypto.createHash("sha256").update(payload).digest("hex");
    const r = await postBlob(Readable.from(payload));
    expect(r.status).toBe(201);
    expect(r.body.sha256).toBe(expected);
    expect(r.body.size).toBe(payload.length);
  });

  it("accepts a body larger than the 1 MiB JSON cap", async () => {
    // 2 MiB body. The non-blob router enforces 1 MiB; the blob route
    // uses streamBody: true and bypasses the cap.
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x42);
    const r = await postBlob(payload);
    expect(r.status).toBe(201);
    expect(r.body.size).toBe(payload.length);
  });

  it("dedupes identical content (second POST hits the same path)", async () => {
    const payload = Buffer.from("dup");
    const first = await postBlob(payload);
    const second = await postBlob(payload);
    expect(second.body.uri).toBe(first.body.uri);
    expect(second.body.sha256).toBe(first.body.sha256);
  });
});

describe("GET /v1/blobs/:sha256", () => {
  it("round-trips bytes uploaded via POST", async () => {
    const payload = Buffer.from("round-trip me");
    const uploaded = await postBlob(payload);
    const res = await fetch(`${server.url}/v1/blobs/${uploaded.body.sha256}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(payload)).toBe(true);
  });

  it("404s on a sha256 the org doesn't own", async () => {
    const missing = "f".repeat(64);
    const res = await fetch(`${server.url}/v1/blobs/${missing}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("400s on a malformed sha256", async () => {
    const res = await fetch(`${server.url}/v1/blobs/not-hex`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("is org-scoped: an org-B sha doesn't return from an org-A token (loopback maps to default org)", async () => {
    // Seed a blob under a non-default org directly through the cp.
    const orgB = await cp.orgs.create({ name: "org-b" });
    const meta = await cp.blobs.put({
      orgId: orgB.id,
      body: Buffer.from("secret"),
    });
    // Loopback request maps to default org → 404 for org-B's sha.
    const res = await fetch(`${server.url}/v1/blobs/${meta.sha256}`);
    expect(res.status).toBe(404);
  });
});
