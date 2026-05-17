/**
 * PyPI Simple Repository API read handlers (PEP 503 + PEP 691).
 *
 *   GET /pypi/<org>/simple/                           root index (project list)
 *   GET /pypi/<org>/simple/<pkg>/                     per-package files list
 *   GET /pypi/<org>/files/<pkg>/<filename>            raw file bytes
 *
 * Content negotiation per PEP 691 §Content Negotiation:
 *   Accept: application/vnd.pypi.simple.v1+json  → JSON
 *   Accept: text/html (or absent)                → PEP 503 HTML
 *
 * Storage layout (per design doc):
 *   manifest.name    = 'pypi/<org>/<normalised-pkg>'
 *   manifest.version = <filename>      (PEP 491 ensures uniqueness)
 *   manifest.kind    = 'pypi'
 *   pypi_metadata_json carries PEP 440 version + PEP 491 wheel tags +
 *                              PEP 345 metadata
 *
 * The read path enumerates rows by manifest.name and aggregates the
 * pypi_metadata_json projection into the wire format pip expects.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  RegistryStorage,
} from "../types.js";
import type {
  ListedManifest,
  Manifest,
  PypiManifestMetadata,
} from "../types.js";
import type { Router } from "../http/router.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { PypiError, asPypiError, writePypiError } from "./errors.js";
import { PYPI_API_VERSION, PYPI_ERROR_CODES } from "./types.js";
import {
  normalisePypiName,
  parsePypiManifestName,
  pypiFilePath,
  pypiManifestName,
} from "./paths.js";
import {
  negotiateSimpleFormat,
  renderPackageHtml,
  renderRootHtml,
  writeSimpleHtml,
  writeSimpleJson,
} from "./http.js";

export interface MountPypiReadOptions {
  storage: RegistryStorage;
  publicBaseUrl?: string;
  /**
   * Optional proxy hook for virtual upstream pull-through. When set
   * and the local lookup returns no rows for a package, the read
   * handler calls this hook; on a non-null return it serves from
   * the now-cached state.
   */
  proxyPackage?: (
    org: string,
    packageName: string,
  ) => Promise<{ files: PypiFileSummary[] } | null>;
  /** Same hook for file-byte fetch when not in the local store. */
  proxyFile?: (
    org: string,
    packageName: string,
    filename: string,
  ) => Promise<{ sha256: string; bytes: Buffer } | null>;
}

/**
 * The shape `proxyPackage` returns — same projection used by the
 * write path, kept here so virtual.ts and read.ts agree on the
 * file-summary contract.
 */
export interface PypiFileSummary {
  filename: string;
  sha256: string;
  size: number;
  version: string;
  filetype: "sdist" | "bdist_wheel";
  requires_python?: string;
  yanked?: string | true;
  core_metadata_sha256?: string;
}

