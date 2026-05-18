/**
 * HF publish endpoint — flattened tarball upload (Q3 lock: single-
 * shot in M4; chunked upload deferred to M4.1).
 *
 *   POST /hf/<org>/<repo>/upload-tarball?revision=<rev>&repo_type=<model|dataset|space>
 *   Content-Type: application/x-tar  (or application/octet-stream)
 *
 * The body is a flat USTAR tar of the model's file tree. For each
 * regular-file entry we:
 *   - validate the entry's path (no traversal; POSIX form)
 *   - reject non-regular-files (Q5 lock)
 *   - enforce the per-blob size cap (Q1 lock)
 *   - stream the bytes into `storage.putBlob` so the parser never
 *     accumulates the file in memory
 *   - classify LFS vs raw by size threshold
 *   - persist a `kind: 'hf'` per-file manifest row
 *
 * After the tar parser returns, we write the `hf_revision` row
 * with the aggregated files list. 409 CONFLICT when the revision
 * already exists with different files (revisions are append-only
 * per locked design item 7).
 *
 * Idempotency: same revision + same files → 200 no-op success.
 *
 * Audit-log: emits one `upload` row per publish, recording the org,
 * repo, repo_type, revision, file_count, total_bytes.
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import type {
  HfManifestMetadata,
  Manifest,
  Provenance,
  RegistryStorage,
} from "../types.js";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
} from "../types.js";
import type {
  HfRepoType,
  HfRevisionFile,
  HfRevisionInsert,
  SqliteManifestIndex,
  VirtualUpstreamConfig,
} from "../storage/sqlite-index.js";
import { HfError } from "./errors.js";
import {
  HF_DEFAULT_LFS_THRESHOLD,
  HF_DEFAULT_MAX_BLOB_BYTES,
  HF_ERROR_CODES,
  HF_MEDIA_TYPES,
} from "./types.js";
import { classifyLfsByThreshold, enforceMaxBlobBytes } from "./guards.js";
import {
  hfManifestName,
  hfManifestVersion,
  validateHfPath,
} from "./paths.js";
import { parseUstarTar, type TarEntry } from "./tar.js";

export interface HfPublishInput {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  org: string;
  repo: string;
  repoType: HfRepoType;
  revision: string;
  /** Tar bytes as a Readable. The handler streams this end-to-end. */
  body: Readable;
  /** Optional per-virtual-upstream config used to source caps + threshold. */
  upstreamConfig?: VirtualUpstreamConfig;
  /** Actor for the audit row. Defaults to `'anonymous'`. */
  actor?: string;
  /** Override the LFS threshold; defaults to the upstream config / HF default. */
  lfsThreshold?: number;
  /** Override the max blob bytes; defaults to the upstream config / HF default. */
  maxBlobBytes?: number;
}

export interface HfPublishResult {
  org: string;
  repo: string;
  repoType: HfRepoType;
  revision: string;
  file_count: number;
  total_bytes: number;
  root_tree_digest: string;
  /** `true` when the revision was already present with identical files (no-op). */
  idempotent: boolean;
}

/**
 * Top-level publish path: stream the tar body, persist per-file
 * manifest rows, persist the revision row, return the summary.
 */
