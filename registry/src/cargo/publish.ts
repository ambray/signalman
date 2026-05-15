/**
 * Cargo publish + yank handlers (WS6 wave-3 M10.3).
 *
 * Three routes under `/cargo/<org>/api/v1/crates/`:
 *
 *   PUT  /cargo/<org>/api/v1/crates/new
 *     The cargo publish endpoint. Body is the binary length-prefixed
 *     format: [u32 metadata_len][metadata JSON][u32 tarball_len]
 *     [tarball bytes]. Both lengths are little-endian uint32.
 *
 *   DELETE /cargo/<org>/api/v1/crates/<name>/<version>/yank
 *     Mark a specific version as yanked. The version stays
 *     downloadable (Cargo.lock-pinned installs work) but new
 *     resolutions skip it. Returns { ok: true }.
 *
 *   PUT  /cargo/<org>/api/v1/crates/<name>/<version>/unyank
 *     Inverse of yank. Returns { ok: true }.
 *
 * Yank semantics: the manifest's `cargo_metadata_json.yanked` flag
 * is mutated in place. This invalidates the original signature
 * (because canonical bytes change), so the row's signature_b64 +
 * signed_by are also cleared on yank. Operators who need attested-
 * yank can re-sign + push a new manifest version. The audit log
 * records every yank/unyank with the actor token id so the
 * forensic API can answer "who yanked this and when".
 *
 * Publish flow:
 *   1. Parse the length-prefixed body.
 *   2. sha256 the tarball; idempotent putBlob (sha-collision means
 *      the bytes are identical so re-publish is a no-op).
 *   3. Map the publish metadata JSON onto CargoManifestMetadata
 *      (field names match cargo's spec already — only `deps` need
 *      light shape massaging).
 *   4. Build a Manifest with kind='cargo' and
 *      name=`cargo/<org>/<crate>`.
 *   5. putManifest with provenance.source='upload' + the actor
 *      token id.
 *   6. Append audit-log entry: action='upload', entityType=
 *      'cargo_crate'.
 *
 * Auth: every route requires a bearer token through the existing
 * federated `sk_<prefix>_<secret>` shape. The v0.4.0 accept-any-
 * shape mode grants admin scope to every shape-valid token; real
 * RBAC ('publish:<org>' scope) lands in M10.6 follow-up alongside
 * the v0.4.4 RBAC work.
 */

import { Readable } from "node:stream";
import * as crypto from "node:crypto";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type CargoDependency,
  type CargoManifestMetadata,
  type Manifest,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes } from "../signing.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import {
  cargoManifestName,
  validateCargoCrateName,
  validateCargoOrgName,
} from "./paths.js";

/**
 * Operator-supplied publish metadata, matching the cargo spec.
 * Fields we don't currently store are accepted-and-discarded
 * (forward compat with future cargo additions).
 */
export interface CargoPublishMetadata {
  name: string;
  vers: string;
  deps?: CargoDependency[];
  features?: Record<string, string[]>;
  authors?: string[];
  description?: string;
  documentation?: string;
  homepage?: string;
  readme?: string;
  readme_file?: string;
  keywords?: string[];
  categories?: string[];
  license?: string;
  license_file?: string | null;
  repository?: string;
  badges?: Record<string, unknown>;
  links?: string | null;
  rust_version?: string | null;
  // Cargo passes `yanked` on first publish only when the operator
  // explicitly opted in. Default is false.
  yanked?: boolean;
}

export interface MountCargoPublishOptions {
  storage: RegistryStorage;
  /**
   * Reference to the SqliteManifestIndex for direct
   * setCargoYanked + appendAuditEntry calls. Optional so non-sqlite
   * backings (S3, Postgres) can plug in a different adapter; when
   * absent, the publish path still works but yank routes 503 with
   * an operator-friendly error.
   */
  index?: SqliteManifestIndex;
  /** Max binary body size for publish. Default 10 MiB. */
  maxPublishBytes?: number;
}

const DEFAULT_MAX_PUBLISH_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Parse the cargo publish binary body format:
 *
 *   [u32-le metadata-length][metadata JSON][u32-le tarball-length][tarball bytes]
 *
 * Exposed for unit tests so we can pin the exact byte layout
 * without spinning up an HTTP server.
 */
