/**
 * Generic blob + manifest format for `@signalman/registry`.
 *
 * The registry is the v0.4.0 spin-out of `@signalman/host`'s
 * BlobDriver / release-manifest model. Two shapes live at the
 * registry-protocol boundary:
 *
 *   - `Blob`: content-addressed bytes. Identity = sha256.
 *   - `Manifest`: a named, versioned record that pins zero or more
 *     blob references plus optional Ed25519 signature.
 *
 * Storage is pluggable behind `RegistryStorage`. The bootstrap
 * milestone ships a single LocalFsRegistryStorage; an S3 / object-
 * store driver lands in v0.4.x.
 *
 * `parseBlobRef` / `formatBlobRef` exist because manifests serialize
 * blob references as plain strings (`<media-type>@sha256:<hex>`).
 * Serializing as a struct would waste bytes and break OCI-spec parity
 * later. The parser is strict — invalid input throws a
 * `RegistryError(BAD_BLOB_REF)`.
 */

import type { Readable } from "node:stream";

// Blob ----------------------------------------------------------------

export interface Blob {
  /** Lowercase hex, exactly 64 chars. Identity of the blob. */
  sha256: string;
  /** Byte length as reported by the storage driver at ingest time. */
  size: number;
  /** Optional media type; advisory, not enforced. */
  contentType?: string;
  /** ISO-8601 UTC timestamp recorded when the blob was first written. */
  createdAt: string;
}

/**
 * A reference to a blob from inside a manifest. Carries the media
 * type (so consumers know how to interpret the bytes) and the
 * content-addressed sha. Serializes as `<media-type>@sha256:<hex>`.
 */
export interface BlobRef {
  mediaType: string;
  sha256: string;
  /** Optional size hint; informational, never trusted over storage. */
  size?: number;
  /** Optional logical name (e.g. "linux-amd64.tar.gz"). */
  name?: string;
}

// Manifest ------------------------------------------------------------

export interface ManifestSignature {
  /** Base64-encoded raw Ed25519 signature (88 base64 chars). */
  signatureB64: string;
  /** First 16 hex chars of sha256(DER-encoded SPKI public key). */
  signedBy: string;
}

/**
 * WS6 wave-3 carve-out #9 (M10): discriminator for the manifest's
 * protocol-specific shape. The base `Manifest` carries the fields
 * common to every kind; per-kind metadata lives in `<kind>Metadata`
 * sub-fields. This lets one storage backend host generic, cargo,
 * npm, and OCI artifacts without per-format tables.
 *
 * - `generic` — back-compat with v0.4.0 (the only kind that existed).
 *   No protocol-specific metadata.
 * - `cargo` — Rust crate. Carries `cargoMetadata` with deps,
 *   features, yanked state, and the canonical crate-name/version
 *   that the sparse index serves.
 * - `npm` — npm package. (Schema reserved; M11 ships the impl.)
 * - `oci` — OCI image manifest. (Schema reserved; v0.4.1 in the
 *   WS5 ROADMAP.)
 */
export type ManifestKind = "generic" | "cargo" | "npm" | "oci";

/**
 * WS6 wave-3 carve-out #9 (M10): cargo-specific metadata.
 * Serialized into the manifest's `cargoMetadata` field when
 * `kind === 'cargo'`. The cargo sparse-index handler reads
 * directly from this shape; no separate `cargo_crate_version`
 * table.
 *
 * Field names match the cargo registry-protocol JSON shape (see
 * https://doc.rust-lang.org/cargo/reference/registry-index.html)
 * so the index handler can pass them through with minimal rewriting.
 */
export interface CargoManifestMetadata {
  /** The crate name, lowercase normalised. */
  name: string;
  /** Semver string. */
  vers: string;
  /** Direct dependencies. */
  deps: CargoDependency[];
  /** sha256 of the .crate tarball (hex). Mirrors `cargoMetadata.cksum` in cargo's index. */
  cksum: string;
  /** Optional features map (name → required deps/features). */
  features?: Record<string, string[]>;
  /** True when this version is yanked from the index. */
  yanked: boolean;
  /** Optional MSRV (`cargo:rust_version`). */
  rust_version?: string;
  /** Optional alternate links (homepage, docs, repository). Informational. */
  links?: string;
}

export interface CargoDependency {
  name: string;
  req: string;
  features: string[];
  optional: boolean;
  default_features: boolean;
  target?: string | null;
  kind?: "dev" | "build" | "normal";
  registry?: string | null;
  package?: string;
}

