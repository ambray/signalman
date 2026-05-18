/**
 * HuggingFace path + manifest-name composition.
 *
 * **Manifest-name grammar:** per-file rows live under
 *
 *   `hf/<org>/<repo>/<repo_type>`
 *
 * keyed on `version = <revision>/<path>` so the same path under
 * different revisions stays a distinct row. The slash inside
 * `version` is permitted by `validateManifestVersion`.
 *
 * **LFS OID grammar:** the Git LFS pointer-file `oid` field is
 * `sha256:<64-lowercase-hex>`. We parse + validate this strictly;
 * unknown algorithms (`sha512:...`, `blake3:...`) are rejected up
 * front because the rest of the registry's blob layer is sha256-only.
 *
 * Path traversal: we never let `..` or `/.../` segments through; the
 * publish-tarball path also rejects absolute paths and symlinks at
 * the tar-entry layer.
 */

import { HfError } from "./errors.js";
import { HF_ERROR_CODES, HF_REPO_TYPES, type HfRepoType } from "./types.js";

/** Org name grammar — same as cargo's `validateCargoOrgName`. Lowercase + digits + `-`/`_`. */
const ORG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * HF repo name grammar. HF allows mixed-case names + `.`, `_`, `-`.
 * We allow [A-Za-z0-9._-], 1-96 chars, first char alphanumeric.
 */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/**
 * Revision string grammar. HF accepts Git SHA-1s, branch names, and
 * tags. We accept anything alphanumeric + `.`, `_`, `-`, 1-128 chars,
 * matching what `huggingface-cli` documents.
 */
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * LFS OID = `sha256:<hex>`. The hex part is exactly 64 lowercase
 * hex chars.
 */
const LFS_OID_RE = /^sha256:([a-f0-9]{64})$/;

/** Bare hex sha256 (no algorithm prefix). */
const HEX_SHA256_RE = /^[a-f0-9]{64}$/;

// ── Validation ────────────────────────────────────────────────────

export function validateHfOrgName(org: string): void {
  if (typeof org !== "string" || org.length === 0) {
    throw new HfError(HF_ERROR_CODES.ORG_INVALID, "org must be a non-empty string");
  }
  if (!ORG_RE.test(org)) {
    throw new HfError(
      HF_ERROR_CODES.ORG_INVALID,
      `org '${truncate(org)}' is not a valid HF org name`,
    );
  }
  if (org.includes("..")) {
    throw new HfError(HF_ERROR_CODES.ORG_INVALID, "org must not contain '..'");
  }
}

export function validateHfRepoName(repo: string): void {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new HfError(HF_ERROR_CODES.REPO_INVALID, "repo must be a non-empty string");
  }
  if (!REPO_RE.test(repo)) {
    throw new HfError(
      HF_ERROR_CODES.REPO_INVALID,
      `repo '${truncate(repo)}' is not a valid HF repo name`,
    );
  }
  if (repo.includes("..")) {
    throw new HfError(HF_ERROR_CODES.REPO_INVALID, "repo must not contain '..'");
  }
}

export function validateHfRepoType(repoType: string): asserts repoType is HfRepoType {
  if (!(HF_REPO_TYPES as readonly string[]).includes(repoType)) {
    throw new HfError(
      HF_ERROR_CODES.REPO_TYPE_INVALID,
      `repo_type '${truncate(repoType)}' is not one of ${HF_REPO_TYPES.join("|")}`,
    );
  }
}

export function validateHfRevision(revision: string): void {
  if (typeof revision !== "string" || revision.length === 0) {
    throw new HfError(
      HF_ERROR_CODES.REVISION_INVALID,
      "revision must be a non-empty string",
    );
  }
  if (!REVISION_RE.test(revision)) {
    throw new HfError(
      HF_ERROR_CODES.REVISION_INVALID,
      `revision '${truncate(revision)}' contains characters outside the HF allowlist`,
    );
  }
  if (revision.includes("..")) {
    throw new HfError(
      HF_ERROR_CODES.REVISION_INVALID,
      "revision must not contain '..'",
    );
  }
}

