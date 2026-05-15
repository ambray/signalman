/**
 * Cargo virtual-registry pull-through (WS6 wave-3 M10.4).
 *
 * When an operator's `signalman registry virtual add --org acme
 * --kind cargo --upstream https://index.crates.io` row exists,
 * sparse-index + download requests that miss the local registry
 * proxy-fetch from the upstream, cache, and serve.
 *
 * Bootstrap-from-signalman use case: a CI build does
 * `cargo fetch` against `https://my-registry/cargo/acme/index/`;
 * crates owned by the org are served directly, crates from
 * crates.io transparently flow through the virtual upstream.
 *
 * # Locked design
 *
 * - **Re-sign on cache write when `resign_on_cache: true`.** The
 *   stored Manifest gets an Ed25519 signature with the operator's
 *   key. Provenance.originalSignature captures whatever upstream
 *   said (if anything) for audit.
 * - **Tarball blobs are content-addressed.** Two upstreams that
 *   serve the same crate tarball (byte-identical) deduplicate
 *   naturally. The blob row's `created_at` records first ingest;
 *   later misses against the same blob are a no-op.
 * - **Sparse-index entries are operator-pinned at cache time.**
 *   A subsequent upstream change (new version added) does NOT
 *   appear locally until the operator either (a) deletes the
 *   cached manifest for that crate to trigger a re-fetch, or (b)
 *   sets `cache_ttl_seconds` to a non-zero value on the upstream
 *   config so the proxy re-fetches periodically. This is the
 *   "pin the bytes that hit your build" semantic — compliance-
 *   friendly.
 * - **Allow / deny patterns** match against the cargo crate name
 *   (lowercased). Deny wins over allow. Implemented as simple
 *   glob: `*` matches any chars, `?` matches one char.
 * - **HTTP failures cascade**: on any upstream non-200, the
 *   handler returns the original 404 so cargo treats the crate
 *   as not-found (rather than the operator getting a confusing
 *   500 mid-build). Audit log captures the failure for
 *   diagnostics.
 *
 * # NOT in scope for M10.4
 *
 * - Streaming upload-on-cache for >1 GiB tarballs. Current path
 *   buffers the response into memory before computing sha256;
 *   acceptable for typical crate sizes (median ~50 KB, p99 ~5 MB).
 *   Streaming is queued for the v0.4.3 operational hardening pass.
 * - Upstream auth pass-through for private crates.io tokens.
 *   `auth_header_template` is wired but `CARGO_VIRTUAL_TOKEN_<id>`
 *   env-var resolution is a M10.6 follow-up.
 * - Materialised sparse-index cache: every read re-queries storage.
 *   Acceptable until measured.
 */

import * as crypto from "node:crypto";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type CargoDependency,
  type CargoManifestMetadata,
  type Manifest,
  type ManifestSignature,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import type {
  SqliteManifestIndex,
  VirtualUpstream,
  VirtualUpstreamConfig,
} from "../storage/sqlite-index.js";
import { cargoManifestName, sparseIndexPathFor } from "./paths.js";

/**
 * Injectable upstream fetcher. Tests stub this with a fixed
 * NDJSON / tarball response; production uses node:fetch.
 */
export type UpstreamFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<UpstreamFetchResult>;

export interface UpstreamFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface VirtualCargoOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  /** Injectable upstream fetcher. Default uses `globalThis.fetch`. */
  fetch?: UpstreamFetch;
  /**
   * Operator's Ed25519 private key (PEM) used for re-signing
   * cached manifests when the upstream's `resign_on_cache` flag is
   * set. Optional — if absent, re-signing is silently skipped
   * (provenance still records the upstream URL for audit).
   */
  signingPrivateKeyPem?: string;
  /**
   * Actor id recorded in the audit log + provenance.fetchedBy for
   * proxy-cache fills. Defaults to `'virtual-cargo'` — the proxy
   * is the system actor for proxy operations.
   */
  proxyActor?: string;
}

/**
 * Try to proxy-fetch + cache a cargo crate's sparse-index entries
 * for one crate name. Returns the locally-stored NDJSON (one line
 * per version) when a virtual upstream covers this org+name and
 * the upstream responds with usable data; returns null when:
 *   - No virtual upstream configured for (org, cargo)
 *   - Name fails the allow/deny pattern check
 *   - Upstream returned non-200 or unparseable data
 *
 * Caller layers this AFTER the local-storage check.
 */