export function parsePublishBody(body: Buffer): {
  metadata: CargoPublishMetadata;
  tarball: Buffer;
} {
  if (body.length < 8) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `cargo publish body too short (${body.length} bytes); minimum 8 bytes for the two length prefixes`,
    );
  }
  const metaLen = body.readUInt32LE(0);
  if (4 + metaLen + 4 > body.length) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `cargo publish body: declared metadata length ${metaLen} exceeds body`,
    );
  }
  const metaJson = body.subarray(4, 4 + metaLen).toString("utf-8");
  let metadata: CargoPublishMetadata;
  try {
    metadata = JSON.parse(metaJson) as CargoPublishMetadata;
  } catch (err) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `cargo publish body: metadata is not valid JSON: ${(err as Error).message}`,
    );
  }
  const tarLenOffset = 4 + metaLen;
  const tarLen = body.readUInt32LE(tarLenOffset);
  if (tarLenOffset + 4 + tarLen !== body.length) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `cargo publish body: declared tarball length ${tarLen} does not match remaining ${body.length - tarLenOffset - 4} bytes`,
    );
  }
  const tarball = body.subarray(tarLenOffset + 4);
  validatePublishMetadata(metadata);
  return { metadata, tarball };
}

function validatePublishMetadata(metadata: CargoPublishMetadata): void {
  if (typeof metadata.name !== "string" || metadata.name.length === 0) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "cargo publish metadata: name is required",
    );
  }
  validateCargoCrateName(metadata.name);
  if (typeof metadata.vers !== "string" || metadata.vers.length === 0) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "cargo publish metadata: vers is required",
    );
  }
  if (metadata.deps !== undefined && !Array.isArray(metadata.deps)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "cargo publish metadata: deps must be an array when set",
    );
  }
}

/**
 * Translate cargo's publish metadata shape into our stored
 * CargoManifestMetadata shape. Field names match the cargo spec
 * already (M10.1 alignment); this just sets defaults for
 * optional fields the operator omitted.
 */
export function publishMetadataToStored(
  metadata: CargoPublishMetadata,
  cksum: string,
): CargoManifestMetadata {
  return {
    name: metadata.name.toLowerCase(),
    vers: metadata.vers,
    deps: (metadata.deps ?? []).map(normaliseDep),
    cksum,
    features: metadata.features ?? {},
    yanked: metadata.yanked ?? false,
    ...(metadata.rust_version != null ? { rust_version: metadata.rust_version } : {}),
    ...(metadata.links != null ? { links: metadata.links } : {}),
  };
}

function normaliseDep(dep: Partial<CargoDependency> & { name?: string; req?: string }): CargoDependency {
  if (!dep.name || !dep.req) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `cargo publish metadata: dep missing required name + req: ${JSON.stringify(dep)}`,
    );
  }
  return {
    name: dep.name,
    req: dep.req,
    features: dep.features ?? [],
    optional: dep.optional ?? false,
    default_features: dep.default_features ?? true,
    target: dep.target ?? null,
    kind: dep.kind ?? "normal",
    registry: dep.registry ?? null,
    ...(dep.package ? { package: dep.package } : {}),
  };
}

/**
 * Mount the cargo publish + yank routes on the given router.
 */
