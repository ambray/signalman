/**
 * PyPI virtual upstream pull-through.
 *
 * Same shape as `registry/src/cargo/virtual.ts` / `npm/virtual.ts` /
 * `oci/virtual.ts`. On a cache miss for either a /simple/<pkg>/
 * index or a /files/<pkg>/<filename> blob, the registry fetches
 * the upstream PEP 691 JSON (or PEP 503 HTML fallback) + the
 * binary file, content-addresses the bytes, persists them as a
 * kind='pypi' manifest with provenance.source='proxy_cache', and
 * re-signs the row when configured.
 *
 * Public upstreams are anonymous (`pypi.org/simple/<pkg>/`).
 * Private indexes (Nexus / Artifactory / GitHub Packages PyPI)
 * authenticate via Basic Auth — `auth_header_template` on the
 * virtual_upstream config row carries the operator-supplied
 * `Authorization: Basic <base64(user:token)>` value.
 */

import * as crypto from "node:crypto";
import {
  type Manifest,
  type Provenance,
  type PypiManifestMetadata,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import type {
  SqliteManifestIndex,
  VirtualUpstream,
} from "../storage/sqlite-index.js";
import { nameMatchesPatterns, type UpstreamFetch } from "../cargo/index.js";
import { PypiError } from "./errors.js";
import { PYPI_ERROR_CODES } from "./types.js";
import {
  classifyFiletype,
  normalisePypiName,
  pypiManifestName,
} from "./paths.js";
import type { PypiFileSummary } from "./read.js";

export interface VirtualPypiOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  fetch?: UpstreamFetch;
  /** Re-sign cached manifest rows with this Ed25519 PEM when configured. */
  signingPrivateKeyPem?: string;
  /** Actor for audit-log entries. Default `'virtual-pypi'`. */
  proxyActor?: string;
}

/**
 * Look up a package's file list from a configured upstream, cache
 * each file's metadata as a kind='pypi' manifest, and return the
 * aggregated PypiFileSummary list for the read path to emit.
 *
 * Returns null when no upstream covers the (org, package) pair OR
 * every configured upstream returned a 404 / failure.
 */
