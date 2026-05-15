/**
 * Npm path helpers (v0.1.1).
 *
 * Npm uses package-level metadata aggregation (the "packument")
 * instead of cargo's per-version sparse index. Routes:
 *
 *   /npm/<org>/<package>                          → packument
 *   /npm/<org>/<package>/-/<package>-<version>.tgz → tarball
 *   /npm/<org>/<package>                          → publish (PUT)
 *
 * Scoped packages (`@signalman/host`) URL-encode the forward slash:
 *   /npm/<org>/@signalman%2Fhost
 *
 * The router decodes URL-encoded path segments before matching, so
 * the `:package` param sees the literal `@signalman/host` value.
 *
 * Per-org namespacing: every route under `/npm/<org>/` is opaque to
 * other orgs. Storage-layer manifest names use
 * `npm/<org>/<package>` so list/lookup APIs round-trip cleanly.
 */

import { RegistryError, REGISTRY_ERROR_CODES } from "../types.js";

// Npm package names: lowercase + digits + `-_.@/` (scope sep).
// Scoped form: @scope/name. Unscoped: alphanumeric + dashes etc.
// We allow what the npm ecosystem allows in practice; npm's own
// validator is more restrictive but for federation we need to
// accept anything operators in the wild publish.
const SCOPED_RE = /^@[a-z0-9](?:[a-z0-9_.-]{0,213})\/[a-z0-9](?:[a-z0-9_.-]{0,213})$/;
const UNSCOPED_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,213})$/;
const ORG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/**
 * Validate an npm package name. Accepts both scoped + unscoped
 * forms. Throws `RegistryError(BAD_NAME)` on malformed input.
 */
export function validateNpmPackageName(name: string): void {
  if (!name || name.length > 214) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `invalid npm package name (must be 1-214 chars): ${truncate(name)}`,
    );
  }
  // npm package names must be lowercase per the npm spec. Validate
  // the original (not lowercased) so we reject UpperCase.
  if (name.startsWith("@")) {
    if (!SCOPED_RE.test(name)) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_NAME,
        `invalid scoped npm package name: ${truncate(name)}`,
      );
    }
  } else {
    if (!UNSCOPED_RE.test(name)) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_NAME,
        `invalid unscoped npm package name: ${truncate(name)}`,
      );
    }
  }
  if (name.includes("..")) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `npm package name must not contain '..': ${truncate(name)}`,
    );
  }
}

/**
 * Validate an org name. Same shape as cargo's; tight to avoid URL
 * surprises.
 */
export function validateNpmOrgName(org: string): void {
  if (!ORG_RE.test(org)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_NAME,
      `invalid org name: ${truncate(org)}`,
    );
  }
}

/**
 * Storage-layer manifest name for an npm package. Lowercases for
 * lookup-key stability (npm packages are case-insensitive on the
 * registry side).
 *
 * Scoped: `@signalman/host` → `npm/<org>/@signalman/host` (slash
 * inside the manifest name is allowed by `validateManifestName`).
 */
export function npmManifestName(org: string, packageName: string): string {
  validateNpmOrgName(org);
  validateNpmPackageName(packageName);
  return `npm/${org}/${packageName.toLowerCase()}`;
}

/**
 * Inverse: extract package name from a storage manifest name.
 * Returns null when the name doesn't match the npm prefix.
 */
export function packageFromManifestName(manifestName: string): {
  org: string;
  packageName: string;
} | null {
  const m = /^npm\/([^/]+)\/(.+)$/.exec(manifestName);
  if (!m) return null;
  return { org: m[1], packageName: m[2] };
}

function truncate(s: string): string {
  if (s.length <= 80) return s;
  return `${s.slice(0, 80)}...`;
}
