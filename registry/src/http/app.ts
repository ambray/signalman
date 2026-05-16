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
import { mountCargoReadRoutes } from "../cargo/index.js";
import { mountCargoPublishRoutes } from "../cargo/publish.js";
import {
  proxyCargoDownload,
  proxyCargoSparseIndex,
  type UpstreamFetch,
} from "../cargo/virtual.js";
import {
  mountNpmReadRoutes,
  mountNpmPublishRoutes,
} from "../npm/index.js";
import { proxyNpmPackument, proxyNpmTarball } from "../npm/virtual.js";
import { mountForensicRoutes } from "./forensic.js";
import { mountOciRoutes, type MountedOciHandles } from "../oci/mount.js";

const VERSION = "0.0.1";
const DEFAULT_BLOB_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export interface AppOptions {
  storage: RegistryStorage;
  /** Forwarded to `makeAuthenticator`. Defaults are dev-friendly. */
  auth?: AuthOptions;
  /** Override the blob upload cap; default 5 GiB. */
  blobMaxBytes?: number;
  /**
   * WS6 wave-3 (M10.2): public base URL of this registry, used to
   * build `dl` + `api` URLs in cargo's index/config.json. Defaults
   * to `""` (relative URLs). Production callers should set this to
   * their externally-resolvable URL.
   */
  publicBaseUrl?: string;
  /**
   * WS6 wave-3 (M10.4): operator's Ed25519 private key (PEM) used
   * for re-signing cached manifests on virtual-registry pull-through.
   * Optional — when absent, virtual upstreams configured with
   * `resign_on_cache: true` cache unsigned + audit-log the skip.
   */
  virtualResignPrivateKeyPem?: string;
  /**
   * WS6 wave-3 (M10.4): injectable upstream fetcher for tests. When
   * undefined, virtual upstreams use the global `fetch`. Tests pass
   * a stub that returns pre-canned responses.
   */
  virtualUpstreamFetch?: UpstreamFetch;
  /**
   * WS10 (v0.5 OCI facade): inject the reaper cadence + upload TTL.
   * Production callers take the defaults; tests pass shorter values.
   */
  ociReaperIntervalMs?: number;
  ociUploadTtlSeconds?: number;
  /** WS10: max chunk body cap for a single PATCH/PUT. Default 5 GiB. */
  ociMaxChunkBytes?: number;
  /**
   * WS10: deterministic clock for tests. Threads through the upload
   * store + reaper so timestamp assertions are stable.
   */
  ociNow?: () => Date;
}

export interface AppHandles {
  /** Stop background tasks (currently: the OCI upload reaper). */
  stopBackgroundTasks(): void;
  /** Programmatically trigger one OCI reaper sweep. */
  ociReaperSweep(): Promise<number>;
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

  // ── Cargo facade (WS6 wave-3 M10.2 + M10.3 + M10.4) ────────────
  //
  // Per-org sparse-index + download + publish + yank + virtual-
  // registry pull-through.
  const idxStorage = storage as Partial<LocalFsRegistryStorage>;

  // Virtual-registry proxy hooks. Only active when the storage
  // backing carries an `index` (i.e. is `LocalFsRegistryStorage`);
  // future S3 / Postgres drivers wire their own equivalents.
  const proxyOpts =
    idxStorage.index !== undefined
      ? {
          storage,
          index: idxStorage.index,
          ...(opts.virtualUpstreamFetch ? { fetch: opts.virtualUpstreamFetch } : {}),
          ...(opts.virtualResignPrivateKeyPem
            ? { signingPrivateKeyPem: opts.virtualResignPrivateKeyPem }
            : {}),
        }
      : null;

  mountCargoReadRoutes(router, {
    storage,
    publicBaseUrl: opts.publicBaseUrl,
    ...(proxyOpts
      ? {
          proxySparseIndex: (org, name) =>
            proxyCargoSparseIndex(proxyOpts, org, name),
          proxyDownload: (org, name, version) =>
            proxyCargoDownload(proxyOpts, org, name, version),
        }
      : {}),
  });
  // Publish + yank need direct access to the SqliteManifestIndex
  // for setCargoYanked + appendAuditEntry. Storage backings that
  // aren't sqlite-backed get a degraded experience (publish works;
  // yank routes 503).
  mountCargoPublishRoutes(router, {
    storage,
    index: idxStorage.index,
  });

