/**
 * S3-compatible implementation of BlobDriver.
 *
 * v0.3.0 design choices:
 *   * **Buffer-then-PUT.** The body is drained to a Buffer before
 *     upload so we can compute sha256 in one pass and PUT to the
 *     final content-addressed key directly. Costs RAM for large
 *     artifacts (typical MSI / tarball under 100 MB is fine); a
 *     streaming `PUT temp → server-side COPY → DELETE temp` path
 *     is left for v0.3.x when artifacts grow beyond ~1 GB.
 *   * **Org-scoped keys.** Layout: `${prefix}${orgId}/${sha[0:2]}/${sha}`.
 *     Same logic as the local-FS driver; key collisions across orgs
 *     are physically impossible (different prefix segment) even when
 *     two orgs upload identical content.
 *   * **Presign for download.** `presignGet` returns a real HTTPS
 *     presigned URL via `@aws-sdk/s3-request-presigner`; clients hit
 *     S3 directly rather than streaming through the control plane.
 *   * **DI-friendly.** Takes an `S3Client` so tests can pass a
 *     mocked client; production constructs a default client from
 *     region + creds via the standard AWS chain.
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { buffer as readToBuffer } from "node:stream/consumers";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobDriver, BlobMetadata } from "./driver.js";
import { BlobNotFoundError } from "./driver.js";

export interface S3BlobOptions {
  /**
   * Bucket name. Required.
   */
  bucket: string;
  /**
   * Optional key prefix inside the bucket (e.g. `signalman-v0.3.0/`).
   * Default: empty. Trailing slash recommended for readability but
   * not required.
   */
  prefix?: string;
  /**
   * Optional pre-built S3Client. If omitted, one is constructed from
   * `clientConfig`.
   */
  client?: S3Client;
  /**
   * S3 client config (region, credentials, endpoint, etc.). Forwarded
   * to `new S3Client(...)` when `client` is not supplied. Defaults to
   * SDK chain (env vars, IMDS, etc.) when omitted entirely.
   */
  clientConfig?: S3ClientConfig;
}

export class S3BlobDriver implements BlobDriver {
  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BlobOptions) {
    if (!opts.bucket) {
      throw new Error("S3BlobDriver: bucket is required");
    }
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "";
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else {
      this.client = new S3Client(opts.clientConfig ?? {});
      this.ownsClient = true;
    }
  }

  async put(input: {
    orgId: string;
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<BlobMetadata> {
    this.validateOrgId(input.orgId);
    // v0.3.0: buffer-then-PUT. Streaming with server-side COPY is
    // the v0.3.x upgrade for artifacts that exceed a runner's RAM.
    const buf = Buffer.isBuffer(input.body)
      ? input.body
      : await readToBuffer(input.body);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const key = this.keyFor(input.orgId, sha256);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buf,
        ContentType: input.contentType,
        // Content-addressed → if the key already exists with the same
        // content, S3 happily overwrites (it's a no-op for content
        // identity). No conditional-put needed.
      }),
    );
    return {
      uri: this.uriFor(key),
      sha256,
      size: buf.length,
    };
  }

  async get(uri: string): Promise<Readable> {
    const key = this.keyFromUri(uri);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) {
        throw new BlobNotFoundError(uri);
      }
      // SDK v3 returns Body as a SdkStream which extends Readable on
      // Node; cast accordingly.
      return res.Body as unknown as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new BlobNotFoundError(uri);
      throw err;
    }
  }

  async presignGet(uri: string, ttlSeconds: number): Promise<string> {
    const key = this.keyFromUri(uri);
    // Confirm the object exists before minting a presigned URL —
    // operators expect "no such blob" to be a 404, not a working URL
    // that fails at download time.
    if (!(await this.exists(uri))) {
      throw new BlobNotFoundError(uri);
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: Math.max(1, Math.floor(ttlSeconds)) },
    );
  }

  async delete(uri: string): Promise<void> {
    let key: string;
    try {
      key = this.keyFromUri(uri);
    } catch (err) {
      // Malformed or out-of-bucket URI → idempotent no-op (matches
      // the local-FS driver's delete-on-unknown semantics).
      if (err instanceof BlobNotFoundError) return;
      throw err;
    }
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      // S3 DELETE is idempotent — missing object returns success on
      // most stacks. If we see a 404 anyway, treat it as success.
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async exists(uri: string): Promise<boolean> {
    let key: string;
    try {
      key = this.keyFromUri(uri);
    } catch {
      return false;
    }
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  resolveBySha(orgId: string, sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`invalid sha256: ${sha256}`);
    }
    this.validateOrgId(orgId);
    return this.uriFor(this.keyFor(orgId, sha256));
  }

  /** Close the underlying client. Safe to call repeatedly. */
  destroy(): void {
    if (this.ownsClient) {
      this.client.destroy();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private keyFor(orgId: string, sha256: string): string {
    return `${this.prefix}${orgId}/${sha256.slice(0, 2)}/${sha256}`;
  }

  private uriFor(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  private keyFromUri(uri: string): string {
    if (!uri.startsWith("s3://")) {
      throw new BlobNotFoundError(uri);
    }
    const rest = uri.slice("s3://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      throw new BlobNotFoundError(uri);
    }
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    if (bucket !== this.bucket) {
      // Different bucket → not ours to serve. Surface as not-found
      // rather than leaking which other buckets exist.
      throw new BlobNotFoundError(uri);
    }
    if (this.prefix && !key.startsWith(this.prefix)) {
      throw new BlobNotFoundError(uri);
    }
    return key;
  }

  private validateOrgId(orgId: string): void {
    if (orgId.includes("..") || orgId.includes("/") || orgId.includes("\\")) {
      throw new Error(`invalid org id: ${orgId}`);
    }
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.$metadata?.httpStatusCode === 404) return true;
  if (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchBucket"
  ) {
    return true;
  }
  return false;
}