export function mountPypiReadRoutes(
  router: Router,
  opts: MountPypiReadOptions,
): void {
  const storage = opts.storage;
  const baseUrl = opts.publicBaseUrl ?? "";

  // ── GET /pypi/<org>/simple/  (root index — list of projects) ───
  router.get(
    "/pypi/:org/simple/",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const format = negotiateSimpleFormat(headerString(ctx.headers.accept));
        const projects = await listProjects(storage, ctx.params.org);
        if (format === "json") {
          writeSimpleJson(res, {
            meta: { "api-version": PYPI_API_VERSION },
            projects: projects.map((p) => ({ name: p })),
          });
        } else {
          writeSimpleHtml(res, renderRootHtml(projects));
        }
      } catch (err) {
        writePypiError(res, asPypiError(err));
      }
    },
    { rawResponse: true },
  );

  // ── GET /pypi/<org>/simple/<pkg>/  (per-package file list) ─────
  router.get(
    "/pypi/:org/simple/:pkg/",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const normalised = normalisePypiName(ctx.params.pkg);
        const storageName = pypiManifestName(ctx.params.org, normalised);
        const format = negotiateSimpleFormat(headerString(ctx.headers.accept));

        let summaries = await loadLocalFileSummaries(storage, storageName);

        // Cache miss → proxy fallback.
        if (summaries.length === 0 && opts.proxyPackage) {
          const proxied = await opts.proxyPackage(ctx.params.org, normalised);
          if (proxied) {
            summaries = proxied.files;
          }
        }

        if (summaries.length === 0) {
          throw new PypiError(
            PYPI_ERROR_CODES.PACKAGE_NOT_FOUND,
            `package '${normalised}' not found in org '${ctx.params.org}'`,
          );
        }

        const distinctVersions = Array.from(
          new Set(summaries.map((s) => s.version)),
        ).sort();

        if (format === "json") {
          const filesJson = summaries.map((s) => composeJsonFile(
            ctx.params.org,
            normalised,
            s,
            baseUrl,
          ));
          writeSimpleJson(res, {
            meta: { "api-version": PYPI_API_VERSION },
            name: normalised,
            files: filesJson,
            versions: distinctVersions,
          });
        } else {
          const htmlFiles = summaries.map((s) => ({
            filename: s.filename,
            url: composeAbsoluteUrl(
              baseUrl,
              pypiFilePath(ctx.params.org, normalised, s.filename),
            ),
            sha256: s.sha256,
            ...(s.requires_python ? { requires_python: s.requires_python } : {}),
            ...(s.yanked !== undefined ? { yanked: s.yanked } : {}),
            ...(s.core_metadata_sha256
              ? { core_metadata_sha256: s.core_metadata_sha256 }
              : {}),
          }));
          writeSimpleHtml(res, renderPackageHtml(normalised, htmlFiles));
        }
      } catch (err) {
        writePypiError(res, asPypiError(err));
      }
    },
    { rawResponse: true },
  );

  // ── GET /pypi/<org>/files/<pkg>/<filename> (raw bytes) ─────────
  router.get(
    "/pypi/:org/files/:pkg/:filename",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const normalised = normalisePypiName(ctx.params.pkg);
        const storageName = pypiManifestName(ctx.params.org, normalised);
        const filename = ctx.params.filename;

        let manifest = await storage.getManifest(storageName, filename);

        // Cache miss → proxy fallback. We call proxyFile when either
        // (a) the manifest row is absent (no metadata for this
        // filename) OR (b) the manifest row exists but the blob
        // bytes haven't been fetched yet (metadata was cached via
        // /simple/<pkg>/ pull-through, but the binary is still
        // upstream-only). This double-check lets the read path
        // hydrate the blob on first access.
        const blobAbsent = async (m: typeof manifest): Promise<boolean> => {
          if (!m) return true;
          const sha = m.blobs[0]?.sha256;
          if (!sha) return true;
          return !(await storage.statBlob(sha));
        };
        if ((await blobAbsent(manifest)) && opts.proxyFile) {
          const proxied = await opts.proxyFile(
            ctx.params.org,
            normalised,
            filename,
          );
          if (proxied) {
            manifest = await storage.getManifest(storageName, filename);
          }
        }

        if (!manifest || !manifest.pypiMetadata) {
          throw new PypiError(
            PYPI_ERROR_CODES.FILE_NOT_FOUND,
            `file '${filename}' not found in package '${normalised}'`,
          );
        }

        if (manifest.blobs.length === 0) {
          throw new PypiError(
            PYPI_ERROR_CODES.FILE_NOT_FOUND,
            `file '${filename}' has no associated blob`,
          );
        }

        const sha256 = manifest.blobs[0].sha256;
        const stat = await storage.statBlob(sha256);
        if (!stat) {
          throw new PypiError(
            PYPI_ERROR_CODES.FILE_NOT_FOUND,
            `blob sha256:${sha256} for file '${filename}' is missing on disk`,
          );
        }
        res.statusCode = 200;
        res.setHeader(
          "content-type",
          manifest.pypiMetadata.filetype === "bdist_wheel"
            ? "application/octet-stream"
            : "application/octet-stream",
        );
        res.setHeader("content-length", String(stat.size));
        res.setHeader("etag", `"sha256:${sha256}"`);
        const stream = await storage.getBlob(sha256);
        stream.pipe(res);
        await new Promise<void>((resolve, reject) => {
          stream.on("end", resolve);
          stream.on("error", reject);
          res.on("error", reject);
        });
      } catch (err) {
        writePypiError(res, asPypiError(err));
      }
    },
    { rawResponse: true },
  );
}

