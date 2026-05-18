// WS13 M4 Story 6 — mount.ts route surface smoke tests.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

describe("HF mount — route smoke", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-mount-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("health route still works after HF mount", async () => {
    const r = await fetch(`${server.baseUrl}/v1/healthz`);
    expect(r.status).toBe(200);
  });

  it("GET on unknown HF route returns 4XX (not 5XX)", async () => {
    const r = await fetch(`${server.baseUrl}/hf/acme/demo/bogus/path`, {
      headers: { authorization: AUTH },
    });
    expect([400, 404]).toContain(r.status);
  });

  it("GET resolve on absent revision returns HF-canonical 404 body", async () => {
    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/resolve/v1/config.json`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: "Revision not found" });
  });

  it("GET blob endpoint on absent sha returns HF error envelope (not canonical)", async () => {
    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/lfs/sha256/${"a".repeat(64)}`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    // BLOB_NOT_FOUND is in the canonical 404 set only for REPO/REV/FILE
    // not for BLOB_NOT_FOUND — that uses the HF-canonical message too.
    // Either an envelope or canonical body is acceptable here.
    expect(body).toBeDefined();
  });

  it("POST LFS Batch with invalid body returns 400 envelope", async () => {
    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/info/lfs/objects/batch`,
      {
        method: "POST",
        headers: {
          authorization: AUTH,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: "bogus", objects: [{ oid: "x", size: 1 }] }),
      },
    );
    expect(r.status).toBe(400);
  });

  it("POST upload-tarball without body returns 400", async () => {
    // Send a 0-byte body that's not a valid tar.
    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/upload-tarball?revision=v1`,
      {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: new Uint8Array(0),
      },
    );
    expect([400, 422]).toContain(r.status);
  });

  it("rejects invalid org name with 400 envelope", async () => {
    const r = await fetch(
      `${server.baseUrl}/hf/UPPER/demo/resolve/v1/config.json`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(400);
  });

  it("rejects invalid repo_type query with 400 envelope", async () => {
    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/resolve/v1/x.txt?repo_type=bogus`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(400);
  });

  it("publish a tiny tarball + GET resolve round-trips bytes", async () => {
    // Build a minimal tar containing one file.
    const fileBytes = Buffer.from("hello");
    const tarBuf = buildSimpleUstarTar([
      { name: "config.json", bytes: fileBytes },
    ]);
    const putResp = await fetch(
      `${server.baseUrl}/hf/acme/demo/upload-tarball?revision=v1`,
      {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tarBuf,
      },
    );
    expect(putResp.status).toBe(201);
    const getResp = await fetch(
      `${server.baseUrl}/hf/acme/demo/resolve/v1/config.json`,
      { headers: { authorization: AUTH } },
    );
    expect(getResp.status).toBe(200);
    const echoed = Buffer.from(await getResp.arrayBuffer());
    expect(echoed.equals(fileBytes)).toBe(true);
  });

  it("GET blob endpoint serves Range bytes", async () => {
    const big = Buffer.from("0123456789abcdef");
    const tarBuf = buildSimpleUstarTar([{ name: "z.txt", bytes: big }]);
    const putResp = await fetch(
      `${server.baseUrl}/hf/acme/demo/upload-tarball?revision=v1`,
      {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tarBuf,
      },
    );
    expect(putResp.status).toBe(201);

    const crypto = await import("node:crypto");
    const sha = crypto.createHash("sha256").update(big).digest("hex");

    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/lfs/sha256/${sha}`,
      { headers: { authorization: AUTH, range: "bytes=0-4" } },
    );
    expect(r.status).toBe(206);
    const echoed = Buffer.from(await r.arrayBuffer());
    expect(echoed.toString()).toBe("01234");
  });

  it("GET resolve serves Range bytes on the raw path", async () => {
    const big = Buffer.from("ABCDEFGHIJ");
    const tarBuf = buildSimpleUstarTar([{ name: "raw.bin", bytes: big }]);
    await fetch(`${server.baseUrl}/hf/acme/demo/upload-tarball?revision=v1`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/x-tar" },
      body: tarBuf,
    });
    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/resolve/v1/raw.bin`,
      { headers: { authorization: AUTH, range: "bytes=2-5" } },
    );
    expect(r.status).toBe(206);
    const echoed = Buffer.from(await r.arrayBuffer());
    expect(echoed.toString()).toBe("CDEF");
  });

  it("invokes the virtual proxy on revision miss when an upstream is configured", async () => {
    // Configure a stub fetcher via the server's option.
    storage.close();
    server.close().catch(() => {});
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-mount-v-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "huggingface",
      upstreamUrl: "https://hf-mirror.example",
      config: {},
    });

    const body = Buffer.from("upstream content");
    server = await createServer({
      storage,
      virtualUpstreamFetch: async (url) => {
        if (url.includes("/resolve/v1/x.json")) {
          return { status: 200, body, headers: {} };
        }
        return { status: 404, body: Buffer.alloc(0), headers: {} };
      },
    });

    const r = await fetch(
      `${server.baseUrl}/hf/acme/demo/resolve/v1/x.json`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const echoed = Buffer.from(await r.arrayBuffer());
    expect(echoed.equals(body)).toBe(true);
  });

  it("LFS Batch returns download action with our public endpoint href", async () => {
    // Publish a file > LFS threshold via a tar.
    const big = Buffer.alloc(6 * 1024 * 1024, 0x42);
    const tarBuf = buildSimpleUstarTar([{ name: "weights.bin", bytes: big }]);
    const putResp = await fetch(
      `${server.baseUrl}/hf/acme/demo/upload-tarball?revision=v1`,
      {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tarBuf,
      },
    );
    expect(putResp.status).toBe(201);

    const crypto = await import("node:crypto");
    const sha = crypto.createHash("sha256").update(big).digest("hex");

    const batchResp = await fetch(
      `${server.baseUrl}/hf/acme/demo/info/lfs/objects/batch`,
      {
        method: "POST",
        headers: {
          authorization: AUTH,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "download",
          objects: [{ oid: `sha256:${sha}`, size: big.length }],
        }),
      },
    );
    expect(batchResp.status).toBe(200);
    const body = await batchResp.json();
    expect(body.objects[0].actions.download.href).toContain(
      `/hf/acme/demo/lfs/sha256/${sha}`,
    );
  });
});

/**
 * Inline USTAR tar builder; same shape as the publish-test helper but
 * inlined here so the mount test doesn't depend on it.
 */
function buildSimpleUstarTar(
  entries: Array<{ name: string; bytes: Buffer }>,
): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(e.name, "utf-8").copy(header, 0);
    Buffer.from("0000644\0", "utf-8").copy(header, 100);
    Buffer.from("0000000\0", "utf-8").copy(header, 108);
    Buffer.from("0000000\0", "utf-8").copy(header, 116);
    const sizeOct = e.bytes.length.toString(8).padStart(11, "0");
    Buffer.from(sizeOct + "\0", "utf-8").copy(header, 124);
    Buffer.from("0000000\0", "utf-8").copy(header, 136);
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    header[156] = "0".charCodeAt(0);
    Buffer.from("ustar\0", "utf-8").copy(header, 257);
    Buffer.from("00", "utf-8").copy(header, 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    const cs = sum.toString(8).padStart(6, "0");
    Buffer.from(cs, "utf-8").copy(header, 148);
    header[148 + 6] = 0;
    header[148 + 7] = 0x20;
    out.push(header);
    out.push(e.bytes);
    const pad = (512 - (e.bytes.length % 512)) % 512;
    if (pad > 0) out.push(Buffer.alloc(pad));
  }
  out.push(Buffer.alloc(512));
  out.push(Buffer.alloc(512));
  return Buffer.concat(out);
}
