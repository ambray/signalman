/**
 * Cargo sparse-index path helpers (WS6 wave-3 M10.2).
 *
 * Cargo's sparse index puts each crate at a deterministic path based
 * on the lowercase name, per the spec at
 * https://doc.rust-lang.org/cargo/reference/registry-index.html
 *
 *   1-char names:   `1/<name>`
 *   2-char names:   `2/<name>`
 *   3-char names:   `3/<first-char>/<name>`
 *   4+ char names:  `<first-2>/<chars-3-4>/<name>`
 *
 * These helpers translate between a crate name and the index path
 * (and back, for the inverse direction the sparse-index handler
 * uses when extracting the name from a request URL).
 *
 * Cargo crate names are restricted to `[a-zA-Z0-9_-]` and must be
 * 1-64 chars; we validate at the boundary so a malformed name can't
 * traverse out of the index tree. The lowercase rule for the prefix
 * dirs is also a spec requirement — `Serde` and `serde` map to the
 * same prefix path because both crates can't coexist.
 *
 * Per-org namespacing (M10):
 *   `/cargo/<org>/index/<paths-above>` for sparse-index
 *   `/cargo/<org>/api/v1/crates/<name>/<version>/...` for publish + download
 *
 * The org is the multi-tenant boundary; an org's index is opaque to
 * other orgs. Each org's `.cargo/config.toml` points at exactly one
 * sparse-index URL.
 *
 * Manifest naming inside storage:
 *   Cargo crates are stored as manifests with `kind: 'cargo'` and
 *   `name: 'cargo/<org>/<crate>'`. The storage-layer name carries
 *   the namespace so list/lookup APIs work uniformly.
 */

import { RegistryError, REGISTRY_ERROR_CODES } from "../types.js";

const CRATE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ORG_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/**
 * Validate a cargo crate name. Throws `RegistryError(BAD_NAME)` for
 * malformed input.
 */
export function validateCargoCrateName(name: string): void {
  if (!CRATE_NAME_RE.test(name)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `invalid cargo crate name (must match [a-zA-Z0-9_-]{1,64}): ${truncate(name)}`,
    );
  }
}

/**
 * Validate an org namespace. The same shape rules as
 * `validateManifestName` but tighter — no slashes, dots, or
 * underscores at the boundary.
 */
export function validateCargoOrgName(org: string): void {
  if (!ORG_NAME_RE.test(org)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `invalid org name (must match [a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?): ${truncate(org)}`,
    );
  }
}

/**
 * Compute the sparse-index path-suffix for a crate. Returns the
 * portion AFTER `/cargo/<org>/index/`.
 *
 * Examples:
 *   `a`            → `1/a`
 *   `ab`           → `2/ab`
 *   `abc`          → `3/a/abc`
 *   `serde`        → `se/rd/serde`
 *   `tokio-util`   → `to/ki/tokio-util`
 *
 * The prefix dirs use the LOWERCASED first 2 / 3 chars per the
 * cargo spec. Crate names with mixed case still produce the
 * lowercase prefix.
 */
export function sparseIndexPathFor(name: string): string {
  validateCargoCrateName(name);
  const lc = name.toLowerCase();
  switch (lc.length) {
    case 1:
      return `1/${name}`;
    case 2:
      return `2/${name}`;
    case 3:
      return `3/${lc[0]}/${name}`;
    default:
      return `${lc.slice(0, 2)}/${lc.slice(2, 4)}/${name}`;
  }
}

/**
 * Extract the crate name from a sparse-index path-suffix. Inverse
 * of {@link sparseIndexPathFor}.
 *
 * Returns `null` when the path doesn't match a valid sparse-index
 * shape (caller maps to 404).
 */
export function crateNameFromSparseIndexPath(suffix: string): string | null {
  // Strip leading slash if present.
  const path = suffix.startsWith("/") ? suffix.slice(1) : suffix;
  const parts = path.split("/");
  let candidate: string;
  if (parts.length === 2 && (parts[0] === "1" || parts[0] === "2")) {
    candidate = parts[1];
  } else if (parts.length === 3 && parts[0] === "3") {
    candidate = parts[2];
  } else if (parts.length === 3) {
    candidate = parts[2];
  } else {
    return null;
  }
  if (!CRATE_NAME_RE.test(candidate)) return null;
  // Verify the prefix matches what we'd compute for this name — a
  // malformed request like `1/abc` (a 1-prefix dir for a 3-char
  // name) is suspicious and gets rejected.
  if (sparseIndexPathFor(candidate) !== path) return null;
  return candidate;
}

/**
 * Storage-layer manifest name for a cargo crate. Includes the org
 * namespace so the same crate name can exist independently under
 * different orgs.
 */
export function cargoManifestName(org: string, crateName: string): string {
  validateCargoOrgName(org);
  validateCargoCrateName(crateName);
  return `cargo/${org}/${crateName.toLowerCase()}`;
}

function truncate(s: string): string {
  if (s.length <= 80) return s;
  return `${s.slice(0, 80)}...`;
}