// ── helpers ────────────────────────────────────────────────────────

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

/**
 * List every distinct PyPI package the registry has rows for under
 * the given org. Reads from the storage layer's `listManifestVersions`
 * shape isn't directly available — we use the SQLite-index db
 * directly when the backing supports it, falling back to an empty
 * list otherwise (the S3 driver landing in v0.4.x will need its own
 * listProjects impl).
 */
async function listProjects(
  storage: RegistryStorage,
  org: string,
): Promise<string[]> {
  const idxStorage = storage as RegistryStorage & {
    index?: { db: import("node:sqlite").DatabaseSync };
  };
  if (!idxStorage.index) return [];
  const rows = idxStorage.index.db
    .prepare(
      `SELECT DISTINCT name FROM manifest
       WHERE name LIKE ? AND kind = 'pypi'
       ORDER BY name ASC`,
    )
    .all(`pypi/${org}/%`) as Array<{ name: string }>;
  return rows.map((r) => {
    const parsed = parsePypiManifestName(r.name);
    return parsed?.packageName ?? r.name;
  });
}

async function loadLocalFileSummaries(
  storage: RegistryStorage,
  storageName: string,
): Promise<PypiFileSummary[]> {
  const versions = await storage.listManifestVersions(storageName);
  // versions here is "newest-first by created_at"; PEP 503 doesn't
  // mandate ordering. We sort lexicographically by filename for
  // stable client output.
  const summaries: PypiFileSummary[] = [];
  for (const v of versions.sort((a, b) => a.version.localeCompare(b.version))) {
    const manifest = await storage.getManifest(v.name, v.version);
    if (!manifest || !manifest.pypiMetadata) continue;
    summaries.push(summaryFromManifest(manifest));
  }
  return summaries;
}

function summaryFromManifest(manifest: Manifest): PypiFileSummary {
  const meta = manifest.pypiMetadata!;
  const sha = manifest.blobs[0]?.sha256 ?? "";
  const size = manifest.blobs[0]?.size ?? 0;
  const out: PypiFileSummary = {
    filename: meta.filename,
    sha256: sha,
    size,
    version: meta.version,
    filetype: meta.filetype,
  };
  if (meta.requires_python) out.requires_python = meta.requires_python;
  if (meta.yanked !== undefined) out.yanked = meta.yanked;
  if (meta.core_metadata?.sha256) out.core_metadata_sha256 = meta.core_metadata.sha256;
  return out;
}

function composeJsonFile(
  org: string,
  packageName: string,
  s: PypiFileSummary,
  baseUrl: string,
): Record<string, unknown> {
  const url = composeAbsoluteUrl(baseUrl, pypiFilePath(org, packageName, s.filename));
  const out: Record<string, unknown> = {
    filename: s.filename,
    url,
    hashes: { sha256: s.sha256 },
    size: s.size,
  };
  if (s.requires_python) out["requires-python"] = s.requires_python;
  if (s.yanked !== undefined) out.yanked = s.yanked;
  if (s.core_metadata_sha256) {
    out["core-metadata"] = { sha256: s.core_metadata_sha256 };
  }
  return out;
}

function composeAbsoluteUrl(baseUrl: string, pathSuffix: string): string {
  if (baseUrl.length === 0) return pathSuffix;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${pathSuffix}`;
}

// Silence unused-import warnings for symbols only referenced via
// type annotations.
void fs;
void path;
void pypiManifestName;
