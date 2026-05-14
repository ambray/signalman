/**
 * Build the registry HTTP application.
 *
 * Route table (v0.4.0 — generic-blob + manifest-catalog scope):
 *
 *   public:
 *     GET    /v1/healthz
 *
 *   blobs:
 *     PUT    /v1/blobs/:sha256        (push blob bytes)
 *     GET    /v1/blobs/:sha256        (pull blob bytes, octet-stream)
 *     HEAD   /v1/blobs/:sha256         — not implemented at v0.4.0;
 *       operators use GET + stat the body. Listed as deferred.
 *
 *   manifests:
 *     PUT    /v1/manifests/:name/:version   (push manifest JSON)
 *     GET    /v1/manifests/:name/:version   (pull manifest JSON)
 *     GET    /v1/manifests/:name            (list versions newest-first)
 *     DELETE /v1/manifests/:name/:version   (admin-scope RBAC stub)
 *
 * Every non-`/v1/healthz` route requires a bearer token through
 * the federated `sk_<prefix>_<secret>` shape. `DELETE` requires the
 * `admin` scope — the bootstrap server grants `admin` to every
 * shape-valid token; v0.4.x RBAC narrows this.
 */

import { Readable } from "node:stream";
import { makeAuthenticator, type AuthOptions } from "./auth.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import { Router, type RequestContext } from "./router.js";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  validateManifestName,
  validateManifestVersion,
  validateSha256,
  type Manifest,
  type ManifestSignature,
  type RegistryStorage,
} from "../types.js";
import type { LocalFsRegistryStorage } from "../storage/registry-storage.js";

const VERSION = "0.0.1";
const DEFAULT_BLOB_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export interface AppOptions {
  storage: RegistryStorage;
  /** Forwarded to `makeAuthenticator`. Defaults are dev-friendly. */
  auth?: AuthOptions;
  /** Override the blob upload cap; default 5 GiB. */
  blobMaxBytes?: number;
}

export function buildApp(opts: AppOptions): Router {
  const storage = opts.storage;
  const authenticate = makeAuthenticator(opts.auth ?? {});
  const router = new Router({
    authenticate,
    publicPaths: new Set(["/v1/healthz"]),
  });
  const blobMaxBytes = opts.blobMaxBytes ?? DEFAULT_BLOB_MAX_BYTES;

  // ── Health ─────────────────────────────────────────────────────
  router.get("/v1/healthz", async () => ({ ok: true, version: VERSION }));

  // ── Blobs ──────────────────────────────────────────────────────
  router.put(
    "/v1/blobs/:sha256",
    async (ctx) => {
      validateSha256Param(ctx.params.sha256);
      if (!ctx.bodyStream) {
        throw badRequest("blob upload requires a request body");
      }
      const contentType =
        typeof ctx.headers["content-type"] === "string"
          ? ctx.headers["content-type"]
          : undefined;
      const meta = await storage.putBlob({
        body: ctx.bodyStream,
        ...(contentType ? { contentType } : {}),
      });
      // Sanity-check that the bytes hash to the URL-declared sha.
      // Otherwise a buggy client uploads with the wrong sha and a
      // future manifest reference will dangle.
      if (meta.sha256 !== ctx.params.sha256) {
        // Delete the misnamed blob? No — the bytes are
        // content-addressed under the *correct* sha, so the
        // operator may just re-PUT under the right URL. Surface
        // the mismatch and let them retry.
        throw badRequest(
          `body hashes to ${meta.sha256}, not the URL-declared ${ctx.params.sha256}`,
        );
      }
      return { status: 201, body: { blob: meta } };
    },
    { streamBody: true, maxBodyBytes: blobMaxBytes },
  );

  router.get(
    "/v1/blobs/:sha256",
    async (ctx) => {
      if (!ctx.res) {
        throw badRequest("internal: rawResponse handler missing res");
      }
      const sha = ctx.params.sha256;
      try {
        validateSha256(sha);
      } catch {
        ctx.res.statusCode = 400;
        ctx.res.setHeader("content-type", "application/json; charset=utf-8");
        ctx.res.end(
          JSON.stringify({
            error: { code: "bad_sha256", message: `invalid sha256: ${truncate(sha)}` },
          }),
        );
        return;
      }
      let stream: Readable;
      try {
        stream = await storage.getBlob(sha);
      } catch (err) {
        if (
          err instanceof RegistryError &&
          err.code === REGISTRY_ERROR_CODES.BLOB_NOT_FOUND
        ) {
          ctx.res.statusCode = 404;
          ctx.res.setHeader("content-type", "application/json; charset=utf-8");
          ctx.res.end(
            JSON.stringify({
              error: { code: "blob_not_found", message: `blob not found: ${sha}` },
            }),
          );
          return;
        }
        throw err;
      }
      const stat = await storage.statBlob(sha);
      ctx.res.statusCode = 200;
      ctx.res.setHeader(
        "content-type",
        stat?.contentType ?? "application/octet-stream",
      );
      if (stat) {
        ctx.res.setHeader("content-length", String(stat.size));
        ctx.res.setHeader("etag", `"sha256:${stat.sha256}"`);
      }
      stream.pipe(ctx.res);
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
        ctx.res!.on("error", reject);
      });
    },
    { rawResponse: true },
  );

  // ── Manifests ──────────────────────────────────────────────────
  router.put("/v1/manifests/:name/:version", async (ctx) => {
    const name = ctx.params.name;
    const version = ctx.params.version;
    validateManifestName(name);
    validateManifestVersion(version);
    const parsed = parseManifestBody(ctx.body, name, version);
    const stored = await storage.putManifest(parsed);
    return { status: 201, body: { manifest: stored } };
  });

  router.get("/v1/manifests/:name/:version", async (ctx) => {
    const name = ctx.params.name;
    const version = ctx.params.version;
    validateManifestName(name);
    validateManifestVersion(version);
    const manifest = await storage.getManifest(name, version);
    if (!manifest) throw notFound(`manifest not found: ${name}@${version}`);
    const storageWithCanonical = storage as Partial<
      Pick<LocalFsRegistryStorage, "getCanonicalManifestBytes">
    >;
    let canonicalBytes: string | undefined;
    if (storageWithCanonical.getCanonicalManifestBytes) {
      const bytes = await storageWithCanonical.getCanonicalManifestBytes(
        name,
        version,
      );
      if (bytes) canonicalBytes = bytes.toString("base64");
    }
    return {
      manifest,
      ...(canonicalBytes ? { canonical_bytes_b64: canonicalBytes } : {}),
    };
  });

  router.get("/v1/manifests/:name", async (ctx) => {
    const name = ctx.params.name;
    validateManifestName(name);
    return { versions: await storage.listManifestVersions(name) };
  });

  router.delete("/v1/manifests/:name/:version", async (ctx) => {
    if (!ctx.auth.scopes.includes("admin")) {
      throw forbidden("delete requires the 'admin' scope");
    }
    const name = ctx.params.name;
    const version = ctx.params.version;
    validateManifestName(name);
    validateManifestVersion(version);
    await storage.deleteManifest(name, version);
    return { status: 204, body: null };
  });

  return router;
}

