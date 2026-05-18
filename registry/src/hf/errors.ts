/**
 * HuggingFace facade error carrier + envelope helpers.
 *
 * Two response shapes:
 *
 *   - **HF-canonical 404 body** for missing-repo / missing-revision /
 *     missing-file on read-path routes (Q7 lock). `huggingface-cli`
 *     parses `{"error": "Repository not found"}` and emits the
 *     friendly message; emitting our generic envelope would break the
 *     CLI's user-visible diagnostic.
 *
 *   - **Generic JSON envelope** for everything else — same shape as
 *     PyPI / Maven / NuGet facades — so operator tooling can parse
 *     failures uniformly.
 *
 * Bearer-token redaction: when an `auth_header_template` is recorded
 * in any thrown error's detail block, we strip it before serialising
 * — the redactBearerToken helper here is what the audit + error paths
 * call.
 */

import type { ServerResponse } from "node:http";
import {
  HF_ERROR_CODES,
  type HfErrorCode,
  type HfErrorEnvelope,
} from "./types.js";

export class HfError extends Error {
  constructor(
    readonly code: HfErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "HfError";
  }
}

/**
 * Map an HfErrorCode to the canonical HTTP status. Cases that fall
 * through the explicit ones default to 400 (validation failures).
 */
export function hfErrorStatus(code: HfErrorCode): number {
  switch (code) {
    case HF_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case HF_ERROR_CODES.REPO_NOT_FOUND:
    case HF_ERROR_CODES.REVISION_NOT_FOUND:
    case HF_ERROR_CODES.FILE_NOT_FOUND:
    case HF_ERROR_CODES.BLOB_NOT_FOUND:
      return 404;
    case HF_ERROR_CODES.CONFLICT:
    case HF_ERROR_CODES.REVISION_EXISTS:
      return 409;
    case HF_ERROR_CODES.TOO_LARGE:
      return 413;
    case HF_ERROR_CODES.RANGE_INVALID:
      return 416;
    case HF_ERROR_CODES.LFS_UNSUPPORTED_OPERATION:
      return 422;
    case HF_ERROR_CODES.ORG_INVALID:
    case HF_ERROR_CODES.REPO_INVALID:
    case HF_ERROR_CODES.REPO_TYPE_INVALID:
    case HF_ERROR_CODES.REVISION_INVALID:
    case HF_ERROR_CODES.PATH_INVALID:
    case HF_ERROR_CODES.OID_INVALID:
    case HF_ERROR_CODES.LFS_BATCH_INVALID:
    case HF_ERROR_CODES.UPLOAD_INVALID:
      return 400;
  }
}

/**
 * 404 codes that emit the HF-canonical body. `huggingface-cli` reads
 * `error: 'Repository not found'` to print the friendly diagnostic;
 * we keep this carve-out aligned with the Q7 lock.
 */
const HF_CANONICAL_404_CODES = new Set<HfErrorCode>([
  HF_ERROR_CODES.REPO_NOT_FOUND,
  HF_ERROR_CODES.REVISION_NOT_FOUND,
  HF_ERROR_CODES.FILE_NOT_FOUND,
]);

export function toEnvelope(err: HfError): HfErrorEnvelope {
  return {
    errors: [
      {
        code: err.code,
        message: redactBearerToken(err.message),
        ...(err.detail !== undefined
          ? { detail: redactDetail(err.detail) }
          : {}),
      },
    ],
  };
}

/**
 * Emit the HF-canonical 404 body for the codes Q7 covers; everything
 * else gets the generic envelope.
 */
export function writeHfError(res: ServerResponse, err: HfError): void {
  if (res.headersSent) return;
  const status = hfErrorStatus(err.code);
  let body: string;
  if (HF_CANONICAL_404_CODES.has(err.code)) {
    body = JSON.stringify({ error: hfCanonical404Message(err.code) });
  } else {
    body = JSON.stringify(toEnvelope(err));
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

function hfCanonical404Message(code: HfErrorCode): string {
  switch (code) {
    case HF_ERROR_CODES.REPO_NOT_FOUND:
      return "Repository not found";
    case HF_ERROR_CODES.REVISION_NOT_FOUND:
      return "Revision not found";
    case HF_ERROR_CODES.FILE_NOT_FOUND:
      return "Entry not found";
    default:
      return "Not found";
  }
}

/**
 * Wrap any thrown value into an HfError. Unknown rejections become
 * `UPLOAD_INVALID` 400 to mirror the PyPI / Maven / NuGet pattern.
 */
export function asHfError(err: unknown): HfError {
  if (err instanceof HfError) return err;
  const msg = err instanceof Error ? err.message : "internal error";
  return new HfError(
    HF_ERROR_CODES.UPLOAD_INVALID,
    `internal: ${redactBearerToken(msg)}`,
  );
}

/**
 * Strip bearer tokens from a string so they never leak into error
 * responses or audit-log details. Catches the canonical
 * `Authorization: Bearer <token>` form and the looser
 * `Bearer <token>` form. The redaction is best-effort — if an
 * operator-supplied token doesn't look like a typical PAT (hex /
 * base64 / dot-separated JWT), the regex won't catch it. We err on
 * the side of redacting too much.
 */
export function redactBearerToken(s: string): string {
  return s.replace(
    /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
    "$1<redacted>",
  );
}

/**
 * Recursively walk a detail value, applying redactBearerToken to
 * strings and string fields known to carry Authorization headers.
 */
export function redactDetail(value: unknown): unknown {
  if (typeof value === "string") return redactBearerToken(value);
  if (Array.isArray(value)) return value.map(redactDetail);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase() === "authorization" || k === "auth_header_template") {
        out[k] = "<redacted>";
      } else {
        out[k] = redactDetail(v);
      }
    }
    return out;
  }
  return value;
}
