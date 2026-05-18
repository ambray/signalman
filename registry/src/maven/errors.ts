/**
 * Maven error carrier + envelope helpers. Maven over HTTP just uses
 * status codes; we emit a small JSON body on 4XX for operator
 * tooling, mirroring the PyPI facade. Maven + Gradle ignore the
 * body and only read the status.
 */

import type { ServerResponse } from "node:http";
import { MAVEN_ERROR_CODES, type MavenErrorCode, type MavenErrorEnvelope } from "./types.js";

export class MavenError extends Error {
  constructor(
    readonly code: MavenErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "MavenError";
  }
}

/**
 * Map a MavenError to the canonical HTTP status for that condition.
 *
 *   - 401 — UNAUTHORIZED.
 *   - 404 — ARTIFACT_NOT_FOUND / METADATA_NOT_FOUND.
 *   - 409 — CONFLICT (overwrite of an already-published release).
 *   - 422 — SNAPSHOT_REFUSED (the policy explicitly refused the
 *           snapshot; clients can map this to a friendlier error).
 *   - 400 — everything else (validation failures).
 */
export function mavenErrorStatus(code: MavenErrorCode): number {
  switch (code) {
    case MAVEN_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND:
    case MAVEN_ERROR_CODES.METADATA_NOT_FOUND:
      return 404;
    case MAVEN_ERROR_CODES.CONFLICT:
      return 409;
    case MAVEN_ERROR_CODES.SNAPSHOT_REFUSED:
      return 422;
    case MAVEN_ERROR_CODES.COORDINATE_INVALID:
    case MAVEN_ERROR_CODES.GROUP_INVALID:
    case MAVEN_ERROR_CODES.ARTIFACT_INVALID:
    case MAVEN_ERROR_CODES.VERSION_INVALID:
    case MAVEN_ERROR_CODES.FILENAME_INVALID:
    case MAVEN_ERROR_CODES.EXTENSION_INVALID:
    case MAVEN_ERROR_CODES.CLASSIFIER_INVALID:
    case MAVEN_ERROR_CODES.UPLOAD_INVALID:
      return 400;
  }
}

export function toEnvelope(err: MavenError): MavenErrorEnvelope {
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

export function writeMavenError(res: ServerResponse, err: MavenError): void {
  if (res.headersSent) return;
  const status = mavenErrorStatus(err.code);
  const body = JSON.stringify(toEnvelope(err));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

/**
 * Wrap any thrown value into a MavenError. Unknown rejections become
 * `UPLOAD_INVALID` 400.
 */
export function asMavenError(err: unknown): MavenError {
  if (err instanceof MavenError) return err;
  const msg = err instanceof Error ? err.message : "internal error";
  return new MavenError(MAVEN_ERROR_CODES.UPLOAD_INVALID, `internal: ${msg}`);
}
