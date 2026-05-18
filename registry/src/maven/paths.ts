/**
 * Maven path composition + parsing per Maven Repository Layout 2.
 *
 * **Path grammar:**
 *   `<groupPath>/<artifactId>/<baseVersion>/<artifactId>-<version>[-<classifier>].<extension>[.<checksum-or-sig>]`
 *
 * Where:
 *   - `groupPath` is the groupId with dots replaced by slashes.
 *     e.g. `com.example.tools` → `com/example/tools`.
 *   - `baseVersion` is the version with `-SNAPSHOT` preserved.
 *   - `version` matches `baseVersion` for releases; for snapshots
 *     it's either still `<base>-SNAPSHOT` (non-resolved) or the
 *     timestamped form `<base>-yyyyMMdd.HHmmss-N` (resolved).
 *   - `classifier` is optional (`sources`, `javadoc`, custom).
 *   - `extension` is one of `jar`, `pom`, `war`, `ear`, `module`,
 *     `aar`, `klib` (the PRIMARY set), and may itself carry a
 *     trailing checksum (`sha1`/`md5`/`sha256`/`sha512`) or
 *     signature (`asc`) suffix.
 *
 * Per-org namespacing: storage manifest name is
 *   `maven/<org>/<groupId>/<artifactId>`
 * with the groupId stored unsplit (dots, not slashes) to keep
 * round-trips simple. Version key is `<baseVersion>/<filename>`.
 */

import { validateCargoOrgName } from "../cargo/paths.js";
import { MavenError } from "./errors.js";
import {
  MAVEN_CHECKSUM_EXTENSIONS,
  MAVEN_ERROR_CODES,
  MAVEN_PRIMARY_EXTENSIONS,
  MAVEN_SIGNATURE_EXTENSIONS,
  type MavenChecksumExtension,
  type MavenCoordinate,
  type MavenPrimaryExtension,
  type MavenSignatureExtension,
  type MavenSnapshotResolution,
} from "./types.js";

/** Maven groupId is a dot-separated identifier-segment list. */
const GROUP_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

/** Maven artifactId is a single identifier-segment with `-`/`_`. */
const ARTIFACT_ID_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/**
 * Maven version: lenient grammar. We reject path-traversal, control
 * chars, whitespace, slashes, but accept the wide range of versions
 * the Maven ecosystem deploys (semver, milestones, RC tags, dates,
 * snapshots, resolved-snapshots).
 */
const VERSION_RE = /^[A-Za-z0-9._+~-]{1,128}$/;

/** Classifier: same shape as a single artifactId segment. */
const CLASSIFIER_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Resolved snapshot tail: `<base>-yyyyMMdd.HHmmss-N`. */
const RESOLVED_SNAPSHOT_TAIL_RE = /-(\d{8}\.\d{6})-(\d+)$/;

const MAX_GROUP_ID = 200;
const MAX_ARTIFACT_ID = 128;
const MAX_FILENAME = 255;

// ── Validation ─────────────────────────────────────────────────────

export function validateMavenGroupId(groupId: string): void {
  if (typeof groupId !== "string" || groupId.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.GROUP_INVALID,
      "groupId must be a non-empty string",
    );
  }
  if (groupId.length > MAX_GROUP_ID) {
    throw new MavenError(
      MAVEN_ERROR_CODES.GROUP_INVALID,
      `groupId length ${groupId.length} exceeds max ${MAX_GROUP_ID}`,
    );
  }
  if (!GROUP_ID_RE.test(groupId)) {
    throw new MavenError(
      MAVEN_ERROR_CODES.GROUP_INVALID,
      `groupId '${truncate(groupId)}' is not a valid dot-separated identifier`,
    );
  }
  if (groupId.includes("..")) {
    throw new MavenError(
      MAVEN_ERROR_CODES.GROUP_INVALID,
      "groupId must not contain consecutive dots",
    );
  }
}

export function validateMavenArtifactId(artifactId: string): void {
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_INVALID,
      "artifactId must be a non-empty string",
    );
  }
  if (artifactId.length > MAX_ARTIFACT_ID) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_INVALID,
      `artifactId length ${artifactId.length} exceeds max ${MAX_ARTIFACT_ID}`,
    );
  }
  if (!ARTIFACT_ID_RE.test(artifactId)) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_INVALID,
      `artifactId '${truncate(artifactId)}' contains characters outside the allowlist`,
    );
  }
}

export function validateMavenVersion(version: string): void {
  if (typeof version !== "string" || version.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.VERSION_INVALID,
      "version must be a non-empty string",
    );
  }
  if (!VERSION_RE.test(version)) {
    throw new MavenError(
      MAVEN_ERROR_CODES.VERSION_INVALID,
      `version '${truncate(version)}' contains characters outside the Maven allowlist`,
    );
  }
  if (version.includes("..")) {
    throw new MavenError(
      MAVEN_ERROR_CODES.VERSION_INVALID,
      "version must not contain '..'",
    );
  }
}

