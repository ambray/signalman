// WS13 M4 Story 2 — resolve.ts + blobs.ts unit-level coverage.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  HF_ERROR_CODES,
  HfError,
  composeLfsPointer,
  hfManifestName,
  hfManifestVersion,
} from "../hf/index.js";
import { serveHfBlob } from "../hf/blobs.js";
import { resolveHfFile, effectiveRevision } from "../hf/resolve.js";
import type { Manifest } from "../types.js";
import type {
  HfRevisionInsert,
  SqliteManifestIndex,
} from "../storage/sqlite-index.js";

function sha256Hex(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  ended: boolean;
  setHeader(k: string, v: string | number): void;
  end(b?: string | Buffer): void;
  write(b: Buffer): boolean;
  on(ev: string, fn: (...args: unknown[]) => void): unknown;
}

function makeFakeRes(): FakeRes {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = String(v);
    },
    write(b) {
      chunks.push(Buffer.from(b));
      return true;
    },
    end(b) {
      if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
      this.body = Buffer.concat(chunks);
      this.ended = true;
    },
    on() {
      return this;
    },
  };
}

describe("serveHfBlob", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let bytes: Buffer;
  let hex: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-blob-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    bytes = Buffer.from("hello world, this is the blob bytes content");
    const meta = await storage.putBlob({ body: bytes });
    hex = meta.sha256;
    void hex;
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("serves the full blob on GET with no Range", async () => {
    const res = makeFakeRes();
    await serveHfBlob({
      storage,
      sha256: hex,
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(bytes.length));
    expect(res.headers["etag"]).toBe(`"sha256:${hex}"`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.body.equals(bytes)).toBe(true);
  });

  it("404s when the blob is missing", async () => {
    const res = makeFakeRes();
    let caught: unknown;
    try {
      await serveHfBlob({
        storage,
        sha256: "0".repeat(64),
        res: res as unknown as ServerResponse,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.BLOB_NOT_FOUND);
  });

  it("honours a Range: bytes=0-9 request", async () => {
    const res = makeFakeRes();
    await serveHfBlob({
      storage,
      sha256: hex,
      rangeHeader: "bytes=0-9",
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["content-range"]).toBe(`bytes 0-9/${bytes.length}`);
    expect(res.body.equals(bytes.subarray(0, 10))).toBe(true);
  });

  it("honours a suffix Range: bytes=-5 request", async () => {
    const res = makeFakeRes();
    await serveHfBlob({
      storage,
      sha256: hex,
      rangeHeader: "bytes=-5",
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(206);
    expect(res.body.equals(bytes.subarray(bytes.length - 5))).toBe(true);
  });

  it("honours an open-ended Range: bytes=10-", async () => {
    const res = makeFakeRes();
    await serveHfBlob({
      storage,
      sha256: hex,
      rangeHeader: "bytes=10-",
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(206);
    expect(res.body.equals(bytes.subarray(10))).toBe(true);
  });

  it("rejects an unsatisfiable range", async () => {
    const res = makeFakeRes();
    let caught: unknown;
    try {
      await serveHfBlob({
        storage,
        sha256: hex,
        rangeHeader: "bytes=9999-99999",
        res: res as unknown as ServerResponse,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.RANGE_INVALID);
  });

  it("honours an explicit content-type override", async () => {
    const res = makeFakeRes();
    await serveHfBlob({
      storage,
      sha256: hex,
      res: res as unknown as ServerResponse,
      contentType: "application/json",
    });
    expect(res.headers["content-type"]).toBe("application/json");
  });
});

describe("resolveHfFile", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let index: SqliteManifestIndex;
  const ORG = "acme";
  const REPO = "demo-model";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-resolve-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    index = storage.index;
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedFile(
    revision: string,
    p: string,
    body: Buffer,
    lfs = false,
  ): Promise<string> {
    const meta = await storage.putBlob({ body });
    const sha = meta.sha256;
    // Per-file manifest row.
    const m: Manifest = {
      name: hfManifestName(ORG, REPO, "model"),
      version: hfManifestVersion(revision, p),
      mediaType: "application/vnd.signalman.hf-file.v1+json",
      kind: "hf",
      blobs: [{ mediaType: "application/octet-stream", sha256: sha, size: body.length, name: p }],
      hfMetadata: {
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision,
        path: p,
        lfs,
        sha256: sha,
        size: body.length,
      },
      createdAt: "2026-05-17T00:00:00.000Z",
    };
    await storage.putManifest(m);
    return sha;
  }

  function seedRevision(rev: string, files: Array<{ path: string; sha256: string; size: number; lfs: boolean }>): void {
    const insert: HfRevisionInsert = {
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: rev,
      rootTreeDigest: "tree-" + rev,
      files,
      createdAt: "2026-05-17T00:00:00.000Z",
    };
    index.putHfRevision(insert);
  }

  it("returns raw bytes for a non-LFS file", async () => {
    const body = Buffer.from(JSON.stringify({ hidden: 768 }));
    const sha = await seedFile("v1", "config.json", body);
    seedRevision("v1", [{ path: "config.json", sha256: sha, size: body.length, lfs: false }]);

    const res = makeFakeRes();
    await resolveHfFile({
      storage,
      index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      path: "config.json",
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.equals(body)).toBe(true);
    expect(res.headers["etag"]).toBe(`"sha256:${sha}"`);
  });

  it("returns the LFS pointer for an LFS-tracked file", async () => {
    const body = Buffer.alloc(10 * 1024 * 1024, 0x42); // 10 MiB
    const sha = await seedFile("v1", "weights.bin", body, true);
    seedRevision("v1", [{ path: "weights.bin", sha256: sha, size: body.length, lfs: true }]);

    const res = makeFakeRes();
    await resolveHfFile({
      storage,
      index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      path: "weights.bin",
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-lfs-pointer"]).toBe("true");
    const expected = composeLfsPointer(sha, body.length);
    expect(res.body.equals(expected)).toBe(true);
  });

  it("404s when the revision is unknown (canonical body emitted upstream)", async () => {
    const res = makeFakeRes();
    let caught: unknown;
    try {
      await resolveHfFile({
        storage,
        index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "doesnotexist",
        path: "config.json",
        res: res as unknown as ServerResponse,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.REVISION_NOT_FOUND);
  });

  it("404s when the file is unknown within an existing revision", async () => {
    seedRevision("v1", [
      { path: "config.json", sha256: "a".repeat(64), size: 7, lfs: false },
    ]);
    const res = makeFakeRes();
    let caught: unknown;
    try {
      await resolveHfFile({
        storage,
        index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        path: "missing.json",
        res: res as unknown as ServerResponse,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.FILE_NOT_FOUND);
  });

  it("calls the proxy hook on revision miss + recovers on success", async () => {
    let proxyCalls = 0;
    const proxyResolve = async () => {
      proxyCalls += 1;
      // Stub: the proxy "fetches" upstream + populates the local row.
      const body = Buffer.from("from upstream");
      const meta = await storage.putBlob({ body });
      const sha = meta.sha256;
      seedRevision("v1", [
        { path: "config.json", sha256: sha, size: body.length, lfs: false },
      ]);
      return true;
    };
    const res = makeFakeRes();
    await resolveHfFile({
      storage,
      index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      path: "config.json",
      res: res as unknown as ServerResponse,
      proxyResolve,
    });
    expect(proxyCalls).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe("from upstream");
  });

  it("calls the proxy hook on file miss within an existing revision", async () => {
    seedRevision("v1", [
      { path: "other.json", sha256: "a".repeat(64), size: 7, lfs: false },
    ]);
    let proxyCalls = 0;
    const proxyResolve = async () => {
      proxyCalls += 1;
      const body = Buffer.from("late-arriving file");
      const meta = await storage.putBlob({ body });
      const sha = meta.sha256;
      // Update revision to include the requested file.
      index.updateHfRevision({
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        rootTreeDigest: "tree-v1-updated",
        files: [
          { path: "other.json", sha256: "a".repeat(64), size: 7, lfs: false },
          { path: "config.json", sha256: sha, size: body.length, lfs: false },
        ],
        createdAt: "2026-05-17T01:00:00.000Z",
      });
      return true;
    };
    const res = makeFakeRes();
    await resolveHfFile({
      storage,
      index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      path: "config.json",
      res: res as unknown as ServerResponse,
      proxyResolve,
    });
    expect(proxyCalls).toBe(1);
    expect(res.body.toString()).toBe("late-arriving file");
  });

  it("404s when the proxy hook is set but reports a miss", async () => {
    const res = makeFakeRes();
    let caught: unknown;
    try {
      await resolveHfFile({
        storage,
        index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "absent",
        path: "config.json",
        res: res as unknown as ServerResponse,
        proxyResolve: async () => false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.REVISION_NOT_FOUND);
  });

  it("honours a Range request on the raw byte path", async () => {
    const body = Buffer.from("0123456789abcdefghij");
    const sha = await seedFile("v1", "config.json", body);
    seedRevision("v1", [{ path: "config.json", sha256: sha, size: body.length, lfs: false }]);

    const res = makeFakeRes();
    await resolveHfFile({
      storage,
      index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      path: "config.json",
      rangeHeader: "bytes=0-4",
      res: res as unknown as ServerResponse,
    });
    expect(res.statusCode).toBe(206);
    expect(res.body.toString()).toBe("01234");
  });

  it("re-attempts the file lookup if proxy populated a different revision row", async () => {
    seedRevision("v1", []);
    const res = makeFakeRes();
    let caught: unknown;
    try {
      await resolveHfFile({
        storage,
        index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        path: "config.json",
        res: res as unknown as ServerResponse,
        proxyResolve: async () => true, // claims success but never populates
      });
    } catch (err) {
      caught = err;
    }
    // Still 404 because proxy claimed success without populating.
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.FILE_NOT_FOUND);
  });
});

describe("effectiveRevision", () => {
  it("returns the supplied revision when present", () => {
    expect(effectiveRevision("v1")).toBe("v1");
  });
  it("returns 'main' when undefined / empty", () => {
    expect(effectiveRevision(undefined)).toBe("main");
    expect(effectiveRevision("")).toBe("main");
  });
});
