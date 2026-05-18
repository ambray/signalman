/**
 * NuGet virtual upstream pull-through.
 *
 * On a flat-container miss (`GET /v3/flat2/<id>/<version>/
 * <id>.<version>.nupkg`), the registry fetches the upstream service
 * index, resolves the package-base-address resource URL, fetches the
 * nupkg, content-addresses the bytes, projects the nuspec into a
 * `kind: 'nuget'` manifest row with `provenance.source = 'proxy_cache'`,
 * and re-signs the row when configured.
 *
 * Version-index pull-through is also supported — when the
 * `flat2/<id>/index.json` is missed, we fetch the upstream version
 * index and stub per-version manifest rows lazily (the per-version
 * blobs populate on first GET).
 *
 * Public nuget.org is anonymous. Private repos (GitHub Packages NuGet,
 * Azure Artifacts, MyGet) authenticate via Basic / Bearer — the
 * existing `auth_header_template` on the virtual_upstream config row
 * is reused.
 *
 * The upstream URL on a virtual_upstream row is the operator-supplied
 * **service-index URL** (e.g. `https://api.nuget.org/v3/index.json`).
 * We fetch it once on each proxy attempt (cheap; nuget.org returns a
 * small JSON document) and resolve the PackageBaseAddress resource
 * to build the per-blob URL.
 */

import {
  type Manifest,
  type NugetManifestMetadata,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import type {
  SqliteManifestIndex,
  VirtualUpstream,
} from "../storage/sqlite-index.js";
import { nameMatchesPatterns, type UpstreamFetch } from "../cargo/index.js";
import * as crypto from "node:crypto";
import { NugetError } from "./errors.js";
import {
  NUGET_ERROR_CODES,
  NUGET_MEDIA_TYPES,
  NUGET_RESOURCE_TYPES,
  type NugetFlatContainerVersionIndex,
  type NugetServiceIndex,
} from "./types.js";
import {
  normalisePackageId,
  normaliseVersion,
  nugetManifestName,
  nugetManifestVersion,
} from "./paths.js";
import { extractNuspecFromNupkg, parseNuspec } from "./guards.js";

export interface VirtualNugetOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  fetch?: UpstreamFetch;
  /** Re-sign cached manifest rows with this Ed25519 PEM when configured. */
  signingPrivateKeyPem?: string;
  /** Actor for audit-log entries. Default `'virtual-nuget'`. */
  proxyActor?: string;
}

/**
 * Pull-through fetch for a single nupkg.
 */