  // ── Npm facade (v0.1.1) ────────────────────────────────────────
  //
  // Same shape as the cargo facade: read (packument + tarball) +
  // publish (PUT /<package>) + virtual pull-through against
  // npmjs.com when configured.
  const npmProxyOpts =
    idxStorage.index !== undefined
      ? {
          storage,
          index: idxStorage.index,
          ...(opts.virtualUpstreamFetch ? { fetch: opts.virtualUpstreamFetch } : {}),
          ...(opts.virtualResignPrivateKeyPem
            ? { signingPrivateKeyPem: opts.virtualResignPrivateKeyPem }
            : {}),
          ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
        }
      : null;
  mountNpmReadRoutes(router, {
    storage,
    publicBaseUrl: opts.publicBaseUrl,
    ...(npmProxyOpts
      ? {
          proxyPackument: (org, packageName) =>
            proxyNpmPackument(npmProxyOpts, org, packageName),
          proxyTarball: (org, packageName, version) =>
            proxyNpmTarball(npmProxyOpts, org, packageName, version),
        }
      : {}),
  });
  mountNpmPublishRoutes(router, {
    storage,
    index: idxStorage.index,
  });

  // ── Forensic + provenance (WS6 wave-3 M10.5) ───────────────────
  mountForensicRoutes(router, {
    storage,
    index: idxStorage.index,
  });

  // ── OCI Distribution Spec v1.1 facade (WS10) ───────────────────
  //
  // Mounts the /v2/* surface alongside the existing /v1/* surface.
  // Requires the LocalFsBlobStore + SqliteManifestIndex to drive the
  // chunked-upload state machine; storage backings that lack those
  // (a future S3 driver) will need their own mount block.
  let oci: MountedOciHandles | null = null;
  if (idxStorage.blobStore && idxStorage.index) {
    oci = mountOciRoutes(router, {
      storage,
      index: idxStorage.index,
      blobStore: idxStorage.blobStore,
      ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
      ...(opts.ociReaperIntervalMs !== undefined
        ? { reaperIntervalMs: opts.ociReaperIntervalMs }
        : {}),
      ...(opts.ociUploadTtlSeconds !== undefined
        ? { uploadTtlSeconds: opts.ociUploadTtlSeconds }
        : {}),
      ...(opts.ociMaxChunkBytes !== undefined
        ? { maxChunkBytes: opts.ociMaxChunkBytes }
        : {}),
      ...(opts.ociNow ? { now: opts.ociNow } : {}),
    });
  }

  // Attach handles to the router for callers that want to drive the
  // reaper or shut down the server cleanly. Type-fudged because Router
  // is shared infra; this is a registry-specific extension.
  const handles: AppHandles = {
    stopBackgroundTasks(): void {
      oci?.stop();
    },
    ociReaperSweep: async () => oci?.reaperSweep() ?? 0,
  };
  (router as Router & { handles: AppHandles }).handles = handles;

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
  // WS6 wave-3 (M10): accept optional `kind` + `cargoMetadata` from
  // the request body. These ARE operator-signed content (the
  // canonical bytes the operator signs include them when present),
  // so we surface them verbatim without defaulting. Old v0.4.0
  // manifests omit `kind` entirely; the storage layer treats absent
  // == 'generic' on row insert + read.
  //
  // NOTE: `provenance` is intentionally NOT parsed from the request
  // body. It's server-side metadata, not operator-signed content.
  // The HTTP layer sets provenance on `putManifest`'s second arg.
  const kind =
    typeof obj.kind === "string" &&
    (obj.kind === "generic" || obj.kind === "cargo" || obj.kind === "npm" || obj.kind === "oci")
      ? (obj.kind as import("../types.js").ManifestKind)
      : undefined;
  const cargoMetadata =
    obj.cargoMetadata && typeof obj.cargoMetadata === "object"
      ? (obj.cargoMetadata as import("../types.js").CargoManifestMetadata)
      : undefined;
  const npmMetadata =
    obj.npmMetadata && typeof obj.npmMetadata === "object"
      ? (obj.npmMetadata as import("../types.js").NpmManifestMetadata)
      : undefined;
  // WS10 (v0.5 OCI facade): the generic /v1/manifests PUT also accepts
  // ociMetadata so an operator pushing an OCI manifest through the
  // generic surface round-trips identically to the /v2/* path.
  const ociMetadata =
    obj.ociMetadata && typeof obj.ociMetadata === "object"
      ? (obj.ociMetadata as import("../types.js").OciManifestMetadata)
      : undefined;
  return {
    name: expectedName,
    version: expectedVersion,
    mediaType,
    ...(kind ? { kind } : {}),
    blobs: parsedBlobs,
    ...(annotations ? { annotations } : {}),
    ...(signature ? { signature } : {}),
    ...(cargoMetadata ? { cargoMetadata } : {}),
    ...(npmMetadata ? { npmMetadata } : {}),
    ...(ociMetadata ? { ociMetadata } : {}),
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
