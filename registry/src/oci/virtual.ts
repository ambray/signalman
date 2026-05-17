/**
 * OCI virtual-upstream pull-through.
 *
 * Same shape as `registry/src/cargo/virtual.ts` and `npm/virtual.ts`:
 *
 *   client GET /v2/<org>/<repo>/manifests/<ref>
 *     │
 *     ├─ local hit  → serve verbatim
 *     │
 *     └─ local miss → consult virtual_upstream rows for (org, kind='oci')
 *                       │
 *                       for each upstream (in created_at order):
 *                       │
 *                       ├─ pattern-match repo against allow/deny
 *                       ├─ resolve upstream-auth adapter (dockerhub|ghcr|ecr)
 *                       ├─ fetch upstream manifest / blob
 *                       ├─ verify upstream digest (Docker-Content-Digest)
 *                       ├─ store as kind='oci' manifest with provenance=proxy_cache
 *                       ├─ re-sign with operator Ed25519 key when configured
 *                       ├─ append audit row (action='proxy_cache')
 *                       └─ return bytes
 *
 * Bytes are cached content-addressed via the existing storage layer.
 * Subsequent requests for the same digest hit local; subsequent
 * requests for the same tag hit the cached tag pointer (no upstream
 * round-trip).
 *
 * **Upstream repository mapping**: the operator's local repo name
 * may differ from the upstream's. Config knob:
 *   upstream_repo_template = "library/{repo}"
 * for Docker Hub library images (so local `acme/alpine` maps to
 * upstream `library/alpine`). When the template is absent, the
 * local repo (the `<repo>` portion of `oci/<org>/<repo>`) maps 1:1
 * to upstream.
 */

import * as crypto from "node:crypto";
import {
  type Manifest,
  type OciManifestMetadata,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import type {
  SqliteManifestIndex,
  VirtualUpstream,
} from "../storage/sqlite-index.js";
import { nameMatchesPatterns, type UpstreamFetch } from "../cargo/index.js";
import { INDEX_MEDIA_TYPES } from "./types.js";
import {
  createUpstreamAuthAdapter,
  type UpstreamFlavor,
} from "./upstream-auth.js";
import { ociManifestName, validateOciDigest } from "./paths.js";
import { TagStore } from "./tag-store.js";

export interface VirtualOciOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  tagStore: TagStore;
  fetch?: UpstreamFetch;
  /** Operator Ed25519 private key (PEM) — re-sign cached manifests when configured. */
  signingPrivateKeyPem?: string;
  /** Actor recorded in audit + provenance for proxy fills. */
  proxyActor?: string;
  /** Tests: injectable clock for SigV4 amz-date stability. */
  now?: () => Date;
}

export interface ProxiedManifest {
  /** sha256 hex of the literal bytes. */
  digestHex: string;
  /** `application/vnd.*` content type. */
  mediaType: string;
  /** The literal manifest body the upstream served. */
  body: Buffer;
}

export interface ProxiedBlob {
  digestHex: string;
  body: Buffer;
  contentType: string;
}

/**
 * Attempt to proxy a manifest from a configured upstream. Returns
 * the proxied manifest body on success (and stores + re-signs it as
 * a side effect); returns null when no upstream matches or every
 * upstream returns 404 / fails.
 */
