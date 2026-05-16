/**
 * OCI Distribution Spec v1.1 manifest protocol — `/v2/<name>/manifests/*`.
 *
 * Route table mounted by `mountOciManifestRoutes`:
 *
 *   PUT    /v2/*name/manifests/:reference     push manifest by tag or digest
 *   GET    /v2/*name/manifests/:reference     pull manifest body
 *   HEAD   /v2/*name/manifests/:reference     existence + Docker-Content-Digest
 *   DELETE /v2/*name/manifests/:reference     drop manifest or tag pointer
 *
 * Reference grammar:
 *   - `<tag>` — `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}` (spec §Tag Reference Format)
 *   - `<digest>` — `sha256:<64-hex-lowercase>` (sha256 only at v0.5)
 *
 * Storage layout (operator-locked Q1 per-org namespacing):
 *   manifest.name    = 'oci/<org>/<repo>'
 *   manifest.version = sha256-hex of literal pushed bytes (no `sha256:` prefix)
 *   manifest.kind    = 'oci'
 *   canonical_bytes  = the literal pushed JSON, byte-identical to what
 *                      `Docker-Content-Digest` advertises on GET
 *   ociMetadata      = row-side projection (isIndex, layer digests,
 *                      child manifest summaries — for cheap forensic queries)
 *
 * Unlike cargo + npm (which sign via the Ed25519 surface and use a
 * canonicalized JSON form), OCI manifests are stored verbatim because
 * the OCI digest IS the sha256 of the raw bytes the operator pushed.
 * Any re-serialization would shift the digest and break clients. We
 * call `index.putManifest(manifest, rawBytes, provenance)` directly
 * to pin the bytes — same pattern the cargo virtual-cache uses.
 *
 * Validation pre-persist:
 *   - single-platform: every `config.digest` + `layers[].digest` must
 *     resolve to a known blob (MANIFEST_BLOB_UNKNOWN otherwise).
 *     `urls`-bearing "foreign" layers are skipped (operator-set
 *     externally-hosted bytes; spec allows).
 *   - image-index: every `manifests[].digest` must resolve to a known
 *     manifest in the SAME repository (MANIFEST_BLOB_UNKNOWN otherwise).
 *
 * Audit log (`registry/src/storage/sqlite-index.ts`):
 *   - PUT manifest         → action='upload', entity_type='manifest'
 *   - tag rotation on PUT  → action='manifest_create', entity_type='manifest'
 *   - DELETE manifest      → action='delete', entity_type='manifest'
 *   - DELETE tag           → action='delete', entity_type='manifest'
 *     (tag-only delete shape — detail.tag carries the rotated-away tag)
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  type Manifest,
  type OciManifestMetadata,
  type Provenance,
  type RegistryStorage,
  REGISTRY_ERROR_CODES,
  RegistryError,
} from "../types.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { OciError } from "./errors.js";
import {
  DOCKER_MEDIA_TYPES,
  INDEX_MEDIA_TYPES,
  OCI_ERROR_CODES,
  OCI_MEDIA_TYPES,
  SINGLE_MANIFEST_MEDIA_TYPES,
  type OciDescriptor,
  type OciIndex,
  type OciManifest,
} from "./types.js";
import {
  ociManifestName,
  parseOciReference,
  validateOciDigest,
  validateOciRepositoryName,
} from "./paths.js";
import { parseManifestOrIndex } from "./guards.js";
import {
  asOciError,
  setDockerContentDigest,
  writeOciError,
} from "./http.js";
import { TagStore } from "./tag-store.js";

export interface MountOciManifestOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  tagStore: TagStore;
  publicBaseUrl?: string;
  /** Max manifest size cap. Per spec, MUST support at least 4 MiB. */
  maxManifestBytes?: number;
  /**
   * Operator-locked Q6 outcome: by default manifest DELETE is allowed
   * per spec. Operators that want immutability flip this to false;
   * the handler then returns 405 UNSUPPORTED.
   */
  allowDelete?: boolean;
  now?: () => Date;
}

const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MiB (spec minimum)

interface ParsedRepository {
  org: string;
  repo: string;
  storageName: string;
}

