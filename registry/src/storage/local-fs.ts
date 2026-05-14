/**
 * Local-filesystem blob storage for `@signalman/registry`.
 *
 * Ported from `host/src/control-plane/blobs/local-fs.ts`. Differences:
 *   - No per-org subdirectory. The registry is a single-namespace
 *     content-addressed store at v0.4.0; multi-tenant scoping lives
 *     at the manifest-catalog layer instead. (Federated bearer-token
 *     auth still scopes manifest reads/writes; blobs are global.)
 *   - Layout: `${root}/blobs/<sha[0:2]>/<sha>`. The two-char prefix
 *     keeps directory fan-out manageable on large stores.
 *   - Records a sidecar `<sha>.meta.json` so `statBlob` can report
 *     `createdAt` and `contentType` without walking the filesystem.
 *
 * Atomicity: writes go through a temp file in the root and rename
 * into place once the sha is computed. Dedupe is automatic — if a
 * blob with the same sha is already on disk, the temp file is
 * discarded.
 *
 * Path-traversal defense: `pathForSha` validates the sha via the
 * `validateSha256` helper; `getBlob` / `statBlob` only accept sha
 * inputs through that helper.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  validateSha256,
  type Blob,
} from "../types.js";

export interface LocalFsBlobStoreOptions {
  /** Filesystem root for blobs. Created on first write. */
  root: string;
  /**
   * Override the timestamp source — only used in tests so the
   * `createdAt` field is deterministic. Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

interface SidecarMetadata {
  createdAt: string;
  size: number;
  contentType?: string;
}

export class LocalFsBlobStore {
  readonly root: string;
  private readonly now: () => Date;

  constructor(opts: LocalFsBlobStoreOptions) {
    this.root = path.resolve(opts.root);
    this.now = opts.now ?? (() => new Date());
  }

  async putBlob(input: {
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<Blob> {
    const blobsDir = path.join(this.root, "blobs");
    await fsp.mkdir(blobsDir, { recursive: true });

    const tmpName = `tmp-${crypto.randomBytes(8).toString("hex")}`;
    const tmpPath = path.join(blobsDir, tmpName);
    const hash = crypto.createHash("sha256");
    let size = 0;

    const source = Buffer.isBuffer(input.body)
      ? Readable.from(input.body)
      : input.body;
    const out = fs.createWriteStream(tmpPath);
    try {
      await pipeline(
        source,
        async function* (src) {
          for await (const chunk of src) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buf);
            size += buf.length;
            yield buf;
          }
        },
        out,
      );
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    const sha256 = hash.digest("hex");
    const finalPath = this.pathForSha(sha256);
    const sidecarPath = `${finalPath}.meta.json`;
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });

    // Existing-sha → dedupe: drop the tmp file, return the stored
    // metadata so timestamps don't shift on re-put.
    const existing = await this.readSidecar(sidecarPath);
    if (existing) {
      await fsp.unlink(tmpPath).catch(() => undefined);
      return {
        sha256,
        size: existing.size,
        contentType: existing.contentType,
        createdAt: existing.createdAt,
      };
    }

    await fsp.rename(tmpPath, finalPath);
    const meta: SidecarMetadata = {
      createdAt: this.now().toISOString(),
      size,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    };
    await fsp.writeFile(sidecarPath, JSON.stringify(meta), "utf-8");
    return {
      sha256,
      size,
      contentType: meta.contentType,
      createdAt: meta.createdAt,
    };
  }

  async getBlob(sha256: string): Promise<Readable> {
    validateSha256(sha256);
    const filePath = this.pathForSha(sha256);
    if (!(await fileExists(filePath))) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BLOB_NOT_FOUND,
        `blob not found: ${sha256}`,
      );
    }
    return fs.createReadStream(filePath);
  }

  async statBlob(sha256: string): Promise<Blob | null> {
    validateSha256(sha256);
    const filePath = this.pathForSha(sha256);
    const sidecarPath = `${filePath}.meta.json`;
    if (!(await fileExists(filePath))) return null;
    const meta = await this.readSidecar(sidecarPath);
    if (meta) {
      return {
        sha256,
        size: meta.size,
        contentType: meta.contentType,
        createdAt: meta.createdAt,
      };
    }
    // Sidecar missing (e.g. corrupted store) — fall back to stat()
    // and return without contentType. We do NOT synthesize createdAt
    // from filesystem mtime because that's unstable on copy/restore.
    const stat = await fsp.stat(filePath);
    return {
      sha256,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
    };
  }

  async deleteBlob(sha256: string): Promise<void> {
    validateSha256(sha256);
    const filePath = this.pathForSha(sha256);
    const sidecarPath = `${filePath}.meta.json`;
    await fsp.unlink(filePath).catch(() => undefined);
    await fsp.unlink(sidecarPath).catch(() => undefined);
  }

  pathForSha(sha256: string): string {
    validateSha256(sha256);
    return path.join(this.root, "blobs", sha256.slice(0, 2), sha256);
  }

  private async readSidecar(
    sidecarPath: string,
  ): Promise<SidecarMetadata | null> {
    try {
      const raw = await fsp.readFile(sidecarPath, "utf-8");
      const parsed = JSON.parse(raw) as SidecarMetadata;
      if (
        typeof parsed.createdAt === "string" &&
        typeof parsed.size === "number"
      ) {
        return parsed;
      }
      return null;
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") return null;
      throw err;
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