export function validateMavenClassifier(classifier: string): void {
  if (typeof classifier !== "string" || classifier.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.CLASSIFIER_INVALID,
      "classifier must be a non-empty string",
    );
  }
  if (!CLASSIFIER_RE.test(classifier)) {
    throw new MavenError(
      MAVEN_ERROR_CODES.CLASSIFIER_INVALID,
      `classifier '${truncate(classifier)}' contains characters outside the allowlist`,
    );
  }
}

// ── Snapshot detection ─────────────────────────────────────────────

export function isSnapshotVersion(version: string): boolean {
  return version.endsWith("-SNAPSHOT");
}

/**
 * Inspect a Maven version string and return the resolved-snapshot
 * timestamp + build number when present. Returns null for plain
 * `-SNAPSHOT` strings (non-resolved) and for releases.
 */
export function parseResolvedSnapshot(
  version: string,
): MavenSnapshotResolution | null {
  // Strip the resolved-snapshot tail; whatever remains must be the
  // base (release-form) version per `-<timestamp>-<build>` Maven
  // Central convention.
  const m = RESOLVED_SNAPSHOT_TAIL_RE.exec(version);
  if (!m) return null;
  return {
    timestamp: m[1],
    buildNumber: parseInt(m[2], 10),
  };
}

/**
 * Given a (possibly resolved) snapshot version, return the
 * `<base>-SNAPSHOT` form. For a non-snapshot version, returns the
 * version unchanged.
 */
export function snapshotBaseVersion(version: string): string {
  if (isSnapshotVersion(version)) return version;
  const m = RESOLVED_SNAPSHOT_TAIL_RE.exec(version);
  if (!m) return version;
  const head = version.slice(0, m.index);
  return `${head}-SNAPSHOT`;
}

// ── Path composition ───────────────────────────────────────────────

/**
 * groupId → groupPath. `com.example.tools` → `com/example/tools`.
 */
export function groupPath(groupId: string): string {
  validateMavenGroupId(groupId);
  return groupId.replace(/\./g, "/");
}

/**
 * Inverse: `com/example/tools` → `com.example.tools`. Throws on
 * empty segments or path-traversal attempts.
 */
export function parseGroupPath(p: string): string {
  if (p.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.GROUP_INVALID,
      "groupPath must be a non-empty path",
    );
  }
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new MavenError(
        MAVEN_ERROR_CODES.GROUP_INVALID,
        "groupPath must not contain empty segments",
      );
    }
    if (seg === "." || seg === "..") {
      throw new MavenError(
        MAVEN_ERROR_CODES.GROUP_INVALID,
        "groupPath must not contain '.' or '..' segments",
      );
    }
  }
  const groupId = segments.join(".");
  validateMavenGroupId(groupId);
  return groupId;
}

/**
 * Compose the artifact filename. For releases: `<artifactId>-
 * <version>[-<classifier>].<extension>`. Multi-suffix extensions
 * (`jar.asc`, `pom.sha1`) are emitted verbatim.
 */
export function composeMavenFilename(coord: MavenCoordinate): string {
  validateMavenArtifactId(coord.artifactId);
  validateMavenVersion(coord.version);
  if (coord.classifier) validateMavenClassifier(coord.classifier);
  validateExtension(coord.extension);
  const classifierSegment = coord.classifier ? `-${coord.classifier}` : "";
  return `${coord.artifactId}-${coord.version}${classifierSegment}.${coord.extension}`;
}

/**
 * Compose the wire path under the registry: the per-org repo prefix
 * `/maven/<org>/` is added by the mount layer.
 */
export function composeMavenPath(coord: MavenCoordinate): string {
  const filename = composeMavenFilename(coord);
  return `${groupPath(coord.groupId)}/${coord.artifactId}/${coord.baseVersion}/${filename}`;
}

/**
 * Parse a maven path **below the per-org repo prefix** into a
 * `MavenCoordinate` shape. Returns null when the path doesn't
 * conform; throws `MavenError` when it conforms but a segment is
 * invalid.
 *
 * Example input: `com/example/demo-lib/1.2.3/demo-lib-1.2.3.jar`
 * Example input: `com/example/demo-lib/1.2.3-SNAPSHOT/demo-lib-1.2.3-20260517.123456-1.jar`
 */
