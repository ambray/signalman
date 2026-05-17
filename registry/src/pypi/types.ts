/**
 * PyPI / pip wire-format types per PEP 503 (Simple Repository API),
 * PEP 691 (JSON variant), PEP 658 (metadata files), PEP 700 (versions
 * field), and PEP 592 (yanked releases).
 *
 * Distinct from the storage-row metadata in `registry/src/types.ts`
 * `PypiManifestMetadata` — these on-wire types describe what clients
 * (pip, twine, uv) send and receive over the HTTP boundary. Strict
 * validators live in `./guards.ts` so this file stays pure types +
 * constants.
 */

// ── Media types ────────────────────────────────────────────────────

export const PYPI_MEDIA_TYPES = {
  /** PEP 691: JSON Simple Repository API. Negotiated via Accept header. */
  SIMPLE_JSON_V1: "application/vnd.pypi.simple.v1+json",
  /** PEP 503: HTML Simple Repository API. Default for older pip. */
  SIMPLE_HTML: "text/html",
  /** PEP 658: per-file core-metadata file (the wheel METADATA contents). */
  CORE_METADATA: "application/vnd.pypi.metadata.v1.0+text",
  /** Wheel binary distribution. */
  WHEEL: "application/octet-stream",
  /** Source distribution (sdist) — typically tar.gz. */
  SDIST: "application/octet-stream",
} as const;

/** PEP 691 currently revises to `1.1` (PEP 700 adds the `versions` key). */
export const PYPI_API_VERSION = "1.1";

// ── PEP 691 JSON response shapes ───────────────────────────────────

/**
 * PEP 691 JSON Simple Repository API — package list response
 * for `GET /simple/`. Lists all known packages.
 */
export interface PypiSimpleProjectListResponse {
  meta: { "api-version": string };
  projects: Array<{ name: string }>;
}

/**
 * PEP 691 JSON Simple Repository API — per-package response for
 * `GET /simple/<package>/`. PEP 700 adds the `versions` field.
 */
export interface PypiSimpleProjectResponse {
  meta: { "api-version": string };
  name: string;
  files: PypiSimpleFile[];
  /** PEP 700: distinct PEP 440 versions, sorted by upload order. */
  versions: string[];
}

/**
 * PEP 691 file entry. Each file (wheel or sdist) of a project.
 */
export interface PypiSimpleFile {
  filename: string;
  /** Absolute or relative URL the client fetches the bytes from. */
  url: string;
  /** SHA-256 (and optionally MD5) of the file. */
  hashes: { sha256: string; md5?: string };
  /** PEP 345 / PEP 440 requires-python spec, e.g. ">=3.8,<4". */
  "requires-python"?: string;
  /** PEP 592: false if not yanked; string reason or true when yanked. */
  yanked?: boolean | string;
  /** PEP 658: when present, `<filename>.metadata` exists; carries the hash. */
  "core-metadata"?: boolean | { sha256: string };
  /** Optional GPG signature URL (legacy). */
  "gpg-sig"?: boolean;
  /** PEP 714: opaque tag identifying the upload tooling. */
  size?: number;
  /** PEP 700: ISO-8601 upload timestamp. */
  "upload-time"?: string;
}

// ── Twine upload form fields (legacy multipart) ────────────────────

/**
 * Field names twine sends in a `:action=file_upload` POST. The PyPI
 * legacy upload endpoint accepts these as multipart form parts; we
 * mirror the same shape so any twine-compatible client (twine itself,
 * `uv publish`, `flit publish --repository`) works unchanged.
 *
 * Required fields: `:action`, `name`, `version`, `filetype`, `content`,
 * `sha256_digest`. The rest are optional metadata-2.x fields from the
 * package's METADATA / PKG-INFO file that twine extracts and forwards.
 */
export const TWINE_REQUIRED_FIELDS = [
  ":action",
  "name",
  "version",
  "filetype",
  "content",
  "sha256_digest",
] as const;

export type TwineFileType = "sdist" | "bdist_wheel";

/**
 * The aggregated upload-shape `parseUploadBody` returns. Holds both
 * the binary file (content) and the metadata fields the parser
 * extracted from the multipart form.
 */
export interface TwineUpload {
  filename: string;
  filetype: TwineFileType;
  /** PEP 440 version string. */
  version: string;
  /** Normalised PyPI package name (PEP 503). */
  packageName: string;
  /** sha256 of `content`, as the client computed. We re-verify. */
  declaredSha256: string;
  /** Raw file bytes. */
  content: Buffer;
  /** Every other form field the client sent, raw. */
  fields: Record<string, string | string[]>;
}

// ── Error envelope ─────────────────────────────────────────────────

/**
 * PyPI does not standardise a JSON error envelope the way OCI does
 * (PEP 691 only specifies success shapes). We emit a small, stable
 * envelope here so operator tooling can parse failures uniformly.
 */
export interface PypiErrorEnvelope {
  errors: Array<{
    code: PypiErrorCode;
    message: string;
    detail?: unknown;
  }>;
}

export const PYPI_ERROR_CODES = {
  NAME_INVALID: "NAME_INVALID",
  VERSION_INVALID: "VERSION_INVALID",
  FILENAME_INVALID: "FILENAME_INVALID",
  DIGEST_INVALID: "DIGEST_INVALID",
  DIGEST_MISMATCH: "DIGEST_MISMATCH",
  PACKAGE_NOT_FOUND: "PACKAGE_NOT_FOUND",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  UPLOAD_INVALID: "UPLOAD_INVALID",
  UNSUPPORTED_FILETYPE: "UNSUPPORTED_FILETYPE",
  UNAUTHORIZED: "UNAUTHORIZED",
  CONFLICT: "CONFLICT",
} as const;

export type PypiErrorCode =
  (typeof PYPI_ERROR_CODES)[keyof typeof PYPI_ERROR_CODES];
