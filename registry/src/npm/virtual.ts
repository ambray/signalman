/**
 * Npm virtual-registry pull-through (v0.1.1).
 *
 * Mirrors the cargo M10.4 design (registry/src/cargo/virtual.ts)
 * for the npm protocol. Lets a CI build `npm install` against
 * `https://my-registry/npm/<org>/` and have both org-owned
 * packages AND npmjs.com packages resolve transparently — with
 * provenance + audit trail.
 *
 * On packument miss:
 *   1. Consult virtual_upstream rows for (org, npm)
 *   2. GET <upstream>/<package> — fetch upstream packument
 *   3. Parse upstream `versions` map; cache each version locally
 *      as a kind='npm' manifest with provenance.source='proxy_cache'
 *   4. Re-sign on cache when resign_on_cache + signing key present
 *      (same Ed25519 path as cargo)
 *   5. Re-aggregate the local packument (operator's own + cached)
 *      and return
 *
 * On tarball miss:
 *   1. GET <upstream>/<package>/-/<basename>-<version>.tgz
 *   2. sha256 the bytes; idempotent putBlob (content-addressed)
 *   3. Audit-log `action: 'proxy_cache', entityType: 'manifest'`
 *
 * Pattern matching reuses the cargo allow/deny glob (`nameMatchesPatterns`
 * in cargo/virtual.ts). The pattern operates on the LOWERCASED
 * package name — scoped packages match as `@scope/name`.
 */

import * as crypto from "node:crypto";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Manifest,
  type NpmManifestMetadata,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import type {
  SqliteManifestIndex,
  VirtualUpstream,
} from "../storage/sqlite-index.js";
import { nameMatchesPatterns, type UpstreamFetch } from "../cargo/index.js";
import { packumentVersionEntry } from "./read.js";
import { npmManifestName } from "./paths.js";

export interface VirtualNpmOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  fetch?: UpstreamFetch;
  signingPrivateKeyPem?: string;
  proxyActor?: string;
  /** Public base URL — passed to packumentVersionEntry for tarball URL rewrite. */
  publicBaseUrl?: string;
}

/**
 * Proxy a packument request. Returns the packument JSON string on
 * upstream hit + cache fill, or null when no upstream covers this
 * package.
 */
export async function proxyNpmPackument(
  opts: VirtualNpmOptions,
  org: string,
  packageName: string,
): Promise<string | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "npm" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-npm";
  const baseUrl = opts.publicBaseUrl ?? "";

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(packageName.toLowerCase(), upstream.config)) continue;
    const url = joinUrl(upstream.upstreamUrl, encodeURIComponent(packageName));
    let resp;
    try {
      resp = await fetcher(url, { headers: buildAuthHeaders(upstream.config) });
    } catch (err) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "fetch_error",
          url,
          package: packageName,
          error: (err as Error).message,
        },
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "upstream_error",
          url,
          package: packageName,
          status: resp.status,
        },
      });
      continue;
    }

    let upstreamPackument: {
      name: string;
      versions: Record<string, NpmPublishVersionShape>;
    };
    try {
      upstreamPackument = JSON.parse(resp.body.toString("utf-8"));
    } catch {
      continue;
    }
    if (!upstreamPackument.versions || typeof upstreamPackument.versions !== "object") {
      continue;
    }

    let cached = 0;
    for (const [v, entry] of Object.entries(upstreamPackument.versions)) {
      const ok = await cacheUpstreamVersion(opts, org, upstream, entry, v, actor);
      if (ok) cached += 1;
    }
    if (cached === 0) continue;

    // Re-aggregate local view (cached + previously-stored)
    const manifestName = npmManifestName(org, packageName);
    const versions = opts.index.listManifestVersions(manifestName);
    const versionsMap: Record<string, Record<string, unknown>> = {};
    let latest: string | null = null;
    for (const v of versions) {
      const m = await opts.storage.getManifest(v.name, v.version);
      if (!m || m.kind !== "npm" || !m.npmMetadata) continue;
      versionsMap[v.version] = packumentVersionEntry(m, org, packageName, baseUrl);
      if (!latest) latest = v.version;
    }
    if (Object.keys(versionsMap).length === 0) return null;
    return JSON.stringify({
      name: packageName,
      "dist-tags": latest ? { latest } : {},
      versions: versionsMap,
    });
  }
  return null;
}

interface NpmPublishVersionShape {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  description?: string;
  keywords?: string[];
  homepage?: string;
  license?: string;
  main?: string;
  bin?: string | Record<string, string>;
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
  };
}

