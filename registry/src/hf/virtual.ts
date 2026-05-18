/**
 * HF virtual upstream pull-through.
 *
 * Three proxy hooks:
 *
 *   - `proxyHfRevision(opts, org, repo, repoType, revision)` — on a
 *     revision miss, fetches the upstream tree manifest via
 *     `GET /api/<repo_type>s/<org>/<repo>/tree/<revision>` and
 *     constructs an `hf_revision` row (files-list only; the bytes
 *     are hydrated lazily by `proxyHfResolve` / `proxyHfLfsBatch`
 *     on first GET).
 *
 *   - `proxyHfResolve(opts, org, repo, repoType, revision, path)` —
 *     on a `/resolve/<rev>/<path>` miss, fetches the upstream
 *     `/<org>/<repo>/resolve/<rev>/<path>` URL. If the upstream
 *     payload is an LFS pointer, translates the OID via the
 *     upstream Batch API and streams the actual bytes; otherwise
 *     stores the raw payload as the blob.
 *
 *   - `proxyHfLfsBatch(opts, org, repo, oids)` — on Batch requests
 *     against unknown OIDs, calls the upstream Batch API and
 *     hydrates each OID's bytes into the local blob layer. The
 *     hrefs the upstream returns are followed under our token (Q2
 *     lock — fully proxy, client never sees the upstream token).
 *
 * Auth: `Authorization: Bearer <token>` via the
 * `auth_header_template` config field on the virtual_upstream row.
 * The HF UI / `huggingface-cli` token-helper file is never read
 * server-side — operators plumb the token in explicitly.
 *
 * Audit-log: every action emits one `proxy_cache` row with `kind:
 * 'hf'` and `phase: 'metadata' | 'resolve' | 'lfs_batch' | 'blob_bytes'`.
 * Bearer tokens are stripped from the audit detail by the
 * `redactDetail` helper before serialisation.
 */

import type {
  HfManifestMetadata,
  Manifest,
  Provenance,
  RegistryStorage,
} from "../types.js";
import type {
  HfRepoType,
  HfRevisionFile,
  HfRevisionInsert,
  SqliteManifestIndex,
  VirtualUpstream,
} from "../storage/sqlite-index.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import { nameMatchesPatterns, type UpstreamFetch } from "../cargo/index.js";
import { redactDetail } from "./errors.js";
import {
  HF_DEFAULT_LFS_THRESHOLD,
  HF_MEDIA_TYPES,
  type HfTreeEntry,
  type LfsBatchRequest,
  type LfsBatchResponse,
} from "./types.js";
import {
  detectLfsPointer,
  classifyLfsByThreshold,
  parseLfsPointer,
} from "./guards.js";
import {
  hfManifestName,
  hfManifestVersion,
  parseLfsOid,
} from "./paths.js";

export interface VirtualHfOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  fetch?: UpstreamFetch;
  /** Re-sign cached manifest rows with this Ed25519 PEM when configured. */
  signingPrivateKeyPem?: string;
  /** Actor for audit-log entries. Default `'virtual-hf'`. */
  proxyActor?: string;
}

/**
 * Pull-through fetch for a revision tree. Returns true when at
 * least one upstream populated the local `hf_revision` row.
 */
export async function proxyHfRevision(
  opts: VirtualHfOptions,
  org: string,
  repo: string,
  repoType: HfRepoType,
  revision: string,
): Promise<boolean> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "huggingface" });
  if (upstreams.length === 0) return false;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-hf";
  const matchKey = `${org}/${repo}`;

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(matchKey, upstream.config)) continue;
    const upstreamUrl =
      `${trimTrailingSlash(upstream.upstreamUrl)}/api/${repoType}s/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(revision)}`;

    let resp;
    try {
      resp = await fetcher(upstreamUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(upstream.config.auth_header_template
            ? { authorization: upstream.config.auth_header_template }
            : {}),
        },
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "metadata_fetch_error", {
        url: upstreamUrl,
        org,
        repo,
        revision,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "metadata_upstream_error", {
        url: upstreamUrl,
        org,
        repo,
        revision,
        status: resp.status,
      });
      continue;
    }

    let entries: HfTreeEntry[];
    try {
      const parsed = JSON.parse(resp.body.toString("utf-8"));
      if (!Array.isArray(parsed)) {
        throw new Error("upstream tree response must be a JSON array");
      }
      entries = parsed as HfTreeEntry[];
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "metadata_parse_error", {
        url: upstreamUrl,
        org,
        repo,
        revision,
        error: (err as Error).message,
      });
      continue;
    }

    const files: HfRevisionFile[] = [];
    for (const e of entries) {
      if (e.type !== "file") continue;
      const isLfs = !!e.lfs;
      const sha256Hex = isLfs && e.lfs
        ? parseLfsOidLenient(e.lfs.oid)
        : "";
      const size = isLfs && e.lfs ? e.lfs.size : e.size ?? 0;
      files.push({
        path: e.path,
        sha256: sha256Hex,
        size,
        lfs: isLfs,
      });
    }
    if (files.length === 0) {
      auditFailure(opts.index, upstream, actor, "metadata_empty_tree", {
        url: upstreamUrl,
        org,
        repo,
        revision,
      });
      continue;
    }

    const createdAt = new Date().toISOString();
    const insert: HfRevisionInsert = {
      org,
      repo,
      repoType,
      revision,
      rootTreeDigest: `proxy:${revision}`,
      files,
      provenance: {
        source: "proxy_cache",
        upstreamUrl: upstream.upstreamUrl,
        fetchedAt: createdAt,
        fetchedBy: actor,
      },
      createdAt,
    };
    try {
      opts.index.putHfRevision(insert);
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "metadata_store_error", {
        org,
        repo,
        revision,
        error: (err as Error).message,
      });
      continue;
    }

    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: `${hfManifestName(org, repo, repoType)}@${revision}`,
      actor,
      detail: redactDetail({
        kind: "hf",
        phase: "metadata",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        org,
        repo,
        repo_type: repoType,
        revision,
        file_count: files.length,
      }) as Record<string, unknown>,
    });
    return true;
  }
  return false;
}