function parseRepositoryParam(rawName: string): ParsedRepository {
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `<name> path parameter is required`,
    );
  }
  const firstSlash = rawName.indexOf("/");
  if (firstSlash <= 0 || firstSlash === rawName.length - 1) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `<name> must include both an org and a repository segment`,
    );
  }
  const org = rawName.slice(0, firstSlash);
  const repo = rawName.slice(firstSlash + 1);
  validateOciRepositoryName(rawName);
  const storageName = ociManifestName(org, repo);
  return { org, repo, storageName };
}

export function mountOciManifestRoutes(
  router: Router,
  opts: MountOciManifestOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;
  const tagStore = opts.tagStore;
  const maxManifestBytes = opts.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  const allowDelete = opts.allowDelete ?? true;
  const now = opts.now ?? (() => new Date());
  const baseUrl = opts.publicBaseUrl ?? "";

  // ── PUT /v2/<name>/manifests/:reference ─────────────────────────
  router.put(
    "/v2/*name/manifests/:reference",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const repo = parseRepositoryParam(ctx.params.name);
        const ref = parseOciReference(ctx.params.reference);
        if (!ctx.bodyStream) {
          throw new OciError(
            OCI_ERROR_CODES.MANIFEST_INVALID,
            `PUT requires a request body`,
          );
        }
        const raw = await readBytes(ctx.bodyStream, maxManifestBytes);
        const manifestSha = crypto.createHash("sha256").update(raw).digest("hex");
        const declaredDigest = `sha256:${manifestSha}`;
        if (ref.kind === "digest" && ref.value !== declaredDigest) {
          throw new OciError(
            OCI_ERROR_CODES.DIGEST_INVALID,
            `body digest ${declaredDigest} does not match path reference ${ref.value}`,
          );
        }

        const ct = headerString(ctx.headers["content-type"]);
        if (!ct) {
          throw new OciError(
            OCI_ERROR_CODES.MANIFEST_INVALID,
            `Content-Type required on manifest PUT`,
          );
        }
        if (
          !SINGLE_MANIFEST_MEDIA_TYPES.has(ct) &&
          !INDEX_MEDIA_TYPES.has(ct)
        ) {
          throw new OciError(
            OCI_ERROR_CODES.MANIFEST_INVALID,
            `Content-Type '${ct}' is not a recognised manifest type`,
          );
        }

        let parsed: ReturnType<typeof parseManifestOrIndex>;
        try {
          const json = JSON.parse(raw.toString("utf-8"));
          parsed = parseManifestOrIndex(json);
        } catch (err) {
          if (err instanceof OciError) throw err;
          throw new OciError(
            OCI_ERROR_CODES.MANIFEST_INVALID,
            `manifest body is not valid JSON: ${(err as Error).message}`,
          );
        }
        // Content-Type must match the body's mediaType to avoid
        // spoofing (e.g. a Docker v2.2 body served under an OCI v1
        // Content-Type would mislead Accept negotiation later).
        if (parsed.value.mediaType !== ct) {
          throw new OciError(
            OCI_ERROR_CODES.MANIFEST_INVALID,
            `body.mediaType '${parsed.value.mediaType}' does not match Content-Type '${ct}'`,
          );
        }

        // Validate referenced blobs (single-platform) or child
        // manifests (image index).
        if (parsed.kind === "manifest") {
          await validateSingleManifestReferences(parsed.value, storage);
        } else {
          await validateIndexChildManifests(parsed.value, repo.storageName, storage);
        }

        const ociMetadata = projectOciMetadata(parsed);
        const blobs = parsed.kind === "manifest"
          ? buildBlobRefsFromManifest(parsed.value)
          : [];

        const manifest: Manifest = {
          name: repo.storageName,
          version: manifestSha,
          mediaType: parsed.value.mediaType,
          kind: "oci",
          blobs,
          ociMetadata,
          createdAt: now().toISOString(),
        };

        const provenance: Provenance = {
          source: "upload",
          fetchedAt: manifest.createdAt,
          fetchedBy: ctx.auth.tokenPrefix?.slice(-16),
        };

        try {
          index.putManifest(manifest, raw, provenance);
        } catch (err) {
          if (
            err instanceof RegistryError &&
            err.code === REGISTRY_ERROR_CODES.MANIFEST_EXISTS
          ) {
            // Same digest, different bytes is impossible (digest is
            // content-addressed). This branch fires when a previous
            // putManifest for the same digest succeeded; treat as
            // idempotent and continue to the tag-rotation step below.
          } else {
            throw err;
          }
        }

        index.appendAuditEntry({
          action: "upload",
          entityType: "manifest",
          entityId: `${repo.storageName}@${declaredDigest}`,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            kind: "oci",
            org: repo.org,
            repository: repo.repo,
            mediaType: parsed.value.mediaType,
            isIndex: ociMetadata.isIndex,
            schemaVariant: ociMetadata.schemaVariant,
            layer_count: ociMetadata.layerDigests?.length ?? null,
            child_manifest_count: ociMetadata.childManifests?.length ?? null,
            bytes: raw.length,
            ref_kind: ref.kind,
            ref_value: ref.value,
          },
        });

        if (ref.kind === "tag") {
          const result = tagStore.put(repo.storageName, ref.value, manifestSha);
          index.appendAuditEntry({
            action: "manifest_create",
            entityType: "manifest",
            entityId: `${repo.storageName}@${declaredDigest}`,
            actor: ctx.auth.tokenPrefix ?? "anonymous",
            detail: {
              kind: "oci",
              org: repo.org,
              repository: repo.repo,
              tag: ref.value,
              rotated: result.rotated,
              previous_sha256: result.previousSha256 ?? null,
            },
          });
        }

        const locationDigest = declaredDigest;
        const location = `${baseUrl}/v2/${repo.org}/${repo.repo}/manifests/${locationDigest}`;
        res.statusCode = 201;
        res.setHeader("Location", location);
        setDockerContentDigest(res, declaredDigest);
        res.setHeader("content-length", "0");
        res.end();
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true, streamBody: true, maxBodyBytes: maxManifestBytes },
  );

  // ── GET /v2/<name>/manifests/:reference ─────────────────────────
  router.get(
    "/v2/*name/manifests/:reference",
    async (ctx) => {
      const res = ctx.res!;
      try {
        await serveManifest(ctx, res, /* head */ false);
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  router.head(
    "/v2/*name/manifests/:reference",
    async (ctx) => {
      const res = ctx.res!;
      try {
        await serveManifest(ctx, res, /* head */ true);
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── DELETE /v2/<name>/manifests/:reference ──────────────────────
  router.delete(
    "/v2/*name/manifests/:reference",
    async (ctx) => {
      const res = ctx.res!;
      try {
        if (!allowDelete) {
          throw new OciError(
            OCI_ERROR_CODES.UNSUPPORTED,
            `manifest DELETE is disabled on this registry`,
          );
        }
        const repo = parseRepositoryParam(ctx.params.name);
        const ref = parseOciReference(ctx.params.reference);

        if (ref.kind === "tag") {
          // Tag-only delete: drop the pointer, leave the underlying
          // manifest in place (other tags + digest lookup may still
          // need it). Spec is ambiguous on this; cosign + crane
          // expect this shape.
          const tagRow = tagStore.get(repo.storageName, ref.value);
          if (!tagRow) {
            throw new OciError(
              OCI_ERROR_CODES.MANIFEST_UNKNOWN,
              `tag ${ref.value} not found in ${repo.storageName}`,
            );
          }
          tagStore.delete(repo.storageName, ref.value);
          index.appendAuditEntry({
            action: "delete",
            entityType: "manifest",
            entityId: `${repo.storageName}@sha256:${tagRow.manifestSha256}`,
            actor: ctx.auth.tokenPrefix ?? "anonymous",
            detail: {
              kind: "oci",
              phase: "tag_delete",
              org: repo.org,
              repository: repo.repo,
              tag: ref.value,
              manifest_sha256: tagRow.manifestSha256,
            },
          });
          res.statusCode = 202;
          res.setHeader("content-length", "0");
          res.end();
          return;
        }

        // Digest delete: drop the manifest row + cascade tag pointers.
        const stored = await storage.getManifest(repo.storageName, ref.hex);
        if (!stored) {
          throw new OciError(
            OCI_ERROR_CODES.MANIFEST_UNKNOWN,
            `manifest ${ref.value} not found`,
          );
        }
        await storage.deleteManifest(repo.storageName, ref.hex);
        const removedTags = tagStore.deleteByDigest(repo.storageName, ref.hex);
        index.appendAuditEntry({
          action: "delete",
          entityType: "manifest",
          entityId: `${repo.storageName}@${ref.value}`,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            kind: "oci",
            phase: "digest_delete",
            org: repo.org,
            repository: repo.repo,
            cascaded_tags: removedTags,
          },
        });
        res.statusCode = 202;
        res.setHeader("content-length", "0");
        res.end();
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── Internals ──────────────────────────────────────────────────

  async function serveManifest(
    ctx: import("../http/router.js").RequestContext,
    res: import("node:http").ServerResponse,
    head: boolean,
  ): Promise<void> {
    const repo = parseRepositoryParam(ctx.params.name);
    const ref = parseOciReference(ctx.params.reference);

    let hex: string;
    if (ref.kind === "digest") {
      hex = ref.hex;
    } else {
      const tagRow = tagStore.get(repo.storageName, ref.value);
      if (!tagRow) {
        throw new OciError(
          OCI_ERROR_CODES.MANIFEST_UNKNOWN,
          `tag ${ref.value} not found in ${repo.storageName}`,
        );
      }
      hex = tagRow.manifestSha256;
    }
    const manifest = await storage.getManifest(repo.storageName, hex);
    if (!manifest) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_UNKNOWN,
        `manifest ${ref.value} not found`,
      );
    }
    const bytesOpt = await maybeGetCanonicalBytes(storage, repo.storageName, hex);
    if (!bytesOpt) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_UNKNOWN,
        `manifest bytes for ${ref.value} not found`,
      );
    }
    // Accept-header negotiation. Spec says the server SHOULD honour
    // the client's Accept list when multiple equivalent representations
    // exist. For OCI we only have one representation per digest (the
    // literal pushed bytes), so we simply 406 when the client's Accept
    // explicitly excludes our mediaType. When Accept is missing or
    // contains `*/*`, we serve verbatim.
    const acceptList = parseAcceptHeader(headerString(ctx.headers.accept));
    if (acceptList.length > 0) {
      const acceptsMine =
        acceptList.includes("*/*") || acceptList.includes(manifest.mediaType);
      if (!acceptsMine) {
        // Spec is ambiguous between 404 and 406 here; both Docker and
        // crane retry against the other surface on 404. We use 404
        // MANIFEST_UNKNOWN to match Docker Distribution's behaviour.
        throw new OciError(
          OCI_ERROR_CODES.MANIFEST_UNKNOWN,
          `no manifest in ${repo.storageName} matches Accept '${acceptList.join(", ")}'`,
        );
      }
    }
    res.statusCode = 200;
    res.setHeader("content-type", manifest.mediaType);
    res.setHeader("content-length", String(bytesOpt.length));
    setDockerContentDigest(res, `sha256:${hex}`);
    if (head) {
      res.end();
      return;
    }
    res.end(bytesOpt);
  }
}

async function readBytes(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buf.length;
    if (received > max) {
      throw new OciError(
        OCI_ERROR_CODES.SIZE_INVALID,
        `manifest body exceeded max ${max} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function validateSingleManifestReferences(
  manifest: OciManifest,
  storage: RegistryStorage,
): Promise<void> {
  // Config blob MUST exist locally.
  const configHex = digestHex(manifest.config.digest);
  if (!(await storage.statBlob(configHex))) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN,
      `config blob ${manifest.config.digest} not found`,
    );
  }
  // Each layer MUST exist locally UNLESS it carries `urls` (foreign /
  // accelerator-hosted layer). Spec §Image Manifest Property
  // Description allows `urls` to signal external availability.
  for (let i = 0; i < manifest.layers.length; i++) {
    const layer = manifest.layers[i];
    if (layer.urls && layer.urls.length > 0) continue;
    const hex = digestHex(layer.digest);
    if (!(await storage.statBlob(hex))) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN,
        `layer[${i}] blob ${layer.digest} not found`,
      );
    }
  }
}

async function validateIndexChildManifests(
  index: OciIndex,
  storageName: string,
  storage: RegistryStorage,
): Promise<void> {
  for (let i = 0; i < index.manifests.length; i++) {
    const child = index.manifests[i];
    const hex = digestHex(child.digest);
    const m = await storage.getManifest(storageName, hex);
    if (!m) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN,
        `child manifest ${child.digest} not found in ${storageName}`,
      );
    }
  }
}

function projectOciMetadata(
  parsed: ReturnType<typeof parseManifestOrIndex>,
): OciManifestMetadata {
  if (parsed.kind === "manifest") {
    const m = parsed.value;
    const variant = classifySchemaVariant(m.mediaType);
    return {
      isIndex: false,
      schemaVariant: variant,
      configDigest: m.config.digest,
      configMediaType: m.config.mediaType,
      layerDigests: m.layers.map((l) => l.digest),
      totalSize: m.layers.reduce((acc, l) => acc + l.size, m.config.size),
      ...(m.subject ? { subjectDigest: m.subject.digest } : {}),
      ...(m.artifactType ? { artifactType: m.artifactType } : {}),
    };
  }
  const idx = parsed.value;
  return {
    isIndex: true,
    schemaVariant: classifySchemaVariant(idx.mediaType),
    childManifests: idx.manifests.map((c: OciDescriptor) => ({
      digest: c.digest,
      mediaType: c.mediaType,
      size: c.size,
      ...(c.platform
        ? {
            platform: {
              architecture: c.platform.architecture,
              os: c.platform.os,
              ...(c.platform.variant ? { variant: c.platform.variant } : {}),
            },
          }
        : {}),
    })),
    ...(idx.subject ? { subjectDigest: idx.subject.digest } : {}),
    ...(idx.artifactType ? { artifactType: idx.artifactType } : {}),
  };
}

function buildBlobRefsFromManifest(
  manifest: OciManifest,
): Manifest["blobs"] {
  const refs: Manifest["blobs"] = [];
  refs.push({
    mediaType: manifest.config.mediaType,
    sha256: digestHex(manifest.config.digest),
    size: manifest.config.size,
  });
  for (const layer of manifest.layers) {
    // Foreign / urls-only layers don't have local blob rows; skip the
    // blobs[] entry so the storage-layer existence check doesn't fail
    // (which is correct — operator vouched for external availability).
    if (layer.urls && layer.urls.length > 0) continue;
    refs.push({
      mediaType: layer.mediaType,
      sha256: digestHex(layer.digest),
      size: layer.size,
    });
  }
  return refs;
}

function classifySchemaVariant(mediaType: string): "oci-v1" | "docker-v2-2" {
  if (
    mediaType === OCI_MEDIA_TYPES.MANIFEST_V1 ||
    mediaType === OCI_MEDIA_TYPES.INDEX_V1
  )
    return "oci-v1";
  if (
    mediaType === DOCKER_MEDIA_TYPES.MANIFEST_V2_2 ||
    mediaType === DOCKER_MEDIA_TYPES.MANIFEST_LIST_V2_2
  )
    return "docker-v2-2";
  // Allowlist guarantees we never get here, but TypeScript wants the
  // exhaustiveness check.
  return "oci-v1";
}

async function maybeGetCanonicalBytes(
  storage: RegistryStorage,
  name: string,
  version: string,
): Promise<Buffer | null> {
  // The LocalFsRegistryStorage backing exposes getCanonicalManifestBytes
  // but the RegistryStorage interface doesn't require it. Probe.
  const fallback = (
    storage as RegistryStorage & {
      getCanonicalManifestBytes?: (n: string, v: string) => Promise<Buffer | null>;
    }
  ).getCanonicalManifestBytes;
  if (!fallback) return null;
  const bytes = await fallback.call(storage, name, version);
  return bytes;
}

function digestHex(digest: string): string {
  return validateOciDigest(digest);
}

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

/**
 * Parse an Accept header into a deduplicated list of media-type tokens
 * (ignoring q-parameters and other RFC-7231 frills). Returns an empty
 * array when the header is missing, meaning "no preference."
 */
function parseAcceptHeader(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.split(";")[0].trim())
    .filter((part) => part.length > 0);
}
