/**
 * OCI Distribution Spec v1.1 + Image Spec v1.1 type definitions.
 *
 * These types describe the JSON shapes that OCI clients (docker,
 * oras, crane, cosign) send and receive on the wire. Distinct from
 * the registry's storage-row metadata `OciManifestMetadata` (which
 * lives in `registry/src/types.ts` next to the cargo/npm
 * row-metadata types) — the on-wire types here are what gets parsed
 * out of an untrusted request body before being mapped into the
 * storage shape.
 *
 * Strict-validating guards live in `./guards.ts` so this file stays
 * a pure type/constant module (excluded from coverage tracking by
 * the registry's vitest config).
 */

// ── Media types ────────────────────────────────────────────────────

/**
 * Canonical OCI Image Spec v1.1 + Docker v2.2 legacy media types
 * the registry recognises. Two-source-of-truth alignment with the
 * upstream image-spec / distribution-spec:
 *   - OCI v1.1: github.com/opencontainers/image-spec
 *   - Docker v2.2: docs.docker.com/registry/spec/manifest-v2-2
 *
 * Naming convention mirrors `OCI_*` for OCI-canonical types and
 * `DOCKER_*` for legacy Docker types. The cosign payload media type
 * is also surfaced here so M6 can reuse the constant.
 */
export const OCI_MEDIA_TYPES = {
  MANIFEST_V1: "application/vnd.oci.image.manifest.v1+json",
  INDEX_V1: "application/vnd.oci.image.index.v1+json",
  CONFIG_V1: "application/vnd.oci.image.config.v1+json",
  LAYER_TAR: "application/vnd.oci.image.layer.v1.tar",
  LAYER_TAR_GZIP: "application/vnd.oci.image.layer.v1.tar+gzip",
  LAYER_TAR_ZSTD: "application/vnd.oci.image.layer.v1.tar+zstd",
  // Empty config blob used for non-image artifacts (referrers).
  EMPTY: "application/vnd.oci.empty.v1+json",
  // Cosign signature payload, used by M6.
  COSIGN_PAYLOAD: "application/vnd.dev.cosign.simplesigning.v1+json",
} as const;

export const DOCKER_MEDIA_TYPES = {
  MANIFEST_V2_2: "application/vnd.docker.distribution.manifest.v2+json",
  MANIFEST_LIST_V2_2: "application/vnd.docker.distribution.manifest.list.v2+json",
  CONFIG_V1: "application/vnd.docker.container.image.v1+json",
  LAYER_TAR_GZIP: "application/vnd.docker.image.rootfs.diff.tar.gzip",
  LAYER_FOREIGN_TAR_GZIP:
    "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
} as const;

/**
 * Media types accepted on PUT /v2/<name>/manifests/<reference> as a
 * single-platform image manifest. Both OCI v1 and Docker v2.2 are
 * accepted so docker-CLI workflows interoperate.
 */
export const SINGLE_MANIFEST_MEDIA_TYPES: ReadonlySet<string> = new Set([
  OCI_MEDIA_TYPES.MANIFEST_V1,
  DOCKER_MEDIA_TYPES.MANIFEST_V2_2,
]);

/**
 * Media types accepted on PUT as an image index (manifest list).
 */
export const INDEX_MEDIA_TYPES: ReadonlySet<string> = new Set([
  OCI_MEDIA_TYPES.INDEX_V1,
  DOCKER_MEDIA_TYPES.MANIFEST_LIST_V2_2,
]);

// ── Wire types ─────────────────────────────────────────────────────

/**
 * OCI Content Descriptor — the universal pointer to a referenced
 * blob. See OCI Image Spec §Content Descriptors. Every layer, every
 * config, and every child manifest in an index is a descriptor.
 *
 * `digest` is always `<alg>:<hex>`; the registry only accepts
 * `sha256:<64-hex-lowercase>` at v0.5. `mediaType` is informational
 * for the client but used by the registry to dispatch validation.
 * `size` is mandatory per spec; the registry verifies it on PUT
 * against the stored blob's size.
 */
export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
  urls?: string[];
  platform?: OciPlatform;
  artifactType?: string;
}

