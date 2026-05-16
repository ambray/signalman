/**
 * HTTP helpers shared across the OCI route handlers.
 *
 * Two responsibilities:
 *   1. Translate `OciError` thrown by inner handlers into the
 *      spec-mandated `OciErrorEnvelope` JSON body plus the right
 *      status code (see `./errors.ts ociErrorStatus`).
 *   2. Parse + validate spec-prescribed headers — `Content-Range`
 *      for chunked PATCH uploads, `Docker-Content-Digest` set on
 *      successful responses.
 *
 * All response-writing helpers operate on the raw `http.ServerResponse`
 * because the router's `rawResponse: true` flag is needed for the
 * binary blob streaming path; once a handler opts into raw responses
 * it owns the wire format entirely.
 */

import type { ServerResponse } from "node:http";
import { OciError, ociErrorStatus, toEnvelope } from "./errors.js";
import { OCI_ERROR_CODES } from "./types.js";

/**
 * Write an `OciError` as a spec-compliant 4XX JSON response. Safe
 * to call even after some headers have been set; checks
 * `headersSent` first.
 */
export function writeOciError(res: ServerResponse, err: OciError): void {
  if (res.headersSent) return;
  const status = ociErrorStatus(err.code);
  const body = JSON.stringify(toEnvelope(err));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

/**
 * Wrap an arbitrary thrown value into an `OciError`. Useful at the
 * top of each handler — unknown rejections (programmer errors, I/O
 * failures) get the spec's `UNSUPPORTED` code with a generic message
 * rather than leaking stack traces.
 */
export function asOciError(err: unknown): OciError {
  if (err instanceof OciError) return err;
  const msg = err instanceof Error ? err.message : "internal error";
  return new OciError(OCI_ERROR_CODES.UNSUPPORTED, `internal: ${msg}`);
}

// ── Content-Range parsing (per spec §Pushing a Blob in Chunks) ─────

export interface ContentRange {
  start: number;
  end: number;
}

/**
 * Spec-mandated regex from §Pushing a Blob in Chunks:
 *   "Content-Range <range>" MUST match ^[0-9]+-[0-9]+$
 *
 * The header value is INCLUSIVE on both ends: `0-499` describes
 * 500 bytes covering offsets [0..499]. Used in PATCH bodies and
 * (optionally) on the final PUT chunk.
 */
const CONTENT_RANGE_RE = /^([0-9]+)-([0-9]+)$/;

/**
 * Parse a `Content-Range` header value. Returns `{ start, end }`
 * inclusive when valid; throws `OciError(BLOB_UPLOAD_INVALID)` on
 * any malformed shape so the HTTP layer surfaces 416 to the client.
 */
export function parseContentRange(value: string | undefined): ContentRange {
  if (typeof value !== "string" || value.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
      "Content-Range header is required for chunked PATCH",
    );
  }
  const m = CONTENT_RANGE_RE.exec(value);
  if (!m) {
    throw new OciError(
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
      `Content-Range '${value}' does not match the OCI grammar '<start>-<end>'`,
    );
  }
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new OciError(
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
      `Content-Range '${value}' contains unsafe integers`,
    );
  }
  if (end < start) {
    throw new OciError(
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
      `Content-Range '${value}' has end < start`,
    );
  }
  return { start, end };
}

/**
 * Compute the byte length described by a Content-Range. Spec says
 * the range is inclusive on both ends so length is `end - start + 1`.
 */
export function contentRangeLength(range: ContentRange): number {
  return range.end - range.start + 1;
}

// ── Spec headers helper ───────────────────────────────────────────

/**
 * Set the `Docker-Content-Digest` response header. Required on every
 * successful manifest GET / HEAD / PUT and every successful blob GET
 * / HEAD per the spec. Idempotent (overwrites prior value).
 */
export function setDockerContentDigest(
  res: ServerResponse,
  digest: string,
): void {
  res.setHeader("Docker-Content-Digest", digest);
}

/**
 * Write an empty 202 Accepted with the upload-session headers Docker
 * + crane expect (Location, Range, Docker-Upload-UUID). Used by POST
 * initiate + PATCH append responses.
 */
export function writeUploadAccepted(
  res: ServerResponse,
  opts: { location: string; uploadId: string; bytesReceived: number },
): void {
  if (res.headersSent) return;
  res.statusCode = 202;
  res.setHeader("Location", opts.location);
  res.setHeader("Docker-Upload-UUID", opts.uploadId);
  // Spec §Pushing a Blob in Chunks: the Range response header carries
  // the inclusive byte range now stored on the server. `0-0` when no
  // bytes have arrived yet.
  res.setHeader(
    "Range",
    opts.bytesReceived === 0 ? "0-0" : `0-${opts.bytesReceived - 1}`,
  );
  res.setHeader("content-length", "0");
  res.end();
}

/**
 * Write a 201 Created for a successful blob finalize.
 * Spec-mandated headers: Location, Docker-Content-Digest.
 */
export function writeBlobCreated(
  res: ServerResponse,
  opts: { location: string; digest: string },
): void {
  if (res.headersSent) return;
  res.statusCode = 201;
  res.setHeader("Location", opts.location);
  setDockerContentDigest(res, opts.digest);
  res.setHeader("content-length", "0");
  res.end();
}