/**
 * Pull-through fetch for a single file. Returns true when bytes
 * landed in the local blob layer (and a per-file manifest row was
 * written). Does not refresh `hf_revision`; the caller's
 * `resolveHfFile` re-reads the row after this returns.
 */
export async function proxyHfResolve(
  opts: VirtualHfOptions,
  org: string,
  repo: string,
  repoType: HfRepoType,
  revision: string,
  path: string,
): Promise<boolean> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "huggingface" });
  if (upstreams.length === 0) return false;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-hf";
  const matchKey = `${org}/${repo}`;

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(matchKey, upstream.config)) continue;
    const url =
      `${trimTrailingSlash(upstream.upstreamUrl)}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/resolve/${encodeURIComponent(revision)}/${encodePathPreserveSlash(path)}`;

    let resp;
    try {
      resp = await fetcher(url, {
        method: "GET",
        headers: {
          accept: "*/*",
          ...(upstream.config.auth_header_template
            ? { authorization: upstream.config.auth_header_template }
            : {}),
        },
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "resolve_fetch_error", {
        url,
        org,
        repo,
        revision,
        path,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "resolve_upstream_error", {
        url,
        org,
        repo,
        revision,
        path,
        status: resp.status,
      });
      continue;
    }

    // Detect LFS pointer payload.
    const pointer = detectLfsPointer(resp.body);
    let blobBytes: Buffer;
    if (pointer) {
      // LFS path: translate the OID via upstream Batch, fetch the
      // resolved bytes.
      const fetched = await fetchLfsBytes(
        opts,
        upstream,
        fetcher,
        actor,
        org,
        repo,
        pointer.oid,
        pointer.size,
      );
      if (!fetched) continue;
      blobBytes = fetched;
    } else {
      blobBytes = resp.body;
    }

    // Store the bytes; the storage layer sha-checks.
    const blobMeta = await opts.storage.putBlob({
      body: blobBytes,
      contentType: HF_MEDIA_TYPES.OCTET_STREAM,
    });

    const lfsThreshold =
      upstream.config.hf_lfs_threshold_bytes ?? HF_DEFAULT_LFS_THRESHOLD;
    const lfs = pointer ? true : classifyLfsByThreshold(blobMeta.size, lfsThreshold);

    // Persist a per-file manifest row.
    const manifestName = hfManifestName(org, repo, repoType);
    const versionKey = hfManifestVersion(revision, path);
    const meta: HfManifestMetadata = {
      org,
      repo,
      repoType,
      revision,
      path,
      lfs,
      sha256: blobMeta.sha256,
      size: blobMeta.size,
      ...(lfs ? { lfsOid: `sha256:${blobMeta.sha256}` } : {}),
    };
    const createdAt = new Date().toISOString();
    const baseManifest: Manifest = {
      name: manifestName,
      version: versionKey,
      mediaType: HF_MEDIA_TYPES.HF_FILE,
      kind: "hf",
      blobs: [
        {
          mediaType: HF_MEDIA_TYPES.OCTET_STREAM,
          sha256: blobMeta.sha256,
          size: blobMeta.size,
          name: path,
        },
      ],
      hfMetadata: meta,
      createdAt,
    };
    const signedManifest = maybeResign(baseManifest, upstream, opts, actor);
    const provenance: Provenance = {
      source: "proxy_cache",
      upstreamUrl: upstream.upstreamUrl,
      fetchedAt: createdAt,
      fetchedBy: actor,
    };
    const canonical = canonicalManifestBytes(signedManifest);
    try {
      opts.index.putManifest(signedManifest, canonical, provenance);
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "resolve_store_error", {
        org,
        repo,
        revision,
        path,
        error: (err as Error).message,
      });
      continue;
    }

    // Update / extend the revision row to include this file. If the
    // revision row already exists (from a prior `proxyHfRevision`),
    // append the entry; otherwise create a single-file row.
    const existingRev = opts.index.getHfRevision(org, repo, repoType, revision);
    const fileEntry: HfRevisionFile = {
      path,
      sha256: blobMeta.sha256,
      size: blobMeta.size,
      lfs,
    };
    let filesNext: HfRevisionFile[];
    if (existingRev) {
      filesNext = existingRev.files.filter((f) => f.path !== path);
      filesNext.push(fileEntry);
    } else {
      filesNext = [fileEntry];
    }
    opts.index.updateHfRevision({
      org,
      repo,
      repoType,
      revision,
      rootTreeDigest:
        existingRev?.rootTreeDigest ?? `proxy:${revision}`,
      ...(existingRev?.parentRevision
        ? { parentRevision: existingRev.parentRevision }
        : {}),
      files: filesNext,
      ...(existingRev?.provenance ? { provenance: existingRev.provenance } : {
        provenance: {
          source: "proxy_cache",
          upstreamUrl: upstream.upstreamUrl,
          fetchedAt: createdAt,
          fetchedBy: actor,
        },
      }),
      createdAt,
    });

    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: `${manifestName}@${versionKey}`,
      actor,
      detail: redactDetail({
        kind: "hf",
        phase: "resolve",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        org,
        repo,
        repo_type: repoType,
        revision,
        path,
        lfs,
        sha256: blobMeta.sha256,
        bytes_fetched: blobMeta.size,
      }) as Record<string, unknown>,
    });
    return true;
  }
  return false;
}

