/**
 * NuGet path composition + parsing.
 *
 * NuGet identifies a package by `(id, version)`. The `id` is
 * case-insensitive per NuGet convention; we **normalise to lowercase**
 * for storage and URL composition (matching nuget.org's flat-container
 * layout — `flat2/<lower-id>/<version>/<lower-id>.<version>.nupkg`).
 *
 * Version grammar accepts the NuGet semver shape:
 *   - SemVer 1: `MAJOR.MINOR.PATCH[-pre]`
 *   - SemVer 2: `MAJOR.MINOR.PATCH[-pre[.pre]][+meta]`
 *   - NuGet 4-segment: `MAJOR.MINOR.PATCH.REVISION` (legacy; common in
 *     enterprise stacks). Per the NuGet versioning rules, the 4-segment
 *     form lacks an explicit semver lane but is widely accepted; we
 *     accept it without prerelease/build metadata for legacy compat.
 *
 * Per-org namespacing — storage manifest name:
 *   `nuget/<org>/<lower-id>`
 * version key:
 *   `<lower-version>` (normalised version)
 *
 * The manifest version key is the normalised version string with no
 * filename appended — every NuGet package version uploads a single
 * `.nupkg` (the zip carrying the .nuspec inside). Distinct files
 * within a version (.nuspec extraction, signature) are derived from
 * the same row, not stored as separate rows.
 */

import { validateCargoOrgName } from "../cargo/paths.js";
import { NugetError } from "./errors.js";
import { NUGET_ERROR_CODES } from "./types.js";

/**
 * Package id grammar. NuGet allows letters, digits, dots, hyphens,
 * underscores. Must start with letter or digit. Max 100 chars (NuGet
 * Gallery's own limit). Case-insensitive.
 */
const PACKAGE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * Version grammar (NuGet semver, accepting the 4-segment quirk).
 *
 * Accepts:
 *   - `1.2.3`
 *   - `1.2.3.4` (legacy 4-segment)
 *   - `1.2.3-alpha`
 *   - `1.2.3-alpha.1`
 *   - `1.2.3-alpha+build.1`
 *   - `1.2.3+build.1`
 *
 * Rejects: empty, whitespace, traversal sequences, control chars.
 */
const VERSION_RE =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const MAX_PACKAGE_ID = 100;
const MAX_VERSION = 64;

// ── Validation ─────────────────────────────────────────────────────

export function validateNugetPackageId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
      "package id must be a non-empty string",
    );
  }
  if (id.length > MAX_PACKAGE_ID) {
    throw new NugetError(
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
      `package id length ${id.length} exceeds max ${MAX_PACKAGE_ID}`,
    );
  }
  if (!PACKAGE_ID_RE.test(id)) {
    throw new NugetError(
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
      `package id '${truncate(id)}' contains characters outside the NuGet allowlist`,
    );
  }
  if (id.includes("..")) {
    throw new NugetError(
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
      "package id must not contain '..'",
    );
  }
  // Reject leading/trailing separators — NuGet Gallery rejects these
  // even though the regex itself would accept e.g. `foo.`.
  if (
    id.startsWith(".") ||
    id.endsWith(".") ||
    id.startsWith("-") ||
    id.endsWith("-") ||
    id.startsWith("_") ||
    id.endsWith("_")
  ) {
    throw new NugetError(
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
      `package id '${truncate(id)}' must not start or end with a separator`,
    );
  }
}

export function validateNugetVersion(version: string): void {
  if (typeof version !== "string" || version.length === 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.VERSION_INVALID,
      "version must be a non-empty string",
    );
  }
  if (version.length > MAX_VERSION) {
    throw new NugetError(
      NUGET_ERROR_CODES.VERSION_INVALID,
      `version length ${version.length} exceeds max ${MAX_VERSION}`,
    );
  }
  if (!VERSION_RE.test(version)) {
    throw new NugetError(
      NUGET_ERROR_CODES.VERSION_INVALID,
      `version '${truncate(version)}' does not match NuGet semver grammar`,
    );
  }
  if (version.includes("..")) {
    throw new NugetError(
      NUGET_ERROR_CODES.VERSION_INVALID,
      "version must not contain '..'",
    );
  }
}

