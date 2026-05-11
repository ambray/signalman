/**
 * Local-filesystem implementation of BlobDriver.
 *
 * Layout: `${root}/${org_id}/${sha256[0:2]}/${sha256}`. Two-char prefix
 * keeps directory fan-out manageable. The `org_id` segment isolates
 * tenants on disk even though queries already scope by org — defense
 * in depth.
 *
 * URIs are `file://` URLs to the on-disk path. `presignGet` returns the
 * URI unchanged (no signing concept on a local filesystem); the future
 * S3 driver will replace this with a real presign.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BlobDriver, BlobMetadata } from "./driver.js";
import { BlobNotFoundError } from "./driver.js";

export interface LocalFsBlobOptions {
  /** Filesystem root for blobs. */
  root: string;
}

export class LocalFsBlobDriver implements BlobDriver {
  private readonly root: string;

  constructor(opts: LocalFsBlobOptions) {
    this.root = path.resolve(opts.root);
  }

  async put(input: {
    orgId: string;
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<BlobMetadata> {
    // Stream to a temp file while hashing, then rename into the
    // content-addressed final path. We don't know the sha256 until we
    // read the body, so we can't write directly to the final location.
    await fsp.mkdir(this.root, { recursive: true });
    const tmpName = `tmp-${crypto.randomBytes(8).toString("hex")}`;
    const tmpPath = path.join(this.root, tmpName);

    const hash = crypto.createHash("sha256");
    let size = 0;
    const source = Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body;
    const out = fs.createWriteStream(tmpPath);
    try {
      // Hash + size while streaming to disk in one pass.
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
    const finalPath = this.pathFor(input.orgId, sha256);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });

    // If the blob already exists with the same hash, drop the tmp file
    // and return the existing entry. Content-addressed dedupe.
    if (await this.fileExists(finalPath)) {
      await fsp.unlink(tmpPath).catch(() => undefined);
    } else {
      await fsp.rename(tmpPath, finalPath);
    }

    return {
      uri: pathToFileURL(finalPath).href,
      sha256,
      size,
    };
  }

  async get(uri: string): Promise<Readable> {
    const filePath = this.fileFromUri(uri);
    if (!(await this.fileExists(filePath))) {
      throw new BlobNotFoundError(uri);
    }
    return fs.createReadStream(filePath);
  }

  async presignGet(uri: string, _ttlSeconds: number): Promise<string> {
    // No signing on a local filesystem; return the URI as-is.
    if (!(await this.exists(uri))) {
      throw new BlobNotFoundError(uri);
    }
    return uri;
  }

  async delete(uri: string): Promise<void> {
    let filePath: string;
    try {
      filePath = this.fileFromUri(uri);
    } catch (err) {
      // delete() is idempotent — an unparseable or out-of-root URI is
      // already "not present" from this driver's perspective.
      if (err instanceof BlobNotFoundError) return;
      throw err;
    }
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") return;
      throw err;
    }
  }

  async exists(uri: string): Promise<boolean> {
    return this.fileExists(this.fileFromUri(uri));
  }

  // ── Internals ─────────────────────────────────────────────────────

  private pathFor(orgId: string, sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`invalid sha256: ${sha256}`);
    }
    if (orgId.includes("..") || orgId.includes("/") || orgId.includes("\\")) {
      throw new Error(`invalid org id: ${orgId}`);
    }
    return path.join(this.root, orgId, sha256.slice(0, 2), sha256);
  }

  private fileFromUri(uri: string): string {
    if (!uri.startsWith("file:")) {
      throw new BlobNotFoundError(uri);
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      // Malformed file URLs (e.g. missing drive letter on Windows)
      // surface as "not found" rather than ERR_INVALID_FILE_URL_PATH.
      throw new BlobNotFoundError(uri);
    }
    const resolved = path.resolve(filePath);
    // Confine to root — refuse path traversal via crafted URIs.
    const rootResolved = path.resolve(this.root);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      throw new BlobNotFoundError(uri);
    }
    return resolved;
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fsp.access(p, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
