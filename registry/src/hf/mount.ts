/**
 * Aggregate HF route mount. The buildApp layer calls
 * `mountHfRoutes` once; this composes the read + LFS Batch +
 * publish + virtual-upstream-proxy hooks.
 *
 * Route surface (under `/hf/<org>/<repo>/`):
 *
 *   GET  /hf/:org/:repo/resolve/:revision/*path     — resolve.ts
 *   GET  /hf/:org/:repo/lfs/sha256/:sha256          — blobs.ts (content-addressed)
 *   POST /hf/:org/:repo/info/lfs/objects/batch      — lfs.ts (Batch API)
 *   POST /hf/:org/:repo/upload-tarball              — publish.ts (flattened publish)
 *
 * The mount layer is the single place that owns the request /
 * response wiring. All parsing happens in `paths.ts` + `guards.ts`;
 * all logic happens in the per-feature handlers; this file is
 * mechanical glue.
 */

import { Readable } from "node:stream";
import type { Router, RequestContext } from "../http/router.js";
import type { RegistryStorage } from "../types.js";
import type {
  HfRepoType,
  SqliteManifestIndex,
} from "../storage/sqlite-index.js";
import type { UpstreamFetch } from "../cargo/index.js";
import { writeHfError, asHfError, HfError } from "./errors.js";
import { HF_ERROR_CODES, HF_MEDIA_TYPES } from "./types.js";
import {
  parseHfBlobPath,
  parseHfResolvePath,
  validateHfOrgName,
  validateHfRepoName,
  validateHfRepoType,
} from "./paths.js";
import { serveHfBlob } from "./blobs.js";
import { resolveHfFile } from "./resolve.js";
import { handleLfsBatch } from "./lfs.js";
import { publishHfTarball } from "./publish.js";
import {
  proxyHfLfsBatch,
  proxyHfResolve,
  proxyHfRevision,
  type VirtualHfOptions,
} from "./virtual.js";

const DEFAULT_MAX_TARBALL_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB per Q1 lock

export interface MountHfOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  /** WS13 M4: injectable upstream fetcher for tests. */
  virtualUpstreamFetch?: UpstreamFetch;
  /** Operator Ed25519 PEM used to re-sign cached rows. */
  virtualResignPrivateKeyPem?: string;
  /** Max body size for a single upload-tarball POST. Default 50 GB. */
  maxTarballBytes?: number;
  /** Base URL the LFS Batch handler uses to compose download hrefs. */
  publicBaseUrl?: string;
}