export async function publishHfTarball(
  input: HfPublishInput,
): Promise<HfPublishResult> {
  const lfsThreshold =
    input.lfsThreshold ??
    input.upstreamConfig?.hf_lfs_threshold_bytes ??
    HF_DEFAULT_LFS_THRESHOLD;
  const maxBlobBytes =
    input.maxBlobBytes ??
    input.upstreamConfig?.hf_max_blob_bytes ??
    HF_DEFAULT_MAX_BLOB_BYTES;
  const actor = input.actor ?? "anonymous";
  const storageName = hfManifestName(input.org, input.repo, input.repoType);
  const files: HfRevisionFile[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  await parseUstarTar(input.body, async (entry) => {
    await handleTarEntry({
      entry,
      input,
      lfsThreshold,
      maxBlobBytes,
      storageName,
      files,
      seenPaths,
      actor,
      getTotal: () => totalBytes,
      addTotal: (n: number) => {
        totalBytes += n;
      },
    });
  });

  if (files.length === 0) {
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      "tarball did not contain any regular-file entries",
    );
  }

  // Sort the files array for deterministic root_tree_digest.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rootTreeDigest = computeRootTreeDigest(files);
  const createdAt = new Date().toISOString();

  const provenance: Record<string, unknown> = {
    source: "upload",
    fetchedAt: createdAt,
    fetchedBy: actor,
  };
  const insert: HfRevisionInsert = {
    org: input.org,
    repo: input.repo,
    repoType: input.repoType,
    revision: input.revision,
    rootTreeDigest,
    files,
    provenance,
    createdAt,
  };

  let idempotent = false;
  try {
    input.index.putHfRevision(insert);
  } catch (err) {
    if (err instanceof RegistryError && err.code === REGISTRY_ERROR_CODES.MANIFEST_EXISTS) {
      // Append-only: same revision id, different bytes. Surface 409.
      throw new HfError(
        HF_ERROR_CODES.REVISION_EXISTS,
        `revision '${input.revision}' for ${input.org}/${input.repo} (${input.repoType}) is already published with different file content`,
      );
    }
    throw err;
  }
  // Idempotency: putHfRevision is a no-op for identical content. We
  // detect this by re-reading the row's createdAt — if it pre-dates
  // ours, the put was a no-op.
  const stored = input.index.getHfRevision(
    input.org,
    input.repo,
    input.repoType,
    input.revision,
  );
  if (stored && stored.createdAt !== createdAt) {
    idempotent = true;
  }

  // Update the 'main' sentinel if not already targeting that revision.
  if (input.revision !== "main") {
    input.index.updateHfRevision({
      org: input.org,
      repo: input.repo,
      repoType: input.repoType,
      revision: "main",
      rootTreeDigest,
      parentRevision: input.revision,
      files,
      provenance: { ...provenance, sentinel: "main", points_at: input.revision },
      createdAt,
    });
  }

  // Audit-log entry.
  input.index.appendAuditEntry({
    action: "upload",
    entityType: "manifest",
    entityId: `${storageName}@${input.revision}`,
    actor,
    detail: {
      kind: "hf",
      org: input.org,
      repo: input.repo,
      repo_type: input.repoType,
      revision: input.revision,
      file_count: files.length,
      total_bytes: totalBytes,
      root_tree_digest: rootTreeDigest,
      idempotent,
    },
  });

  return {
    org: input.org,
    repo: input.repo,
    repoType: input.repoType,
    revision: input.revision,
    file_count: files.length,
    total_bytes: totalBytes,
    root_tree_digest: rootTreeDigest,
    idempotent,
  };
}

interface HandleTarEntryArgs {
  entry: TarEntry;
  input: HfPublishInput;
  lfsThreshold: number;
  maxBlobBytes: number;
  storageName: string;
  files: HfRevisionFile[];
  seenPaths: Set<string>;
  actor: string;
  getTotal: () => number;
  addTotal: (n: number) => void;
}