export function mountCargoPublishRoutes(
  router: Router,
  opts: MountCargoPublishOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;
  const maxPublishBytes = opts.maxPublishBytes ?? DEFAULT_MAX_PUBLISH_BYTES;

  // ── Publish ────────────────────────────────────────────────────

  router.put(
    "/cargo/:org/api/v1/crates/new",
    async (ctx) => {
      validateCargoOrgName(ctx.params.org);
      if (!ctx.bodyStream) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.BAD_MANIFEST,
          "cargo publish requires a request body",
        );
      }
      const body = await readBodyStream(ctx.bodyStream, maxPublishBytes);
      const { metadata, tarball } = parsePublishBody(body);

      // Hash + store the tarball blob. putBlob is idempotent on
      // sha-collision, so re-publishing the same tarball is a no-op.
      const cksum = crypto.createHash("sha256").update(tarball).digest("hex");
      const blobMeta = await storage.putBlob({
        body: tarball,
        contentType: "application/x-tar",
      });
      if (blobMeta.sha256 !== cksum) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.BAD_MANIFEST,
          `cargo publish: stored blob sha256 ${blobMeta.sha256} does not match computed ${cksum}`,
        );
      }

      const cargoMetadata = publishMetadataToStored(metadata, cksum);
      const manifestName = cargoManifestName(ctx.params.org, metadata.name);

      const manifest: Manifest = {
        name: manifestName,
        version: metadata.vers,
        mediaType: "application/vnd.signalman.cargo-crate.v1+json",
        kind: "cargo",
        blobs: [
          {
            mediaType: "application/x-tar",
            sha256: cksum,
            size: tarball.length,
            name: `${metadata.name}-${metadata.vers}.crate`,
          },
        ],
        cargoMetadata,
        createdAt: new Date().toISOString(),
      };

      const provenance: Provenance = {
        source: "upload",
        fetchedAt: manifest.createdAt,
        fetchedBy: ctx.auth.tokenPrefix?.slice(-16),
      };
      try {
        await storage.putManifest(manifest, provenance);
      } catch (err) {
        if (
          err instanceof RegistryError &&
          err.code === REGISTRY_ERROR_CODES.MANIFEST_EXISTS
        ) {
          throw new RegistryError(
            REGISTRY_ERROR_CODES.MANIFEST_EXISTS,
            `cargo crate ${metadata.name}@${metadata.vers} already published with different content`,
          );
        }
        throw err;
      }

      if (index) {
        index.appendAuditEntry({
          action: "upload",
          entityType: "cargo_crate",
          entityId: `${manifestName}@${metadata.vers}`,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            tarball_bytes: tarball.length,
            cksum,
            org: ctx.params.org,
          },
        });
      }

      // Cargo expects this exact response shape on success.
      return { status: 200, body: { warnings: { invalid_categories: [], invalid_badges: [], other: [] } } };
    },
    { streamBody: true, maxBodyBytes: maxPublishBytes },
  );

  // ── Yank ───────────────────────────────────────────────────────

  router.delete(
    "/cargo/:org/api/v1/crates/:name/:version/yank",
    async (ctx) => {
      return await mutateYank(
        ctx,
        storage,
        index,
        ctx.params.org,
        ctx.params.name,
        ctx.params.version,
        true,
      );
    },
  );

  router.put(
    "/cargo/:org/api/v1/crates/:name/:version/unyank",
    async (ctx) => {
      return await mutateYank(
        ctx,
        storage,
        index,
        ctx.params.org,
        ctx.params.name,
        ctx.params.version,
        false,
      );
    },
  );
}

async function mutateYank(
  ctx: { auth: { tokenPrefix: string | null; scopes: readonly string[] }; params: Record<string, string> },
  storage: RegistryStorage,
  index: SqliteManifestIndex | undefined,
  org: string,
  name: string,
  version: string,
  yanked: boolean,
): Promise<{ status: number; body: unknown }> {
  validateCargoOrgName(org);
  validateCargoCrateName(name);
  if (version.length === 0 || /[\s/]/.test(version)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_VERSION,
      `invalid cargo crate version: ${version}`,
    );
  }
  if (!index) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "yank/unyank requires a SqliteManifestIndex; the current storage backing does not support it",
    );
  }

  const manifestName = cargoManifestName(org, name);
  const manifest = await storage.getManifest(manifestName, version);
  if (!manifest || manifest.kind !== "cargo" || !manifest.cargoMetadata) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.MANIFEST_NOT_FOUND,
      `cargo crate ${org}/${name}@${version} not found`,
    );
  }

  // Mutate the cargo_metadata_json + clear the signature in one
  // transaction. The original signed canonical bytes can no longer
  // be verified against the stored row (the row's bytes have
  // changed); operators that need attested-yank can re-publish a
  // new version that explicitly carries yanked=true.
  index.setCargoYanked(manifestName, version, yanked);

  index.appendAuditEntry({
    action: yanked ? "yank" : "unyank",
    entityType: "cargo_crate",
    entityId: `${manifestName}@${version}`,
    actor: ctx.auth.tokenPrefix ?? "anonymous",
    detail: { org, name, version },
  });

  return { status: 200, body: { ok: true } };
}

async function readBodyStream(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > max) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_MANIFEST,
        `cargo publish body too large: ${received} bytes (max ${max})`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Re-export the canonical-bytes helper so callers can verify
// post-publish round-trip if needed. Not directly used by the
// publish path (we don't re-sign on publish; that's the operator's
// pre-publish responsibility).
export { canonicalManifestBytes };