/**
 * WS6 wave-3 carve-out #9 (M10): provenance metadata.
 *
 * Every artifact ingested into the registry carries provenance —
 * "where did this come from?". This powers the forensic / SBOM
 * surface the operator can query via `GET /v1/provenance/<sha256>`.
 *
 * - `source` is the discriminator: how this artifact got here.
 * - For `proxy_cache` entries, `upstreamUrl` + `fetchedAt` capture
 *   the upstream identity; `originalSignature` (if present) carries
 *   the upstream's signature verbatim; the registry's own
 *   `Manifest.signature` (if present) is the operator's re-sign.
 * - For `upload` entries, `fetchedBy` carries the actor token id.
 *
 * The forensic API answers "what's in my registry and where did it
 * come from"; long-term this links into the host's deployments
 * table so an operator can trace any deployment back to the
 * artifacts it pulled.
 */
export interface Provenance {
  source: "upload" | "proxy_cache" | "manifest_create" | "migration";
  /** For `proxy_cache`: the upstream URL the bytes were fetched from. */
  upstreamUrl?: string;
  /** ISO-8601 when the bytes entered our registry. */
  fetchedAt: string;
  /** Token-id fragment of the actor who triggered ingest (16 hex chars). */
  fetchedBy?: string;
  /**
   * For `proxy_cache`: the original upstream signature (if any),
   * preserved verbatim alongside our re-sign for audit purposes.
   */
  originalSignature?: ManifestSignature;
}

export interface Manifest {
  /**
   * Manifest name. Lowercase alphanumeric plus `-`, `_`, `.`, `/`;
   * 1-255 chars. The slash is allowed so namespaced names
   * (`org/foo`, `team/svc/sub`) survive the registry-to-OCI port.
   *
   * For cargo: prefer org-namespaced shape `cargo/<org>/<crate>`
   * to keep multi-tenant collisions impossible. The cargo handler
   * does this automatically; direct manifest writers pick their
   * own prefix.
   */
  name: string;
  /**
   * Version string. Any non-empty UTF-8 except whitespace and `/`;
   * tag semantics (`latest`, `staging`, etc.) are deferred.
   */
  version: string;
  /** Media type identifier; namespaces the manifest schema. */
  mediaType: string;
  /**
   * WS6 wave-3 (M10): protocol-specific discriminator. Operator-
   * signed content; old v0.4.0 manifests omit this field and the
   * storage layer surfaces them as `kind: 'generic'` on read.
   *
   * **Signing contract**: when present, this field is included in
   * the canonical bytes that the operator signs. The server MUST
   * preserve the operator's canonical bytes byte-for-byte; it does
   * NOT re-canonicalize on write. Cargo / npm / OCI handlers
   * always set this field explicitly.
   */
  kind?: ManifestKind;
  /** Blob refs the manifest pins. May be empty for metadata-only manifests. */
  blobs: BlobRef[];
  /** Optional key/value annotations. Free-form. */
  annotations?: Record<string, string>;
  /**
   * Optional signature. Present when the manifest was signed at push
   * time; consumers verify with `verifyManifest`. Unsigned manifests
   * are accepted by the v0.4.0 server but flagged by the verify CLI.
   */
  signature?: ManifestSignature;
  /**
   * WS6 wave-3 (M10): cargo-specific metadata when `kind === 'cargo'`.
   * Operator-signed content; absent for other kinds.
   */
  cargoMetadata?: CargoManifestMetadata;
  /** ISO-8601 UTC timestamp when the manifest was first written. */
  createdAt: string;
}

/**
 * WS6 wave-3 (M10): a manifest paired with the server's row-side
 * metadata. The HTTP pull endpoint returns this shape on
 * `GET /v1/manifests/<name>/<version>` so the operator can see the
 * provenance without it bleeding into the operator-signed `Manifest`
 * canonical bytes.
 *
 * Signing contract: `provenance` is server-side metadata. It is NEVER
 * part of the canonical bytes the operator signed; the verify path
 * MUST NOT include it in the bytes it feeds to `verifyManifest`.
 */
export interface ManifestWithProvenance {
  manifest: Manifest;
  provenance: Provenance;
}

export interface ListedManifest {
  name: string;
  version: string;
  mediaType: string;
  /** WS6 wave-3 (M10): protocol discriminator. */
  kind: ManifestKind;
  createdAt: string;
  signed: boolean;
}

// Storage -------------------------------------------------------------

