/**
 * HuggingFace Hub facade wire-format types (WS13 M4, v0.6).
 *
 * Distinct from the storage-row metadata in
 * `registry/src/types.ts::HfManifestMetadata` — these types describe
 * what HF clients (huggingface-cli, transformers, diffusers, Git LFS
 * Batch API consumers) send and receive over the HTTP boundary.
 *
 * The HF Hub protocol is itself two related sub-protocols glued by
 * a content-addressed blob layer:
 *
 *   1. **HTTP-Git proxy lane** — `/resolve/<rev>/<path>` returns
 *      either the raw bytes (for small / non-LFS files) or a Git LFS
 *      pointer file (for large / LFS-tracked files). The pointer's
 *      `oid sha256:<hex>` is the address of the actual bytes.
 *   2. **LFS Batch API** — `POST /info/lfs/objects/batch` converts a
 *      list of OIDs into HTTP URLs the client can GET to fetch the
 *      bytes. We return URLs pointing at our content-addressed blob
 *      endpoint.
 *
 * Per-revision tree manifests live in a sibling `hf_revision` SQLite
 * table (see migration 0008). They are the first non-`manifest`
 * companion table any facade has introduced — see the audit doc for
 * the architectural rationale.
 *
 * References:
 *   https://huggingface.co/docs/hub/api
 *   https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
 *   https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md  (pointer file format)
 */

// ── Media types ───────────────────────────────────────────────────

export const HF_MEDIA_TYPES = {
  /** Per-file manifest row media type. */
  HF_FILE: "application/vnd.signalman.hf-file.v1+json",
  /** Per-revision row media type (revision rows live in hf_revision). */
  HF_REVISION: "application/vnd.signalman.hf-revision.v1+json",
  /** Git LFS Batch API request + response media type (LFS spec). */
  LFS_BATCH: "application/vnd.git-lfs+json",
  /** Generic blob bytes. */
  OCTET_STREAM: "application/octet-stream",
  /** LFS pointer file plain-text payload. */
  LFS_POINTER_TEXT: "text/plain",
} as const;

// ── Repo type ─────────────────────────────────────────────────────

/**
 * HF repo types. `model` is the default for `huggingface-cli download`
 * with no `--repo-type` flag; `dataset` + `space` round-trip read-only
 * in M4 (publish is models-only per the WS13 prompt's non-goals).
 */
export const HF_REPO_TYPES = ["model", "dataset", "space"] as const;
export type HfRepoType = (typeof HF_REPO_TYPES)[number];

// ── Defaults ──────────────────────────────────────────────────────

/** Default revision when the client omits it on `/resolve/<rev>/<path>`. Locked M0 → `main`. */
export const HF_DEFAULT_REVISION = "main";

/**
 * Default LFS threshold in bytes. HF's git-server config tracks files
 * larger than 5 MiB via LFS by default. Operator publish-tarball uses
 * this on each tar entry: `size > HF_DEFAULT_LFS_THRESHOLD` → `lfs: true`.
 * Override per virtual_upstream config row.
 */
export const HF_DEFAULT_LFS_THRESHOLD = 5 * 1024 * 1024;

/**
 * Default hard-cap on a single blob's bytes. 50 GB matches what the HF
 * production fleet allows. Override per virtual_upstream config row
 * via `hf_max_blob_bytes`. Locked M0.
 */
export const HF_DEFAULT_MAX_BLOB_BYTES = 50 * 1024 * 1024 * 1024;

// ── Revision row shape ────────────────────────────────────────────

/**
 * Per-revision file-tree manifest stored in `hf_revision`. The
 * `files` array is the canonical projection a `huggingface-cli
 * download` workflow walks: each entry pins a path + content sha +
 * size + LFS flag.
 */
export interface HfRevisionRow {
  org: string;
  repo: string;
  repoType: HfRepoType;
  /** Revision identifier — Git SHA-1, tag, or branch name. */
  revision: string;
  /** Git tree SHA-1 (when known); informational. */
  rootTreeDigest: string;
  /** Parent revision (for ancestry tracking; nullable for orphan/initial). */
  parentRevision?: string;
  /** Per-file projection. Path-traversal-checked on insert. */
  files: HfRevisionFile[];
  /** Optional provenance JSON (audit-side, never client-visible verbatim). */
  provenance?: Record<string, unknown>;
  /** ISO-8601 UTC at insert. */
  createdAt: string;
}

/**
 * One entry in `HfRevisionRow.files`. `path` is the in-repo relative
 * path (forward-slash). `sha256` is hex; for LFS-tracked files it's
 * the content sha256, which matches the LFS pointer's `oid sha256:<hex>`.
 */