/**
 * OCI Platform — appears inside descriptors that reside in an
 * image-index. `architecture` + `os` are mandatory per spec;
 * `variant`, `os.version`, `os.features` are optional. The
 * `'os.version'` / `'os.features'` keys hyphen by convention but
 * the JSON shape uses dotted keys verbatim.
 */
export interface OciPlatform {
  architecture: string;
  os: string;
  "os.version"?: string;
  "os.features"?: string[];
  variant?: string;
  features?: string[];
}

/**
 * OCI Image Manifest v1.1 — a single-platform image. One config
 * descriptor + N layer descriptors. The optional `subject` is the
 * OCI 1.1 referrers extension; v0.5 stores it on the row but does
 * not yet implement the referrers GET endpoint (deferred to v0.6).
 */
export interface OciManifest {
  schemaVersion: 2;
  mediaType: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
  annotations?: Record<string, string>;
  subject?: OciDescriptor;
  artifactType?: string;
}

/**
 * OCI Image Index v1.1 (manifest list in Docker v2.2 nomenclature).
 * A list of platform-specific manifest descriptors. Multi-arch
 * images are typically published as one index pointing at N child
 * manifests (one per arch).
 */
export interface OciIndex {
  schemaVersion: 2;
  mediaType: string;
  manifests: OciDescriptor[];
  annotations?: Record<string, string>;
  subject?: OciDescriptor;
  artifactType?: string;
}

/**
 * OCI Image Config — the JSON blob the manifest's `config`
 * descriptor points at. We never parse this server-side beyond
 * counting bytes (it's content-addressed; the operator owns its
 * shape). Surfaced as a type for completeness so M6 cosign payloads
 * can reference it.
 */
export interface OciConfig {
  architecture?: string;
  os?: string;
  config?: Record<string, unknown>;
  rootfs?: { type: "layers"; diff_ids: string[] };
  history?: Array<Record<string, unknown>>;
  created?: string;
}

/**
 * Cosign simple-signing payload — what M6 signs with the operator's
 * Ed25519 key and stores at the `<digest>.sig` tag.
 *
 * Shape comes from sigstore/cosign §Signature Specification:
 *   critical: { identity, image: { docker-manifest-digest }, type }
 *   optional?: free-form
 */
export interface CosignSimpleSigningPayload {
  critical: {
    identity: { "docker-reference": string };
    image: { "docker-manifest-digest": string };
    type: "cosign container image signature";
  };
  optional?: Record<string, unknown> | null;
}

// ── Error envelope ─────────────────────────────────────────────────

/**
 * The exhaustive set of error codes the OCI Distribution Spec
 * defines. Quoted verbatim from §Error Codes (distribution-spec
 * v1.1). `code` MUST be a unique uppercase-underscore identifier;
 * the spec is unambiguous about this naming.
 */
export const OCI_ERROR_CODES = {
  BLOB_UNKNOWN: "BLOB_UNKNOWN",
  BLOB_UPLOAD_INVALID: "BLOB_UPLOAD_INVALID",
  BLOB_UPLOAD_UNKNOWN: "BLOB_UPLOAD_UNKNOWN",
  DIGEST_INVALID: "DIGEST_INVALID",
  MANIFEST_BLOB_UNKNOWN: "MANIFEST_BLOB_UNKNOWN",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  MANIFEST_UNKNOWN: "MANIFEST_UNKNOWN",
  NAME_INVALID: "NAME_INVALID",
  NAME_UNKNOWN: "NAME_UNKNOWN",
  SIZE_INVALID: "SIZE_INVALID",
  UNAUTHORIZED: "UNAUTHORIZED",
  DENIED: "DENIED",
  UNSUPPORTED: "UNSUPPORTED",
  TOOMANYREQUESTS: "TOOMANYREQUESTS",
} as const;

export type OciErrorCode = (typeof OCI_ERROR_CODES)[keyof typeof OCI_ERROR_CODES];

/**
 * Spec-mandated 4XX response body. The spec allows any format on
 * 4XX, but when JSON is returned it MUST match this exact shape.
 * The registry always returns this shape on every 4XX from `/v2/*`.
 */
export interface OciErrorEnvelope {
  errors: Array<{
    code: OciErrorCode;
    message?: string;
    /** Unstructured per spec — may contain arbitrary JSON. */
    detail?: unknown;
  }>;
}