async function handleTarEntry(args: HandleTarEntryArgs): Promise<void> {
  const { entry } = args;
  const normalisedPath = validateHfPath(entry.name);

  if (args.seenPaths.has(normalisedPath)) {
    // Drain the payload so the parser advances + then throw.
    await drain(entry.payload);
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      `tar contains duplicate entry for path '${normalisedPath}'`,
    );
  }
  args.seenPaths.add(normalisedPath);

  enforceMaxBlobBytes(entry.size, args.maxBlobBytes);

  // Stream the payload into the blob layer while also computing
  // sha256 in-line so we don't re-read the file afterwards.
  const hash = crypto.createHash("sha256");
  const blobBody = entry.payload.pipe(new HashingPassthrough(hash));
  const blobMeta = await args.input.storage.putBlob({
    body: blobBody,
    contentType: HF_MEDIA_TYPES.OCTET_STREAM,
  });
  // Cross-check size: blob meta size MUST equal the tar header size,
  // otherwise the parser truncated or the body lies.
  if (blobMeta.size !== entry.size) {
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      `tar entry '${normalisedPath}' declared size ${entry.size} but stored ${blobMeta.size} bytes`,
    );
  }
  args.addTotal(blobMeta.size);

  const lfs = classifyLfsByThreshold(blobMeta.size, args.lfsThreshold);
  const meta: HfManifestMetadata = {
    org: args.input.org,
    repo: args.input.repo,
    repoType: args.input.repoType,
    revision: args.input.revision,
    path: normalisedPath,
    lfs,
    sha256: blobMeta.sha256,
    size: blobMeta.size,
    ...(lfs ? { lfsOid: `sha256:${blobMeta.sha256}` } : {}),
  };

  const versionKey = hfManifestVersion(args.input.revision, normalisedPath);

  // Check for an existing per-file manifest row. Idempotent re-put:
  // when the existing row points at the SAME blob sha, treat as a
  // no-op (createdAt will differ between publishes, so the shared
  // putManifest's canonical-byte compare would otherwise raise
  // MANIFEST_EXISTS). A different blob sha for the same key
  // violates revision append-only semantics → 409.
  const existing = await args.input.storage.getManifest(args.storageName, versionKey);
  if (existing) {
    const existingSha = existing.blobs[0]?.sha256;
    if (existingSha !== blobMeta.sha256) {
      throw new HfError(
        HF_ERROR_CODES.REVISION_EXISTS,
        `file ${normalisedPath} at revision ${args.input.revision} already published with different content`,
      );
    }
    args.files.push({
      path: normalisedPath,
      sha256: blobMeta.sha256,
      size: blobMeta.size,
      lfs,
    });
    const ourHashEarly = hash.digest("hex");
    if (ourHashEarly !== blobMeta.sha256) {
      throw new HfError(
        HF_ERROR_CODES.UPLOAD_INVALID,
        `internal: sha256 disagreement on '${normalisedPath}' (storage=${blobMeta.sha256}, parser=${ourHashEarly})`,
      );
    }
    return;
  }

  const createdAt = new Date().toISOString();
  const manifest: Manifest = {
    name: args.storageName,
    version: versionKey,
    mediaType: HF_MEDIA_TYPES.HF_FILE,
    kind: "hf",
    blobs: [
      {
        mediaType: HF_MEDIA_TYPES.OCTET_STREAM,
        sha256: blobMeta.sha256,
        size: blobMeta.size,
        name: normalisedPath,
      },
    ],
    hfMetadata: meta,
    createdAt,
  };
  const provenance: Provenance = {
    source: "upload",
    fetchedAt: createdAt,
    fetchedBy: args.actor.slice(-16),
  };
  try {
    await args.input.storage.putManifest(manifest, provenance);
  } catch (err) {
    if (err instanceof RegistryError && err.code === REGISTRY_ERROR_CODES.MANIFEST_EXISTS) {
      throw new HfError(
        HF_ERROR_CODES.REVISION_EXISTS,
        `file ${normalisedPath} at revision ${args.input.revision} already published with different content`,
      );
    }
    throw err;
  }

  args.files.push({
    path: normalisedPath,
    sha256: blobMeta.sha256,
    size: blobMeta.size,
    lfs,
  });

  // We also confirm the hash matches the storage-layer sha. They
  // must be identical (both compute sha256 over the same bytes).
  const ourHash = hash.digest("hex");
  if (ourHash !== blobMeta.sha256) {
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      `internal: sha256 disagreement on '${normalisedPath}' (storage=${blobMeta.sha256}, parser=${ourHash})`,
    );
  }
}

/**
 * SHA-256 of the canonical files-list JSON. Acts as a synthetic
 * "root tree digest" for the revision row; matches a content hash
 * of the file set rather than a true git tree SHA-1 (operators who
 * push a full git tree via v0.7 will replace this with the real
 * sha-1).
 */
function computeRootTreeDigest(files: HfRevisionFile[]): string {
  const canonical = files
    .map((f) => `${f.path}\0${f.sha256}\0${f.size}\0${f.lfs ? 1 : 0}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * A PassThrough that runs each chunk through a node Hash. The
 * outgoing stream is unaltered.
 */
import { Transform } from "node:stream";
class HashingPassthrough extends Transform {
  constructor(private readonly hash: crypto.Hash) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    this.hash.update(chunk);
    this.push(chunk);
    callback();
  }
}

async function drain(s: Readable): Promise<void> {
  for await (const _ of s) {
    void _;
  }
}