/**
 * Parse + validate an LFS pointer `oid sha256:<hex>` field. Returns
 * the lowercase 64-hex content sha. Throws OID_INVALID on any
 * malformation.
 */
export function parseLfsOid(oid: string): string {
  if (typeof oid !== "string" || oid.length === 0) {
    throw new HfError(HF_ERROR_CODES.OID_INVALID, "oid must be a non-empty string");
  }
  const m = LFS_OID_RE.exec(oid);
  if (!m) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `oid '${truncate(oid)}' is not a valid sha256 LFS OID`,
    );
  }
  return m[1];
}

export function validateHexSha256(sha: string): void {
  if (typeof sha !== "string" || !HEX_SHA256_RE.test(sha)) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `sha256 '${truncate(sha)}' is not a 64-char lowercase hex digest`,
    );
  }
}

// ── In-repo file path validation ──────────────────────────────────

/**
 * Validate a file path inside an HF repo. Rejects:
 *   - empty / leading `/` / trailing `/`
 *   - any `..` segment (path traversal)
 *   - any segment matching `.` (current-dir)
 *   - any NUL byte / control char / backslash
 *   - any path > 1024 chars
 *
 * Returns the normalised path (collapsed `./` and consecutive slashes,
 * preserving relative POSIX form).
 */
export function validateHfPath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new HfError(HF_ERROR_CODES.PATH_INVALID, "path must be a non-empty string");
  }
  if (p.length > 1024) {
    throw new HfError(
      HF_ERROR_CODES.PATH_INVALID,
      `path length ${p.length} exceeds 1024`,
    );
  }
  if (p.startsWith("/")) {
    throw new HfError(
      HF_ERROR_CODES.PATH_INVALID,
      `path must not start with '/' (absolute paths refused): ${truncate(p)}`,
    );
  }
  if (p.endsWith("/")) {
    throw new HfError(
      HF_ERROR_CODES.PATH_INVALID,
      `path must not end with '/' (directories refused): ${truncate(p)}`,
    );
  }
  if (p.includes("\0")) {
    throw new HfError(HF_ERROR_CODES.PATH_INVALID, "path contains NUL byte");
  }
  if (p.includes("\\")) {
    throw new HfError(
      HF_ERROR_CODES.PATH_INVALID,
      "path must not contain backslashes (forward-slash POSIX form only)",
    );
  }
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new HfError(
        HF_ERROR_CODES.PATH_INVALID,
        `path contains control char at offset ${i}`,
      );
    }
  }
  const segments = p.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue; // collapse `./` and `//`
    if (seg === "..") {
      throw new HfError(
        HF_ERROR_CODES.PATH_INVALID,
        `path contains '..' segment: ${truncate(p)}`,
      );
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw new HfError(HF_ERROR_CODES.PATH_INVALID, "path normalises to empty");
  }
  return out.join("/");
}

// ── Manifest-name composition ─────────────────────────────────────

/**
 * Storage manifest name for an HF per-file row.
 *
 *   `hf/<org>/<repo>/<repo_type>`
 *
 * The repo_type segment lives at the END (not before <repo>) so the
 * LIKE-prefix scan `hf/<org>/<repo>/%` enumerates all repo_type
 * shards for a given (org, repo). Real-world HF repos almost never
 * collide across types (a `dataset` org/repo and a `model` org/repo
 * are distinct entities), but the layout keeps the option open.
 */
export function hfManifestName(
  org: string,
  repo: string,
  repoType: HfRepoType,
): string {
  validateHfOrgName(org);
  validateHfRepoName(repo);
  validateHfRepoType(repoType);
  return `hf/${org}/${repo}/${repoType}`;
}

/**
 * Inverse: split a storage name back into (org, repo, repo_type).
 * Returns null when the prefix is missing or the shape is wrong.
 */
export function parseHfManifestName(
  storageName: string,
): { org: string; repo: string; repoType: HfRepoType } | null {
  if (!storageName.startsWith("hf/")) return null;
  const rest = storageName.slice("hf/".length);
  const segments = rest.split("/");
  if (segments.length !== 3) return null;
  const [org, repo, repoType] = segments;
  if (!(HF_REPO_TYPES as readonly string[]).includes(repoType)) return null;
  if (org.length === 0 || repo.length === 0) return null;
  return { org, repo, repoType: repoType as HfRepoType };
}