export interface HfRevisionFile {
  /** Relative path inside the repo, e.g. `config.json` or `weights/model.bin`. */
  path: string;
  /** Lowercase hex sha256, 64 chars. */
  sha256: string;
  /** Decoded file size in bytes. */
  size: number;
  /** When true, `/resolve/<rev>/<path>` returns the LFS pointer payload, not the bytes. */
  lfs: boolean;
  /** Optional content type hint; advisory, not enforced on serve. */
  mimeType?: string;
}

// ── Git LFS Batch API shapes ──────────────────────────────────────

/**
 * Git LFS Batch API request — POST `/info/lfs/objects/batch`. We accept
 * only `operation: 'download'` in M4; upload via LFS protocol is v0.7
 * stretch (operators use the flattened tarball path instead).
 */
export interface LfsBatchRequest {
  operation: "download" | "upload";
  transfers?: string[];
  /** Per-OID requests. Each carries the LFS sha256 OID and the declared size. */
  objects: Array<{ oid: string; size: number }>;
  /** Optional `ref` field (Git ref the LFS objects are scoped to). */
  ref?: { name: string };
  /** Optional `hash_algo`; LFS only standardises `sha256`. */
  hash_algo?: "sha256";
}

/**
 * Git LFS Batch API response. Per the spec, each object MAY carry an
 * `actions` block (success path) OR an `error` block (per-object 4XX).
 * The top-level status is the HTTP status of the Batch endpoint; the
 * per-object status is in the `error.code` (or implicit success when
 * `actions` is present).
 */
export interface LfsBatchResponse {
  transfer?: string;
  objects: Array<LfsBatchObject>;
  hash_algo?: "sha256";
}

export interface LfsBatchObject {
  oid: string;
  size: number;
  /** Set on success. `download` is the only action we emit in M4. */
  actions?: {
    download?: {
      href: string;
      header?: Record<string, string>;
      expires_at?: string;
      expires_in?: number;
    };
  };
  /** Set on per-object failure. */
  error?: {
    code: number;
    message: string;
  };
  /** Optional `authenticated` marker. */
  authenticated?: boolean;
}

// ── LFS pointer file shape ────────────────────────────────────────

/**
 * Canonical LFS pointer file. The on-wire form is the 3-line text:
 *
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<hex>
 *   size <N>
 *
 * (trailing newline, no blank lines, no CRLF). Older pointers may
 * carry additional `x-<key> <value>` lines for extension fields; we
 * parse + preserve them but the canonical write form emits only the
 * 3 standard lines.
 */
export interface LfsPointer {
  /** Always `https://git-lfs.github.com/spec/v1` in M4. */
  version: string;
  oid: string; // `sha256:<hex>`
  size: number;
}

// ── Tree response (HF API) ────────────────────────────────────────

/**
 * The shape `/api/<repo_type>s/<org>/<repo>/tree/<revision>` returns
 * upstream. We mirror this on the virtual pull-through path so our
 * `proxyHfRevision` can construct an `hf_revision` row from the
 * upstream listing.
 */
export interface HfTreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  oid?: string;
  /** When the entry is an LFS file, this block carries the real
   * content sha + size; `oid` is the Git blob sha (not LFS). */
  lfs?: { oid: string; size: number; pointerSize?: number };
}

// ── Error envelope ────────────────────────────────────────────────

/**
 * HF Hub does not document a standardised JSON error envelope —
 * production HF emits varied 4XX bodies (`{"error": "..."}` for
 * 404, sometimes empty for 401). We emit a small stable envelope on
 * 4XX so operator tooling can parse failures uniformly, with one
 * carve-out: 404 from the read path emits the HF-canonical shape
 * `{"error": "Repository not found"}` because `huggingface-cli`
 * parses it. (Q7 lock.)
 */
export interface HfErrorEnvelope {
  errors: Array<{
    code: HfErrorCode;
    message: string;
    detail?: unknown;
  }>;
}

export const HF_ERROR_CODES = {
  ORG_INVALID: "ORG_INVALID",
  REPO_INVALID: "REPO_INVALID",
  REPO_TYPE_INVALID: "REPO_TYPE_INVALID",
  REVISION_INVALID: "REVISION_INVALID",
  PATH_INVALID: "PATH_INVALID",
  OID_INVALID: "OID_INVALID",
  REPO_NOT_FOUND: "REPO_NOT_FOUND",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  BLOB_NOT_FOUND: "BLOB_NOT_FOUND",
  LFS_BATCH_INVALID: "LFS_BATCH_INVALID",
  LFS_UNSUPPORTED_OPERATION: "LFS_UNSUPPORTED_OPERATION",
  UPLOAD_INVALID: "UPLOAD_INVALID",
  REVISION_EXISTS: "REVISION_EXISTS",
  RANGE_INVALID: "RANGE_INVALID",
  TOO_LARGE: "TOO_LARGE",
  UNAUTHORIZED: "UNAUTHORIZED",
  CONFLICT: "CONFLICT",
} as const;

export type HfErrorCode = (typeof HF_ERROR_CODES)[keyof typeof HF_ERROR_CODES];
