/**
 * HF resolve endpoint — the canonical read path.
 *
 *   GET /hf/<org>/<repo>/resolve/<revision>/<path>
 *
 * Returns either the raw bytes (small / non-LFS files) or a canonical
 * LFS pointer file (large / LFS-tracked files). Matches the upstream
 * `https://huggingface.co/<org>/<repo>/resolve/<rev>/<path>` byte-
 * for-byte.
 *
 * Lookup walk:
 *   1. Resolve <revision> in the `hf_revision` companion table. When
 *      the row is absent → optional virtual-upstream proxy hook;
 *      re-read after the proxy populates the cache; 404 (canonical
 *      body) on continued miss.
 *   2. Locate the file's `{path, sha256, size, lfs}` entry within the
 *      revision row's `files` array. 404 (FILE_NOT_FOUND, canonical
 *      body) when absent.
 *   3. For non-LFS files: stream the blob bytes back; honour Range.
 *   4. For LFS files: emit the 3-line canonical LFS pointer text.
 *
 * The optional proxy hook receives the (org, repo, revision, path)
 * tuple and returns true when it populated the local cache; the
 * handler then re-runs the lookup. Cache miss propagation is the
 * HF-canonical 404 body per Q7 lock.
 */

import type { ServerResponse } from "node:http";
import type { RegistryStorage } from "../types.js";
import type {
  HfRevisionFile,
  HfRevisionRow,
  HfRepoType,
  SqliteManifestIndex,
} from "../storage/sqlite-index.js";
import { HfError } from "./errors.js";
import { HF_DEFAULT_REVISION, HF_ERROR_CODES, HF_MEDIA_TYPES } from "./types.js";
import { composeLfsPointer } from "./guards.js";
import { hfManifestName, hfManifestVersion } from "./paths.js";
import { serveHfBlob } from "./blobs.js";

export interface ResolveHfFileOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  /** Parsed inputs from the route layer. */
  org: string;
  repo: string;
  repoType: HfRepoType;
  revision: string;
  path: string;
  /** Optional Range header for raw byte serves. */
  rangeHeader?: string;
  /** Response writer. */
  res: ServerResponse;
  /**
   * Pull-through hook. On a revision OR file miss, the handler calls
   * this once and re-runs the lookup. Returns true when the proxy
   * populated the cache. Wired in Story 5.
   */
  proxyResolve?: (
    org: string,
    repo: string,
    repoType: HfRepoType,
    revision: string,
    path: string,
  ) => Promise<boolean>;
}

export async function resolveHfFile(opts: ResolveHfFileOptions): Promise<void> {
  let revisionRow = opts.index.getHfRevision(
    opts.org,
    opts.repo,
    opts.repoType,
    opts.revision,
  );

  if (!revisionRow && opts.proxyResolve) {
    const ok = await opts.proxyResolve(
      opts.org,
      opts.repo,
      opts.repoType,
      opts.revision,
      opts.path,
    );
    if (ok) {
      revisionRow = opts.index.getHfRevision(
        opts.org,
        opts.repo,
        opts.repoType,
        opts.revision,
      );
    }
  }

  if (!revisionRow) {
    throw new HfError(
      HF_ERROR_CODES.REVISION_NOT_FOUND,
      `revision '${opts.revision}' not found for ${opts.org}/${opts.repo} (${opts.repoType})`,
    );
  }

  let fileEntry = findFile(revisionRow, opts.path);
  if (!fileEntry && opts.proxyResolve) {
    const ok = await opts.proxyResolve(
      opts.org,
      opts.repo,
      opts.repoType,
      opts.revision,
      opts.path,
    );
    if (ok) {
      const refreshed = opts.index.getHfRevision(
        opts.org,
        opts.repo,
        opts.repoType,
        opts.revision,
      );
      if (refreshed) {
        revisionRow = refreshed;
        fileEntry = findFile(revisionRow, opts.path);
      }
    }
  }
  if (!fileEntry) {
    throw new HfError(
      HF_ERROR_CODES.FILE_NOT_FOUND,
      `path '${opts.path}' not found in revision '${opts.revision}'`,
    );
  }

  if (fileEntry.lfs) {
    await emitLfsPointer(fileEntry, opts.res);
    return;
  }

  // Non-LFS: stream the bytes directly. We rely on `serveHfBlob` to
  // handle Range + headers + 404 propagation. When the per-file
  // manifest row exists, we may consult its mimeType — otherwise
  // fall back to octet-stream.
  const perFile = await opts.storage.getManifest(
    hfManifestName(opts.org, opts.repo, opts.repoType),
    hfManifestVersion(opts.revision, opts.path),
  );
  const contentType =
    perFile?.hfMetadata?.mimeType ??
    fileEntry.mimeType ??
    HF_MEDIA_TYPES.OCTET_STREAM;

  await serveHfBlob({
    storage: opts.storage,
    sha256: fileEntry.sha256,
    ...(opts.rangeHeader !== undefined ? { rangeHeader: opts.rangeHeader } : {}),
    res: opts.res,
    contentType,
  });
}

/**
 * Walk the revision's files array for the matching path. Comparison
 * is exact; the caller has already normalised the path via
 * `validateHfPath`, so e.g. trailing slashes won't reach here.
 */
function findFile(
  rev: HfRevisionRow,
  path: string,
): HfRevisionFile | undefined {
  for (const f of rev.files) {
    if (f.path === path) return f;
  }
  return undefined;
}

function emitLfsPointer(file: HfRevisionFile, res: ServerResponse): void {
  const pointer = composeLfsPointer(file.sha256, file.size);
  res.statusCode = 200;
  res.setHeader("content-type", HF_MEDIA_TYPES.LFS_POINTER_TEXT + "; charset=utf-8");
  res.setHeader("content-length", String(pointer.length));
  res.setHeader("x-lfs-pointer", "true");
  res.setHeader("etag", `"lfs-pointer:${file.sha256}"`);
  res.end(pointer);
}

/**
 * Resolve a "default revision" reference: when the URL omits the
 * revision, fall back to the M0-locked `main` sentinel.
 */
export function effectiveRevision(revision: string | undefined): string {
  if (typeof revision !== "string" || revision.length === 0) {
    return HF_DEFAULT_REVISION;
  }
  return revision;
}

// Re-export so other modules can find the route-time helpers.
export type { HfRevisionFile, HfRevisionRow };