/**
 * Compose the per-row manifest.version key.
 *
 * Format: `<revision>:<percent-encoded-path>`. The `:` separator is
 * not in the HF revision allowlist `[A-Za-z0-9._-]`, so it cleanly
 * splits the two halves. The path is percent-encoded (only `/`,
 * `%`, and other reserved chars get hex-encoded) to avoid the `/`
 * that `validateManifestVersion` forbids.
 *
 * Path is normalised + traversal-rejected before composition.
 */
export function hfManifestVersion(revision: string, path: string): string {
  validateHfRevision(revision);
  const normalised = validateHfPath(path);
  return `${revision}:${encodeHfPathSegment(normalised)}`;
}

/**
 * Parse an `hf` manifest.version key back into (revision, path).
 * Returns null when the shape is wrong.
 */
export function parseHfManifestVersion(
  v: string,
): { revision: string; path: string } | null {
  const idx = v.indexOf(":");
  if (idx <= 0) return null;
  const revision = v.slice(0, idx);
  const encoded = v.slice(idx + 1);
  if (revision.length === 0 || encoded.length === 0) return null;
  let path: string;
  try {
    path = decodeHfPathSegment(encoded);
  } catch {
    return null;
  }
  if (path.length === 0) return null;
  return { revision, path };
}

/**
 * Percent-encode an HF path so it can sit inside a manifest.version
 * string (which forbids `/`). We encode the small set of chars that
 * either collide with `validateManifestVersion` (`/`) or could
 * confuse the round-trip (`%` itself). Leaves alphanumerics + the
 * usual safe punctuation alone.
 */
function encodeHfPathSegment(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "/" || c === "%") {
      out += `%${c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`;
    } else {
      out += c;
    }
  }
  return out;
}

function decodeHfPathSegment(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "%") {
      if (i + 2 >= s.length) {
        throw new HfError(HF_ERROR_CODES.PATH_INVALID, "truncated percent-escape");
      }
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new HfError(
          HF_ERROR_CODES.PATH_INVALID,
          `bad percent-escape '%${hex}'`,
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else {
      out += c;
    }
  }
  return out;
}

// ── Wire-path composers / parsers ─────────────────────────────────

/**
 * `/resolve/<revision>/<path>` — the canonical HF read path. The
 * mount layer prefixes this with `/hf/<org>/<repo>/`.
 */
export function composeHfResolvePath(
  revision: string,
  path: string,
): string {
  const normalised = validateHfPath(path);
  validateHfRevision(revision);
  return `resolve/${revision}/${normalised}`;
}

/**
 * Parse a path string of the form `resolve/<revision>/<path>`. The
 * caller passes the segment AFTER `/hf/<org>/<repo>/`. Returns null
 * when the prefix is missing.
 */
export function parseHfResolvePath(
  rest: string,
): { revision: string; path: string } | null {
  if (!rest.startsWith("resolve/")) return null;
  const tail = rest.slice("resolve/".length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return null;
  const revision = tail.slice(0, slash);
  const path = tail.slice(slash + 1);
  if (revision.length === 0 || path.length === 0) return null;
  return { revision, path };
}

/**
 * Compose the LFS blob endpoint path (mount-relative). Format:
 *   `lfs/sha256/<hex>`
 */
export function composeHfBlobPath(sha256Hex: string): string {
  validateHexSha256(sha256Hex);
  return `lfs/sha256/${sha256Hex}`;
}

/** Inverse parser for `lfs/sha256/<hex>`. Returns null when shape is wrong. */
export function parseHfBlobPath(rest: string): { sha256: string } | null {
  if (!rest.startsWith("lfs/sha256/")) return null;
  const sha = rest.slice("lfs/sha256/".length);
  if (!HEX_SHA256_RE.test(sha)) return null;
  return { sha256: sha };
}

// ── Trivial helpers ───────────────────────────────────────────────

function truncate(s: unknown): string {
  if (typeof s !== "string") return String(s);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}