/**
 * Pull-through Batch: for each missing OID, call the upstream Batch
 * API, follow the `download.href` under our token (Q2 lock), and
 * land the bytes in the local blob layer. Returns the set of OIDs
 * we actually populated.
 */
export async function proxyHfLfsBatch(
  opts: VirtualHfOptions,
  org: string,
  repo: string,
  missing: Array<{ oid: string; size: number }>,
): Promise<Set<string>> {
  const populated = new Set<string>();
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "huggingface" });
  if (upstreams.length === 0) return populated;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-hf";
  const matchKey = `${org}/${repo}`;

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(matchKey, upstream.config)) continue;
    if (missing.length === 0) break;
    // Determine which OIDs still need populating in this iteration.
    const stillNeeded = missing.filter((o) => !populated.has(o.oid));
    if (stillNeeded.length === 0) break;
    for (const obj of stillNeeded) {
      const sha256Hex = parseLfsOidLenient(obj.oid);
      if (sha256Hex.length === 0) continue;
      const bytes = await fetchLfsBytes(
        opts,
        upstream,
        fetcher,
        actor,
        org,
        repo,
        obj.oid,
        obj.size,
      );
      if (!bytes) continue;
      await opts.storage.putBlob({
        body: bytes,
        contentType: HF_MEDIA_TYPES.OCTET_STREAM,
      });
      populated.add(obj.oid);
    }
    if (populated.size === missing.length) break;
  }
  return populated;
}

// ── internals ──────────────────────────────────────────────────

/**
 * Call the upstream LFS Batch API for one OID and follow the
 * `download.href` to fetch the bytes. Returns the bytes on success;
 * null on failure (audit-logged).
 */
