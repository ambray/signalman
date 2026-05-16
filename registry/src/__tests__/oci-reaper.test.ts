// WS10 M2 — pending-upload reaper tests.
//
// The reaper sweeps expired rows from `pending_blob_uploads` and the
// matching tmp file on disk. Tests pin: identifies expired rows by
// cutoff, deletes both SQL + filesystem state, writes an audit row,
// is idempotent on re-sweep, survives transient FS errors.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteManifestIndex } from "../storage/sqlite-index.js";
import {
  startReaper,
  UploadFsStore,
  UploadStore,
} from "../oci/index.js";

const EARLY = new Date("2026-05-15T00:00:00.000Z");
const LATE = new Date("2026-05-17T00:00:00.000Z");

describe("startReaper", () => {
  let root: string;
  let idx: SqliteManifestIndex;
  let uploadStore: UploadStore;
  let uploadFs: UploadFsStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-reaper-"));
    idx = new SqliteManifestIndex({ path: ":memory:" });
    uploadFs = new UploadFsStore({ root });
    await uploadFs.ensureDir();
    uploadStore = new UploadStore({
      index: idx,
      now: () => EARLY,
      // 32-hex; satisfies the path-traversal guard in UploadFsStore.
      newId: () => "ea" + "0".repeat(30),
    });
  });

  afterEach(async () => {
    idx.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("sweeps a row whose expires_at <= cutoff and deletes the tmp file", async () => {
    const row = uploadStore.create("oci/a/svc", "sk_TEST");
    await uploadFs.appendBytes(row.uploadId, Buffer.from("partial"));
    expect(uploadStore.get(row.uploadId)).not.toBeNull();
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      now: () => LATE,
    });
    const reaped = await reaper.sweep();
    reaper.stop();
    expect(reaped).toBe(1);
    expect(uploadStore.get(row.uploadId)).toBeNull();
    expect(await uploadFs.stat(row.uploadId)).toBeNull();
  });

  it("writes an audit row for each reaped upload", async () => {
    const row = uploadStore.create("oci/a/svc", "sk_TEST");
    await uploadFs.appendBytes(row.uploadId, Buffer.from("p"));
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      now: () => LATE,
    });
    await reaper.sweep();
    reaper.stop();
    const audits = idx.listAuditEntries({ action: "delete" });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const entry = audits.find((e) => e.entityId === `upload:${row.uploadId}`);
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe("reaper");
    expect(entry?.detail).toMatchObject({
      kind: "oci",
      phase: "pending_upload_reaped",
      repository: "oci/a/svc",
    });
  });

  it("leaves rows alone whose expires_at > cutoff", async () => {
    const row = uploadStore.create("oci/a/svc", "sk_TEST");
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      // Cutoff before the row's expiresAt (24h after EARLY)
      now: () => new Date(EARLY.getTime() + 60 * 60 * 1000),
    });
    const reaped = await reaper.sweep();
    reaper.stop();
    expect(reaped).toBe(0);
    expect(uploadStore.get(row.uploadId)).not.toBeNull();
  });

  it("is idempotent on re-sweep", async () => {
    uploadStore.create("oci/a/svc", "sk_TEST");
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      now: () => LATE,
    });
    expect(await reaper.sweep()).toBe(1);
    expect(await reaper.sweep()).toBe(0);
    reaper.stop();
  });

  it("survives filesystem unlink errors without crashing", async () => {
    const row = uploadStore.create("oci/a/svc", "sk_TEST");
    // Don't create the tmp file — `delete` will silently no-op the missing
    // file and the SQL row will still be cleared.
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      now: () => LATE,
    });
    expect(await reaper.sweep()).toBe(1);
    reaper.stop();
    expect(uploadStore.get(row.uploadId)).toBeNull();
  });

  it("stop() is idempotent", () => {
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      now: () => LATE,
    });
    reaper.stop();
    reaper.stop();
  });

  it("sweep() after stop() returns 0", async () => {
    const reaper = startReaper({
      uploadStore,
      uploadFs,
      index: idx,
      intervalMs: 60 * 60 * 1000,
      now: () => LATE,
    });
    reaper.stop();
    expect(await reaper.sweep()).toBe(0);
  });
});
