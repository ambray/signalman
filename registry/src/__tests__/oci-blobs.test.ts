// WS10 M2 — end-to-end OCI blob protocol tests.
//
// Booted against a real HTTP server + LocalFsRegistryStorage. Covers
// the chunked-upload state machine, digest verification, atomic
// finalize, idempotency, error envelopes, and the audit-log trail.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { OCI_ERROR_CODES, type OciErrorEnvelope } from "../oci/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const REPO_ORG = "acme";
const REPO_NAME = "team/svc";
const REPO_PATH = `${REPO_ORG}/${REPO_NAME}`;

interface FetchOpts {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

async function call(server: ServerHandle, opts: FetchOpts): Promise<Response> {
  const url = `${server.baseUrl}${opts.path}`;
  const headers: Record<string, string> = { authorization: AUTH, ...opts.headers };
  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : new Uint8Array(opts.body);
  }
  return globalThis.fetch(url, init);
}

describe("OCI blob protocol (HTTP integration)", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-blobs-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({
      storage,
      // 1-hour interval so the reaper effectively never fires
      // mid-test; tests trigger sweeps explicitly via handles.
      ociReaperIntervalMs: 60 * 60 * 1000,
    });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  // ── Single-PATCH chunked upload happy path ───────────────────────
  it("POST → PATCH → PUT round-trips a blob", async () => {
    const bytes = Buffer.from("hello world", "utf-8");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

    // 1. POST initiate
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    expect(init.status).toBe(202);
    const location = init.headers.get("location");
    expect(location).toMatch(/\/v2\/acme\/team\/svc\/blobs\/uploads\/[a-f0-9]{32}$/);
    const uploadId = location!.split("/").pop()!;
    expect(init.headers.get("docker-upload-uuid")).toBe(uploadId);
    expect(init.headers.get("range")).toBe("0-0");

    // 2. PATCH chunk (offset 0, all bytes)
    const patch = await call(server, {
      method: "PATCH",
      path: location!,
      headers: {
        "content-range": `0-${bytes.length - 1}`,
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(patch.status).toBe(202);
    expect(patch.headers.get("range")).toBe(`0-${bytes.length - 1}`);

    // 3. PUT finalize
    const finalize = await call(server, {
      method: "PUT",
      path: `${location}?digest=${digest}`,
    });
    expect(finalize.status).toBe(201);
    expect(finalize.headers.get("docker-content-digest")).toBe(digest);
    expect(finalize.headers.get("location")).toBe(
      `/v2/${REPO_PATH}/blobs/${digest}`,
    );

    // 4. GET round-trips the bytes + Docker-Content-Digest
    const get = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("docker-content-digest")).toBe(digest);
    expect(get.headers.get("content-length")).toBe(String(bytes.length));
    const echoed = Buffer.from(await get.arrayBuffer());
    expect(echoed.equals(bytes)).toBe(true);

    // 5. HEAD returns headers without body
    const head = await call(server, {
      method: "HEAD",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("docker-content-digest")).toBe(digest);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
  });

  // ── Multi-chunk upload ───────────────────────────────────────────
  it("supports a multi-chunk PATCH sequence", async () => {
    const part1 = Buffer.alloc(1024, "a");
    const part2 = Buffer.alloc(2048, "b");
    const part3 = Buffer.alloc(512, "c");
    const total = Buffer.concat([part1, part2, part3]);
    const digest = `sha256:${crypto.createHash("sha256").update(total).digest("hex")}`;

    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;

    let offset = 0;
    for (const part of [part1, part2, part3]) {
      const r = await call(server, {
        method: "PATCH",
        path: location,
        headers: {
          "content-range": `${offset}-${offset + part.length - 1}`,
          "content-type": "application/octet-stream",
        },
        body: part,
      });
      expect(r.status).toBe(202);
      offset += part.length;
      expect(r.headers.get("range")).toBe(`0-${offset - 1}`);
    }

    const finalize = await call(server, {
      method: "PUT",
      path: `${location}?digest=${digest}`,
    });
    expect(finalize.status).toBe(201);

    const get = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    const echoed = Buffer.from(await get.arrayBuffer());
    expect(echoed.equals(total)).toBe(true);
  });

  // ── PUT can carry the final chunk inline ─────────────────────────
  it("PUT with body accepts the closing bytes inline", async () => {
    const part1 = Buffer.alloc(8, "x");
    const part2 = Buffer.alloc(8, "y");
    const total = Buffer.concat([part1, part2]);
    const digest = `sha256:${crypto.createHash("sha256").update(total).digest("hex")}`;

    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;

    await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": `0-${part1.length - 1}` },
      body: part1,
    });

    const finalize = await call(server, {
      method: "PUT",
      path: `${location}?digest=${digest}`,
      headers: { "content-range": `${part1.length}-${total.length - 1}` },
      body: part2,
    });
    expect(finalize.status).toBe(201);

    const get = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    const echoed = Buffer.from(await get.arrayBuffer());
    expect(echoed.equals(total)).toBe(true);
  });

  // ── PUT with body but no Content-Range (single-PUT pattern) ──────
  it("PUT with body but no Content-Range appends as a tail chunk", async () => {
    const bytes = Buffer.from("inline-finalize");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;

    const finalize = await call(server, {
      method: "PUT",
      path: `${location}?digest=${digest}`,
      body: bytes,
    });
    expect(finalize.status).toBe(201);
    const get = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    expect(get.status).toBe(200);
  });

  // ── Error: out-of-order chunk ───────────────────────────────────
  it("rejects out-of-order PATCH with 416 + BLOB_UPLOAD_INVALID", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;

    const r = await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": "100-199" },
      body: Buffer.alloc(100, "z"),
    });
    expect(r.status).toBe(416);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.BLOB_UPLOAD_INVALID);
  });

  // ── Error: malformed Content-Range ──────────────────────────────
  it("rejects malformed Content-Range with 416 BLOB_UPLOAD_INVALID", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    const r = await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": "bytes=0-99" },
      body: Buffer.alloc(100, "z"),
    });
    expect(r.status).toBe(416);
  });

  // ── Error: body length != Content-Range length ──────────────────
  it("rejects body length / Content-Range mismatch with SIZE_INVALID", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    const r = await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": "0-99" },
      body: Buffer.alloc(50, "z"), // declared 100, sent 50
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.SIZE_INVALID);
  });

  // ── Error: digest mismatch on finalize ──────────────────────────
  it("rejects PUT with a mismatched ?digest= and emits DIGEST_INVALID", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    const bytes = Buffer.from("payload");
    await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": `0-${bytes.length - 1}` },
      body: bytes,
    });
    // Claim a digest that doesn't match the bytes
    const wrong = `sha256:${"0".repeat(64)}`;
    const r = await call(server, {
      method: "PUT",
      path: `${location}?digest=${wrong}`,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.DIGEST_INVALID);
  });

  // ── Error: out-of-order final-chunk on PUT ───────────────────────
  it("rejects PUT with out-of-order Content-Range final chunk", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    // Skip the prior PATCH — bytes_received is 0, but the final chunk
    // claims to start at offset 100 (out of order).
    const r = await call(server, {
      method: "PUT",
      path: `${location}?digest=sha256:${"0".repeat(64)}`,
      headers: { "content-range": "100-149" },
      body: Buffer.alloc(50, "z"),
    });
    expect(r.status).toBe(416);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.BLOB_UPLOAD_INVALID);
  });

  // ── Error: body / Content-Range mismatch on PUT final chunk ──────
  it("rejects PUT final chunk where body length != Content-Range length", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    const r = await call(server, {
      method: "PUT",
      path: `${location}?digest=sha256:${"0".repeat(64)}`,
      headers: { "content-range": "0-99" },
      body: Buffer.alloc(50, "z"), // declared 100, sent 50
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.SIZE_INVALID);
  });

  // ── Error: PUT without ?digest= ──────────────────────────────────
  it("rejects PUT missing ?digest= with DIGEST_INVALID", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    const r = await call(server, { method: "PUT", path: location });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.DIGEST_INVALID);
  });

  // ── Error: unknown upload UUID ──────────────────────────────────
  it("PATCH on an unknown upload returns 404 BLOB_UPLOAD_UNKNOWN", async () => {
    const r = await call(server, {
      method: "PATCH",
      path: `/v2/${REPO_PATH}/blobs/uploads/${"0".repeat(32)}`,
      headers: { "content-range": "0-9" },
      body: Buffer.alloc(10),
    });
    expect(r.status).toBe(404);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN);
  });

  // ── Cross-repo upload protection ────────────────────────────────
  it("rejects PATCH from a different repository than initiated", async () => {
    const init = await call(server, {
      method: "POST",
      path: `/v2/acme/team-a/svc/blobs/uploads/`,
    });
    expect(init.status).toBe(202);
    const location = init.headers.get("location")!;
    // Rewrite the URL to a different repo but keep the uploadId
    const uploadId = location.split("/").pop()!;
    const r = await call(server, {
      method: "PATCH",
      path: `/v2/acme/team-b/svc/blobs/uploads/${uploadId}`,
      headers: { "content-range": "0-9" },
      body: Buffer.alloc(10),
    });
    expect(r.status).toBe(404);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN);
  });

  // ── GET unknown blob ─────────────────────────────────────────────
  it("GET of an unknown blob returns 404 BLOB_UNKNOWN", async () => {
    const r = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/blobs/sha256:${"f".repeat(64)}`,
    });
    expect(r.status).toBe(404);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.BLOB_UNKNOWN);
  });

  // ── GET with malformed digest ────────────────────────────────────
  it("GET with a malformed digest returns 400 DIGEST_INVALID", async () => {
    const r = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/blobs/sha512:abc`,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.DIGEST_INVALID);
  });

  // ── HEAD with malformed digest ───────────────────────────────────
  it("HEAD with a malformed digest returns 400 DIGEST_INVALID", async () => {
    const r = await call(server, {
      method: "HEAD",
      path: `/v2/${REPO_PATH}/blobs/notadigest`,
    });
    expect(r.status).toBe(400);
  });

  // ── HEAD on unknown digest ───────────────────────────────────────
  it("HEAD on unknown blob returns 404 BLOB_UNKNOWN", async () => {
    const r = await call(server, {
      method: "HEAD",
      path: `/v2/${REPO_PATH}/blobs/sha256:${"a".repeat(64)}`,
    });
    expect(r.status).toBe(404);
  });

  // ── DELETE with malformed digest ────────────────────────────────
  it("DELETE with a malformed digest returns 400 DIGEST_INVALID", async () => {
    const r = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/blobs/sha512:abc`,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.DIGEST_INVALID);
  });

  // ── POST initiate with invalid name ──────────────────────────────
  it("POST initiate with an invalid repository name returns 400 NAME_INVALID", async () => {
    const r = await call(server, {
      method: "POST",
      path: `/v2/Acme/SVC/blobs/uploads/`,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.NAME_INVALID);
  });

  // ── POST initiate with single-segment name (no org) ──────────────
  it("POST initiate with a single-segment name (missing org or repo) returns 400 NAME_INVALID", async () => {
    const r = await call(server, {
      method: "POST",
      path: `/v2/onlyorg/blobs/uploads/`,
    });
    // No `/repo` portion under /v2/<org>/. The router still matches
    // *name = "onlyorg" but parseRepositoryParam rejects it.
    expect(r.status).toBe(400);
  });

  // ── GET with invalid repository name ─────────────────────────────
  it("GET with an invalid repository name returns 400 NAME_INVALID", async () => {
    const r = await call(server, {
      method: "GET",
      path: `/v2/Acme/SVC/blobs/sha256:${"f".repeat(64)}`,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.NAME_INVALID);
  });

  // ── DELETE idempotent + audit-logged ────────────────────────────
  it("DELETE removes the blob and audit-logs it", async () => {
    const bytes = Buffer.from("payload-for-delete");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": `0-${bytes.length - 1}` },
      body: bytes,
    });
    await call(server, { method: "PUT", path: `${location}?digest=${digest}` });

    const del = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    expect(del.status).toBe(202);

    const audits = storage.index.listAuditEntries({ action: "delete" });
    const entry = audits.find((e) => e.entityId === digest.slice("sha256:".length));
    expect(entry).toBeDefined();
    expect(entry?.detail).toMatchObject({ kind: "oci" });

    // Second DELETE returns 404 BLOB_UNKNOWN (blob already gone).
    const again = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    expect(again.status).toBe(404);
  });

  // ── Audit log on successful upload ──────────────────────────────
  it("PUT finalize writes action='upload', entity_type='blob' audit row", async () => {
    const bytes = Buffer.from("audit-me");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": `0-${bytes.length - 1}` },
      body: bytes,
    });
    await call(server, { method: "PUT", path: `${location}?digest=${digest}` });
    const audits = storage.index.listAuditEntries({
      action: "upload",
      entityType: "blob",
    });
    const entry = audits.find(
      (e) => e.entityId === digest.slice("sha256:".length),
    );
    expect(entry).toBeDefined();
    expect(entry?.detail).toMatchObject({
      kind: "oci",
      org: REPO_ORG,
      repository: REPO_NAME,
    });
  });

  // ── Resume after restart ─────────────────────────────────────────
  it("upload state survives registry restart mid-PATCH", async () => {
    const part1 = Buffer.alloc(8, "p");
    const part2 = Buffer.alloc(8, "q");
    const total = Buffer.concat([part1, part2]);
    const digest = `sha256:${crypto.createHash("sha256").update(total).digest("hex")}`;

    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const location = init.headers.get("location")!;
    await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": `0-${part1.length - 1}` },
      body: part1,
    });

    // Restart: close server + storage, reopen on the same root.
    await server.close();
    storage.close();
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
    });

    // Continue the same upload-id on the new server.
    const r = await call(server, {
      method: "PATCH",
      path: location,
      headers: { "content-range": `${part1.length}-${total.length - 1}` },
      body: part2,
    });
    expect(r.status).toBe(202);

    const finalize = await call(server, {
      method: "PUT",
      path: `${location}?digest=${digest}`,
    });
    expect(finalize.status).toBe(201);
  });

  // ── Reaper sweep clears expired pending uploads ─────────────────
  it("reaper sweep removes expired pending uploads", async () => {
    // Open a fresh server with a 1-second TTL so an idle upload
    // ages out fast.
    await server.close();
    server = await createServer({
      storage,
      ociUploadTtlSeconds: 0, // expires immediately
      ociReaperIntervalMs: 60 * 60 * 1000,
    });
    const init = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    expect(init.status).toBe(202);
    expect(server.handles).toBeDefined();
    const reaped = await server.handles!.ociReaperSweep();
    expect(reaped).toBe(1);
  });

  // ── Idempotent re-upload (same bytes → same digest → 201) ───────
  it("re-uploading the same bytes is idempotent at the storage layer", async () => {
    const bytes = Buffer.from("idem-test");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

    // First upload
    const init1 = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const loc1 = init1.headers.get("location")!;
    await call(server, {
      method: "PATCH",
      path: loc1,
      headers: { "content-range": `0-${bytes.length - 1}` },
      body: bytes,
    });
    const f1 = await call(server, { method: "PUT", path: `${loc1}?digest=${digest}` });
    expect(f1.status).toBe(201);

    // Second upload (same bytes)
    const init2 = await call(server, {
      method: "POST",
      path: `/v2/${REPO_PATH}/blobs/uploads/`,
    });
    const loc2 = init2.headers.get("location")!;
    await call(server, {
      method: "PATCH",
      path: loc2,
      headers: { "content-range": `0-${bytes.length - 1}` },
      body: bytes,
    });
    const f2 = await call(server, { method: "PUT", path: `${loc2}?digest=${digest}` });
    expect(f2.status).toBe(201);

    // Both PUTs produced 201; blob is single content-addressed copy on disk.
    const head = await call(server, {
      method: "HEAD",
      path: `/v2/${REPO_PATH}/blobs/${digest}`,
    });
    expect(head.status).toBe(200);
  });
});
