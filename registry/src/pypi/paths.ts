/**
 * PyPI naming + path conventions per PEP 503 / PEP 491 / PEP 440.
 *
 * **Normalised name** (PEP 503 §normalised-names):
 *   lowercase the input, then collapse runs of `[-_.]+` to single `-`.
 *   So `Foo_Bar.baz` and `foo-bar-baz` and `FOO__BAR.BAZ` all resolve
 *   to `foo-bar-baz`. The normalised form is the storage key.
 *
 * **Filename grammar** (PEP 491 wheel + sdist conventions):
 *   - wheel:  `<distribution>-<version>(-<build tag>)?-<python>-<abi>-<platform>.whl`
 *   - sdist:  `<distribution>-<version>.tar.gz`  (or `.zip`)
 *   The `<distribution>` segment is the package name with `-` and `_`
 *   normalised; pip is lenient about exactly which form clients send.
 *
 * **PEP 440 version**: long-spec, includes pre-release, post-release,
 *   dev, local-version (with `+`). We validate the version is non-
 *   empty and contains no path-traversal chars; full PEP 440 parsing
 *   is the consumer's job (`pip` and `packaging` parse it).
 *
 * Per-org namespacing: storage manifest name is `pypi/<org>/<name>`
 * where `<name>` is the normalised PyPI name.
 */

import { validateCargoOrgName } from "../cargo/paths.js";
import { PypiError } from "./errors.js";
import { PYPI_ERROR_CODES } from "./types.js";

/**
 * Maximum PyPI package name length we accept. PEP 503 doesn't fix
 * one; Warehouse caps at 100 chars. We mirror that for sanity.
 */
const MAX_PACKAGE_NAME_LENGTH = 100;

/**
 * After PEP 503 normalisation, the resulting name must match this
 * regex: lowercase + digit + `-` only, starts + ends with alphanum,
 * no runs of `--` (we collapsed those during normalisation).
 */
const NORMALISED_NAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/**
 * The pre-normalisation grammar accepts what PEP 503 calls
 * "non-normalised" forms: any sequence of `[A-Za-z0-9]` runs
 * separated by single chars from `[-_.]`.
 */
const RAW_PACKAGE_NAME_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/**
 * PEP 440 leniency: we accept any non-empty version up to 128 chars
 * with no `/`, `\\`, control chars, or whitespace. Full PEP 440
 * parsing is the consumer's job — we don't want to reject valid
 * but-rare forms (post-releases, local-version with `+`, etc.).
 */
const VERSION_RE = /^[A-Za-z0-9._+!~-]{1,128}$/;

/** Wheel filename per PEP 491. */
const WHEEL_FILENAME_RE =
  /^([A-Za-z0-9._]+)-([A-Za-z0-9._+!~-]+?)(?:-(\d[^-]*))?-([A-Za-z0-9_]+)-([A-Za-z0-9_]+)-([A-Za-z0-9_.]+)\.whl$/;

/** Sdist filename: `<name>-<version>.<ext>` with .tar.gz / .zip / .tar.bz2. */
const SDIST_EXTS = [".tar.gz", ".tar.bz2", ".tar.xz", ".zip"] as const;

/**
 * PEP 503 normalisation. Lowercase + collapse `[-_.]+` runs to `-`.
 *
 * Examples:
 *   "Foo_Bar.baz"      → "foo-bar-baz"
 *   "FOO__BAR.BAZ"     → "foo-bar-baz"
 *   "foo---bar"        → "foo-bar"
 *   "_foo-bar-"        → ValidationError (after normalisation,
 *                        leading/trailing `-` violates spec)
 */
export function normalisePypiName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new PypiError(
      PYPI_ERROR_CODES.NAME_INVALID,
      "package name must be a non-empty string",
    );
  }
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    throw new PypiError(
      PYPI_ERROR_CODES.NAME_INVALID,
      `package name length ${name.length} exceeds max ${MAX_PACKAGE_NAME_LENGTH}`,
    );
  }
  if (!RAW_PACKAGE_NAME_RE.test(name)) {
    throw new PypiError(
      PYPI_ERROR_CODES.NAME_INVALID,
      `package name '${truncate(name)}' contains characters outside [A-Za-z0-9._-]`,
    );
  }
  const lowered = name.toLowerCase();
  const collapsed = lowered.replace(/[-_.]+/g, "-");
  if (!NORMALISED_NAME_RE.test(collapsed)) {
    throw new PypiError(
      PYPI_ERROR_CODES.NAME_INVALID,
      `package name '${name}' normalises to '${collapsed}' which is invalid`,
    );
  }
  return collapsed;
}

/**
 * Validate a PEP 440-shaped version string. We're lenient on the
 * exact PEP 440 grammar — pip + packaging do the real parsing — but
 * we reject obviously dangerous inputs (path traversal, whitespace,
 * control chars).
 */