export async function proxyPypiPackage(
  opts: VirtualPypiOptions,
  org: string,
  packageName: string,
): Promise<{ files: PypiFileSummary[] } | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "pypi" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-pypi";
  const normalised = normalisePypiName(packageName);

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(normalised, upstream.config)) continue;
    const url = `${trimTrailingSlash(upstream.upstreamUrl)}/${encodeURIComponent(normalised)}/`;
    let resp;
    try {
      resp = await fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/vnd.pypi.simple.v1+json",
          ...(upstream.config.auth_header_template
            ? { authorization: upstream.config.auth_header_template }
            : {}),
        },
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "fetch_error", {
        url,
        packageName: normalised,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "upstream_error", {
        url,
        packageName: normalised,
        status: resp.status,
      });
      continue;
    }
    // Parse PEP 691 JSON OR PEP 503 HTML, dispatch on Content-Type.
    const contentType =
      resp.headers["content-type"] ?? resp.headers["Content-Type"] ?? "";
    let upstreamFiles: UpstreamFileEntry[];
    try {
      upstreamFiles = parseUpstreamFiles(
        normalised,
        resp.body.toString("utf-8"),
        contentType,
      );
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "parse_error", {
        url,
        packageName: normalised,
        error: (err as Error).message,
      });
      continue;
    }
    if (upstreamFiles.length === 0) continue;

    // Cache each file's metadata as its own manifest row. We do NOT
    // pre-fetch binaries here — that happens lazily on first GET
    // /files/<pkg>/<filename> via proxyPypiFile.
    const storageName = pypiManifestName(org, normalised);
    for (const file of upstreamFiles) {
      const existing = await opts.storage.getManifest(storageName, file.filename);
      if (existing) continue;
      const meta = projectMetadata(file);
      const manifest: Manifest = {
        name: storageName,
        version: file.filename,
        mediaType: "application/vnd.signalman.pypi-file.v1+json",
        kind: "pypi",
        blobs: [
          {
            mediaType: "application/octet-stream",
            sha256: file.sha256,
            ...(file.size ? { size: file.size } : {}),
            name: file.filename,
          },
        ],
        pypiMetadata: meta,
        createdAt: new Date().toISOString(),
      };
      // Re-sign with the operator's key when configured.
      let signedManifest = manifest;
      if (
        upstream.config.resign_on_cache &&
        opts.signingPrivateKeyPem
      ) {
        try {
          const sig = signManifest(manifest, opts.signingPrivateKeyPem);
          signedManifest = {
            ...manifest,
            signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
          };
        } catch (err) {
          auditFailure(opts.index, upstream, actor, "resign_error", {
            packageName: normalised,
            filename: file.filename,
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
      // We bypass storage.putManifest (which would reject the
      // blob-not-yet-present check) and call index.putManifest
      // directly — file bytes flow in lazily via proxyPypiFile.
      const canonical = canonicalManifestBytes(signedManifest);
      try {
        opts.index.putManifest(signedManifest, canonical, provenance);
      } catch (err) {
        auditFailure(opts.index, upstream, actor, "store_error", {
          packageName: normalised,
          filename: file.filename,
          error: (err as Error).message,
        });
        continue;
      }
      opts.index.appendAuditEntry({
        action: "proxy_cache",
        entityType: "manifest",
        entityId: `${storageName}@${file.filename}`,
        actor,
        detail: {
          kind: "pypi",
          phase: "metadata_cached",
          upstream_url: upstream.upstreamUrl,
          upstream_id: upstream.id,
          org,
          package: normalised,
          version: file.version,
          filename: file.filename,
          resigned: !!(upstream.config.resign_on_cache && opts.signingPrivateKeyPem),
        },
      });
    }

    // Aggregate the now-cached rows into PypiFileSummary for the
    // read handler.
    const summaries: PypiFileSummary[] = [];
    const versions = opts.index.listManifestVersions(storageName);
    for (const v of versions) {
      const m = opts.index.getManifest(v.name, v.version);
      if (!m || m.kind !== "pypi" || !m.pypiMetadata) continue;
      const sha = m.blobs[0]?.sha256 ?? "";
      const size = m.blobs[0]?.size ?? 0;
      const s: PypiFileSummary = {
        filename: m.pypiMetadata.filename,
        sha256: sha,
        size,
        version: m.pypiMetadata.version,
        filetype: m.pypiMetadata.filetype,
      };
      if (m.pypiMetadata.requires_python) s.requires_python = m.pypiMetadata.requires_python;
      if (m.pypiMetadata.yanked !== undefined) s.yanked = m.pypiMetadata.yanked;
      if (m.pypiMetadata.core_metadata?.sha256) {
        s.core_metadata_sha256 = m.pypiMetadata.core_metadata.sha256;
      }
      summaries.push(s);
    }
    if (summaries.length === 0) continue;
    return { files: summaries };
  }
  return null;
}

/**
 * Fetch a single file's bytes from a configured upstream + cache
 * them. The metadata for the file must already exist (typically
 * cached by `proxyPypiPackage`); this just fills the blob.
 */
export async function proxyPypiFile(
  opts: VirtualPypiOptions,
  org: string,
  packageName: string,
  filename: string,
): Promise<{ sha256: string; bytes: Buffer } | null> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "pypi" });
  if (upstreams.length === 0) return null;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-pypi";
  const normalised = normalisePypiName(packageName);

  // Look up the expected sha256 from the cached manifest row.
  const storageName = pypiManifestName(org, normalised);
  const manifest = opts.index.getManifest(storageName, filename);
  if (!manifest || !manifest.pypiMetadata) return null;
  const expectedSha = manifest.blobs[0]?.sha256;
  if (!expectedSha) return null;

  for (const upstream of upstreams) {
    if (!nameMatchesPatterns(normalised, upstream.config)) continue;
    // PyPI file URLs use the `packages/<id>/<id>/...` Warehouse
    // CDN convention; mirrors typically expose files under
    // `/packages/...`. We construct the simplest fallback URL by
    // appending `/<filename>` to the per-package endpoint; many
    // mirrors honour this redirect. Operators with non-default
    // mirror shapes set `upstream_repo_template` per virtual_upstream
    // config to override (mirrors of Warehouse all share the same
    // file-URL convention so the template default works in 99%
    // of cases).
    const url = composeUpstreamFileUrl(upstream, normalised, filename);
    let resp;
    try {
      resp = await fetcher(url, {
        method: "GET",
        headers: upstream.config.auth_header_template
          ? { authorization: upstream.config.auth_header_template }
          : {},
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "file_fetch_error", {
        url,
        filename,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "file_upstream_error", {
        url,
        filename,
        status: resp.status,
      });
      continue;
    }
    const computed = crypto.createHash("sha256").update(resp.body).digest("hex");
    if (computed !== expectedSha) {
      auditFailure(opts.index, upstream, actor, "file_digest_mismatch", {
        url,
        filename,
        expected: expectedSha,
        computed,
      });
      continue;
    }
    const blob = await opts.storage.putBlob({
      body: resp.body,
      contentType: "application/octet-stream",
    });
    if (blob.sha256 !== computed) continue;
    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "blob",
      entityId: computed,
      actor,
      detail: {
        kind: "pypi",
        phase: "file_cached",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        package: normalised,
        filename,
        bytes: resp.body.length,
      },
    });
    return { sha256: computed, bytes: resp.body };
  }
  return null;
}