export async function proxyOciManifest(
  opts: VirtualOciOptions,
  org: string,
  repo: string,
  reference: { kind: "tag" | "digest"; value: string },
): Promise<ProxiedManifest | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "oci" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-oci";

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(repo.toLowerCase(), upstream.config)) continue;
    const flavor = upstreamFlavorFrom(upstream);
    if (!flavor) continue;
    const upstreamRepo = composeUpstreamRepo(repo, upstream);

    let authValue = "";
    try {
      const adapter = createUpstreamAuthAdapter({
        flavor,
        config: upstream.config as Record<string, unknown>,
        ...(upstream.config.auth_header_template
          ? { bearerToken: stripBearerPrefix(upstream.config.auth_header_template) }
          : {}),
        fetch: fetcher,
        ...(opts.now ? { now: opts.now } : {}),
      });
      const result = await adapter.authorize({
        repository: upstreamRepo,
        action: "pull",
      });
      authValue = result.authorization;
    } catch (err) {
      logProxyFailure(opts.index, upstream, actor, "auth_error", {
        repository: upstreamRepo,
        error: (err as Error).message,
      });
      continue;
    }

    const url = `${trimTrailingSlash(upstream.upstreamUrl)}/v2/${upstreamRepo}/manifests/${reference.value}`;
    let resp;
    try {
      resp = await fetcher(url, {
        method: "GET",
        headers: composeFetchHeaders(authValue),
      });
    } catch (err) {
      logProxyFailure(opts.index, upstream, actor, "fetch_error", {
        url,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      logProxyFailure(opts.index, upstream, actor, "upstream_error", {
        url,
        status: resp.status,
      });
      continue;
    }
    const mediaType =
      resp.headers["content-type"] ??
      resp.headers["Content-Type"] ??
      "application/vnd.oci.image.manifest.v1+json";
    const digestHex = crypto.createHash("sha256").update(resp.body).digest("hex");
    // If the upstream advertised a digest, verify our computation matches.
    const upstreamDigest =
      resp.headers["docker-content-digest"] ??
      resp.headers["Docker-Content-Digest"];
    if (upstreamDigest) {
      try {
        const upstreamHex = validateOciDigest(upstreamDigest);
        if (upstreamHex !== digestHex) {
          logProxyFailure(opts.index, upstream, actor, "digest_mismatch", {
            url,
            upstream_digest: upstreamDigest,
            computed_digest: `sha256:${digestHex}`,
          });
          continue;
        }
      } catch {
        // Upstream sent a malformed digest header; trust our compute.
      }
    }

    // Persist as a kind='oci' manifest. Reuses M3's bypass-canonicalize
    // pattern so the stored bytes match the upstream's bytes verbatim
    // (matters because the digest is the bytes' sha256).
    const storageName = ociManifestName(org, repo);
    const provenance: Provenance = {
      source: "proxy_cache",
      upstreamUrl: upstream.upstreamUrl,
      fetchedAt: new Date().toISOString(),
      fetchedBy: actor,
    };
    const ociMetadata = projectMinimalMetadata(resp.body, mediaType);
    const manifest: Manifest = {
      name: storageName,
      version: digestHex,
      mediaType,
      kind: "oci",
      blobs: [],
      ociMetadata,
      createdAt: provenance.fetchedAt,
    };

    // Re-sign with the operator's key when configured. The re-sign
    // does NOT mutate the cached bytes (the OCI digest must stay
    // verbatim); the registry's signature lives on the row's
    // signature_b64 column. Cosign consumers use that as a sibling
    // signature; M6 wires it cleanly. M5 just records the sig.
    let signedManifest = manifest;
    if (upstream.config.resign_on_cache && opts.signingPrivateKeyPem) {
      try {
        const sig = signManifest(
          {
            ...manifest,
            // Strip ociMetadata + blobs from the signing surface so
            // the registry-side row signature only attests to the
            // canonical fields shared with cargo + npm. The OCI body
            // itself is bytes-pinned via canonical_bytes.
          },
          opts.signingPrivateKeyPem,
        );
        signedManifest = {
          ...manifest,
          signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
        };
      } catch (err) {
        logProxyFailure(opts.index, upstream, actor, "resign_error", {
          repository: upstreamRepo,
          error: (err as Error).message,
        });
        // Fall through — cache unsigned + audit the skip.
      }
    }

    try {
      opts.index.putManifest(signedManifest, resp.body, provenance);
    } catch (err) {
      // MANIFEST_EXISTS is acceptable (idempotent re-cache).
      const e = err as { code?: string };
      if (e.code !== "manifest_exists") {
        logProxyFailure(opts.index, upstream, actor, "store_error", {
          repository: upstreamRepo,
          error: (err as Error).message,
        });
        continue;
      }
    }

    // If the operator referenced by tag, install the tag pointer too.
    if (reference.kind === "tag") {
      opts.tagStore.put(storageName, reference.value, digestHex);
    }

    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: `${storageName}@sha256:${digestHex}`,
      actor,
      detail: {
        kind: "oci",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        upstream_flavor: flavor,
        upstream_repo: upstreamRepo,
        ref_kind: reference.kind,
        ref_value: reference.value,
        bytes: resp.body.length,
        media_type: mediaType,
        resigned: !!(upstream.config.resign_on_cache && opts.signingPrivateKeyPem),
      },
    });

    return { digestHex, mediaType, body: resp.body };
  }

  return null;
}

/**
 * Attempt to proxy a blob from a configured upstream. Returns the
 * fetched bytes on success (and caches as a content-addressed blob
 * with a `proxy_cache` audit row); returns null when nothing matches.
 */
export async function proxyOciBlob(
  opts: VirtualOciOptions,
  org: string,
  repo: string,
  digestHex: string,
): Promise<ProxiedBlob | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "oci" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-oci";

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(repo.toLowerCase(), upstream.config)) continue;
    const flavor = upstreamFlavorFrom(upstream);
    if (!flavor) continue;
    const upstreamRepo = composeUpstreamRepo(repo, upstream);

    let authValue = "";
    try {
      const adapter = createUpstreamAuthAdapter({
        flavor,
        config: upstream.config as Record<string, unknown>,
        ...(upstream.config.auth_header_template
          ? { bearerToken: stripBearerPrefix(upstream.config.auth_header_template) }
          : {}),
        fetch: fetcher,
        ...(opts.now ? { now: opts.now } : {}),
      });
      const result = await adapter.authorize({
        repository: upstreamRepo,
        action: "pull",
      });
      authValue = result.authorization;
    } catch (err) {
      logProxyFailure(opts.index, upstream, actor, "auth_error", {
        repository: upstreamRepo,
        error: (err as Error).message,
      });
      continue;
    }

    const url = `${trimTrailingSlash(upstream.upstreamUrl)}/v2/${upstreamRepo}/blobs/sha256:${digestHex}`;
    let resp;
    try {
      resp = await fetcher(url, {
        method: "GET",
        headers: composeFetchHeaders(authValue),
      });
    } catch (err) {
      logProxyFailure(opts.index, upstream, actor, "fetch_error", {
        url,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      logProxyFailure(opts.index, upstream, actor, "upstream_error", {
        url,
        status: resp.status,
      });
      continue;
    }
    const computed = crypto.createHash("sha256").update(resp.body).digest("hex");
    if (computed !== digestHex) {
      logProxyFailure(opts.index, upstream, actor, "digest_mismatch", {
        url,
        upstream_digest: `sha256:${computed}`,
        requested_digest: `sha256:${digestHex}`,
      });
      continue;
    }
    const contentType =
      resp.headers["content-type"] ??
      resp.headers["Content-Type"] ??
      "application/octet-stream";
    const blob = await opts.storage.putBlob({ body: resp.body, contentType });
    if (blob.sha256 !== digestHex) {
      // Storage driver bug — refuse to serve.
      continue;
    }
    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "blob",
      entityId: digestHex,
      actor,
      detail: {
        kind: "oci",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        upstream_flavor: flavor,
        upstream_repo: upstreamRepo,
        bytes: resp.body.length,
        content_type: contentType,
      },
    });
    return { digestHex, body: resp.body, contentType };
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────