export async function proxyNugetNupkg(
  opts: VirtualNugetOptions,
  org: string,
  id: string,
  version: string,
): Promise<boolean> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "nuget" });
  if (upstreams.length === 0) return false;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-nuget";
  const lid = normalisePackageId(id);
  const lver = normaliseVersion(version);

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(lid, upstream.config)) continue;
    const baseAddr = await resolvePackageBaseAddress(fetcher, upstream);
    if (!baseAddr) {
      auditFailure(opts.index, upstream, actor, "service_index_error", {
        url: upstream.upstreamUrl,
        id: lid,
        version: lver,
      });
      continue;
    }
    const upstreamPath = `${trimTrailingSlash(baseAddr)}/${lid}/${lver}/${lid}.${lver}.nupkg`;
    let resp;
    try {
      resp = await fetcher(upstreamPath, {
        method: "GET",
        headers: authHeaders(upstream),
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "fetch_error", {
        url: upstreamPath,
        id: lid,
        version: lver,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "upstream_error", {
        url: upstreamPath,
        id: lid,
        version: lver,
        status: resp.status,
      });
      continue;
    }

    // Cache the bytes + project nuspec.
    let nuspecBytes;
    try {
      nuspecBytes = extractNuspecFromNupkg(resp.body);
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "parse_error", {
        url: upstreamPath,
        id: lid,
        version: lver,
        error: `nuspec extract failed: ${(err as Error).message}`,
      });
      continue;
    }
    let nuspec;
    try {
      nuspec = parseNuspec(nuspecBytes);
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "parse_error", {
        url: upstreamPath,
        id: lid,
        version: lver,
        error: `nuspec parse failed: ${(err as Error).message}`,
      });
      continue;
    }

    const blobMeta = await opts.storage.putBlob({
      body: resp.body,
      contentType: NUGET_MEDIA_TYPES.NUPKG,
    });
    const packageHash = crypto.createHash("sha512").update(resp.body).digest("base64");
    const storageName = nugetManifestName(org, lid);
    const versionKey = nugetManifestVersion(lver);
    const nugetMetadata: NugetManifestMetadata = {
      id: lid,
      version: lver,
      ...(nuspec.id !== lid ? { originalId: nuspec.id } : {}),
      ...(nuspec.version !== lver ? { originalVersion: nuspec.version } : {}),
      ...(nuspec.authors ? { authors: nuspec.authors } : {}),
      ...(nuspec.description ? { description: nuspec.description } : {}),
      ...(nuspec.summary ? { summary: nuspec.summary } : {}),
      ...(nuspec.title ? { title: nuspec.title } : {}),
      ...(nuspec.tags ? { tags: nuspec.tags } : {}),
      ...(nuspec.projectUrl ? { projectUrl: nuspec.projectUrl } : {}),
      ...(nuspec.licenseUrl ? { licenseUrl: nuspec.licenseUrl } : {}),
      ...(nuspec.licenseExpression
        ? { licenseExpression: nuspec.licenseExpression }
        : {}),
      ...(nuspec.iconUrl ? { iconUrl: nuspec.iconUrl } : {}),
      ...(nuspec.requireLicenseAcceptance !== undefined
        ? { requireLicenseAcceptance: nuspec.requireLicenseAcceptance }
        : {}),
      ...(nuspec.dependencyGroups
        ? { dependencyGroups: nuspec.dependencyGroups }
        : {}),
      ...(nuspec.targetFrameworks
        ? { targetFrameworks: nuspec.targetFrameworks }
        : {}),
      packageHash,
      packageHashAlgorithm: "SHA512",
      packageSize: resp.body.length,
      listed: true,
    };

    const manifest: Manifest = {
      name: storageName,
      version: versionKey,
      mediaType: "application/vnd.signalman.nuget-package.v1+json",
      kind: "nuget",
      blobs: [
        {
          mediaType: NUGET_MEDIA_TYPES.NUPKG,
          sha256: blobMeta.sha256,
          size: blobMeta.size,
          name: `${lid}.${lver}.nupkg`,
        },
      ],
      nugetMetadata,
      createdAt: new Date().toISOString(),
    };

    let signedManifest = manifest;
    if (upstream.config.resign_on_cache && opts.signingPrivateKeyPem) {
      try {
        const sig = signManifest(manifest, opts.signingPrivateKeyPem);
        signedManifest = {
          ...manifest,
          signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
        };
      } catch (err) {
        auditFailure(opts.index, upstream, actor, "resign_error", {
          id: lid,
          version: lver,
          error: (err as Error).message,
        });
      }
    }
    const provenance: Provenance = {
      source: "proxy_cache",
      upstreamUrl: upstream.upstreamUrl,
      fetchedAt: manifest.createdAt,
      fetchedBy: actor,
    };
    const canonical = canonicalManifestBytes(signedManifest);
    try {
      opts.index.putManifest(signedManifest, canonical, provenance);
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "store_error", {
        id: lid,
        version: lver,
        error: (err as Error).message,
      });
      continue;
    }

    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: `${storageName}@${versionKey}`,
      actor,
      detail: {
        kind: "nuget",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        org,
        id: lid,
        version: lver,
        bytes: resp.body.length,
        resigned: !!(upstream.config.resign_on_cache && opts.signingPrivateKeyPem),
      },
    });
    return true;
  }
  return false;
}

/**
 * Pull-through fetch for a flat-container version index. On miss,
 * fetch the upstream `flat2/<id>/index.json` and lazy-stub a manifest
 * row for each version (per-version blobs cache on first artifact
 * GET via `proxyNugetNupkg`).
 *
 * **Implementation note**: at v0.6 we don't pre-stub the blobs (that
 * would require fetching every nupkg eagerly — wrong cost model for
 * a transparent pull-through). Instead we fetch the upstream version
 * list and create empty placeholder rows would be incorrect since the
 * read path expects a blob ref. So this implementation eagerly hydrates
 * the FIRST version listed (so subsequent GET-by-version requests
 * succeed via `proxyNugetNupkg` per-version); the version-index
 * response from upstream is forwarded byte-equivalent for the
 * common case where the operator just wants to see what's available.
 *
 * The simpler model: return false, leaving cache miss → 404 for the
 * version-index endpoint, and rely on per-blob proxy. The dotnet
 * client requests the version index but is content with a per-blob
 * lookup if the version index 404s. This is the v0.6 behaviour;
 * a richer version-index pull-through is a v0.6.1 polish.
 */