export function validatePypiVersion(version: string): void {
  if (typeof version !== "string" || version.length === 0) {
    throw new PypiError(
      PYPI_ERROR_CODES.VERSION_INVALID,
      "version must be a non-empty string",
    );
  }
  if (!VERSION_RE.test(version)) {
    throw new PypiError(
      PYPI_ERROR_CODES.VERSION_INVALID,
      `version '${truncate(version)}' contains characters outside the PEP 440 allowlist`,
    );
  }
  if (version.includes("..")) {
    throw new PypiError(
      PYPI_ERROR_CODES.VERSION_INVALID,
      "version must not contain '..'",
    );
  }
}

/**
 * Parse a wheel filename per PEP 491. Returns the structured tuple
 * (distribution / version / build / python / abi / platform). The
 * distribution is NOT normalised — call `normalisePypiName` on it
 * if you need the storage key form.
 */
export interface WheelFilename {
  distribution: string;
  version: string;
  build?: string;
  pythonTag: string;
  abiTag: string;
  platformTag: string;
}

export function parseWheelFilename(filename: string): WheelFilename {
  const m = WHEEL_FILENAME_RE.exec(filename);
  if (!m) {
    throw new PypiError(
      PYPI_ERROR_CODES.FILENAME_INVALID,
      `wheel filename '${truncate(filename)}' does not match the PEP 491 grammar`,
    );
  }
  const out: WheelFilename = {
    distribution: m[1],
    version: m[2],
    pythonTag: m[4],
    abiTag: m[5],
    platformTag: m[6],
  };
  if (m[3]) out.build = m[3];
  return out;
}

/**
 * Detect whether `filename` ends with a recognised sdist extension
 * and return the (distribution, version) pair. Returns null when
 * the extension is not a sdist; throws when the extension matches
 * but the prefix is malformed.
 */
export interface SdistFilename {
  distribution: string;
  version: string;
}

export function parseSdistFilename(filename: string): SdistFilename | null {
  const ext = SDIST_EXTS.find((e) => filename.endsWith(e));
  if (!ext) return null;
  const stem = filename.slice(0, filename.length - ext.length);
  // Sdist stem is `<distribution>-<version>`. PEP 625 says
  // distribution must be the normalised form, but historically
  // sdists shipped raw names; pip is lenient. We split on the
  // *last* `-` because version strings can contain `-` (rarely;
  // PEP 440 uses `-` in local-version segments after `+`).
  const lastDash = stem.lastIndexOf("-");
  if (lastDash <= 0 || lastDash === stem.length - 1) {
    throw new PypiError(
      PYPI_ERROR_CODES.FILENAME_INVALID,
      `sdist filename '${truncate(filename)}' lacks a '-' separator`,
    );
  }
  return {
    distribution: stem.slice(0, lastDash),
    version: stem.slice(lastDash + 1),
  };
}

/**
 * Returns 'sdist' | 'bdist_wheel' for any recognised PyPI distribution
 * filename. Throws when unrecognised.
 */
export function classifyFiletype(filename: string): "sdist" | "bdist_wheel" {
  if (filename.endsWith(".whl")) return "bdist_wheel";
  if (SDIST_EXTS.some((e) => filename.endsWith(e))) return "sdist";
  throw new PypiError(
    PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE,
    `filename '${truncate(filename)}' is neither a wheel (.whl) nor a recognised sdist (${SDIST_EXTS.join(", ")})`,
  );
}

/**
 * Compose the storage-layer manifest name for a PyPI package.
 * `org` reuses the cargo org-name validator (lowercase, hyphens
 * + underscores OK, 1-64 chars).
 */
export function pypiManifestName(org: string, packageName: string): string {
  validateCargoOrgName(org);
  const normalised = normalisePypiName(packageName);
  return `pypi/${org}/${normalised}`;
}

/**
 * Inverse: split a storage name back into (org, packageName).
 * Returns null when the prefix is missing.
 */
export function parsePypiManifestName(
  storageName: string,
): { org: string; packageName: string } | null {
  if (!storageName.startsWith("pypi/")) return null;
  const rest = storageName.slice("pypi/".length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return null;
  const org = rest.slice(0, firstSlash);
  const packageName = rest.slice(firstSlash + 1);
  if (packageName.length === 0 || packageName.includes("/")) return null;
  return { org, packageName };
}

/**
 * Construct the public URL the registry advertises for a file in
 * its PEP 503 / PEP 691 index. Relative to the registry root; we
 * prepend the operator's `publicBaseUrl` in `read.ts`.
 */
export function pypiFilePath(
  org: string,
  packageName: string,
  filename: string,
): string {
  const normalised = normalisePypiName(packageName);
  return `/pypi/${org}/files/${normalised}/${filename}`;
}

function truncate(s: unknown): string {
  if (typeof s !== "string") return String(s);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}