interface UpstreamFileEntry {
  filename: string;
  url: string;
  sha256: string;
  size?: number;
  version: string;
  filetype: "sdist" | "bdist_wheel";
  requires_python?: string;
  yanked?: string | true;
}

/**
 * Dispatch on Content-Type: PEP 691 JSON vs PEP 503 HTML. We accept
 * both because mirrors are inconsistent (PyPI.org itself emits JSON
 * to clients that ask; older Artifactory / Nexus instances still
 * only emit HTML).
 */
function parseUpstreamFiles(
  packageName: string,
  body: string,
  contentType: string,
): UpstreamFileEntry[] {
  if (contentType.includes("json")) {
    return parseJsonResponse(body);
  }
  return parseHtmlResponse(packageName, body);
}

function parseJsonResponse(body: string): UpstreamFileEntry[] {
  const parsed = JSON.parse(body) as {
    files?: Array<{
      filename: string;
      url: string;
      hashes?: { sha256?: string };
      "requires-python"?: string;
      yanked?: boolean | string;
      size?: number;
    }>;
  };
  if (!Array.isArray(parsed.files)) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      "upstream JSON missing `files` array",
    );
  }
  const out: UpstreamFileEntry[] = [];
  for (const f of parsed.files) {
    if (!f.filename || !f.hashes?.sha256) continue;
    let filetype: "sdist" | "bdist_wheel";
    try {
      filetype = classifyFiletype(f.filename);
    } catch {
      continue;
    }
    const version = extractVersionFromFilename(f.filename) ?? "";
    const entry: UpstreamFileEntry = {
      filename: f.filename,
      url: f.url,
      sha256: f.hashes.sha256.toLowerCase(),
      version,
      filetype,
    };
    if (f.size !== undefined) entry.size = f.size;
    if (f["requires-python"]) entry.requires_python = f["requires-python"];
    if (f.yanked !== undefined && f.yanked !== false) {
      entry.yanked = typeof f.yanked === "string" ? f.yanked : true;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Minimal PEP 503 HTML parser. Extracts <a href=...> tags and their
 * `#sha256=...` anchors. Not a full HTML parser — we only need the
 * shape PyPI mirrors actually emit (`<a href="...#sha256=hex"
 * data-requires-python="...">filename</a>`).
 */
function parseHtmlResponse(
  packageName: string,
  body: string,
): UpstreamFileEntry[] {
  const linkRe = /<a\s+([^>]+)>([^<]+)<\/a>/gi;
  const out: UpstreamFileEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(body)) !== null) {
    const attrs = m[1];
    const filename = m[2].trim();
    const hrefM = /href\s*=\s*"([^"]+)"/i.exec(attrs);
    if (!hrefM) continue;
    const href = hrefM[1];
    const shaM = /#sha256=([a-f0-9]{64})/i.exec(href);
    if (!shaM) continue;
    let filetype: "sdist" | "bdist_wheel";
    try {
      filetype = classifyFiletype(filename);
    } catch {
      continue;
    }
    const reqPyM = /data-requires-python\s*=\s*"([^"]+)"/i.exec(attrs);
    const yankedM = /data-yanked\s*=\s*"([^"]*)"/i.exec(attrs);
    const entry: UpstreamFileEntry = {
      filename,
      url: href.split("#")[0],
      sha256: shaM[1].toLowerCase(),
      version: extractVersionFromFilename(filename) ?? "",
      filetype,
    };
    if (reqPyM) entry.requires_python = reqPyM[1];
    if (yankedM) entry.yanked = yankedM[1].length > 0 ? yankedM[1] : true;
    out.push(entry);
  }
  void packageName;
  return out;
}