function validateSha256Param(sha: string): void {
  try {
    validateSha256(sha);
  } catch (err) {
    if (err instanceof RegistryError) {
      throw badRequest(err.message, "bad_sha256");
    }
    throw err;
  }
}

function parseManifestBody(
  body: unknown,
  expectedName: string,
  expectedVersion: string,
): Manifest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("manifest body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  // Tolerate the operator embedding the name/version in the body
  // for round-trip fidelity; reject mismatch to catch typos at the
  // gate rather than indexing a wrong-keyed row.
  if (typeof obj.name === "string" && obj.name !== expectedName) {
    throw badRequest(
      `body.name '${obj.name}' must equal URL path name '${expectedName}'`,
    );
  }
  if (typeof obj.version === "string" && obj.version !== expectedVersion) {
    throw badRequest(
      `body.version '${obj.version}' must equal URL path version '${expectedVersion}'`,
    );
  }
  const mediaType = obj.mediaType;
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    throw badRequest("mediaType is required (string)");
  }
  const blobs = obj.blobs;
  if (!Array.isArray(blobs)) {
    throw badRequest("blobs is required (array)");
  }
  const parsedBlobs = blobs.map((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw badRequest(`blobs[${idx}] must be an object`);
    }
    const ref = entry as Record<string, unknown>;
    if (typeof ref.mediaType !== "string" || ref.mediaType.length === 0) {
      throw badRequest(`blobs[${idx}].mediaType is required (string)`);
    }
    if (typeof ref.sha256 !== "string") {
      throw badRequest(`blobs[${idx}].sha256 is required (string)`);
    }
    try {
      validateSha256(ref.sha256);
    } catch (err) {
      if (err instanceof RegistryError) {
        throw badRequest(`blobs[${idx}]: ${err.message}`);
      }
      throw err;
    }
    const size =
      typeof ref.size === "number" && Number.isInteger(ref.size) && ref.size >= 0
        ? ref.size
        : undefined;
    const name = typeof ref.name === "string" ? ref.name : undefined;
    return {
      mediaType: ref.mediaType,
      sha256: ref.sha256,
      ...(size !== undefined ? { size } : {}),
      ...(name !== undefined ? { name } : {}),
    };
  });
  const annotations =
    obj.annotations && typeof obj.annotations === "object"
      ? (obj.annotations as Record<string, string>)
      : undefined;
  const signature = parseSignatureBody(obj.signature);
  const createdAt =
    typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString();
  return {
    name: expectedName,
    version: expectedVersion,
    mediaType,
    blobs: parsedBlobs,
    ...(annotations ? { annotations } : {}),
    ...(signature ? { signature } : {}),
    createdAt,
  };
}

function parseSignatureBody(value: unknown): ManifestSignature | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw badRequest("signature must be an object");
  }
  const obj = value as Record<string, unknown>;
  const signatureB64 = obj.signatureB64;
  const signedBy = obj.signedBy;
  if (typeof signatureB64 !== "string" || typeof signedBy !== "string") {
    throw badRequest("signature.signatureB64 and signature.signedBy are required");
  }
  return { signatureB64, signedBy };
}

function truncate(s: string): string {
  return s.length > 64 ? `${s.slice(0, 64)}...` : s;
}

// Re-export the RequestContext type for symmetry with host's app.ts.
export type { RequestContext };