export async function proxyCargoSparseIndex(
  opts: VirtualCargoOptions,
  org: string,
  name: string,
): Promise<string | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "cargo" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-cargo";

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(name, upstream.config)) continue;
    const upstreamSparsePath = sparseIndexPathFor(name);
    const url = joinUrl(upstream.upstreamUrl, upstreamSparsePath);
    let resp: UpstreamFetchResult;
    try {
      resp = await fetcher(url, {
        headers: buildAuthHeaders(upstream.config),
      });
    } catch (err) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "fetch_error",
          url,
          name,
          error: (err as Error).message,
        },
      });
      continue;
    }
    if (resp.status === 404) continue; // try next upstream
    if (resp.status >= 400) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "upstream_error",
          url,
          name,
          status: resp.status,
        },
      });
      continue;
    }

    // Parse upstream NDJSON → cache each version as a cargo manifest
    const lines = resp.body
      .toString("utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    let cached = 0;
    for (const line of lines) {
      let entry: Partial<CargoManifestMetadata> & {
        name?: string;
        vers?: string;
        cksum?: string;
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry.name || !entry.vers || !entry.cksum) continue;
      const cached_ok = await cacheUpstreamVersion(
        opts,
        org,
        upstream,
        entry as CargoManifestMetadata,
        actor,
      );
      if (cached_ok) cached += 1;
    }
    if (cached === 0) continue; // no usable versions; try next upstream

    // Read back the merged local view (includes any already-cached
    // versions + the freshly-cached ones)
    const manifestName = cargoManifestName(org, name);
    const versions = opts.index.listManifestVersions(manifestName);
    const out: string[] = [];
    for (const v of versions) {
      const m = await opts.storage.getManifest(v.name, v.version);
      if (!m || m.kind !== "cargo" || !m.cargoMetadata) continue;
      out.push(JSON.stringify(serializeIndexEntryShape(m.cargoMetadata)));
    }
    return out.length === 0 ? null : out.join("\n") + "\n";
  }
  return null;
}

/**
 * Proxy a cargo tarball download. Returns the cached blob's sha256
 * when the upstream had the bytes (and the local cache now holds
 * them); null when no upstream covers the crate or upstream 404'd.
 */
export async function proxyCargoDownload(
  opts: VirtualCargoOptions,
  org: string,
  name: string,
  version: string,
): Promise<{ sha256: string; bytes: Buffer } | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "cargo" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-cargo";

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(name, upstream.config)) continue;
    const url = joinUrl(
      upstream.upstreamUrl,
      // Cargo's CDN-style download URL. Different upstreams have
      // different shapes; this works for crates.io's static.crates.io
      // form. Operators with non-standard upstreams override via
      // virtualUpstream.config.download_url_template (M10.6 follow-up).
      `${name}/${version}/download`,
    );
    let resp: UpstreamFetchResult;
    try {
      resp = await fetcher(url, {
        headers: buildAuthHeaders(upstream.config),
      });
    } catch (err) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "download_fetch_error",
          url,
          name,
          version,
          error: (err as Error).message,
        },
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) continue;
    const sha256 = crypto.createHash("sha256").update(resp.body).digest("hex");
    const blob = await opts.storage.putBlob({
      body: resp.body,
      contentType: "application/x-tar",
    });
    if (blob.sha256 !== sha256) {
      // Driver bug; refuse to serve.
      continue;
    }
    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "virtual_upstream",
      entityId: upstream.id,
      actor,
      detail: {
        phase: "download_cached",
        url,
        name,
        version,
        bytes: resp.body.length,
        sha256,
      },
    });
    return { sha256, bytes: resp.body };
  }
  return null;
}