// ── Normalisation ──────────────────────────────────────────────────

/**
 * Lowercase the package id. NuGet flat-container URLs use the
 * lowercase form regardless of how the operator pushed it.
 *
 * `validateNugetPackageId` should be called separately when input
 * comes from a wire path — `normalisePackageId` does not validate.
 */
export function normalisePackageId(id: string): string {
  return id.toLowerCase();
}

/**
 * Normalise a NuGet version per the NuGet versioning rules:
 *
 *   - lowercase the prerelease tag
 *   - strip leading zeros from numeric segments (NuGet treats
 *     `1.2.3` and `01.02.03` as equivalent; we normalise to no
 *     leading zeros)
 *   - drop a trailing `.0` 4th segment ("1.2.3.0" → "1.2.3") to
 *     match the canonical form `dotnet` clients expect when computing
 *     the flat-container URL
 *
 * `validateNugetVersion` should be called before normalisation.
 */
export function normaliseVersion(version: string): string {
  const lower = version.toLowerCase();
  const plusIdx = lower.indexOf("+");
  const noMeta = plusIdx >= 0 ? lower.slice(0, plusIdx) : lower;
  const dashIdx = noMeta.indexOf("-");
  const numericPart = dashIdx >= 0 ? noMeta.slice(0, dashIdx) : noMeta;
  const pre = dashIdx >= 0 ? noMeta.slice(dashIdx) : "";
  const segs = numericPart.split(".").map((seg) => {
    if (seg.length === 0) return "0";
    // Strip leading zeros, but keep a single "0".
    let i = 0;
    while (i < seg.length - 1 && seg[i] === "0") i++;
    return seg.slice(i);
  });
  // Drop trailing .0 on the 4-segment form (e.g. "1.2.3.0" → "1.2.3").
  // Per NuGet versioning rules, this is the canonical form.
  while (segs.length > 3 && segs[segs.length - 1] === "0") {
    segs.pop();
  }
  return `${segs.join(".")}${pre}`;
}

// ── Path composition ───────────────────────────────────────────────

/**
 * Compose the flat-container nupkg path **below the per-org repo
 * prefix**. The mount layer adds `/nuget/<org>/`.
 *
 *   `<lower-id>/<lower-version>/<lower-id>.<lower-version>.nupkg`
 */
export function flatContainerNupkgPath(
  id: string,
  version: string,
): string {
  validateNugetPackageId(id);
  validateNugetVersion(version);
  const lid = normalisePackageId(id);
  const lver = normaliseVersion(version);
  return `${lid}/${lver}/${lid}.${lver}.nupkg`;
}

/**
 * Compose the flat-container nuspec path (extracted-from-nupkg form).
 */
export function flatContainerNuspecPath(
  id: string,
  version: string,
): string {
  validateNugetPackageId(id);
  validateNugetVersion(version);
  const lid = normalisePackageId(id);
  const lver = normaliseVersion(version);
  return `${lid}/${lver}/${lid}.nuspec`;
}

/**
 * Compose the version-index path: `<lower-id>/index.json`.
 */
export function flatContainerIndexPath(id: string): string {
  validateNugetPackageId(id);
  return `${normalisePackageId(id)}/index.json`;
}

/**
 * Parse a path **below the per-org repo prefix**. Returns the parsed
 * resource kind + (id, version?) when conformant; throws NugetError
 * on shape-conformant-but-invalid segments; returns null when the
 * path doesn't conform to any known shape.
 *
 * Recognised shapes:
 *   - `v3/index.json`                              service index
 *   - `v3/flat2/<id>/index.json`                   version listing
 *   - `v3/flat2/<id>/<version>/<id>.<version>.nupkg`
 *   - `v3/flat2/<id>/<version>/<id>.nuspec`
 *   - `v3/registration5-semver1/<id>/index.json`   registration index
 *   - `v3/registration5-semver1/<id>/<version>.json` registration leaf
 *   - `v3/publish`                                 publish (NuGet v3 push)
 *   - `v3/search`                                  search query (stub)
 */