export interface RegistryStorage {
  /**
   * Write blob bytes. Returns the recorded Blob (sha256 computed by
   * the driver while streaming). Idempotent when a blob with the
   * same sha already exists.
   */
  putBlob(input: {
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<Blob>;

  /** Open a read stream for a previously-stored blob. */
  getBlob(sha256: string): Promise<Readable>;

  /** Returns null when the blob is absent. */
  statBlob(sha256: string): Promise<Blob | null>;

  /**
   * Write a manifest. Mirrors `putBlob`'s idempotency: re-putting the
   * same `(name, version)` with identical content is a no-op,
   * different content is `MANIFEST_EXISTS` (RegistryError). The
   * server-side handler decides whether to allow overwrite via RBAC.
   *
   * WS6 wave-3 (M10): caller MAY supply explicit `provenance` for
   * cache-fill / proxy-pull paths. When absent, the storage layer
   * records `source: 'manifest_create'` at the current timestamp.
   */
  putManifest(manifest: Manifest, provenance?: Provenance): Promise<Manifest>;

  /** Returns null if the (name, version) pair is unknown. */
  getManifest(name: string, version: string): Promise<Manifest | null>;

  /**
   * WS6 wave-3 (M10): fetch row-side provenance for an existing
   * manifest. The forensic API uses this; the standard GET also
   * surfaces it as a sibling alongside the manifest body.
   */
  getProvenance?(name: string, version: string): Promise<Provenance | null>;

  /** List versions of a given manifest name, newest first. */
  listManifestVersions(name: string): Promise<ListedManifest[]>;

  /**
   * Admin-only delete. Removes the manifest row from the catalog;
   * does NOT GC referenced blobs (retention/GC is a v0.4.x feature).
   */
  deleteManifest(name: string, version: string): Promise<void>;
}

// Errors --------------------------------------------------------------

export const REGISTRY_ERROR_CODES = {
  BAD_BLOB_REF: "bad_blob_ref",
  BAD_MANIFEST: "bad_manifest",
  BAD_NAME: "bad_name",
  BAD_VERSION: "bad_version",
  BAD_SHA256: "bad_sha256",
  BLOB_NOT_FOUND: "blob_not_found",
  MANIFEST_NOT_FOUND: "manifest_not_found",
  MANIFEST_EXISTS: "manifest_exists",
  SIGNATURE_INVALID: "signature_invalid",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
} as const;

export type RegistryErrorCode =
  (typeof REGISTRY_ERROR_CODES)[keyof typeof REGISTRY_ERROR_CODES];

export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

// BlobRef parser ------------------------------------------------------

// Media-type: anything but whitespace and the `@` separator. Length
// capped at 256 to defend against absurd inputs in error paths.
const BLOB_REF_RE = /^([^@\s]{1,256})@sha256:([a-f0-9]{64})(?:\?size=(\d+))?$/;

/**
 * Parse a serialized BlobRef. Format:
 *   `<media-type>@sha256:<64-hex>` (optional `?size=<n>` suffix)
 *
 * `name` is not encoded in the string form — it travels separately
 * in the parent manifest's blob list when present. The parser
 * rejects anything that doesn't match the regex exactly to avoid
 * media-type spoofing via embedded whitespace.
 */
export function parseBlobRef(s: string): BlobRef {
  const m = BLOB_REF_RE.exec(s);
  if (!m) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_BLOB_REF,
      `invalid blob ref: ${truncateForError(s)}`,
    );
  }
  const ref: BlobRef = {
    mediaType: m[1],
    sha256: m[2],
  };
  if (m[3] !== undefined) {
    const size = Number(m[3]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_BLOB_REF,
        `invalid blob ref size: ${m[3]}`,
      );
    }
    ref.size = size;
  }
  return ref;
}

/** Inverse of `parseBlobRef`. Skips the `?size=` suffix when omitted. */
export function formatBlobRef(ref: BlobRef): string {
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_SHA256,
      `invalid sha256: ${truncateForError(ref.sha256)}`,
    );
  }
  if (ref.mediaType.length === 0 || /[\s@]/.test(ref.mediaType)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_BLOB_REF,
      `invalid media type: ${truncateForError(ref.mediaType)}`,
    );
  }
  const base = `${ref.mediaType}@sha256:${ref.sha256}`;
  return ref.size === undefined ? base : `${base}?size=${ref.size}`;
}

// Validation helpers --------------------------------------------------

// Names: lowercase letters/digits with `.`, `_`, `-`, `/` separators.
// Must start + end alphanumeric. Up to 255 chars total. Slash allows
// namespaced names like `org/foo`.
const NAME_RE = /^[a-z0-9](?:[a-z0-9._/-]{0,253}[a-z0-9])?$/;

export function validateManifestName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `invalid manifest name: ${truncateForError(name)}`,
    );
  }
  if (name.includes("..")) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `manifest name must not contain '..': ${truncateForError(name)}`,
    );
  }
}

export function validateManifestVersion(version: string): void {
  if (version.length === 0 || version.length > 255) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_VERSION,
      `invalid manifest version length: ${truncateForError(version)}`,
    );
  }
  // Forbid whitespace, slash, control chars, and `..` traversal sequences.
  for (let i = 0; i < version.length; i++) {
    const code = version.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || version[i] === "/") {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_VERSION,
        `invalid manifest version: ${truncateForError(version)}`,
      );
    }
  }
  if (version.includes("..")) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_VERSION,
      `manifest version must not contain '..': ${truncateForError(version)}`,
    );
  }
}

export function validateSha256(sha: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_SHA256,
      `invalid sha256: ${truncateForError(sha)}`,
    );
  }
}

function truncateForError(s: string): string {
  if (s.length <= 64) return s;
  return `${s.slice(0, 64)}...`;
}
