/**
 * Git LFS Batch API handler.
 *
 *   POST /hf/<org>/<repo>/info/lfs/objects/batch
 *   Content-Type: application/vnd.git-lfs+json
 *
 * Body shape (per the LFS spec):
 *
 *   {
 *     "operation": "download",
 *     "transfers": ["basic"],
 *     "objects": [{ "oid": "sha256:<hex>", "size": <N> }, ...]
 *   }
 *
 * Response shape (per the LFS spec):
 *
 *   {
 *     "transfer": "basic",
 *     "objects": [
 *       {
 *         "oid": "sha256:<hex>",
 *         "size": <N>,
 *         "actions": {
 *           "download": { "href": "<our blob endpoint>", "expires_in": <N> }
 *         }
 *       },
 *       {
 *         "oid": "sha256:<other>",
 *         "size": <N>,
 *         "error": { "code": 404, "message": "Object not found" }
 *       }
 *     ]
 *   }
 *
 * The `download.href` always points back at our content-addressed
 * blob endpoint (Q2 lock — fully proxy, never expose the upstream
 * token in `download.header`). When the OID is unknown locally, the
 * caller's optional `proxyBatch` hook is consulted — Story 5 wires
 * that to the virtual-upstream Batch API.
 *
 * `operation: 'upload'` is rejected with LFS_UNSUPPORTED_OPERATION
 * 422; operators use the flattened tarball publish path in M4.
 */

import type { RegistryStorage } from "../types.js";
import { HfError } from "./errors.js";
import {
  HF_ERROR_CODES,
  type LfsBatchObject,
  type LfsBatchRequest,
  type LfsBatchResponse,
} from "./types.js";
import { parseLfsOid } from "./paths.js";

export interface LfsBatchHandlerOptions {
  storage: RegistryStorage;
  /** Org + repo from the route — passed to the proxy hook. */
  org: string;
  repo: string;
  /** Parsed request body. */
  request: LfsBatchRequest;
  /**
   * Function the handler calls to compose the `download.href` for a
   * given OID. Typically:
   *   `(oid) => "<base>/hf/<org>/<repo>/lfs/sha256/<hex>"`
   *
   * Wired by the mount layer (Story 6). Letting the caller compose
   * the URL keeps the handler free of public-base-URL plumbing.
   */
  composeDownloadHref: (sha256Hex: string) => string;
  /**
   * Optional `expires_in` value (seconds) on the action block. LFS
   * spec defaults to 86400 (24h); we propagate the caller's value
   * verbatim and omit when undefined.
   */
  expiresIn?: number;
  /**
   * Optional pull-through proxy: on unknown OIDs we call this once
   * with the missing oids and re-stat afterwards. Returns the set
   * of OIDs the proxy populated.
   */
  proxyBatch?: (
    org: string,
    repo: string,
    missingOids: Array<{ oid: string; size: number }>,
  ) => Promise<Set<string>>;
}

/**
 * Process an LFS Batch request and return the response object. The
 * caller (the route handler) writes JSON + status.
 */
export async function handleLfsBatch(
  opts: LfsBatchHandlerOptions,
): Promise<LfsBatchResponse> {
  validateBatchRequest(opts.request);
  const objects: LfsBatchObject[] = [];

  // First pass: for each declared OID, look up the blob. Collect
  // missing OIDs for the proxy hook.
  type Lookup = {
    oid: string;
    size: number;
    sha256Hex: string;
    present: boolean;
  };
  const lookups: Lookup[] = [];
  for (const obj of opts.request.objects) {
    let sha256Hex: string;
    try {
      sha256Hex = parseLfsOid(obj.oid);
    } catch {
      lookups.push({
        oid: obj.oid,
        size: obj.size,
        sha256Hex: "",
        present: false,
      });
      continue;
    }
    const stat = await opts.storage.statBlob(sha256Hex);
    lookups.push({
      oid: obj.oid,
      size: obj.size,
      sha256Hex,
      present: stat !== null,
    });
  }

  // Optional proxy pull-through for the missing OIDs.
  if (opts.proxyBatch) {
    const missing = lookups
      .filter((l) => !l.present && l.sha256Hex.length > 0)
      .map((l) => ({ oid: l.oid, size: l.size }));
    if (missing.length > 0) {
      const populated = await opts.proxyBatch(opts.org, opts.repo, missing);
      for (const lookup of lookups) {
        if (!lookup.present && populated.has(lookup.oid)) {
          // Re-stat after proxy claim.
          const stat = await opts.storage.statBlob(lookup.sha256Hex);
          if (stat) lookup.present = true;
        }
      }
    }
  }

  for (const lookup of lookups) {
    if (lookup.present && lookup.sha256Hex.length > 0) {
      const obj: LfsBatchObject = {
        oid: lookup.oid,
        size: lookup.size,
        actions: {
          download: {
            href: opts.composeDownloadHref(lookup.sha256Hex),
            ...(opts.expiresIn !== undefined
              ? { expires_in: opts.expiresIn }
              : {}),
          },
        },
      };
      objects.push(obj);
    } else {
      objects.push({
        oid: lookup.oid,
        size: lookup.size,
        error: {
          code: 404,
          message:
            lookup.sha256Hex.length === 0
              ? `Object oid '${lookup.oid}' has an invalid sha256 format`
              : `Object oid '${lookup.oid}' not found`,
        },
      });
    }
  }

  return {
    transfer: "basic",
    objects,
    hash_algo: "sha256",
  };
}

function validateBatchRequest(req: unknown): asserts req is LfsBatchRequest {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    throw new HfError(
      HF_ERROR_CODES.LFS_BATCH_INVALID,
      "request body must be a JSON object",
    );
  }
  const r = req as Record<string, unknown>;
  const operation = r.operation;
  if (operation !== "download" && operation !== "upload") {
    throw new HfError(
      HF_ERROR_CODES.LFS_BATCH_INVALID,
      `operation must be 'download' or 'upload'; got ${truncate(operation)}`,
    );
  }
  if (operation === "upload") {
    throw new HfError(
      HF_ERROR_CODES.LFS_UNSUPPORTED_OPERATION,
      "LFS 'upload' operation is not supported on this registry — use the flattened tarball publish endpoint",
    );
  }
  const objects = r.objects;
  if (!Array.isArray(objects)) {
    throw new HfError(
      HF_ERROR_CODES.LFS_BATCH_INVALID,
      "'objects' must be an array",
    );
  }
  if (objects.length === 0) {
    throw new HfError(
      HF_ERROR_CODES.LFS_BATCH_INVALID,
      "'objects' array must not be empty",
    );
  }
  if (objects.length > 1024) {
    throw new HfError(
      HF_ERROR_CODES.LFS_BATCH_INVALID,
      `'objects' array too large: ${objects.length} > 1024`,
    );
  }
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      throw new HfError(
        HF_ERROR_CODES.LFS_BATCH_INVALID,
        `objects[${i}] must be an object`,
      );
    }
    const rec = o as Record<string, unknown>;
    if (typeof rec.oid !== "string") {
      throw new HfError(
        HF_ERROR_CODES.LFS_BATCH_INVALID,
        `objects[${i}].oid must be a string`,
      );
    }
    if (typeof rec.size !== "number" || !Number.isInteger(rec.size) || rec.size < 0) {
      throw new HfError(
        HF_ERROR_CODES.LFS_BATCH_INVALID,
        `objects[${i}].size must be a non-negative integer`,
      );
    }
  }
}

function truncate(v: unknown): string {
  const s = typeof v === "string" ? v : String(v);
  return s.length > 64 ? `${s.slice(0, 64)}...` : s;
}
