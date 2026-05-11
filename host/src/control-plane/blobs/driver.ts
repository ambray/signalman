/**
 * BlobDriver — content-addressed artifact blob store interface.
 *
 * Pluggable per docs/design/meta-build-system.md §5: local FS for
 * self-hosted (default), S3-compatible for hosted. Blobs are
 * content-addressed by sha256; the driver chooses the on-disk layout
 * (e.g. `${root}/${org_id}/${sha256[0:2]}/${sha256}` for local FS).
 *
 * Returned `uri` strings are opaque to callers — they are stored in
 * `artifact.blob_uri` and round-tripped through `get`/`presignGet`/
 * `delete`. The local FS driver returns `file://` URIs; the future S3
 * driver returns `s3://bucket/key`.
 *
 * The interface intentionally does NOT include a `list` method;
 * artifact metadata lives in the relational store. Blobs are storage,
 * not catalog.
 */

import type { Readable } from "node:stream";

export interface BlobMetadata {
  uri: string;
  sha256: string;
  size: number;
}

export interface BlobDriver {
  /** Upload a blob. Returns its content-addressed URI + computed hash. */
  put(input: {
    orgId: string;
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<BlobMetadata>;

  /** Open a read stream for a previously-stored blob. */
  get(uri: string): Promise<Readable>;

  /** Mint a presigned URL for direct client download. Local FS returns the file:// URI as-is. */
  presignGet(uri: string, ttlSeconds: number): Promise<string>;

  /** Delete a blob. Idempotent; missing blobs return without error. */
  delete(uri: string): Promise<void>;

  /** Existence check. */
  exists(uri: string): Promise<boolean>;
}

/** Thrown when a referenced blob URI is not present in the store. */
export class BlobNotFoundError extends Error {
  constructor(uri: string) {
    super(`blob not found: ${uri}`);
    this.name = "BlobNotFoundError";
  }
}
