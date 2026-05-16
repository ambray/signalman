/**
 * Filesystem-side state for chunked blob uploads.
 *
 * Each pending upload session has a tmp file at
 * `<root>/uploads/<upload_id>`. The first PATCH creates the file;
 * subsequent PATCHes append; the PUT finalize hashes the assembled
 * bytes + atomically renames into the content-addressed blob store
 * at `<root>/blobs/<sha[0:2]>/<sha>` via `LocalFsBlobStore.putBlob`
 * (or the more efficient `promoteUploadFile` shortcut when the
 * caller has the sha already).
 *
 * The reaper sweeps both the SQL row + this tmp file as a pair so
 * the two halves of "pending upload" never desync.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { LocalFsBlobStore } from "../storage/local-fs.js";

export interface UploadFsStoreOptions {
  /** Same root the LocalFsBlobStore uses. */
  root: string;
}

/**
 * Filesystem-only handle on `<root>/uploads/`. Composes with the
 * SQL-side `UploadStore` to form the full state machine.
 */
export class UploadFsStore {
  readonly uploadsDir: string;
  private readonly blobsRoot: string;

  constructor(opts: UploadFsStoreOptions) {
    const resolvedRoot = path.resolve(opts.root);
    this.blobsRoot = resolvedRoot;
    this.uploadsDir = path.join(resolvedRoot, "uploads");
  }

  /** Ensure the uploads tmp directory exists. Idempotent. */
  async ensureDir(): Promise<void> {
    await fsp.mkdir(this.uploadsDir, { recursive: true });
  }

  /** Path to the tmp file for a given upload id. */
  pathFor(uploadId: string): string {
    validateUploadId(uploadId);
    return path.join(this.uploadsDir, uploadId);
  }

  /**
   * Append bytes to the upload's tmp file. Creates the file when it
   * doesn't exist yet (idempotent first-chunk path). Returns the
   * total bytes now on disk for the upload.
   */
  async appendBytes(uploadId: string, bytes: Buffer): Promise<number> {
    await this.ensureDir();
    const target = this.pathFor(uploadId);
    const fd = await fsp.open(target, "a");
    try {
      await fd.appendFile(bytes);
    } finally {
      await fd.close();
    }
    const stat = await fsp.stat(target);
    return stat.size;
  }

  /**
   * Read the assembled bytes back. Used by the finalize path to
   * compute the sha256 over the whole blob.
   */
  async readAssembled(uploadId: string): Promise<Buffer> {
    const target = this.pathFor(uploadId);
    return fsp.readFile(target);
  }

  /** Stat the tmp file. Returns null when absent. */
  async stat(uploadId: string): Promise<{ size: number } | null> {
    const target = this.pathFor(uploadId);
    try {
      const s = await fsp.stat(target);
      return { size: s.size };
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Delete the tmp file for an upload. Idempotent — missing file
   * is a no-op. Called on PUT finalize after the blob has been
   * promoted into the content-addressed store, and by the reaper
   * for expired uploads.
   */
  async delete(uploadId: string): Promise<void> {
    const target = this.pathFor(uploadId);
    await fsp.unlink(target).catch(() => undefined);
  }

  /**
   * Atomically promote a tmp file into the content-addressed blob
   * store. Computes nothing — caller has already verified the sha
   * against the spec-mandated `?digest=` query param. Writes the
   * sidecar metadata so `statBlob` works.
   *
   * Returns the storage path on disk so callers can audit-log it.
   */
  async promoteToBlob(
    uploadId: string,
    sha256: string,
    blobStore: LocalFsBlobStore,
    opts: { contentType?: string; now: () => Date },
  ): Promise<{ size: number }> {
    const src = this.pathFor(uploadId);
    const dest = blobStore.pathForSha(sha256);
    const sidecar = `${dest}.meta.json`;
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    // Dedupe: if the destination already exists, the bytes are
    // identical-by-content-address. Drop the tmp file and reuse
    // the existing sidecar's timestamps.
    try {
      const existing = await fsp.readFile(sidecar, "utf-8");
      const parsed = JSON.parse(existing) as { size: number };
      await fsp.unlink(src).catch(() => undefined);
      return { size: parsed.size };
    } catch (err) {
      const e = err as { code?: string };
      if (e.code !== "ENOENT") throw err;
    }

    const stat = await fsp.stat(src);
    await fsp.rename(src, dest);
    const sidecarBody: Record<string, unknown> = {
      createdAt: opts.now().toISOString(),
      size: stat.size,
    };
    if (opts.contentType) sidecarBody.contentType = opts.contentType;
    await fsp.writeFile(sidecar, JSON.stringify(sidecarBody), "utf-8");
    return { size: stat.size };
  }

  /**
   * Compute the sha256 of the assembled tmp file in one pass. Used
   * by the finalize handler to validate against the operator-supplied
   * `?digest=` query parameter before promotion.
   */
  async hashAssembled(uploadId: string): Promise<string> {
    const target = this.pathFor(uploadId);
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(target);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }
}

/**
 * Upload-id shape gate. Mirrors `crypto.randomBytes(16).toString("hex")`
 * — exactly 32 lowercase hex chars. Any other shape gets a stub-out
 * to defend against path traversal (`..`, slashes, null bytes).
 *
 * Exported so the route handler can mirror the same check before
 * the SQL lookup, avoiding an unnecessary database round-trip on
 * obviously-malformed inputs.
 */
export function validateUploadId(uploadId: string): void {
  if (typeof uploadId !== "string" || !/^[a-f0-9]{32}$/.test(uploadId)) {
    throw new Error(`invalid upload id: ${truncate(uploadId)}`);
  }
}

function truncate(s: unknown): string {
  if (typeof s !== "string") return String(s);
  return s.length > 48 ? `${s.slice(0, 48)}...` : s;
}
