/**
 * Strict-validating helpers for Maven inputs that cross the trust
 * boundary — the operator-supplied (groupId, artifactId, version,
 * filename, extension) tuple and the snapshot-policy guard.
 *
 * Every public function either returns the strongly-typed value or
 * throws `MavenError` with a code the HTTP layer maps to a 4XX.
 */

import { MavenError } from "./errors.js";
import {
  MAVEN_CHECKSUM_EXTENSIONS,
  MAVEN_ERROR_CODES,
  MAVEN_PRIMARY_EXTENSIONS,
  MAVEN_SIGNATURE_EXTENSIONS,
  type MavenCoordinate,
  type MavenSnapshotPolicy,
} from "./types.js";
import { isSnapshotVersion } from "./paths.js";

/**
 * Snapshot policy enforcement. Default policy is `reject`. The
 * publish path calls this on every PUT.
 *
 *   - `reject`: throws SNAPSHOT_REFUSED on any `-SNAPSHOT` version.
 *   - `accept`: passes through.
 *
 * Operators flip policy to `accept` via the per-org virtual_upstream
 * config (`snapshot_policy: accept`) or via a per-repo registry
 * config knob (not yet exposed; M2 takes it as an option to
 * `mountMavenPublishRoutes`).
 */
export function enforceSnapshotPolicy(
  coord: MavenCoordinate,
  policy: MavenSnapshotPolicy,
): void {
  if (!coord.isSnapshot && !isSnapshotVersion(coord.version)) return;
  if (policy === "accept") return;
  throw new MavenError(
    MAVEN_ERROR_CODES.SNAPSHOT_REFUSED,
    `snapshot artifact ${coord.groupId}:${coord.artifactId}:${coord.version} refused — snapshot_policy is 'reject' (default). Set snapshot_policy: accept on the repo or virtual upstream to permit.`,
  );
}

/**
 * Classify an extension into one of:
 *   - 'primary'    — jar/pom/war/ear/module/aar/klib
 *   - 'checksum'   — sha1/md5/sha256/sha512 (or primary.checksum)
 *   - 'signature'  — asc (or primary.asc)
 *
 * Returns 'unknown' for anything else; the caller decides whether
 * to reject (publish path) or store-verbatim (Maven Central
 * passthrough on unusual classifiers).
 */
export type ExtensionRole = "primary" | "checksum" | "signature" | "unknown";

export function classifyExtension(extension: string): ExtensionRole {
  if ((MAVEN_PRIMARY_EXTENSIONS as readonly string[]).includes(extension)) {
    return "primary";
  }
  if ((MAVEN_CHECKSUM_EXTENSIONS as readonly string[]).includes(extension)) {
    return "checksum";
  }
  if ((MAVEN_SIGNATURE_EXTENSIONS as readonly string[]).includes(extension)) {
    return "signature";
  }
  const dot = extension.indexOf(".");
  if (dot > 0) {
    const head = extension.slice(0, dot);
    const tail = extension.slice(dot + 1);
    const isPrimary = (MAVEN_PRIMARY_EXTENSIONS as readonly string[]).includes(head);
    if (isPrimary) {
      if ((MAVEN_CHECKSUM_EXTENSIONS as readonly string[]).includes(tail)) {
        return "checksum";
      }
      if ((MAVEN_SIGNATURE_EXTENSIONS as readonly string[]).includes(tail)) {
        return "signature";
      }
    }
  }
  return "unknown";
}

/**
 * Split a checksum / signature extension into (covered-extension,
 * suffix). e.g. `'jar.sha1'` → `{covered: 'jar', suffix: 'sha1'}`.
 * Returns null when extension is not a multi-suffix form.
 */
export function splitMultiExtension(
  extension: string,
): { covered: string; suffix: string } | null {
  const dot = extension.indexOf(".");
  if (dot <= 0) return null;
  return {
    covered: extension.slice(0, dot),
    suffix: extension.slice(dot + 1),
  };
}

/**
 * Compute the filename of the artifact that a checksum / signature
 * file covers. e.g. for `demo-lib-1.2.3.jar.sha1` returns
 * `demo-lib-1.2.3.jar`.
 *
 * Returns null when the input is not a checksum or signature
 * filename.
 */
export function filenameOfCoveredArtifact(filename: string): string | null {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const ext = filename.slice(lastDot + 1);
  if (
    !(MAVEN_CHECKSUM_EXTENSIONS as readonly string[]).includes(ext) &&
    !(MAVEN_SIGNATURE_EXTENSIONS as readonly string[]).includes(ext)
  ) {
    return null;
  }
  return filename.slice(0, lastDot);
}

/**
 * Validate that a buffer of plain-text checksum payload matches the
 * expected hex digest. Maven Central stores checksums as
 * `<hex-digest><optional whitespace + filename>`; we accept either
 * the bare hex form or the bare-plus-filename form.
 */
export function parseChecksumPayload(
  payload: Buffer,
  suffix: string,
): string {
  const text = payload.toString("utf-8").trim();
  // Maven Central checksum files are either "<hex>" alone, or
  // "<hex>  <filename>" (sha256sum-style). We take the first
  // whitespace-separated token as the digest.
  const firstToken = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  const expectedLen = expectedChecksumHexLength(suffix);
  if (expectedLen === null) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `unknown checksum suffix '${suffix}'`,
    );
  }
  if (firstToken.length !== expectedLen || !/^[a-f0-9]+$/.test(firstToken)) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `checksum payload '${truncate(text)}' is not a ${expectedLen}-char hex digest`,
    );
  }
  return firstToken;
}

function expectedChecksumHexLength(suffix: string): number | null {
  switch (suffix) {
    case "sha1":
      return 40;
    case "md5":
      return 32;
    case "sha256":
      return 64;
    case "sha512":
      return 128;
    default:
      return null;
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}
