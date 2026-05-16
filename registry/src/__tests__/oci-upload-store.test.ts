// WS10 M2 — pending_blob_uploads SQL helpers + on-disk tmp-file
// store. Unit tests only; the HTTP integration sits in
// oci-blobs.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteManifestIndex } from "../storage/sqlite-index.js";
import {
  DEFAULT_UPLOAD_TTL_SECONDS,
  UploadFsStore,
  UploadStore,
  validateUploadId,
} from "../oci/index.js";

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

describe("UploadStore (SQL)", () => {
  let idx: SqliteManifestIndex;
  let store: UploadStore;
  let idCounter = 0;

  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
    idCounter = 0;
    store = new UploadStore({
      index: idx,
      now: () => FIXED_NOW,
      newId: () => `id${(++idCounter).toString().padStart(31, "0")}`,
    });
  });

  afterEach(() => {
    idx.close();
  });

  it("create() writes a row with TTL = 24h", () => {
    const row = store.create("oci/acme/svc", "sk_TEST");
    expect(row.uploadId).toBe("id" + "0".repeat(31).slice(0, 30) + "1");
    expect(row.repository).toBe("oci/acme/svc");
    expect(row.actor).toBe("sk_TEST");
    expect(row.bytesReceived).toBe(0);
    expect(row.chunks).toEqual([]);
    expect(row.createdAt).toBe(FIXED_NOW.toISOString());
    const expected = new Date(
      FIXED_NOW.getTime() + DEFAULT_UPLOAD_TTL_SECONDS * 1000,
    ).toISOString();
    expect(row.expiresAt).toBe(expected);
  });

  it("get() round-trips the row", () => {
    const created = store.create("oci/acme/svc", "sk_TEST");
    const got = store.get(created.uploadId);
    expect(got).toEqual(created);
  });

  it("get() returns null on unknown upload id", () => {
    expect(store.get("missing")).toBeNull();
  });

  it("appendChunk() advances bytes_received and stores chunk metadata", () => {
    const created = store.create("oci/acme/svc", "sk_TEST");
    const next = store.appendChunk(created.uploadId, {
      offset: 0,
      length: 100,
      sha256: "a".repeat(64),
    });
    expect(next.bytesReceived).toBe(100);
    expect(next.chunks).toHaveLength(1);
    expect(next.chunks[0]).toEqual({
      offset: 0,
      length: 100,
      sha256: "a".repeat(64),
    });
    const second = store.appendChunk(created.uploadId, {
      offset: 100,
      length: 50,
      sha256: "b".repeat(64),
    });
    expect(second.bytesReceived).toBe(150);
    expect(second.chunks).toHaveLength(2);
  });

  it("appendChunk() throws when the row is unknown", () => {
    expect(() =>
      store.appendChunk("missing", { offset: 0, length: 1, sha256: "x" }),
    ).toThrow(/not found/);
  });

  it("delete() is idempotent", () => {
    const row = store.create("oci/acme/svc", "sk_TEST");
    store.delete(row.uploadId);
    expect(() => store.delete(row.uploadId)).not.toThrow();
    expect(store.get(row.uploadId)).toBeNull();
  });

  it("listExpired() returns only rows at or before the cutoff", () => {
    const earlyStore = new UploadStore({
      index: idx,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
      newId: () => "early000000000000000000000000000",
    });
    const lateStore = new UploadStore({
      index: idx,
      now: () => new Date("2026-05-16T12:00:00.000Z"),
      newId: () => "late0000000000000000000000000000",
    });
    earlyStore.create("oci/a/svc", "actor");
    lateStore.create("oci/a/svc", "actor");
    // Cutoff between the two expirations
    const cutoff = new Date("2026-05-16T13:00:00.000Z");
    const expired = lateStore.listExpired(cutoff);
    // Only the earlier row's expiresAt is past the cutoff
    expect(expired.map((r) => r.uploadId)).toEqual([
      "early000000000000000000000000000",
    ]);
  });
});

describe("validateUploadId", () => {
  it("accepts a 32-hex id", () => {
    expect(() => validateUploadId("a".repeat(32))).not.toThrow();
  });

  it("rejects shorter / longer ids", () => {
    expect(() => validateUploadId("a".repeat(31))).toThrow();
    expect(() => validateUploadId("a".repeat(33))).toThrow();
  });

  it("rejects uppercase / mixed case", () => {
    expect(() => validateUploadId("A".repeat(32))).toThrow();
  });

  it("rejects path-traversal attempts", () => {
    expect(() => validateUploadId("../etc/passwd")).toThrow();
    expect(() => validateUploadId("..".repeat(16))).toThrow();
  });

  it("rejects non-string input", () => {
    expect(() => validateUploadId(undefined as unknown as string)).toThrow();
    expect(() => validateUploadId(42 as unknown as string)).toThrow();
  });
});

describe("UploadFsStore (filesystem)", () => {
  let root: string;
  let fsStore: UploadFsStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-upload-fs-"));
    fsStore = new UploadFsStore({ root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ensureDir() is idempotent", async () => {
    await fsStore.ensureDir();
    await fsStore.ensureDir();
    const stat = await fs.stat(fsStore.uploadsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("appendBytes() creates the file then appends", async () => {
    const id = "a".repeat(32);
    const after1 = await fsStore.appendBytes(id, Buffer.from("hello"));
    expect(after1).toBe(5);
    const after2 = await fsStore.appendBytes(id, Buffer.from(" world"));
    expect(after2).toBe(11);
    const assembled = await fsStore.readAssembled(id);
    expect(assembled.toString("utf-8")).toBe("hello world");
  });

  it("stat() returns null for an absent upload", async () => {
    expect(await fsStore.stat("a".repeat(32))).toBeNull();
  });

  it("stat() returns size for an existing upload", async () => {
    const id = "b".repeat(32);
    await fsStore.appendBytes(id, Buffer.from("abc"));
    const s = await fsStore.stat(id);
    expect(s?.size).toBe(3);
  });

  it("delete() is idempotent on missing file", async () => {
    await expect(fsStore.delete("c".repeat(32))).resolves.toBeUndefined();
  });

  it("hashAssembled() computes the sha256 of the full file", async () => {
    const id = "d".repeat(32);
    await fsStore.appendBytes(id, Buffer.from("hello "));
    await fsStore.appendBytes(id, Buffer.from("world"));
    const hex = await fsStore.hashAssembled(id);
    // sha256("hello world")
    expect(hex).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("rejects invalid upload ids via path traversal defense", () => {
    expect(() => fsStore.pathFor("..//etc/passwd")).toThrow();
    expect(() => fsStore.pathFor("a".repeat(31))).toThrow();
  });
});