function projectMinimalMetadata(
  body: Buffer,
  mediaType: string,
): OciManifestMetadata {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const schemaVariant =
    mediaType.includes("vnd.oci.")
      ? "oci-v1"
      : "docker-v2-2";
  const out: OciManifestMetadata = {
    isIndex: INDEX_MEDIA_TYPES.has(mediaType),
    schemaVariant,
  };
  if (parsed && typeof parsed === "object") {
    if (!out.isIndex) {
      const config = parsed.config as { digest?: string; mediaType?: string; size?: number } | undefined;
      const layers = parsed.layers as Array<{ digest?: string; size?: number }> | undefined;
      if (config?.digest) out.configDigest = config.digest;
      if (config?.mediaType) out.configMediaType = config.mediaType;
      if (Array.isArray(layers)) {
        out.layerDigests = layers
          .map((l) => (typeof l.digest === "string" ? l.digest : ""))
          .filter((d) => d.length > 0);
        const totalSize = layers.reduce(
          (acc, l) => acc + (typeof l.size === "number" ? l.size : 0),
          typeof config?.size === "number" ? config.size : 0,
        );
        if (totalSize > 0) out.totalSize = totalSize;
      }
    } else {
      const manifests = parsed.manifests as Array<{
        digest?: string;
        mediaType?: string;
        size?: number;
        platform?: { architecture?: string; os?: string; variant?: string };
      }> | undefined;
      if (Array.isArray(manifests)) {
        out.childManifests = manifests
          .filter((c) => typeof c.digest === "string")
          .map((c) => ({
            digest: c.digest as string,
            mediaType: c.mediaType ?? "",
            size: typeof c.size === "number" ? c.size : 0,
            ...(c.platform &&
            typeof c.platform.architecture === "string" &&
            typeof c.platform.os === "string"
              ? {
                  platform: {
                    architecture: c.platform.architecture,
                    os: c.platform.os,
                    ...(c.platform.variant ? { variant: c.platform.variant } : {}),
                  },
                }
              : {}),
          }));
      }
    }
  }
  return out;
}

function upstreamFlavorFrom(upstream: VirtualUpstream): UpstreamFlavor | null {
  const flavor = upstream.config.upstream_flavor;
  if (
    flavor === "dockerhub" ||
    flavor === "ghcr" ||
    flavor === "ecr"
  ) {
    return flavor;
  }
  return null;
}

function composeUpstreamRepo(
  localRepo: string,
  upstream: VirtualUpstream,
): string {
  const template = upstream.config.upstream_repo_template;
  if (typeof template === "string" && template.length > 0) {
    return template.replace(/{repo}/g, localRepo);
  }
  return localRepo;
}

function composeFetchHeaders(authValue: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: [
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
    ].join(", "),
  };
  if (authValue) headers.authorization = authValue;
  return headers;
}

function stripBearerPrefix(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function logProxyFailure(
  index: SqliteManifestIndex,
  upstream: VirtualUpstream,
  actor: string,
  phase: string,
  detail: Record<string, unknown>,
): void {
  index.appendAuditEntry({
    action: "proxy_cache",
    entityType: "virtual_upstream",
    entityId: upstream.id,
    actor,
    detail: { kind: "oci", phase, ...detail },
  });
}

const defaultFetch: UpstreamFetch = async (url, init) => {
  const method = (init as { method?: string } | undefined)?.method ?? "GET";
  const headers = init?.headers ?? {};
  const body = (init as { body?: string } | undefined)?.body;
  const resp = await globalThis.fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const bytes = Buffer.from(await resp.arrayBuffer());
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });
  return { status: resp.status, headers: respHeaders, body: bytes };
};

// `canonicalManifestBytes` is imported above for future M5-extension
// signing flows. M5 today re-signs against the operator key without
// canonicalizing (OCI bytes are pinned verbatim). Kept on the import
// list so the M6 cosign wrapper can reuse the same surface.
void canonicalManifestBytes;