export type ParsedNugetPath =
  | { kind: "service-index" }
  | { kind: "flat-version-index"; id: string }
  | { kind: "flat-nupkg"; id: string; version: string }
  | { kind: "flat-nuspec"; id: string; version: string }
  | { kind: "registration-index"; id: string }
  | { kind: "registration-leaf"; id: string; version: string }
  | { kind: "publish" }
  | { kind: "search" };

const FLAT_PREFIX = "v3/flat2/";
const REG_PREFIX_SEMVER1 = "v3/registration5-semver1/";
const REG_PREFIX_SEMVER2 = "v3/registration5-semver2/";

export function parseNugetPath(p: string): ParsedNugetPath | null {
  if (p.length === 0 || p.startsWith("/")) return null;
  // Strip any trailing slash for the comparisons (the router strips
  // these too, but defensive).
  const path = p.endsWith("/") ? p.slice(0, -1) : p;

  if (path === "v3/index.json") return { kind: "service-index" };
  if (path === "v3/publish") return { kind: "publish" };
  if (path === "v3/search") return { kind: "search" };

  if (path.startsWith(FLAT_PREFIX)) {
    const rest = path.slice(FLAT_PREFIX.length);
    const segments = rest.split("/");
    if (segments.length === 0) return null;
    const id = segments[0];
    validateNugetPackageId(id);
    if (segments.length === 2 && segments[1] === "index.json") {
      return { kind: "flat-version-index", id: normalisePackageId(id) };
    }
    if (segments.length === 3) {
      const version = segments[1];
      validateNugetVersion(version);
      const filename = segments[2];
      const lid = normalisePackageId(id);
      const lver = normaliseVersion(version);
      const nupkgName = `${lid}.${lver}.nupkg`;
      const nuspecName = `${lid}.nuspec`;
      if (filename === nupkgName) {
        return { kind: "flat-nupkg", id: lid, version: lver };
      }
      if (filename === nuspecName) {
        return { kind: "flat-nuspec", id: lid, version: lver };
      }
      // Reject filename mismatches strictly — clients always emit the
      // canonical form, and anything else is a misconfigured push.
      throw new NugetError(
        NUGET_ERROR_CODES.RESOURCE_NOT_FOUND,
        `flat-container filename '${filename}' does not match expected '${nupkgName}' or '${nuspecName}'`,
      );
    }
    return null;
  }

  for (const prefix of [REG_PREFIX_SEMVER1, REG_PREFIX_SEMVER2]) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      const segments = rest.split("/");
      if (segments.length === 0) return null;
      const id = segments[0];
      validateNugetPackageId(id);
      if (segments.length === 2 && segments[1] === "index.json") {
        return { kind: "registration-index", id: normalisePackageId(id) };
      }
      if (segments.length === 2 && segments[1].endsWith(".json")) {
        const version = segments[1].slice(0, -".json".length);
        validateNugetVersion(version);
        return {
          kind: "registration-leaf",
          id: normalisePackageId(id),
          version: normaliseVersion(version),
        };
      }
      return null;
    }
  }

  return null;
}

// ── Manifest-name composition ──────────────────────────────────────

/**
 * Storage manifest name. id stays lowercase to match the flat-container
 * URL convention; version is per-row.
 */
export function nugetManifestName(org: string, id: string): string {
  validateCargoOrgName(org);
  validateNugetPackageId(id);
  return `nuget/${org}/${normalisePackageId(id)}`;
}

/**
 * Inverse: split a storage name back into (org, id). Returns null
 * when the prefix is missing or the shape is wrong.
 */
export function parseNugetManifestName(
  storageName: string,
): { org: string; id: string } | null {
  if (!storageName.startsWith("nuget/")) return null;
  const rest = storageName.slice("nuget/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const org = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (org.length === 0 || id.length === 0) return null;
  if (id.includes("/")) return null;
  return { org, id };
}

/**
 * Per-row manifest version key. Normalised lower-case form.
 */
export function nugetManifestVersion(version: string): string {
  validateNugetVersion(version);
  return normaliseVersion(version);
}

function truncate(s: unknown): string {
  if (typeof s !== "string") return String(s);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}
