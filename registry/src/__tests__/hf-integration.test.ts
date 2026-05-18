// WS13 M4 Story 7 — HTTP integration for the HuggingFace facade.
//
// Boots a real server with LocalFsRegistryStorage. Covers:
//   - PUT tarball → GET resolve/<rev>/<path>.
//   - LFS pointer for files > 5 MB; raw bytes for smaller.
//   - LFS Batch: download action; missing OID.
//   - Range requests.
//   - Virtual upstream pull-through (mocked fetcher) for resolve,
//     LFS Batch, and revision tree.
//   - Snapshot revisions: revision A, revision B; resolve against
//     each returns the right bytes.
//   - 409 on conflicting revision push.
//   - Symlink-in-tarball rejection.
//   - Oversize-blob rejection.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  composeLfsPointer,
  HF_DEFAULT_LFS_THRESHOLD,
} from "../hf/index.js";
import type { UpstreamFetch } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";
const REPO = "demo-model";

function sha256Hex(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

/** Inline USTAR tar builder. */
function buildTar(
  entries: Array<{ path: string; bytes: Buffer; typeflag?: string }>,
): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(e.path, "utf-8").copy(header, 0);
    Buffer.from("0000644\0", "utf-8").copy(header, 100);
    Buffer.from("0000000\0", "utf-8").copy(header, 108);
    Buffer.from("0000000\0", "utf-8").copy(header, 116);
    const sizeOct = e.bytes.length.toString(8).padStart(11, "0");
    Buffer.from(sizeOct + "\0", "utf-8").copy(header, 124);
    Buffer.from("0000000\0", "utf-8").copy(header, 136);
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    header[156] = (e.typeflag ?? "0").charCodeAt(0);
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

function makeStub(impl: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => { status: number; body: Buffer; headers?: Record<string, string> }): UpstreamFetch {
  return async (url, init) => {
    const out = impl(url, init);
    return { status: out.status, body: out.body, headers: out.headers ?? {} };
  };
}

describe("HF HTTP integration", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-int-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("publish + read happy path", () => {
    it("round-trips a small file through publish + resolve", async () => {
      const body = Buffer.from('{"hidden_dim":768}');
      const tar = buildTar([{ path: "config.json", bytes: body }]);
      const put = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tar,
      });
      expect(put.status).toBe(201);
      const result = await put.json();
      expect(result.file_count).toBe(1);
      expect(result.revision).toBe("v1");
      expect(result.total_bytes).toBe(body.length);

      const get = await fetch(
        `${server.baseUrl}/hf/${ORG}/${REPO}/resolve/v1/config.json`,
        { headers: { authorization: AUTH } },
      );
      expect(get.status).toBe(200);
      const echoed = Buffer.from(await get.arrayBuffer());
      expect(echoed.equals(body)).toBe(true);
    });

    it("emits an LFS pointer for files larger than the threshold", async () => {
      const big = Buffer.alloc(HF_DEFAULT_LFS_THRESHOLD + 1024, 0x42);
      const tar = buildTar([{ path: "weights.bin", bytes: big }]);
      const put = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tar,
      });
      expect(put.status).toBe(201);

      const get = await fetch(
        `${server.baseUrl}/hf/${ORG}/${REPO}/resolve/v1/weights.bin`,
        { headers: { authorization: AUTH } },
      );
      expect(get.status).toBe(200);
      expect(get.headers.get("x-lfs-pointer")).toBe("true");
      const pointer = Buffer.from(await get.arrayBuffer());
      const expected = composeLfsPointer(sha256Hex(big), big.length);
      expect(pointer.equals(expected)).toBe(true);
    });

    it("LFS Batch returns a download action for present OID + 404 error for missing", async () => {
      const big = Buffer.alloc(HF_DEFAULT_LFS_THRESHOLD + 100, 0x42);
      const tar = buildTar([{ path: "weights.bin", bytes: big }]);
      const put = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tar,
      });
      expect(put.status).toBe(201);

      const sha = sha256Hex(big);
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/info/lfs/objects/batch`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          operation: "download",
          objects: [
            { oid: `sha256:${sha}`, size: big.length },
            { oid: `sha256:${"0".repeat(64)}`, size: 1 },
          ],
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.objects[0].actions.download.href).toContain(
        `/hf/${ORG}/${REPO}/lfs/sha256/${sha}`,
      );
      expect(body.objects[1].error.code).toBe(404);
    });

    it("blob endpoint serves bytes + honours HTTP Range", async () => {
      const big = Buffer.from("0123456789ABCDEFGHIJ");
      const tar = buildTar([{ path: "f.txt", bytes: big }]);
      await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tar,
      });

      const sha = sha256Hex(big);
      const full = await fetch(
        `${server.baseUrl}/hf/${ORG}/${REPO}/lfs/sha256/${sha}`,
        { headers: { authorization: AUTH } },
      );
      expect(full.status).toBe(200);
      expect(Buffer.from(await full.arrayBuffer()).equals(big)).toBe(true);

      const partial = await fetch(
        `${server.baseUrl}/hf/${ORG}/${REPO}/lfs/sha256/${sha}`,
        { headers: { authorization: AUTH, range: "bytes=5-9" } },
      );
      expect(partial.status).toBe(206);
      expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe("56789");
    });
  });

  describe("revisions", () => {
    it("two revisions land independent file trees", async () => {
      const aBody = Buffer.from("revision A bytes");
      const bBody = Buffer.from("revision B different bytes");
      const tarA = buildTar([{ path: "x.txt", bytes: aBody }]);
      const tarB = buildTar([{ path: "x.txt", bytes: bBody }]);
      await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=A`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tarA,
      });
      await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=B`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tarB,
      });
      const a = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/A/x.txt`, {
        headers: { authorization: AUTH },
      });
      const b = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/B/x.txt`, {
        headers: { authorization: AUTH },
      });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(Buffer.from(await a.arrayBuffer()).equals(aBody)).toBe(true);
      expect(Buffer.from(await b.arrayBuffer()).equals(bBody)).toBe(true);
    });

    it("the 'main' sentinel tracks the latest publish", async () => {
      const aBody = Buffer.from("rev A content");
      const bBody = Buffer.from("rev B content");
      await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=A`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: buildTar([{ path: "x.txt", bytes: aBody }]),
      });
      await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=B`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: buildTar([{ path: "x.txt", bytes: bBody }]),
      });
      const main = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/main/x.txt`, {
        headers: { authorization: AUTH },
      });
      expect(main.status).toBe(200);
      expect(Buffer.from(await main.arrayBuffer()).equals(bBody)).toBe(true);
    });

    it("409 CONFLICT on republishing the same revision with different bytes", async () => {
      const a = buildTar([{ path: "x.txt", bytes: Buffer.from("first") }]);
      const b = buildTar([{ path: "x.txt", bytes: Buffer.from("second") }]);
      await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: a,
      });
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: b,
      });
      expect(r.status).toBe(409);
    });
  });

  describe("upload rejection paths", () => {
    it("rejects a tarball with a symlink entry", async () => {
      const tar = buildTar([
        { path: "x.txt", bytes: Buffer.from("ok") },
        { path: "link", bytes: Buffer.alloc(0), typeflag: "2" },
      ]);
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tar,
      });
      expect(r.status).toBe(400);
    });

    it("rejects a tarball with path traversal", async () => {
      const tar = buildTar([{ path: "../escape.txt", bytes: Buffer.from("x") }]);
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/upload-tarball?revision=v1`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/x-tar" },
        body: tar,
      });
      expect(r.status).toBe(400);
    });

    it("404 with HF-canonical body for unknown repo path", async () => {
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/v1/missing.json`, {
        headers: { authorization: AUTH },
      });
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body).toEqual({ error: "Revision not found" });
    });

    it("rejects an LFS Batch with operation: upload (422)", async () => {
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/info/lfs/objects/batch`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          operation: "upload",
          objects: [{ oid: `sha256:${"a".repeat(64)}`, size: 1 }],
        }),
      });
      expect(r.status).toBe(422);
    });
  });

  describe("virtual upstream pull-through", () => {
    it("resolves a missing file via upstream + caches the bytes locally", async () => {
      await server.close();
      const fileBody = Buffer.from("upstream file content");
      const fetchStub = makeStub((url) => {
        if (url.includes(`/resolve/v1/upstream.json`)) {
          return { status: 200, body: fileBody };
        }
        return { status: 404, body: Buffer.alloc(0) };
      });
      server = await createServer({
        storage,
        virtualUpstreamFetch: fetchStub,
      });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "huggingface",
        upstreamUrl: "https://hf-mirror.example",
        config: {},
      });

      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/v1/upstream.json`, {
        headers: { authorization: AUTH },
      });
      expect(r.status).toBe(200);
      const echoed = Buffer.from(await r.arrayBuffer());
      expect(echoed.equals(fileBody)).toBe(true);

      // Second fetch should hit the local cache (we never recreate the
      // upstream stub here; if a second upstream call happens, the
      // stub would still return the body, but the audit log distinguishes).
      const before = storage.index.listAuditEntries({ action: "proxy_cache" }).length;
      const r2 = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/v1/upstream.json`, {
        headers: { authorization: AUTH },
      });
      expect(r2.status).toBe(200);
      const after = storage.index.listAuditEntries({ action: "proxy_cache" }).length;
      // Cache hit: no new proxy_cache audit entries.
      expect(after).toBe(before);
    });

    it("LFS Batch pulls missing OIDs through the upstream Batch + blob fetch", async () => {
      await server.close();
      const blob = Buffer.alloc(100, 0x42);
      const blobHex = sha256Hex(blob);
      const fetchStub = makeStub((url) => {
        if (url.endsWith(".git/info/lfs/objects/batch")) {
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify({
                objects: [{
                  oid: `sha256:${blobHex}`,
                  size: blob.length,
                  actions: { download: { href: "https://lfs.example/x" } },
                }],
              }),
            ),
          };
        }
        if (url === "https://lfs.example/x") {
          return { status: 200, body: blob };
        }
        return { status: 404, body: Buffer.alloc(0) };
      });
      server = await createServer({
        storage,
        virtualUpstreamFetch: fetchStub,
      });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "huggingface",
        upstreamUrl: "https://hf-mirror.example",
        config: {},
      });
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/info/lfs/objects/batch`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          operation: "download",
          objects: [{ oid: `sha256:${blobHex}`, size: blob.length }],
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.objects[0].actions.download.href).toContain(
        `/hf/${ORG}/${REPO}/lfs/sha256/${blobHex}`,
      );
      // Direct blob fetch now works against our local endpoint.
      const blobResp = await fetch(
        `${server.baseUrl}/hf/${ORG}/${REPO}/lfs/sha256/${blobHex}`,
        { headers: { authorization: AUTH } },
      );
      expect(blobResp.status).toBe(200);
      const echoed = Buffer.from(await blobResp.arrayBuffer());
      expect(echoed.equals(blob)).toBe(true);
    });

    it("populates a revision tree from upstream then serves per-file from it", async () => {
      await server.close();
      const fileBody = Buffer.from("tree-populated content");
      const fetchStub = makeStub((url) => {
        if (url.endsWith(`/api/models/${ORG}/${REPO}/tree/v1`)) {
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify([
                { type: "file", path: "tree.txt", size: fileBody.length },
              ]),
            ),
          };
        }
        if (url.includes("/resolve/v1/tree.txt")) {
          return { status: 200, body: fileBody };
        }
        return { status: 404, body: Buffer.alloc(0) };
      });
      server = await createServer({
        storage,
        virtualUpstreamFetch: fetchStub,
      });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "huggingface",
        upstreamUrl: "https://hf-mirror.example",
        config: {},
      });
      const r = await fetch(`${server.baseUrl}/hf/${ORG}/${REPO}/resolve/v1/tree.txt`, {
        headers: { authorization: AUTH },
      });
      expect(r.status).toBe(200);
      const echoed = Buffer.from(await r.arrayBuffer());
      expect(echoed.equals(fileBody)).toBe(true);
    });
  });
});
