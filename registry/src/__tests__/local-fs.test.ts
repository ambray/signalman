import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsBlobStore } from "../storage/local-fs.js";
import { RegistryError } from "../types.js";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("LocalFsBlobStore", () => {
  let root: string;
  let store: LocalFsBlobStore;
  let fixedNow: Date;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-blob-"));
    fixedNow = new Date("2026-05-14T12:00:00.000Z");
    store = new LocalFsBlobStore({ root, now: () => fixedNow });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("round-trips a buffer blob", async () => {
    const body = Buffer.from("hello world");
    const meta = await store.putBlob({ body, contentType: "text/plain" });
    expect(meta.size).toBe(body.length);
    expect(meta.createdAt).toBe("2026-05-14T12:00:00.000Z");
    expect(meta.contentType).toBe("text/plain");
    const expectedSha = crypto.createHash("sha256").update(body).digest("hex");
    expect(meta.sha256).toBe(expectedSha);

    const stream = await store.getBlob(meta.sha256);
    const bytes = await readAll(stream);
    expect(bytes.equals(body)).toBe(true);
  });

  it("round-trips a stream blob", async () => {
    const body = Readable.from([Buffer.from("ab"), Buffer.from("cdef")]);
    const meta = await store.putBlob({ body });
    expect(meta.size).toBe(6);
    const expectedSha = crypto
      .createHash("sha256")
      .update("abcdef")
      .digest("hex");
    expect(meta.sha256).toBe(expectedSha);
  });

  it("dedupes a re-put without changing createdAt", async () => {
    const body = Buffer.from("dedupe");
    const first = await store.putBlob({ body });
    // Advance the clock; a re-put should preserve the original
    // createdAt, not adopt the new timestamp.
    fixedNow = new Date("2026-06-01T00:00:00.000Z");
    const second = await store.putBlob({ body, contentType: "application/x" });
    expect(second.sha256).toBe(first.sha256);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.contentType).toBeUndefined();
  });

  it("returns null from statBlob for an unknown sha", async () => {
    const sha = "f".repeat(64);
    expect(await store.statBlob(sha)).toBeNull();
  });

  it("returns metadata from statBlob after put", async () => {
    const meta = await store.putBlob({ body: Buffer.from("stat-me") });
    const stat = await store.statBlob(meta.sha256);
    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(7);
    expect(stat!.createdAt).toBe("2026-05-14T12:00:00.000Z");
  });

  it("throws BLOB_NOT_FOUND from getBlob for an unknown sha", async () => {
    let caught: unknown;
    try {
      await store.getBlob("0".repeat(64));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe("blob_not_found");
  });

  it("rejects invalid shas from getBlob", async () => {
    await expect(store.getBlob("notasha")).rejects.toThrowError(RegistryError);
  });

  it("rejects invalid shas from statBlob", async () => {
    await expect(store.statBlob("notasha")).rejects.toThrowError(
      RegistryError,
    );
  });

  it("rejects invalid shas from deleteBlob", async () => {
    await expect(store.deleteBlob("notasha")).rejects.toThrowError(
      RegistryError,
    );
  });

  it("deleteBlob is idempotent on a missing sha", async () => {
    await expect(store.deleteBlob("0".repeat(64))).resolves.toBeUndefined();
  });

  it("deleteBlob removes the blob + sidecar", async () => {
    const meta = await store.putBlob({ body: Buffer.from("byebye") });
    await store.deleteBlob(meta.sha256);
    expect(await store.statBlob(meta.sha256)).toBeNull();
  });

  it("falls back to filesystem stat when the sidecar is missing", async () => {
    const meta = await store.putBlob({ body: Buffer.from("xx") });
    const sidecarPath = `${store.pathForSha(meta.sha256)}.meta.json`;
    await fsp.unlink(sidecarPath);
    const stat = await store.statBlob(meta.sha256);
    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(2);
    expect(stat!.contentType).toBeUndefined();
  });

  it("stores blobs under <root>/blobs/<sha[0:2]>/<sha>", async () => {
    const meta = await store.putBlob({ body: Buffer.from("layout") });
    const expected = path.join(
      root,
      "blobs",
      meta.sha256.slice(0, 2),
      meta.sha256,
    );
    expect(await fsp.stat(expected)).toBeTruthy();
  });

  it("returns the same on-disk path from pathForSha", () => {
    const sha = "abcd".repeat(16);
    const p = store.pathForSha(sha);
    expect(p).toBe(path.join(root, "blobs", "ab", sha));
  });

  it("rejects path-traversal-shaped shas from pathForSha", () => {
    expect(() => store.pathForSha("../" + "a".repeat(60) + "abc")).toThrowError(
      RegistryError,
    );
  });
});