export function parseMavenPath(p: string): MavenCoordinate | null {
  if (p.length === 0 || p.startsWith("/") || p.endsWith("/")) return null;
  const segments = p.split("/");
  if (segments.length < 4) return null;

  // Filename = last segment; baseVersion = second-to-last; artifactId
  // = third-to-last; groupPath = everything before.
  const filename = segments[segments.length - 1];
  const baseVersion = segments[segments.length - 2];
  const artifactId = segments[segments.length - 3];
  const groupSegments = segments.slice(0, segments.length - 3);
  if (groupSegments.length === 0) return null;

  validateMavenArtifactId(artifactId);
  validateMavenVersion(baseVersion);
  const groupId = groupSegments.join(".");
  validateMavenGroupId(groupId);

  // Filename structure: <artifactId>-<version>[-<classifier>].<extension>
  // where <extension> may itself have a trailing checksum or signature
  // suffix. We don't validate the filename's <artifactId> against
  // <artifactId> from the path because Maven is sometimes lenient
  // (`com.foo:bar` artifact whose final path uses `bar` is fine but
  // a strict parse here would reject naming-canonical artifacts that
  // are technically valid). Instead we require the filename to BEGIN
  // with `<artifactId>-` and decompose from there.
  const filenamePrefix = `${artifactId}-`;
  if (!filename.startsWith(filenamePrefix)) {
    throw new MavenError(
      MAVEN_ERROR_CODES.FILENAME_INVALID,
      `filename '${filename}' does not start with artifactId prefix '${filenamePrefix}'`,
    );
  }
  const rest = filename.slice(filenamePrefix.length);
  if (rest.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.FILENAME_INVALID,
      `filename '${filename}' has no version + extension after artifactId prefix`,
    );
  }

  // Find the extension. Multi-suffix extensions (`.jar.asc`,
  // `.pom.sha1`) require us to look at the LAST dot first, then
  // walk back if the suffix is a checksum or signature variant.
  const lastDot = rest.lastIndexOf(".");
  if (lastDot <= 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.FILENAME_INVALID,
      `filename '${filename}' has no extension separator`,
    );
  }
  let extension = rest.slice(lastDot + 1);
  let stem = rest.slice(0, lastDot);

  const suffixCheck = MAVEN_CHECKSUM_EXTENSIONS as readonly string[];
  const sigCheck = MAVEN_SIGNATURE_EXTENSIONS as readonly string[];
  if (suffixCheck.includes(extension) || sigCheck.includes(extension)) {
    // Walk back one more dot — `*.jar.asc` peels to extension =
    // `jar.asc`, stem = `<artifactId>-<version>[-<classifier>]`.
    const innerDot = stem.lastIndexOf(".");
    if (innerDot > 0) {
      const inner = stem.slice(innerDot + 1);
      // Only peel back when the inner is a primary extension —
      // otherwise we'd misinterpret e.g. `<classifier>.<asc>`-shaped
      // filenames. For Maven Central + OSSRH, the inner is always a
      // primary extension when a checksum / signature is attached.
      if ((MAVEN_PRIMARY_EXTENSIONS as readonly string[]).includes(inner)) {
        extension = `${inner}.${extension}`;
        stem = stem.slice(0, innerDot);
      }
    }
  }

  validateExtension(extension);

  // Stem = `<version>[-<classifier>]`. We need to decide where the
  // version ends. Strategy: try the longest version + no classifier
  // first; if that doesn't match the baseVersion or its resolved
  // form, fall back to splitting on the LAST `-`.
  //
  // For a release (`baseVersion === version`), the path's
  // baseVersion equals the filename's version, so we can detect it
  // exactly:
  if (stem === baseVersion) {
    return {
      groupId,
      artifactId,
      version: baseVersion,
      baseVersion,
      extension,
      isSnapshot: isSnapshotVersion(baseVersion),
    };
  }
  // <baseVersion>-<classifier>:
  if (stem.startsWith(`${baseVersion}-`)) {
    const classifier = stem.slice(baseVersion.length + 1);
    validateMavenClassifier(classifier);
    return {
      groupId,
      artifactId,
      version: baseVersion,
      baseVersion,
      classifier,
      extension,
      isSnapshot: isSnapshotVersion(baseVersion),
    };
  }
  // Resolved snapshot: stem starts with `<base>-` (where `<base>`
  // is `baseVersion` with `-SNAPSHOT` stripped) and the tail
  // matches `<timestamp>-<build>` possibly followed by
  // `-<classifier>`.
  if (isSnapshotVersion(baseVersion)) {
    const base = baseVersion.slice(0, -"-SNAPSHOT".length);
    const prefix = `${base}-`;
    if (stem.startsWith(prefix)) {
      const tail = stem.slice(prefix.length);
      // Try `<timestamp>-<build>` then `<timestamp>-<build>-<classifier>`.
      // tail might look like "20260517.123456-1" or
      // "20260517.123456-1-sources".
      const resolved = parseResolvedSnapshotTail(tail);
      if (resolved) {
        const version = `${base}-${resolved.versionTail}`;
        const out: MavenCoordinate = {
          groupId,
          artifactId,
          version,
          baseVersion,
          extension,
          isSnapshot: true,
          snapshot: resolved.snapshot,
        };
        if (resolved.classifier) {
          validateMavenClassifier(resolved.classifier);
          out.classifier = resolved.classifier;
        }
        return out;
      }
    }
  }
  throw new MavenError(
    MAVEN_ERROR_CODES.FILENAME_INVALID,
    `filename '${filename}' does not match baseVersion '${baseVersion}'`,
  );
}

