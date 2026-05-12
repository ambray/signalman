/**
 * Release manifest — the canonical, hashable summary of a release's
 * artifacts. The manifest sha256 lives on the `release` row and is the
 * "did anything actually change" identity of a build.
 *
 * Determinism contract (per docs/design/meta-build-system.md §6.2):
 *   Two builds at the same commit SHA produce the same manifest sha256
 *   IFF every artifact's content (blob sha256 / image ref) matches.
 *   Toolchain non-determinism (timestamps embedded in MSIs, etc.) is
 *   tolerated — that's why we hash the manifest, not the binaries.
 *
 * Manifest layout: a list of `{component, kind, sha256?, image_ref?}`
 * entries, sorted by component name + a per-component artifact index.
 * The JSON is canonicalized (sorted keys, no whitespace) before hashing.
 */

import * as crypto from "node:crypto";

export interface ManifestEntry {
  component: string;
  kind: "blob" | "image_ref";
  /** sha256 hex (kind=blob only). */
  sha256?: string;
  /** Image reference, e.g. "myapp-backend:v1.0.0" (kind=image_ref only). */
  image_ref?: string;
}

export interface ReleaseManifest {
  schema_version: 1;
  product: string;
  tag: string;
  commit_sha: string;
  artifacts: ManifestEntry[];
}

/**
 * Canonicalize a JSON-serializable value: sort object keys, drop
 * undefined fields, no whitespace.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

/** SHA-256 hex of the canonical JSON of `manifest`. */
export function hashManifest(manifest: ReleaseManifest): string {
  const canon = canonicalize(manifest);
  return crypto.createHash("sha256").update(canon).digest("hex");
}

/** Build a manifest from a flat list of (component, artifact) pairs. */
export function buildManifest(input: {
  product: string;
  tag: string;
  commitSha: string;
  entries: ManifestEntry[];
}): ReleaseManifest {
  // Sort by component name for stable output. We don't sort by
  // artifact index because components are expected to declare their
  // artifacts in a stable order; preserving declaration order makes
  // diffs human-readable.
  const byComponent = new Map<string, ManifestEntry[]>();
  for (const e of input.entries) {
    if (!byComponent.has(e.component)) byComponent.set(e.component, []);
    byComponent.get(e.component)!.push(e);
  }
  const sortedComponents = Array.from(byComponent.keys()).sort();
  const ordered: ManifestEntry[] = [];
  for (const c of sortedComponents) {
    for (const e of byComponent.get(c)!) {
      ordered.push(e);
    }
  }
  return {
    schema_version: 1,
    product: input.product,
    tag: input.tag,
    commit_sha: input.commitSha,
    artifacts: ordered,
  };
}
