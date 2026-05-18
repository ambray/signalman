/**
 * NuGet error carrier + envelope helpers. NuGet over HTTP just uses
 * status codes; we emit a small JSON envelope on 4XX/5XX for
 * operator tooling, mirroring the Maven + PyPI facades. `dotnet`
 * ignores the body and only reads the status.
 */

import type { ServerResponse } from "node:http";
import {
  NUGET_ERROR_CODES,
  type NugetErrorCode,
  type NugetErrorEnvelope,
} from "./types.js";

export class NugetError extends Error {
  constructor(
    readonly code: NugetErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "NugetError";
  }
}

/**
 * Map a NugetError to the canonical HTTP status for that condition.
 *
 *   - 401 — UNAUTHORIZED.
 *   - 404 — PACKAGE_NOT_FOUND / VERSION_NOT_FOUND / RESOURCE_NOT_FOUND.
 *   - 409 — CONFLICT (overwrite of an already-published version).
 *   - 400 — everything else (validation failures).
 */
export function nugetErrorStatus(code: NugetErrorCode): number {
  switch (code) {
    case NUGET_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case NUGET_ERROR_CODES.PACKAGE_NOT_FOUND:
    case NUGET_ERROR_CODES.VERSION_NOT_FOUND:
    case NUGET_ERROR_CODES.RESOURCE_NOT_FOUND:
      return 404;
    case NUGET_ERROR_CODES.CONFLICT:
      return 409;
    case NUGET_ERROR_CODES.PACKAGE_ID_INVALID:
    case NUGET_ERROR_CODES.VERSION_INVALID:
    case NUGET_ERROR_CODES.UPLOAD_INVALID:
    case NUGET_ERROR_CODES.NUPKG_INVALID:
    case NUGET_ERROR_CODES.NUSPEC_INVALID:
      return 400;
  }
}

export function toEnvelope(err: NugetError): NugetErrorEnvelope {
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

export function writeNugetError(res: ServerResponse, err: NugetError): void {
  if (res.headersSent) return;
  const status = nugetErrorStatus(err.code);
  const body = JSON.stringify(toEnvelope(err));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

/**
 * Wrap any thrown value into a NugetError. Unknown rejections become
 * `UPLOAD_INVALID` 400 — same pattern as the Maven + PyPI facades.
 */
export function asNugetError(err: unknown): NugetError {
  if (err instanceof NugetError) return err;
  const msg = err instanceof Error ? err.message : "internal error";
  return new NugetError(NUGET_ERROR_CODES.UPLOAD_INVALID, `internal: ${msg}`);
}
