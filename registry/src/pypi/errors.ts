/**
 * PyPI error carrier + envelope helpers. PyPI doesn't standardise an
 * error envelope shape the way OCI does — the legacy upload endpoint
 * historically returns plain-text errors with `X-Request-Id` headers,
 * and PEP 691 only specifies success responses. We emit a small JSON
 * envelope on 4XX/5XX for operator-tooling friendliness; pip itself
 * just reads status codes.
 */

import type { ServerResponse } from "node:http";
import { PYPI_ERROR_CODES, type PypiErrorCode, type PypiErrorEnvelope } from "./types.js";

export class PypiError extends Error {
  constructor(
    readonly code: PypiErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PypiError";
  }
}

/**
 * Map a PypiError to the right HTTP status. PyPI doesn't lock these
 * down (it varies per Warehouse endpoint), so we pick the canonical
 * meaning for each code.
 */
export function pypiErrorStatus(code: PypiErrorCode): number {
  switch (code) {
    case PYPI_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case PYPI_ERROR_CODES.PACKAGE_NOT_FOUND:
    case PYPI_ERROR_CODES.FILE_NOT_FOUND:
      return 404;
    case PYPI_ERROR_CODES.CONFLICT:
      return 409;
    case PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE:
      return 415;
    case PYPI_ERROR_CODES.NAME_INVALID:
    case PYPI_ERROR_CODES.VERSION_INVALID:
    case PYPI_ERROR_CODES.FILENAME_INVALID:
    case PYPI_ERROR_CODES.DIGEST_INVALID:
    case PYPI_ERROR_CODES.DIGEST_MISMATCH:
    case PYPI_ERROR_CODES.UPLOAD_INVALID:
      return 400;
  }
}

export function toEnvelope(err: PypiError): PypiErrorEnvelope {
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

export function writePypiError(res: ServerResponse, err: PypiError): void {
  if (res.headersSent) return;
  const status = pypiErrorStatus(err.code);
  const body = JSON.stringify(toEnvelope(err));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

/**
 * Wrap any thrown value into a PypiError. Unknown rejections become
 * `UPLOAD_INVALID` 400 (matching legacy Warehouse behaviour for
 * unexpected upload failures).
 */
export function asPypiError(err: unknown): PypiError {
  if (err instanceof PypiError) return err;
  const msg = err instanceof Error ? err.message : "internal error";
  return new PypiError(PYPI_ERROR_CODES.UPLOAD_INVALID, `internal: ${msg}`);
}
