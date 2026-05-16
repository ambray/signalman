/**
 * OCI Distribution Spec v1.1 blob protocol — `/v2/<name>/blobs/*`.
 *
 * Route table mounted by `mountOciBlobRoutes`:
 *
 *   GET    /v2/*name/blobs/:digest                pull blob bytes
 *   HEAD   /v2/*name/blobs/:digest                existence + Docker-Content-Digest
 *   DELETE /v2/*name/blobs/:digest                delete blob (idempotent)
 *   POST   /v2/*name/blobs/uploads/               initiate upload session
 *   PATCH  /v2/*name/blobs/uploads/:uploadId      append chunk
 *   PUT    /v2/*name/blobs/uploads/:uploadId      finalize (?digest=<digest>)
 *
 * State machine for chunked uploads (spec §Pushing a Blob in Chunks):
 *
 *   POST                                          PATCH                          PUT
 *   ────────                                      ──────                         ───────
 *   create row + return                  ──→     validate Content-Range  ──→    hash assembled tmp file,
 *   { Location, Docker-Upload-UUID,              {start == bytesReceived}        verify against ?digest=,
 *     Range: 0-0 }                               append to tmp file,             promote into LocalFsBlobStore,
 *                                                update chunks_json + bytes,     delete pending row + tmp file,
 *                                                return 202 + new Range header   write audit-log row,
 *                                                                                return 201 + Location
 *
 * Per-route audit-log entries (Q-Audit per workstream prompt):
 *   POST  → none (no state change beyond opaque session)
 *   PATCH → none (in-progress state mutation, surfaced via reaper-side counter)
 *   PUT   → action='upload', entity_type='blob', entity_id=sha256
 *   DELETE → action='delete', entity_type='blob', entity_id=sha256
 *
 * Spec-compliant error envelope on every failure path. The route
 * handler catches `OciError` thrown by inner code and writes the
 * single-entry `{errors: [...]}` body with the spec-mapped status.
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { type RegistryStorage } from "../types.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { LocalFsBlobStore } from "../storage/local-fs.js";
import { OciError } from "./errors.js";
import { OCI_ERROR_CODES } from "./types.js";
import {
  ociManifestName,
  validateOciDigest,
  validateOciRepositoryName,
} from "./paths.js";
import {
  asOciError,
  contentRangeLength,
  parseContentRange,
  setDockerContentDigest,
  writeBlobCreated,
  writeOciError,
  writeUploadAccepted,
} from "./http.js";
import { UploadStore } from "./upload-store.js";
import { UploadFsStore, validateUploadId } from "./upload-fs.js";

export interface MountOciBlobOptions {
  storage: RegistryStorage;
  /** Required for upload state + audit log. */
  index: SqliteManifestIndex;
  /**
   * LocalFsBlobStore used by the upload-finalize path to promote
   * the assembled tmp file into the content-addressed store. M2
   * requires the local-fs driver; future S3-backed drivers will
   * stream upload bytes directly from the request body.
   */
  blobStore: LocalFsBlobStore;
  uploadStore: UploadStore;
  uploadFs: UploadFsStore;
  /** Public base URL — used in Location header composition. */
  publicBaseUrl?: string;
  /** Max single-chunk body. Default 5 GiB. */
  maxChunkBytes?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

const DEFAULT_MAX_CHUNK_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

interface ParsedRepository {
  org: string;
  repo: string;
  storageName: string;
}

/**
 * Validate the `*name` capture against the OCI per-org-namespaced
 * shape. Throws spec-canonical errors that the route wrapper maps
 * to the right status + envelope.
 */
function parseRepositoryParam(rawName: string): ParsedRepository {
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `<name> path parameter is required`,
    );
  }
  // Per Q1: the path under /v2/ is <org>/<repo>[/<sub>...]. Split at
  // the first `/` to get the org segment; the rest is the repo.
  const firstSlash = rawName.indexOf("/");
  if (firstSlash <= 0 || firstSlash === rawName.length - 1) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `<name> must include both an org and a repository segment`,
    );
  }
  const org = rawName.slice(0, firstSlash);
  const repo = rawName.slice(firstSlash + 1);
  validateOciRepositoryName(rawName);
  const storageName = ociManifestName(org, repo);
  return { org, repo, storageName };
}