async function cacheUpstreamVersion(
  opts: VirtualNpmOptions,
  org: string,
  upstream: VirtualUpstream,
  entry: NpmPublishVersionShape,
  version: string,
  actor: string,
): Promise<boolean> {
  if (!entry.name || !entry.version) return false;
  const manifestName = npmManifestName(org, entry.name);
  const existing = await opts.storage.getManifest(manifestName, version);
  if (existing) return false;

  // For npm, the upstream packument carries dist.integrity + shasum
  // but NOT the tarball bytes themselves. The tarball is a separate
  // GET against dist.tarball. We cache the METADATA now; tarball
  // bytes are fetched on first download via proxyNpmTarball.
  //
  // The blob reference uses a synthetic sha256 derived from
  // integrity when present; otherwise we mark the blob as
  // "unknown-sha until first download". For now, we require
  // integrity to be present (skip versions without it).
  if (!entry.dist?.integrity) {
    return false;
  }
  // Extract sha256 from integrity if it's sha256-... (rare; most
  // npm packages use sha512). Otherwise leave the blob's sha256
  // pinned to the integrity-derived hex when the download lands.
  // For storage: we use the integrity's digest as a stable
  // identifier. The actual blob isn't present yet; the download
  // path fills it.
  //
  // Compute a synthetic blob sha from the upstream integrity. The
  // download endpoint validates the actual fetched bytes match.
  const blobSha = sha256FromIntegrity(entry.dist.integrity);

  const npmMetadata: NpmManifestMetadata = {
    name: entry.name,
    version: entry.version,
    integrity: entry.dist.integrity,
    ...(entry.dist.shasum ? { shasum: entry.dist.shasum } : {}),
    ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    ...(entry.devDependencies ? { devDependencies: entry.devDependencies } : {}),
    ...(entry.peerDependencies ? { peerDependencies: entry.peerDependencies } : {}),
    ...(entry.optionalDependencies ? { optionalDependencies: entry.optionalDependencies } : {}),
    ...(entry.engines ? { engines: entry.engines } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.keywords ? { keywords: entry.keywords } : {}),
    ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
    ...(entry.license !== undefined ? { license: entry.license } : {}),
    ...(entry.main !== undefined ? { main: entry.main } : {}),
    ...(entry.bin !== undefined ? { bin: entry.bin } : {}),
  };

  let manifest: Manifest = {
    name: manifestName,
    version,
    mediaType: "application/vnd.signalman.npm-package.v1+json",
    kind: "npm",
    blobs: [
      {
        mediaType: "application/octet-stream",
        sha256: blobSha,
      },
    ],
    npmMetadata,
    createdAt: new Date().toISOString(),
  };

  if (upstream.config.resign_on_cache && opts.signingPrivateKeyPem) {
    try {
      const sig = signManifest(manifest, opts.signingPrivateKeyPem);
      manifest = {
        ...manifest,
        signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
      };
    } catch (err) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "resign_error",
          name: entry.name,
          version,
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

  const canonical = canonicalManifestBytes(manifest);
  try {
    opts.index.putManifest(manifest, canonical, provenance);
  } catch (err) {
    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "virtual_upstream",
      entityId: upstream.id,
      actor,
      detail: {
        phase: "store_error",
        name: entry.name,
        version,
        error: (err as Error).message,
      },
    });
    return false;
  }

  opts.index.appendAuditEntry({
    action: "proxy_cache",
    entityType: "manifest",
    entityId: `${manifestName}@${version}`,
    actor,
    detail: {
      kind: "npm",
      upstream_url: upstream.upstreamUrl,
      upstream_id: upstream.id,
      org,
      name: entry.name,
      version,
      integrity: entry.dist.integrity,
      resigned: !!(upstream.config.resign_on_cache && opts.signingPrivateKeyPem),
    },
  });
  return true;
}

/**
 * Proxy a tarball download. Returns the cached bytes on upstream
 * hit, null when no upstream covers it.
 */
export async function proxyNpmTarball(
  opts: VirtualNpmOptions,
  org: string,
  packageName: string,
  version: string,
): Promise<{ sha256: string; bytes: Buffer } | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "npm" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-npm";

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(packageName.toLowerCase(), upstream.config)) continue;
    const basename = packageName.includes("/")
      ? packageName.split("/")[1]
      : packageName;
    // Standard npm tarball URL form (matches both registry.npmjs.org
    // and most mirrors)
    const url = joinUrl(
      upstream.upstreamUrl,
      `${encodeURIComponent(packageName)}/-/${basename}-${version}.tgz`,
    );
    let resp;
    try {
      resp = await fetcher(url, { headers: buildAuthHeaders(upstream.config) });
    } catch (err) {
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "virtual_upstream",
        entityId: upstream.id,
        actor,
        detail: {
          phase: "tarball_fetch_error",
          url,
          package: packageName,
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
      contentType: "application/octet-stream",
    });
    if (blob.sha256 !== sha256) continue;
    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: `${npmManifestName(org, packageName)}@${version}`,
      actor,
      detail: {
        kind: "npm",
        phase: "tarball_cached",
        url,
        bytes: resp.body.length,
        sha256,
      },
    });
    return { sha256, bytes: resp.body };
  }
  return null;
}

function sha256FromIntegrity(integrity: string): string {
  // npm SRI: `sha512-<base64>` or `sha256-<base64>`. We accept
  // either and convert to hex. If the algo isn't sha256 we
  // derive a stable identifier by hashing the integrity string
  // itself (so the row has a unique blob sha).
  if (integrity.startsWith("sha256-")) {
    const b64 = integrity.slice("sha256-".length);
    return Buffer.from(b64, "base64").toString("hex");
  }
  // Fallback: deterministic synthetic sha from the integrity bytes.
  return crypto.createHash("sha256").update(integrity).digest("hex");
}

function buildAuthHeaders(
  config: { auth_header_template?: string },
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
  const resp = await globalThis.fetch(url, { headers: init?.headers ?? {} });
  const bytes = Buffer.from(await resp.arrayBuffer());
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: resp.status, headers, body: bytes };
};
