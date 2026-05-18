// WS13 M4 Story 3 — LFS Batch API.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  HF_ERROR_CODES,
  HfError,
  handleLfsBatch,
  type LfsBatchRequest,
} from "../hf/index.js";

function sha256Hex(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

describe("handleLfsBatch", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let body: Buffer;
  let hex: string;
  const ORG = "acme";
  const REPO = "demo-model";
  const COMPOSE = (sha: string) => `https://registry.example/hf/${ORG}/${REPO}/lfs/sha256/${sha}`;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-lfs-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    body = Buffer.from("some big file bytes");
    const meta = await storage.putBlob({ body });
    hex = meta.sha256;
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns a download action for a present OID", async () => {
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: `sha256:${hex}`, size: body.length }],
      },
      composeDownloadHref: COMPOSE,
    });
    expect(resp.transfer).toBe("basic");
    expect(resp.objects.length).toBe(1);
    const o = resp.objects[0];
    expect(o.oid).toBe(`sha256:${hex}`);
    expect(o.actions?.download?.href).toBe(COMPOSE(hex));
    expect(o.error).toBeUndefined();
  });

  it("returns a 404 per-object error for an unknown OID", async () => {
    const missing = `sha256:${"0".repeat(64)}`;
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: missing, size: 100 }],
      },
      composeDownloadHref: COMPOSE,
    });
    expect(resp.objects.length).toBe(1);
    expect(resp.objects[0].error?.code).toBe(404);
    expect(resp.objects[0].actions).toBeUndefined();
  });

  it("returns a per-object error for a malformed OID", async () => {
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: "bad-oid", size: 1 }],
      },
      composeDownloadHref: COMPOSE,
    });
    expect(resp.objects[0].error?.code).toBe(404);
    expect(resp.objects[0].error?.message).toMatch(/invalid sha256/);
  });

  it("handles a mixed batch (present + missing + malformed)", async () => {
    const otherBody = Buffer.from("other content");
    const otherMeta = await storage.putBlob({ body: otherBody });
    const otherHex = otherMeta.sha256;
    const missing = `sha256:${"a".repeat(64)}`;
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [
          { oid: `sha256:${hex}`, size: body.length },
          { oid: missing, size: 100 },
          { oid: "garbage", size: 0 },
          { oid: `sha256:${otherHex}`, size: otherBody.length },
        ],
      },
      composeDownloadHref: COMPOSE,
    });
    expect(resp.objects.length).toBe(4);
    expect(resp.objects[0].actions?.download).toBeDefined();
    expect(resp.objects[1].error?.code).toBe(404);
    expect(resp.objects[2].error?.code).toBe(404);
    expect(resp.objects[3].actions?.download).toBeDefined();
  });

  it("propagates expires_in to action blocks", async () => {
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: `sha256:${hex}`, size: body.length }],
      },
      composeDownloadHref: COMPOSE,
      expiresIn: 600,
    });
    expect(resp.objects[0].actions?.download?.expires_in).toBe(600);
  });

  it("rejects operation: upload with 422 LFS_UNSUPPORTED_OPERATION", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: {
          operation: "upload",
          objects: [{ oid: `sha256:${hex}`, size: body.length }],
        } as LfsBatchRequest,
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_UNSUPPORTED_OPERATION);
  });

  it("rejects an unknown operation", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: { operation: "bogus" as never, objects: [{ oid: "x", size: 1 }] },
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("rejects a non-object request body", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: null as unknown as LfsBatchRequest,
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("rejects when objects is missing or not an array", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: { operation: "download" } as unknown as LfsBatchRequest,
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("rejects when objects is empty or too large", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: { operation: "download", objects: [] },
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);

    const big = Array.from({ length: 1025 }, () => ({ oid: `sha256:${hex}`, size: 1 }));
    caught = undefined;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: { operation: "download", objects: big },
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("rejects when an object entry is not a record", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: { operation: "download", objects: [null as unknown as { oid: string; size: number }] },
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("rejects when oid is not a string", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: {
          operation: "download",
          objects: [{ oid: 42 as unknown as string, size: 1 }],
        },
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("rejects when size is not a non-negative integer", async () => {
    let caught: unknown;
    try {
      await handleLfsBatch({
        storage,
        org: ORG,
        repo: REPO,
        request: {
          operation: "download",
          objects: [{ oid: `sha256:${hex}`, size: -1 }],
        },
        composeDownloadHref: COMPOSE,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.LFS_BATCH_INVALID);
  });

  it("invokes the proxyBatch hook for missing OIDs + recovers on populate", async () => {
    const lateBody = Buffer.from("late content");
    const lateHex = sha256Hex(lateBody);
    let proxyCalls = 0;
    const proxyBatch = async (
      _org: string,
      _repo: string,
      missing: Array<{ oid: string; size: number }>,
    ): Promise<Set<string>> => {
      proxyCalls += 1;
      const populated = new Set<string>();
      for (const m of missing) {
        if (m.oid === `sha256:${lateHex}`) {
          await storage.putBlob({ body: lateBody });
          populated.add(m.oid);
        }
      }
      return populated;
    };
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: `sha256:${lateHex}`, size: lateBody.length }],
      },
      composeDownloadHref: COMPOSE,
      proxyBatch,
    });
    expect(proxyCalls).toBe(1);
    expect(resp.objects[0].actions?.download?.href).toBe(COMPOSE(lateHex));
  });

  it("does not invoke proxyBatch when every OID is present", async () => {
    let proxyCalls = 0;
    const proxyBatch = async () => {
      proxyCalls += 1;
      return new Set<string>();
    };
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: `sha256:${hex}`, size: body.length }],
      },
      composeDownloadHref: COMPOSE,
      proxyBatch,
    });
    expect(proxyCalls).toBe(0);
    expect(resp.objects[0].actions?.download).toBeDefined();
  });

  it("reports 404 when proxyBatch declines to populate", async () => {
    const missing = `sha256:${"e".repeat(64)}`;
    const resp = await handleLfsBatch({
      storage,
      org: ORG,
      repo: REPO,
      request: {
        operation: "download",
        objects: [{ oid: missing, size: 1 }],
      },
      composeDownloadHref: COMPOSE,
      proxyBatch: async () => new Set<string>(),
    });
    expect(resp.objects[0].error?.code).toBe(404);
  });
});
