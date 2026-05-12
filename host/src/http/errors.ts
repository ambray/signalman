/**
 * HTTP error types + mapping from control-plane domain errors to HTTP
 * status codes.
 *
 * Handlers throw HttpError (or a domain error from storage/deploy/etc.)
 * and the dispatcher resolves a status + JSON body. Keeping the
 * mapping centralized means routes don't sprinkle try/catch around
 * every repo call.
 */

import {
  StorageConflictError,
  StorageNotFoundError,
} from "../control-plane/storage/index.js";
import { BlobNotFoundError } from "../control-plane/blobs/index.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFound(message: string, code = "not_found"): HttpError {
  return new HttpError(404, message, code);
}

export function badRequest(message: string, code = "bad_request"): HttpError {
  return new HttpError(400, message, code);
}

export function conflict(message: string, code = "conflict"): HttpError {
  return new HttpError(409, message, code);
}

export function unauthorized(
  message = "missing or invalid bearer token",
  code = "unauthorized",
): HttpError {
  return new HttpError(401, message, code);
}

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Map any thrown value to an HTTP status + JSON body. */
export function mapError(err: unknown): { status: number; body: HttpErrorBody } {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { code: err.code ?? "error", message: err.message } },
    };
  }
  if (err instanceof StorageNotFoundError || err instanceof BlobNotFoundError) {
    return {
      status: 404,
      body: { error: { code: "not_found", message: (err as Error).message } },
    };
  }
  if (err instanceof StorageConflictError) {
    return {
      status: 409,
      body: { error: { code: "conflict", message: err.message } },
    };
  }
  // Domain errors with a `name` we recognize.
  const e = err as Error & { name?: string };
  if (e.name) {
    switch (e.name) {
      case "BuildYamlValidationError":
      case "RepoUrlValidationError":
      case "GitRefValidationError":
        return {
          status: 400,
          body: { error: { code: "validation_error", message: e.message } },
        };
      case "ReleaseAlreadyExistsError":
        return {
          status: 409,
          body: { error: { code: "release_exists", message: e.message } },
        };
      case "ComponentBuildError":
      case "MissingArtifactError":
        return {
          status: 422,
          body: { error: { code: "build_failed", message: e.message } },
        };
      case "DeployBlockedError":
        return {
          status: 409,
          body: { error: { code: "deploy_blocked", message: e.message } },
        };
      case "DeployHealthFailedError":
        return {
          status: 422,
          body: { error: { code: "deploy_unhealthy", message: e.message } },
        };
    }
  }
  // Default: 500. Log the stack on the server, don't leak to the client.
  process.stderr.write(
    `[http] unhandled error: ${(err as Error).stack ?? String(err)}\n`,
  );
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "internal server error" } },
  };
}