async function cacheUpstreamVersion(
  opts: VirtualCargoOptions,
  org: string,
  upstream: VirtualUpstream,
  entry: CargoManifestMetadata,
  actor: string,
): Promise<boolean> {
  // Skip versions we've already cached. The local row's cargoMetadata
  // takes precedence (operator's yank decisions stick).
  const manifestName = cargoManifestName(org, entry.name);
  const existing = await opts.storage.getManifest(manifestName, entry.vers);
  if (existing) return false;

  const manifest: Manifest = {
    name: manifestName,
    version: entry.vers,
    mediaType: "application/vnd.signalman.cargo-crate.v1+json",
    kind: "cargo",
    blobs: [
      {
        mediaType: "application/x-tar",
        sha256: entry.cksum,
        // We don't have size at sparse-index time — first download
        // populates the blob. Size is informational on the BlobRef.
        name: `${entry.name}-${entry.vers}.crate`,
      },
    ],
    cargoMetadata: normaliseCargoMetadata(entry),
    createdAt: new Date().toISOString(),
  };

  // Re-sign with the operator's key when configured. The original
  // upstream signature (if cargo carried one) lives on provenance.
  let signedManifest = manifest;
  if (upstream.config.resign_on_cache && opts.signingPrivateKeyPem) {
    try {
      const sig = signManifest(manifest, opts.signingPrivateKeyPem);
      signedManifest = {
        ...manifest,
        signature: {
          signatureB64: sig.signatureB64,
          signedBy: sig.signedBy,
        },
      };
    } catch (err) {
      // Re-sign failure isn't fatal; we cache unsigned + audit it.
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "resign_error",
          name: entry.name,
          vers: entry.vers,
          error: (err as Error).message,
        },
      });
    }
  }

  const provenance: Provenance = {
    source: "proxy_cache",
    upstreamUrl: upstream.upstreamUrl,
    fetchedAt: manifest.createdAt,
    fetchedBy: actor,
  };

  // Cargo's sparse-index proxy path doesn't fetch the tarball — we
  // only have the cksum hint, no bytes. Storage's putManifest
  // refuses manifests pinning unknown blobs, so we sidestep by
  // calling the index directly. The download endpoint pulls
  // tarball bytes on first access (proxyCargoDownload).
  //
  // canonical bytes MUST match what signManifest computed (the
  // sig-stripped form). canonicalManifestBytes() does exactly that.
  const canonical = canonicalManifestBytes(signedManifest);
  try {
    opts.index.putManifest(signedManifest, canonical, provenance);
  } catch (err) {
    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "virtual_upstream",
      entityId: upstream.id,
      actor,
      detail: {
        phase: "store_error",
        name: entry.name,
        vers: entry.vers,
        error: (err as Error).message,
      },
    });
    return false;
  }

  opts.index.appendAuditEntry({
    action: "proxy_cache",
    entityType: "cargo_crate",
    entityId: `${manifestName}@${entry.vers}`,
    actor,
    detail: {
      upstream_url: upstream.upstreamUrl,
      upstream_id: upstream.id,
      org,
      name: entry.name,
      vers: entry.vers,
      cksum: entry.cksum,
      resigned: !!(upstream.config.resign_on_cache && opts.signingPrivateKeyPem),
    },
  });
  return true;
}

function normaliseCargoMetadata(
  entry: Partial<CargoManifestMetadata>,
): CargoManifestMetadata {
  return {
    name: entry.name!,
    vers: entry.vers!,
    deps: (entry.deps ?? []) as CargoDependency[],
    cksum: entry.cksum!,
    features: entry.features ?? {},
    yanked: entry.yanked ?? false,
    ...(entry.rust_version != null ? { rust_version: entry.rust_version } : {}),
    ...(entry.links != null ? { links: entry.links } : {}),
  };
}

/**
 * Glob-match the crate name against the upstream's allow/deny
 * patterns. Default: allow everything (no patterns set).
 */
export function nameMatchesPatterns(
  name: string,
  config: VirtualUpstreamConfig,
): boolean {
  const lc = name.toLowerCase();
  if (config.deny_patterns?.some((p) => globMatch(lc, p))) return false;
  if (config.allow_patterns && config.allow_patterns.length > 0) {
    return config.allow_patterns.some((p) => globMatch(lc, p));
  }
  return true;
}

function globMatch(s: string, pattern: string): boolean {
  // Glob → regex: `*` → `.*`, `?` → `.`, escape other regex meta.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(s);
}

function buildAuthHeaders(
  config: VirtualUpstreamConfig,
): Record<string, string> {
  if (!config.auth_header_template) return {};
  return { authorization: config.auth_header_template };
}

function joinUrl(base: string, suffix: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

const defaultFetch: UpstreamFetch = async (url, init) => {
  const resp = await globalThis.fetch(url, {
    headers: init?.headers ?? {},
  });
  const bytes = Buffer.from(await resp.arrayBuffer());
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    status: resp.status,
    headers,
    body: bytes,
  };
};

// Re-shape an internal CargoManifestMetadata into the cargo-spec
// sparse-index entry shape. Mirrors `serializeIndexEntry` in read.ts
// but inlined here to avoid the cargo/cargo circular import.
function serializeIndexEntryShape(meta: CargoManifestMetadata): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: meta.name,
    vers: meta.vers,
    deps: meta.deps,
    cksum: meta.cksum,
    features: meta.features ?? {},
    yanked: meta.yanked,
  };
  if (meta.rust_version !== undefined) entry.rust_version = meta.rust_version;
  if (meta.links !== undefined) entry.links = meta.links;
  return entry;
}