export function mountOciBlobRoutes(router: Router, opts: MountOciBlobOptions): void {
  const storage = opts.storage;
  const index = opts.index;
  const blobStore = opts.blobStore;
  const uploadStore = opts.uploadStore;
  const uploadFs = opts.uploadFs;
  const maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const now = opts.now ?? (() => new Date());
  const baseUrl = opts.publicBaseUrl ?? "";

  // Order matters: register more-specific routes first. The router
  // walks `routes` in registration order and the first match wins.
  // `uploads/` routes must precede the generic `:digest` route so
  // a request to `/v2/<name>/blobs/uploads/` does not accidentally
  // match the digest route with digest='uploads' (the path's
  // trailing `/` actually prevents this collision because the digest
  // route has no trailing slash, but explicit ordering is documentation
  // for the reader).

  // ── POST /v2/<name>/blobs/uploads/ ──────────────────────────────
  router.post(
    "/v2/*name/blobs/uploads/",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const repo = parseRepositoryParam(ctx.params.name);
        await uploadFs.ensureDir();
        const row = uploadStore.create(
          repo.storageName,
          ctx.auth.tokenPrefix ?? "anonymous",
        );
        const location = `${baseUrl}/v2/${repo.org}/${repo.repo}/blobs/uploads/${row.uploadId}`;
        writeUploadAccepted(res, {
          location,
          uploadId: row.uploadId,
          bytesReceived: 0,
        });
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── PATCH /v2/<name>/blobs/uploads/:uploadId ────────────────────
  router.route(
    "PATCH",
    "/v2/*name/blobs/uploads/:uploadId",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const repo = parseRepositoryParam(ctx.params.name);
        validateUploadId(ctx.params.uploadId);
        const row = uploadStore.get(ctx.params.uploadId);
        if (!row) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN,
            `pending upload ${ctx.params.uploadId} unknown`,
          );
        }
        if (row.repository !== repo.storageName) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN,
            `pending upload ${ctx.params.uploadId} belongs to a different repository`,
          );
        }
        const range = parseContentRange(
          headerString(ctx.headers["content-range"]),
        );
        if (range.start !== row.bytesReceived) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
            `out-of-order chunk: Content-Range start ${range.start} != bytes_received ${row.bytesReceived}`,
            { expected_offset: row.bytesReceived, got: range.start },
          );
        }
        const expectedLength = contentRangeLength(range);
        if (!ctx.bodyStream) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
            `PATCH requires a request body`,
          );
        }
        const chunk = await readChunk(ctx.bodyStream);
        if (chunk.length !== expectedLength) {
          throw new OciError(
            OCI_ERROR_CODES.SIZE_INVALID,
            `body length ${chunk.length} does not match Content-Range length ${expectedLength}`,
          );
        }
        const newTotal = await uploadFs.appendBytes(row.uploadId, chunk);
        // Defensive: filesystem cursor should agree with our SQL math.
        if (newTotal !== row.bytesReceived + chunk.length) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
            `internal: tmp-file cursor diverged after append`,
          );
        }
        const sha256 = crypto.createHash("sha256").update(chunk).digest("hex");
        const updated = uploadStore.appendChunk(row.uploadId, {
          offset: range.start,
          length: chunk.length,
          sha256,
        });
        const location = `${baseUrl}/v2/${repo.org}/${repo.repo}/blobs/uploads/${row.uploadId}`;
        writeUploadAccepted(res, {
          location,
          uploadId: row.uploadId,
          bytesReceived: updated.bytesReceived,
        });
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true, streamBody: true, maxBodyBytes: maxChunkBytes },
  );

  // ── PUT /v2/<name>/blobs/uploads/:uploadId?digest=<digest> ──────
  router.put(
    "/v2/*name/blobs/uploads/:uploadId",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const repo = parseRepositoryParam(ctx.params.name);
        validateUploadId(ctx.params.uploadId);
        const row = uploadStore.get(ctx.params.uploadId);
        if (!row) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN,
            `pending upload ${ctx.params.uploadId} unknown`,
          );
        }
        if (row.repository !== repo.storageName) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN,
            `pending upload ${ctx.params.uploadId} belongs to a different repository`,
          );
        }
        const declaredDigest = headerString(ctx.query.digest);
        if (!declaredDigest) {
          throw new OciError(
            OCI_ERROR_CODES.DIGEST_INVALID,
            `PUT finalize requires the ?digest=<digest> query parameter`,
          );
        }
        const declaredHex = validateOciDigest(declaredDigest);

        // Spec allows a final chunk on the PUT. If a body is present
        // we append it just like a PATCH before hashing.
        if (ctx.bodyStream) {
          const range = headerString(ctx.headers["content-range"]);
          if (range !== undefined) {
            // Final chunk has the same out-of-order rule as PATCH.
            const parsed = parseContentRange(range);
            if (parsed.start !== row.bytesReceived) {
              throw new OciError(
                OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
                `out-of-order final chunk: Content-Range start ${parsed.start} != bytes_received ${row.bytesReceived}`,
              );
            }
            const expectedLength = contentRangeLength(parsed);
            const tail = await readChunk(ctx.bodyStream);
            if (tail.length !== expectedLength) {
              throw new OciError(
                OCI_ERROR_CODES.SIZE_INVALID,
                `final chunk body length ${tail.length} != Content-Range length ${expectedLength}`,
              );
            }
            if (tail.length > 0) {
              await uploadFs.appendBytes(row.uploadId, tail);
              const sha256Chunk = crypto.createHash("sha256").update(tail).digest("hex");
              uploadStore.appendChunk(row.uploadId, {
                offset: parsed.start,
                length: tail.length,
                sha256: sha256Chunk,
              });
            }
          } else {
            // No Content-Range — treat as "PATCH-then-PUT-collapse" pattern.
            // Spec says the final PUT MAY contain the closing bytes; we
            // accept them as a chunk at offset == bytes_received.
            const tail = await readChunk(ctx.bodyStream);
            if (tail.length > 0) {
              await uploadFs.appendBytes(row.uploadId, tail);
              const sha256Chunk = crypto.createHash("sha256").update(tail).digest("hex");
              uploadStore.appendChunk(row.uploadId, {
                offset: row.bytesReceived,
                length: tail.length,
                sha256: sha256Chunk,
              });
            }
          }
        }

        // Hash the assembled tmp file in one pass + verify against
        // the operator-declared digest. Mismatch is the spec-canonical
        // DIGEST_INVALID with no audit (no state change).
        const assembledHex = await uploadFs.hashAssembled(row.uploadId);
        if (assembledHex !== declaredHex) {
          throw new OciError(
            OCI_ERROR_CODES.DIGEST_INVALID,
            `assembled digest sha256:${assembledHex} does not match declared sha256:${declaredHex}`,
          );
        }

        await uploadFs.promoteToBlob(row.uploadId, assembledHex, blobStore, {
          contentType: "application/octet-stream",
          now,
        });
        // Mirror the SQL row so subsequent stat() calls hit it. The
        // storage layer's recordBlob is idempotent on conflict.
        const stat = await blobStore.statBlob(assembledHex);
        if (stat) index.recordBlob(stat);

        uploadStore.delete(row.uploadId);

        index.appendAuditEntry({
          action: "upload",
          entityType: "blob",
          entityId: assembledHex,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            kind: "oci",
            org: repo.org,
            repository: repo.repo,
            upload_id: row.uploadId,
            bytes: stat?.size ?? null,
          },
        });

        const location = `${baseUrl}/v2/${repo.org}/${repo.repo}/blobs/${declaredDigest}`;
        writeBlobCreated(res, { location, digest: declaredDigest });
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true, streamBody: true, maxBodyBytes: maxChunkBytes },
  );

  // ── GET /v2/<name>/blobs/<digest> ──────────────────────────────
  router.get(
    "/v2/*name/blobs/:digest",
    async (ctx) => {
      const res = ctx.res!;
      try {
        // Repository name is validated for consistency, but blobs are
        // a global content-addressed store at v0.4.0 — the spec also
        // says clients only need a name to address; the bytes are
        // sha-keyed once cached.
        validateOciRepositoryName(ctx.params.name);
        const hex = validateOciDigest(ctx.params.digest);
        const stat = await storage.statBlob(hex);
        if (!stat) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UNKNOWN,
            `blob ${ctx.params.digest} not found`,
          );
        }
        setDockerContentDigest(res, ctx.params.digest);
        res.setHeader("content-type", stat.contentType ?? "application/octet-stream");
        res.setHeader("content-length", String(stat.size));
        res.statusCode = 200;
        const stream = await storage.getBlob(hex);
        stream.pipe(res);
        await new Promise<void>((resolve, reject) => {
          stream.on("end", resolve);
          stream.on("error", reject);
          res.on("error", reject);
        });
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── HEAD /v2/<name>/blobs/<digest> ─────────────────────────────
  router.head(
    "/v2/*name/blobs/:digest",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateOciRepositoryName(ctx.params.name);
        const hex = validateOciDigest(ctx.params.digest);
        const stat = await storage.statBlob(hex);
        if (!stat) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UNKNOWN,
            `blob ${ctx.params.digest} not found`,
          );
        }
        setDockerContentDigest(res, ctx.params.digest);
        res.setHeader("content-type", stat.contentType ?? "application/octet-stream");
        res.setHeader("content-length", String(stat.size));
        res.statusCode = 200;
        res.end();
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── DELETE /v2/<name>/blobs/<digest> ───────────────────────────
  router.delete(
    "/v2/*name/blobs/:digest",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateOciRepositoryName(ctx.params.name);
        const hex = validateOciDigest(ctx.params.digest);
        // Spec says DELETE on an unknown digest returns 404; we
        // look it up first so the audit row only fires on actual
        // deletions.
        const stat = await storage.statBlob(hex);
        if (!stat) {
          throw new OciError(
            OCI_ERROR_CODES.BLOB_UNKNOWN,
            `blob ${ctx.params.digest} not found`,
          );
        }
        await blobStore.deleteBlob(hex);
        // Drop the SQLite blob-row mirror too so subsequent stat() is null.
        index.db.prepare("DELETE FROM blob WHERE sha256 = ?").run(hex);

        index.appendAuditEntry({
          action: "delete",
          entityType: "blob",
          entityId: hex,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            kind: "oci",
            repository: ctx.params.name,
          },
        });
        res.statusCode = 202;
        res.setHeader("content-length", "0");
        res.end();
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

/**
 * Read a request body into a Buffer with the supplied cap. The
 * upstream `capStreamBody` in the router already enforces the same
 * cap, but we re-read so we have the bytes in one place for hashing
 * + filesystem append.
 */
async function readChunk(stream: Readable): Promise<Buffer> {
  // The router's `capStreamBody` already enforces the per-route
  // `maxBodyBytes` cap and 413s with the standard error envelope
  // before this handler sees the stream, so this function just
  // accumulates.
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