export function mountHfRoutes(router: Router, opts: MountHfOptions): void {
  const storage = opts.storage;
  const index = opts.index;
  const maxTarballBytes = opts.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const publicBaseUrl = opts.publicBaseUrl ?? "";

  const virtualOpts: VirtualHfOptions = {
    storage,
    index,
    ...(opts.virtualUpstreamFetch ? { fetch: opts.virtualUpstreamFetch } : {}),
    ...(opts.virtualResignPrivateKeyPem
      ? { signingPrivateKeyPem: opts.virtualResignPrivateKeyPem }
      : {}),
  };

  // Helper: parse the leading (org, repo) + remaining path segment.
  // Returns null with status written on validation failure.
  function parseOrgRepo(
    ctx: RequestContext,
    repoTypeQuery?: string,
  ): { org: string; repo: string; repoType: HfRepoType } | null {
    try {
      validateHfOrgName(ctx.params.org);
      validateHfRepoName(ctx.params.repo);
      const repoType = (repoTypeQuery ?? ctx.query.repo_type ?? "model") as string;
      validateHfRepoType(repoType);
      return {
        org: ctx.params.org,
        repo: ctx.params.repo,
        repoType: repoType as HfRepoType,
      };
    } catch (err) {
      if (ctx.res) writeHfError(ctx.res, asHfError(err));
      return null;
    }
  }

  // ── Publish: POST upload-tarball ──────────────────────────────
  router.post(
    "/hf/:org/:repo/upload-tarball",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const parsed = parseOrgRepo(ctx);
        if (!parsed) return;
        const revision = ctx.query.revision ?? "main";
        if (!ctx.bodyStream) {
          throw new HfError(
            HF_ERROR_CODES.UPLOAD_INVALID,
            "POST upload-tarball requires a request body",
          );
        }
        const actor = ctx.auth.tokenPrefix ?? "anonymous";
        const result = await publishHfTarball({
          storage,
          index,
          org: parsed.org,
          repo: parsed.repo,
          repoType: parsed.repoType,
          revision,
          body: ctx.bodyStream,
          actor,
        });
        const body = JSON.stringify(result);
        res.statusCode = 201;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("content-length", Buffer.byteLength(body).toString());
        res.end(body);
      } catch (err) {
        writeHfError(res, asHfError(err));
      }
    },
    { streamBody: true, rawResponse: true, maxBodyBytes: maxTarballBytes },
  );

  // ── LFS Batch API ─────────────────────────────────────────────
  router.post(
    "/hf/:org/:repo/info/lfs/objects/batch",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const parsed = parseOrgRepo(ctx);
        if (!parsed) return;
        const response = await handleLfsBatch({
          storage,
          org: parsed.org,
          repo: parsed.repo,
          request: ctx.body as never,
          composeDownloadHref: (sha: string) =>
            `${trimTrailingSlash(publicBaseUrl)}/hf/${parsed.org}/${parsed.repo}/lfs/sha256/${sha}`,
          proxyBatch: (org, repo, missing) =>
            proxyHfLfsBatch(virtualOpts, org, repo, missing),
        });
        const body = JSON.stringify(response);
        res.statusCode = 200;
        res.setHeader("content-type", HF_MEDIA_TYPES.LFS_BATCH);
        res.setHeader("content-length", Buffer.byteLength(body).toString());
        res.end(body);
      } catch (err) {
        writeHfError(res, asHfError(err));
      }
    },
    { rawResponse: true },
  );

  // ── Read: blob endpoint (content-addressed) ───────────────────
  router.get(
    "/hf/:org/:repo/*rest",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const parsed = parseOrgRepo(ctx);
        if (!parsed) return;
        const rest = ctx.params.rest;

        const blob = parseHfBlobPath(rest);
        if (blob) {
          await serveHfBlob({
            storage,
            sha256: blob.sha256,
            res,
            ...(typeof ctx.headers.range === "string"
              ? { rangeHeader: ctx.headers.range }
              : {}),
          });
          return;
        }

        const resolve = parseHfResolvePath(rest);
        if (resolve) {
          await resolveHfFile({
            storage,
            index,
            org: parsed.org,
            repo: parsed.repo,
            repoType: parsed.repoType,
            revision: resolve.revision,
            path: resolve.path,
            res,
            ...(typeof ctx.headers.range === "string"
              ? { rangeHeader: ctx.headers.range }
              : {}),
            proxyResolve: (org, repo, repoType, revision, path) =>
              proxyResolveCombined(
                virtualOpts,
                org,
                repo,
                repoType,
                revision,
                path,
              ),
          });
          return;
        }

        throw new HfError(
          HF_ERROR_CODES.PATH_INVALID,
          `unknown HF route '${rest}'`,
        );
      } catch (err) {
        writeHfError(res, asHfError(err));
      }
    },
    { rawResponse: true },
  );
}

/**
 * Combined revision-then-file proxy. On a revision miss, try the
 * tree-listing proxy first; then try the per-file resolve. Returns
 * true when either populated something.
 */
async function proxyResolveCombined(
  opts: VirtualHfOptions,
  org: string,
  repo: string,
  repoType: HfRepoType,
  revision: string,
  path: string,
): Promise<boolean> {
  // Try resolve directly first — it lands per-file rows + extends
  // the revision row. If the upstream serves the file straight,
  // we skip the tree-listing round trip.
  const direct = await proxyHfResolve(opts, org, repo, repoType, revision, path);
  if (direct) return true;
  // Fall back: try populating just the revision tree (no bytes).
  // The caller will then re-stat and 404 if the path isn't in the
  // tree.
  const tree = await proxyHfRevision(opts, org, repo, repoType, revision);
  return tree;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// Quiet unused-import warning.
void Readable;