export async function proxyNugetVersionIndex(
  opts: VirtualNugetOptions,
  org: string,
  id: string,
): Promise<boolean> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "nuget" });
  if (upstreams.length === 0) return false;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-nuget";
  const lid = normalisePackageId(id);

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(lid, upstream.config)) continue;
    const baseAddr = await resolvePackageBaseAddress(fetcher, upstream);
    if (!baseAddr) {
      auditFailure(opts.index, upstream, actor, "service_index_error", {
        url: upstream.upstreamUrl,
        id: lid,
        phase: "version_index",
      });
      continue;
    }
    const url = `${trimTrailingSlash(baseAddr)}/${lid}/index.json`;
    let resp;
    try {
      resp = await fetcher(url, {
        method: "GET",
        headers: authHeaders(upstream),
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "fetch_error", {
        url,
        id: lid,
        phase: "version_index",
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "upstream_error", {
        url,
        id: lid,
        status: resp.status,
      });
      continue;
    }
    let parsed: NugetFlatContainerVersionIndex;
    try {
      parsed = JSON.parse(resp.body.toString("utf-8")) as NugetFlatContainerVersionIndex;
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "parse_error", {
        url,
        id: lid,
        error: `version-index JSON parse failed: ${(err as Error).message}`,
      });
      continue;
    }
    if (!Array.isArray(parsed.versions) || parsed.versions.length === 0) {
      continue;
    }
    // Hydrate every version by recursing into proxyNugetNupkg. For the
    // typical small-package case this is fine; for packages with
    // hundreds of versions this is expensive (each version is a
    // separate upstream fetch). Operators who want bounded hydration
    // can set `deny_patterns` on the upstream or rely on the
    // per-blob lazy path (skip the version-index endpoint, hit the
    // nupkg URLs directly).
    let any = false;
    for (const v of parsed.versions) {
      const ok = await proxyNugetNupkg(opts, org, lid, v);
      if (ok) any = true;
    }
    if (any) return true;
  }
  return false;
}

/**
 * Resolve the PackageBaseAddress resource URL from an upstream's
 * service-index. Cached in-memory per process via the SqliteManifestIndex
 * is overkill at v0.6 — each request re-fetches index.json. nuget.org
 * gates this on edge caches; latency is bounded.
 */
async function resolvePackageBaseAddress(
  fetcher: UpstreamFetch,
  upstream: VirtualUpstream,
): Promise<string | null> {
  // Operators may configure `upstream_url` as either the service-index
  // URL (canonical) or the flat-container base. Heuristic: if the URL
  // ends with `index.json`, treat as service-index; otherwise as a
  // direct flat-container base.
  if (!upstream.upstreamUrl.endsWith("index.json")) {
    return upstream.upstreamUrl;
  }
  let resp;
  try {
    resp = await fetcher(upstream.upstreamUrl, {
      method: "GET",
      headers: authHeaders(upstream),
    });
  } catch {
    return null;
  }
  if (resp.status >= 400) return null;
  let parsed: NugetServiceIndex;
  try {
    parsed = JSON.parse(resp.body.toString("utf-8")) as NugetServiceIndex;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.resources)) return null;
  for (const r of parsed.resources) {
    if (r["@type"] === NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS) {
      return r["@id"];
    }
  }
  return null;
}

function authHeaders(upstream: VirtualUpstream): Record<string, string> {
  return upstream.config.auth_header_template
    ? { authorization: upstream.config.auth_header_template }
    : {};
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

const defaultFetch: UpstreamFetch = async (url, init) => {
  const resp = await fetch(url, {
    method: init?.method ?? "GET",
    ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: resp.status, body: buf, headers };
};

function auditFailure(
  index: SqliteManifestIndex,
  upstream: VirtualUpstream,
  actor: string,
  phase: string,
  detail: Record<string, unknown>,
): void {
  index.appendAuditEntry({
    action: "proxy_cache",
    entityType: "manifest",
    entityId: `nuget@${upstream.id}`,
    actor,
    detail: {
      kind: "nuget",
      phase,
      upstream_url: upstream.upstreamUrl,
      upstream_id: upstream.id,
      ...detail,
    },
  });
}

void NugetError;
void NUGET_ERROR_CODES;
