/**
 * HTTP error mapping for `@signalman/registry`.
 *
 * Mirrors host/src/http/errors.ts: handlers throw HttpError (or a
 * domain RegistryError / SignatureVerificationError) and the
 * dispatcher resolves a status + JSON body. Keeping the mapping
 * centralized means routes don't sprinkle try/catch around every
 * storage call.
 */

import { SignatureVerificationError } from "../signing.js";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type RegistryErrorCode,
} from "../types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, code = "bad_request"): HttpError {
  return new HttpError(400, message, code);
}

export function unauthorized(
  message = "missing or invalid bearer token",
  code = "unauthorized",
): HttpError {
  return new HttpError(401, message, code);
}

export function forbidden(
  message = "forbidden",
  code = "forbidden",
): HttpError {
  return new HttpError(403, message, code);
}

export function notFound(message: string, code = "not_found"): HttpError {
  return new HttpError(404, message, code);
}

export function conflict(message: string, code = "conflict"): HttpError {
  return new HttpError(409, message, code);
}

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
  };
}

const REGISTRY_CODE_TO_STATUS: Record<RegistryErrorCode, number> = {
  [REGISTRY_ERROR_CODES.BAD_BLOB_REF]: 400,
  [REGISTRY_ERROR_CODES.BAD_MANIFEST]: 400,
  [REGISTRY_ERROR_CODES.BAD_NAME]: 400,
  [REGISTRY_ERROR_CODES.BAD_VERSION]: 400,
  [REGISTRY_ERROR_CODES.BAD_SHA256]: 400,
  [REGISTRY_ERROR_CODES.BLOB_NOT_FOUND]: 404,
  [REGISTRY_ERROR_CODES.MANIFEST_NOT_FOUND]: 404,
  [REGISTRY_ERROR_CODES.MANIFEST_EXISTS]: 409,
  [REGISTRY_ERROR_CODES.SIGNATURE_INVALID]: 422,
  [REGISTRY_ERROR_CODES.UNAUTHORIZED]: 401,
  [REGISTRY_ERROR_CODES.FORBIDDEN]: 403,
};

export function mapError(err: unknown): { status: number; body: HttpErrorBody } {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof RegistryError) {
    const status = REGISTRY_CODE_TO_STATUS[err.code] ?? 500;
    return {
      status,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof SignatureVerificationError) {
    return {
      status: 422,
      body: { error: { code: "signature_invalid", message: err.message } },
    };
  }
  // Log unhandled errors on the server, don't leak details to the
  // client. Stack output mirrors host/http/errors.ts behavior.
  process.stderr.write(
    `[registry] unhandled error: ${(err as Error).stack ?? String(err)}\n`,
  );
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "internal server error" } },
  };
}
