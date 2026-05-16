/**
 * OCI Distribution Spec repository-name + reference parser.
 *
 * The spec's grammar (§Pulling Manifests) defines:
 *
 *   <name>      ::= [a-z0-9]+ ((\.|_|__|-+) [a-z0-9]+)*
 *                     (/ [a-z0-9]+ ((\.|_|__|-+) [a-z0-9]+)*)*
 *   <reference> ::= <tag> | <digest>
 *   <tag>       ::= [a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}
 *   <digest>    ::= sha256:[a-f0-9]{64}     (only sha256 at v0.5)
 *
 * Per-org namespacing layered on top: storage manifest name is
 * `oci/<org>/<repo>` so the same `<repo>` can exist independently
 * under different orgs. The `<org>` segment reuses the cargo
 * org-name validator, the `<repo>` segment passes through the OCI
 * grammar above.
 *
 * Combined length limit: clients commonly cap registry-host +
 * `/` + `<name>` at 255 chars. The spec is informational here ("Many
 * clients impose a limit of 255 chars on the concatenation..."); we
 * enforce 255 on `<name>` itself to keep storage rows bounded.
 *
 * All validators throw `OciError(NAME_INVALID, ...)` on malformed
 * input. Repository-name parsing happens at the HTTP boundary before
 * any storage lookup.
 */

import { validateCargoOrgName } from "../cargo/paths.js";
import { OciError } from "./errors.js";
import { OCI_ERROR_CODES } from "./types.js";

// Single path component — lowercase alphanumeric runs separated by
// one of: `.`, `_`, `__`, or one-or-more `-`. Anchored. The lookahead-
// free form below matches what the spec calls "alphanumeric components
// separated by one period, one or two underscores, or one or more
// hyphens".
const OCI_NAME_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

// Tag grammar from §Tag Reference Format. Max 128 chars.
const OCI_TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

// Digest — `sha256:` plus exactly 64 lowercase hex chars. Other algos
// are rejected at v0.5 to keep the trust surface narrow; the spec
// allows other algorithms in principle.
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

// Max length we accept for the full `<name>` (per-spec informational
// guidance, enforced as a hard cap here).
const MAX_REPOSITORY_NAME_LENGTH = 255;

/**
 * Validate an OCI repository name (e.g. `team/svc`, `library/alpine`,
 * `acme/sdk/runtime`). Multi-segment with `/` separators; each segment
 * must match the OCI component grammar.
 */
export function validateOciRepositoryName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `repository name must be a non-empty string`,
    );
  }
  if (name.length > MAX_REPOSITORY_NAME_LENGTH) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `repository name length ${name.length} exceeds max ${MAX_REPOSITORY_NAME_LENGTH}`,
    );
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (!OCI_NAME_COMPONENT.test(seg)) {
      throw new OciError(
        OCI_ERROR_CODES.NAME_INVALID,
        `invalid repository name segment '${truncate(seg)}'`,
      );
    }
  }
}

/**
 * Validate an OCI tag reference. Per spec: 1-128 chars,
 * `[a-zA-Z0-9_]` first, then `[a-zA-Z0-9._-]`.
 */
export function validateOciTag(tag: string): void {
  if (typeof tag !== "string" || !OCI_TAG.test(tag)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `invalid tag '${truncate(tag)}'`,
    );
  }
}

/**
 * Validate a content-addressed digest. v0.5 accepts only
 * `sha256:<64-hex-lowercase>`. Returns the lowercase hex portion
 * (without the `sha256:` prefix) for downstream consumers that
 * use the bare hex in the existing `Blob`/`BlobRef` shape.
 */
export function validateOciDigest(digest: string): string {
  if (typeof digest !== "string" || !OCI_DIGEST.test(digest)) {
    throw new OciError(
      OCI_ERROR_CODES.DIGEST_INVALID,
      `invalid digest '${truncate(digest)}'`,
    );
  }
  return digest.slice("sha256:".length);
}

/**
 * Parsed OCI reference — either a tag or a sha256 digest. The
 * manifest GET / HEAD handler uses the discriminator to route to a
 * tag lookup vs a digest lookup.
 */
export type OciReference =
  | { kind: "tag"; value: string }
  | { kind: "digest"; value: string; hex: string };

/**
 * Parse the `<reference>` path segment from `/v2/<name>/manifests/<reference>`.
 * Digest-shaped refs (starting `sha256:`) are validated as digests;
 * everything else is validated as a tag.
 *
 * Throws `OciError(MANIFEST_INVALID)` for tag-shape failures, or
 * `OciError(DIGEST_INVALID)` for digest-shape failures.
 */
export function parseOciReference(s: string): OciReference {
  if (typeof s !== "string" || s.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest reference must be a non-empty string`,
    );
  }
  if (s.startsWith("sha256:")) {
    const hex = validateOciDigest(s);
    return { kind: "digest", value: s, hex };
  }
  validateOciTag(s);
  return { kind: "tag", value: s };
}

/**
 * Compose the storage-layer manifest name for an OCI repository.
 * Mirrors `cargoManifestName` + `npmManifestName` — the `<org>` is
 * the multi-tenant boundary and the resulting string is what
 * lands in the `manifest.name` column.
 */
export function ociManifestName(org: string, repo: string): string {
  validateCargoOrgName(org);
  validateOciRepositoryName(repo);
  return `oci/${org}/${repo}`;
}

/**
 * Inverse of `ociManifestName` — split a stored manifest name back
 * into its (org, repo) pair. Returns null when the name does not
 * carry the `oci/` prefix; callers map that to a 404 / NAME_UNKNOWN.
 */
export function parseOciManifestName(
  storageName: string,
): { org: string; repo: string } | null {
  if (!storageName.startsWith("oci/")) return null;
  const rest = storageName.slice("oci/".length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return null;
  const org = rest.slice(0, firstSlash);
  const repo = rest.slice(firstSlash + 1);
  if (org.length === 0 || repo.length === 0) return null;
  return { org, repo };
}

function truncate(s: unknown): string {
  if (typeof s !== "string") return String(s);
  return s.length > 64 ? `${s.slice(0, 64)}...` : s;
}
