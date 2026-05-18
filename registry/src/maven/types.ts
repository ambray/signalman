/**
 * Maven wire-format types per Maven Repository Layout 2 + the
 * Maven Central conventions Sonatype publishes for OSSRH.
 *
 * Distinct from the storage-row metadata in `registry/src/types.ts`
 * `MavenManifestMetadata` — these on-wire types describe what
 * clients (Maven, Gradle, sbt, mill) send and receive over the
 * HTTP boundary.
 *
 * Reference:
 *   https://maven.apache.org/repository/layout.html
 *   https://maven.apache.org/ref/3.9.6/maven-repository-metadata/repository-metadata.html
 */

// ── Media types ────────────────────────────────────────────────────

export const MAVEN_MEDIA_TYPES = {
  JAR: "application/java-archive",
  POM: "application/xml",
  XML: "application/xml",
  /** Maven also uses text/xml for metadata. */
  XML_TEXT: "text/xml",
  OCTET_STREAM: "application/octet-stream",
  CHECKSUM: "text/plain",
  ASC: "text/plain",
  /** Gradle Module Metadata file (`.module`). */
  MODULE_JSON: "application/json",
} as const;

/** Extensions Maven Central recognises plus our checksum/signature flavours. */
export const MAVEN_PRIMARY_EXTENSIONS = [
  "jar",
  "pom",
  "war",
  "ear",
  "module",
  "aar",
  "klib",
] as const;

export const MAVEN_CHECKSUM_EXTENSIONS = ["sha1", "md5", "sha256", "sha512"] as const;
export const MAVEN_SIGNATURE_EXTENSIONS = ["asc"] as const;

export type MavenPrimaryExtension = (typeof MAVEN_PRIMARY_EXTENSIONS)[number];
export type MavenChecksumExtension = (typeof MAVEN_CHECKSUM_EXTENSIONS)[number];
export type MavenSignatureExtension = (typeof MAVEN_SIGNATURE_EXTENSIONS)[number];

// ── Maven coordinate ───────────────────────────────────────────────

/**
 * Maven coordinate triple (GAV) plus optional classifier + extension.
 *
 * Snapshot artifacts have two version flavours in the wire:
 *   - **base**: `1.2.3-SNAPSHOT`. The artifactId / metadata path
 *     uses this form.
 *   - **resolved**: `1.2.3-20260517.123456-1` (timestamp + build).
 *     The per-file path uses this form once the server resolves
 *     the snapshot.
 *
 * We carry both — `version` is the resolved one for snapshot files
 * (or identical to `baseVersion` for non-snapshots), and
 * `baseVersion` is the path-segment form.
 */
export interface MavenCoordinate {
  groupId: string;
  artifactId: string;
  /** Resolved version (timestamped for snapshots, plain otherwise). */
  version: string;
  /** Path-segment version (`<base>-SNAPSHOT` for snapshots). */
  baseVersion: string;
  classifier?: string;
  extension: string;
  /** True when `baseVersion` ends with `-SNAPSHOT`. */
  isSnapshot: boolean;
  /** When set, this is a resolved-snapshot artifact; the snapshot
   *  block carries the timestamp + buildNumber. */
  snapshot?: MavenSnapshotResolution;
}

export interface MavenSnapshotResolution {
  /** YYYYMMDD.HHMMSS form, e.g. `20260517.123456`. */
  timestamp: string;
  /** Monotonic per-base-version build counter, 1-indexed. */
  buildNumber: number;
}

// ── Snapshot policy ────────────────────────────────────────────────

/**
 * Per-org / per-upstream snapshot acceptance policy. M0 locked the
 * default as `reject` — Maven Central itself rejects snapshots in
 * `repo1.maven.org`, and operators who want a snapshot lane opt in
 * deliberately.
 */
export type MavenSnapshotPolicy = "reject" | "accept";

// ── maven-metadata.xml shapes ──────────────────────────────────────

/**
 * Artifact-level metadata (one per groupId+artifactId). Mavens use
 * this to discover the latest / release version and the available
 * version list. Lives at
 * `<groupPath>/<artifactId>/maven-metadata.xml`.
 */
export interface MavenArtifactMetadata {
  groupId: string;
  artifactId: string;
  versioning: {
    latest?: string;
    release?: string;
    versions: string[];
    /** ISO-8601 UTC, but Maven also stores `yyyyMMddHHmmss`. We round-trip both. */
    lastUpdated?: string;
  };
}

/**
 * Version-level snapshot metadata (one per groupId+artifactId+
 * baseVersion). Maven uses this to learn the active resolved
 * snapshot (`localCopy`) + the per-extension snapshot version list.
 * Lives at
 * `<groupPath>/<artifactId>/<baseVersion>/maven-metadata.xml`.
 */
export interface MavenSnapshotMetadata {
  groupId: string;
  artifactId: string;
  version: string; // == baseVersion (e.g. "1.2.3-SNAPSHOT")
  versioning: {
    snapshot: {
      timestamp: string;
      buildNumber: number;
    };
    lastUpdated?: string;
    snapshotVersions?: Array<{
      classifier?: string;
      extension: string;
      value: string; // e.g. "1.2.3-20260517.123456-1"
      updated?: string;
    }>;
  };
}

// ── Error envelope ─────────────────────────────────────────────────

/**
 * Maven does not standardise a JSON error envelope (the wire is
 * pure HTTP — 200/404/409/400 with optional plain-text bodies).
 * We emit a small, stable JSON envelope on 4XX/5XX for operator
 * tooling friendliness; Maven + Gradle ignore the body and only
 * read the status code.
 */
export interface MavenErrorEnvelope {
  errors: Array<{
    code: MavenErrorCode;
    message: string;
    detail?: unknown;
  }>;
}

export const MAVEN_ERROR_CODES = {
  COORDINATE_INVALID: "COORDINATE_INVALID",
  GROUP_INVALID: "GROUP_INVALID",
  ARTIFACT_INVALID: "ARTIFACT_INVALID",
  VERSION_INVALID: "VERSION_INVALID",
  FILENAME_INVALID: "FILENAME_INVALID",
  EXTENSION_INVALID: "EXTENSION_INVALID",
  CLASSIFIER_INVALID: "CLASSIFIER_INVALID",
  ARTIFACT_NOT_FOUND: "ARTIFACT_NOT_FOUND",
  METADATA_NOT_FOUND: "METADATA_NOT_FOUND",
  CONFLICT: "CONFLICT",
  SNAPSHOT_REFUSED: "SNAPSHOT_REFUSED",
  UPLOAD_INVALID: "UPLOAD_INVALID",
  UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export type MavenErrorCode =
  (typeof MAVEN_ERROR_CODES)[keyof typeof MAVEN_ERROR_CODES];
