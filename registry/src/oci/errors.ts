/**
 * OCI Distribution Spec error envelope + carrier.
 *
 * Every 4XX response from a `/v2/*` route returns the spec-mandated
 * JSON envelope (`OciErrorEnvelope` in `./types.ts`). `OciError` is
 * the in-process exception that handlers throw; the HTTP layer maps
 * each instance into a single-entry envelope with the right status
 * code.
 *
 * Status-code mapping follows the spec's per-code conventions:
 *   - 401 UNAUTHORIZED — auth required (precedes the bearer challenge)
 *   - 403 DENIED — auth supplied but lacks scope
 *   - 404 NAME_UNKNOWN / MANIFEST_UNKNOWN / BLOB_UNKNOWN / BLOB_UPLOAD_UNKNOWN
 *   - 405 UNSUPPORTED — operation disabled by operator config (e.g. manifest DELETE)
 *   - 416 BLOB_UPLOAD_INVALID — chunk out-of-order or invalid Content-Range
 *   - 429 TOOMANYREQUESTS — rate-limited
 *   - 400 everything else (NAME_INVALID, DIGEST_INVALID, MANIFEST_INVALID, SIZE_INVALID)
 */

import { OCI_ERROR_CODES, type OciErrorCode, type OciErrorEnvelope } from "./types.js";

export class OciError extends Error {
  constructor(
    readonly code: OciErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "OciError";
  }
}

/**
 * Map an `OciError` to its spec-conformant HTTP status code.
 *
 * Operators reading code can grep for the constant on the right
 * side; the spec's "appropriate 4XX response code" language defers
 * to implementations, so this table is the registry's contract with
 * clients.
 */
export function ociErrorStatus(code: OciErrorCode): number {
  switch (code) {
    case OCI_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case OCI_ERROR_CODES.DENIED:
      return 403;
    case OCI_ERROR_CODES.NAME_UNKNOWN:
    case OCI_ERROR_CODES.MANIFEST_UNKNOWN:
    case OCI_ERROR_CODES.BLOB_UNKNOWN:
    case OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN:
      return 404;
    case OCI_ERROR_CODES.UNSUPPORTED:
      return 405;
    case OCI_ERROR_CODES.BLOB_UPLOAD_INVALID:
      return 416;
    case OCI_ERROR_CODES.TOOMANYREQUESTS:
      return 429;
    case OCI_ERROR_CODES.NAME_INVALID:
    case OCI_ERROR_CODES.DIGEST_INVALID:
    case OCI_ERROR_CODES.MANIFEST_INVALID:
    case OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN:
    case OCI_ERROR_CODES.SIZE_INVALID:
      return 400;
  }
}

/**
 * Build the spec-mandated single-entry envelope from one `OciError`.
 * Detail is only populated when non-undefined to keep the wire
 * payload compact for the common case.
 */
export function toEnvelope(err: OciError): OciErrorEnvelope {
  return {
    errors: [
      {
        code: err.code,
        message: err.message,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      },
    ],
  };
}

/**
 * Build a multi-error envelope. Most error sites only emit one error,
 * but manifest validation surfaces several (e.g. several missing
 * referenced blobs). Caller composes the array.
 */
export function envelope(errors: OciError[]): OciErrorEnvelope {
  return {
    errors: errors.map((e) => ({
      code: e.code,
      message: e.message,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    })),
  };
}

/**
 * The maximum HTTP status across a set of OciErrors — used when a
 * multi-error envelope needs a single response code (e.g. on
 * manifest PUT with several validation failures). Picks the highest
 * spec-mapped status so the most severe error wins (NAME_UNKNOWN
 * 404 beats NAME_INVALID 400 etc.).
 */
export function maxStatus(errors: OciError[]): number {
  let max = 400;
  for (const e of errors) {
    const s = ociErrorStatus(e.code);
    if (s > max) max = s;
  }
  return max;
}