function extractVersionFromFilename(filename: string): string | null {
  // Best-effort version extraction. The PEP 491 wheel grammar locks
  // this down precisely; sdist grammar is loose. Used only for the
  // PEP 691 `versions` field aggregation — read-path correctness
  // does not depend on it.
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -4).split("-");
    if (parts.length >= 5) return parts[1];
  }
  for (const ext of [".tar.gz", ".tar.bz2", ".tar.xz", ".zip"]) {
    if (filename.endsWith(ext)) {
      const stem = filename.slice(0, filename.length - ext.length);
      const dash = stem.lastIndexOf("-");
      if (dash > 0) return stem.slice(dash + 1);
    }
  }
  return null;
}

function projectMetadata(file: UpstreamFileEntry): PypiManifestMetadata {
  const meta: PypiManifestMetadata = {
    version: file.version,
    filename: file.filename,
    filetype: file.filetype,
  };
  if (file.requires_python) meta.requires_python = file.requires_python;
  if (file.yanked !== undefined) meta.yanked = file.yanked;
  return meta;
}

function composeUpstreamFileUrl(
  upstream: VirtualUpstream,
  packageName: string,
  filename: string,
): string {
  // Default Warehouse / mirror convention: per-package endpoint at
  // /simple/<pkg>/ links into /packages/<...>/<filename>. Mirrors
  // resolve relative paths from the index page; we follow the link
  // directly by appending `/<filename>` to the canonical mirror URL.
  // Operators with non-default shapes override via
  // `upstream_repo_template` (e.g. "{filename_first_two}/{filename}"
  // for /packages/ab/c/...).
  const template = upstream.config.upstream_repo_template;
  if (typeof template === "string" && template.length > 0) {
    return template
      .replace(/\{filename\}/g, filename)
      .replace(/\{package\}/g, packageName);
  }
  return `${trimTrailingSlash(upstream.upstreamUrl)}/${encodeURIComponent(packageName)}/${filename}`;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function auditFailure(
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
    detail: { kind: "pypi", phase, ...detail },
  });
}

const defaultFetch: UpstreamFetch = async (url, init) => {
  const resp = await globalThis.fetch(url, {
    method: (init as { method?: string } | undefined)?.method ?? "GET",
    headers: init?.headers ?? {},
  });
  const bytes = Buffer.from(await resp.arrayBuffer());
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: resp.status, headers, body: bytes };
};