function parseResolvedSnapshotTail(
  tail: string,
): { versionTail: string; snapshot: MavenSnapshotResolution; classifier?: string } | null {
  // Match `<timestamp>-<build>` at the start; classifier (if any)
  // follows after another `-`.
  const m = /^(\d{8}\.\d{6})-(\d+)(?:-([A-Za-z0-9._-]+))?$/.exec(tail);
  if (!m) return null;
  const versionTail = `${m[1]}-${m[2]}`;
  const out: { versionTail: string; snapshot: MavenSnapshotResolution; classifier?: string } = {
    versionTail,
    snapshot: { timestamp: m[1], buildNumber: parseInt(m[2], 10) },
  };
  if (m[3]) out.classifier = m[3];
  return out;
}

function validateExtension(extension: string): void {
  // Primary, or primary.checksum, or primary.signature.
  if ((MAVEN_PRIMARY_EXTENSIONS as readonly string[]).includes(extension)) return;
  if ((MAVEN_CHECKSUM_EXTENSIONS as readonly string[]).includes(extension)) return;
  if ((MAVEN_SIGNATURE_EXTENSIONS as readonly string[]).includes(extension)) return;
  const dot = extension.indexOf(".");
  if (dot > 0) {
    const head = extension.slice(0, dot);
    const tail = extension.slice(dot + 1);
    if (
      (MAVEN_PRIMARY_EXTENSIONS as readonly string[]).includes(head) &&
      ((MAVEN_CHECKSUM_EXTENSIONS as readonly string[]).includes(tail) ||
        (MAVEN_SIGNATURE_EXTENSIONS as readonly string[]).includes(tail))
    ) {
      return;
    }
  }
  throw new MavenError(
    MAVEN_ERROR_CODES.EXTENSION_INVALID,
    `extension '${extension}' is not a recognised Maven artifact extension`,
  );
}

// ── Manifest-name composition ──────────────────────────────────────

/**
 * Storage manifest name. groupId stays dot-form (not slash-form) so
 * the manifest-name LIKE prefix matches don't accidentally span
 * groupId boundaries.
 */
export function mavenManifestName(org: string, groupId: string, artifactId: string): string {
  validateCargoOrgName(org);
  validateMavenGroupId(groupId);
  validateMavenArtifactId(artifactId);
  return `maven/${org}/${groupId}/${artifactId}`;
}

/**
 * Inverse: split a storage name back into (org, groupId, artifactId).
 * Returns null when the prefix is missing or the shape is wrong.
 */
export function parseMavenManifestName(
  storageName: string,
): { org: string; groupId: string; artifactId: string } | null {
  if (!storageName.startsWith("maven/")) return null;
  const rest = storageName.slice("maven/".length);
  const segments = rest.split("/");
  if (segments.length < 3) return null;
  const org = segments[0];
  const artifactId = segments[segments.length - 1];
  const groupId = segments.slice(1, segments.length - 1).join(".");
  if (org.length === 0 || groupId.length === 0 || artifactId.length === 0) {
    return null;
  }
  return { org, groupId, artifactId };
}

/**
 * Compose the per-row manifest.version key.
 * `<baseVersion>/<filename>`. The slash inside the version string
 * is permitted by the manifest schema; this is the same trick the
 * cargo facade uses for `<crate>/<version>.crate`.
 */
export function mavenManifestVersion(baseVersion: string, filename: string): string {
  validateMavenVersion(baseVersion);
  if (filename.length === 0 || filename.length > MAX_FILENAME) {
    throw new MavenError(
      MAVEN_ERROR_CODES.FILENAME_INVALID,
      `filename length ${filename.length} is out of bounds (1..${MAX_FILENAME})`,
    );
  }
  if (filename.includes("/")) {
    throw new MavenError(
      MAVEN_ERROR_CODES.FILENAME_INVALID,
      "filename must not contain '/'",
    );
  }
  return `${baseVersion}/${filename}`;
}

function truncate(s: unknown): string {
  if (typeof s !== "string") return String(s);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}