async function fetchLfsBytes(
  opts: VirtualHfOptions,
  upstream: VirtualUpstream,
  fetcher: UpstreamFetch,
  actor: string,
  org: string,
  repo: string,
  oid: string,
  size: number,
): Promise<Buffer | null> {
  const batchUrl = `${trimTrailingSlash(upstream.upstreamUrl)}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}.git/info/lfs/objects/batch`;
  const body: LfsBatchRequest = {
    operation: "download",
    transfers: ["basic"],
    objects: [{ oid, size }],
  };
  let resp;
  try {
    resp = await fetcher(batchUrl, {
      method: "POST",
      headers: {
        accept: HF_MEDIA_TYPES.LFS_BATCH,
        "content-type": HF_MEDIA_TYPES.LFS_BATCH,
        ...(upstream.config.auth_header_template
          ? { authorization: upstream.config.auth_header_template }
          : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    auditFailure(opts.index, upstream, actor, "lfs_batch_fetch_error", {
      url: batchUrl,
      org,
      repo,
      oid,
      error: (err as Error).message,
    });
    return null;
  }
  if (resp.status >= 400) {
    auditFailure(opts.index, upstream, actor, "lfs_batch_upstream_error", {
      url: batchUrl,
      org,
      repo,
      oid,
      status: resp.status,
    });
    return null;
  }
  let parsed: LfsBatchResponse;
  try {
    parsed = JSON.parse(resp.body.toString("utf-8")) as LfsBatchResponse;
  } catch (err) {
    auditFailure(opts.index, upstream, actor, "lfs_batch_parse_error", {
      url: batchUrl,
      org,
      repo,
      oid,
      error: (err as Error).message,
    });
    return null;
  }
  const action = parsed.objects?.[0]?.actions?.download;
  if (!action || !action.href) {
    auditFailure(opts.index, upstream, actor, "lfs_batch_no_action", {
      url: batchUrl,
      org,
      repo,
      oid,
      error: parsed.objects?.[0]?.error?.message ?? "missing download action",
    });
    return null;
  }

  let blobResp;
  try {
    blobResp = await fetcher(action.href, {
      method: "GET",
      headers: {
        accept: "*/*",
        // Per Q2 lock: we ALWAYS authenticate under our token; the
        // action.header field (if present) we forward verbatim.
        ...(action.header ?? {}),
        ...(!action.header && upstream.config.auth_header_template
          ? { authorization: upstream.config.auth_header_template }
          : {}),
      },
    });
  } catch (err) {
    auditFailure(opts.index, upstream, actor, "lfs_blob_fetch_error", {
      url: action.href,
      org,
      repo,
      oid,
      error: (err as Error).message,
    });
    return null;
  }
  if (blobResp.status >= 400) {
    auditFailure(opts.index, upstream, actor, "lfs_blob_upstream_error", {
      url: action.href,
      org,
      repo,
      oid,
      status: blobResp.status,
    });
    return null;
  }
  // Verify the bytes hash to the declared OID.
  const expectedSha = parseLfsOidLenient(oid);
  if (expectedSha.length === 0) {
    auditFailure(opts.index, upstream, actor, "lfs_blob_oid_invalid", {
      org,
      repo,
      oid,
    });
    return null;
  }
  // Use storage.putBlob's content-addressed sha to validate.
  const meta = await opts.storage.putBlob({
    body: blobResp.body,
    contentType: HF_MEDIA_TYPES.OCTET_STREAM,
  });
  if (meta.sha256 !== expectedSha) {
    auditFailure(opts.index, upstream, actor, "lfs_blob_sha_mismatch", {
      org,
      repo,
      oid,
      computed: meta.sha256,
      declared: expectedSha,
    });
    return null;
  }
  opts.index.appendAuditEntry({
    action: "proxy_cache",
    entityType: "manifest",
    entityId: `lfs@${expectedSha}`,
    actor,
    detail: redactDetail({
      kind: "hf",
      phase: "blob_bytes",
      upstream_url: upstream.upstreamUrl,
      upstream_id: upstream.id,
      org,
      repo,
      oid,
      bytes_fetched: meta.size,
    }) as Record<string, unknown>,
  });
  return blobResp.body;
}

function maybeResign(
  manifest: Manifest,
  upstream: VirtualUpstream,
  opts: VirtualHfOptions,
  actor: string,
): Manifest {
  if (!(upstream.config.resign_on_cache && opts.signingPrivateKeyPem)) {
    return manifest;
  }
  try {
    const sig = signManifest(manifest, opts.signingPrivateKeyPem);
    return {
      ...manifest,
      signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
    };
  } catch (err) {
    auditFailure(opts.index, upstream, actor, "resign_error", {
      org: manifest.hfMetadata?.org,
      repo: manifest.hfMetadata?.repo,
      path: manifest.hfMetadata?.path,
      error: (err as Error).message,
    });
    return manifest;
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Percent-encode a path while preserving `/` separators. Behaves
 * like encodeURI but limited to byte-level escaping.
 */
function encodePathPreserveSlash(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function parseLfsOidLenient(oid: string): string {
  try {
    return parseLfsOid(oid);
  } catch {
    return "";
  }
}

const defaultFetch: UpstreamFetch = async (url, init) => {
  const resp = await fetch(url, {
    method: init?.method ?? "GET",
    ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
    ...(init?.body ? { body: init.body } : {}),
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
    entityId: `hf@${upstream.id}`,
    actor,
    detail: redactDetail({
      kind: "hf",
      phase,
      upstream_url: upstream.upstreamUrl,
      upstream_id: upstream.id,
      ...detail,
    }) as Record<string, unknown>,
  });
}

// Silence unused-import warnings.
void parseLfsPointer;
