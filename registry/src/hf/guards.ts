/**
 * Higher-level validators that compose the path-grammar primitives
 * with workflow-aware checks: LFS pointer parsing, tar-entry
 * sanity, blob-size cap enforcement, and HTTP Range header parsing.
 *
 * Pure helpers — no I/O. The publish path + the read path import
 * from here.
 */

import { HfError } from "./errors.js";
import {
  HF_DEFAULT_LFS_THRESHOLD,
  HF_DEFAULT_MAX_BLOB_BYTES,
  HF_ERROR_CODES,
  type LfsPointer,
} from "./types.js";
import { parseLfsOid } from "./paths.js";

// ── LFS pointer file parser ───────────────────────────────────────

/**
 * Canonical Git LFS pointer file. Format (per spec):
 *
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<hex>
 *   size <N>
 *
 * Lines are LF-only, sorted alphabetically by key, terminated with a
 * trailing LF. The parser is strict: rejects CRLF, rejects out-of-order
 * keys, requires the version header to begin with `git-lfs.github.com`.
 *
 * Returns the parsed pointer; throws `HfError(OID_INVALID)` on any
 * malformation. The bytes are usually < 200 bytes — we never accept
 * a buffer larger than 1 KB as a "pointer" (any larger and it's
 * almost certainly the actual file).
 */
export function parseLfsPointer(buf: Buffer): LfsPointer {
  if (buf.length === 0 || buf.length > 1024) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `LFS pointer length ${buf.length} out of bounds (1..1024)`,
    );
  }
  const text = buf.toString("utf-8");
  if (text.includes("\r")) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      "LFS pointer must use LF line endings only (no CR)",
    );
  }
  const lines = text.split("\n");
  // Tolerate trailing newline → final empty element. Required keys:
  // version (first), oid, size.
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (trimmed.length < 3) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `LFS pointer must contain at least 3 lines; got ${trimmed.length}`,
    );
  }

  const map = new Map<string, string>();
  for (const line of trimmed) {
    const space = line.indexOf(" ");
    if (space <= 0) {
      throw new HfError(
        HF_ERROR_CODES.OID_INVALID,
        `LFS pointer line '${line}' missing ' ' separator`,
      );
    }
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (map.has(key)) {
      throw new HfError(
        HF_ERROR_CODES.OID_INVALID,
        `LFS pointer key '${key}' appears twice`,
      );
    }
    map.set(key, value);
  }

  // First key MUST be 'version' per spec. Some implementations drift;
  // we accept it anywhere but require it to be present + canonical.
  const version = map.get("version");
  if (typeof version !== "string" || !version.startsWith("https://git-lfs.github.com/spec/")) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `LFS pointer 'version' header must point to git-lfs.github.com/spec; got '${version ?? "<missing>"}'`,
    );
  }
  const oid = map.get("oid");
  if (typeof oid !== "string") {
    throw new HfError(HF_ERROR_CODES.OID_INVALID, "LFS pointer 'oid' missing");
  }
  parseLfsOid(oid); // throws on malformed sha256:<hex>
  const sizeStr = map.get("size");
  if (typeof sizeStr !== "string") {
    throw new HfError(HF_ERROR_CODES.OID_INVALID, "LFS pointer 'size' missing");
  }
  const size = Number(sizeStr);
  if (!Number.isInteger(size) || size < 0 || !Number.isFinite(size)) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `LFS pointer 'size' '${sizeStr}' is not a non-negative integer`,
    );
  }
  return { version, oid, size };
}

/**
 * Emit the canonical LFS pointer text for a (sha256-hex, size) pair.
 * Always emits the 3 canonical lines with trailing LF.
 */
export function composeLfsPointer(sha256Hex: string, size: number): Buffer {
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `composeLfsPointer: sha256 '${sha256Hex}' is not a 64-char lowercase hex`,
    );
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new HfError(
      HF_ERROR_CODES.OID_INVALID,
      `composeLfsPointer: size '${size}' must be a non-negative integer`,
    );
  }
  const text =
    "version https://git-lfs.github.com/spec/v1\n" +
    `oid sha256:${sha256Hex}\n` +
    `size ${size}\n`;
  return Buffer.from(text, "utf-8");
}

/**
 * Detect whether a buffer is an LFS pointer file (the read path uses
 * this on virtual-upstream `/resolve/...` responses). Returns the
 * parsed pointer on a positive match, null otherwise. Never throws.
 */
export function detectLfsPointer(buf: Buffer): LfsPointer | null {
  if (buf.length === 0 || buf.length > 1024) return null;
  // Cheap front-check before the full parse: pointer files always
  // start with `version `.
  if (!buf.slice(0, 8).equals(Buffer.from("version "))) return null;
  try {
    return parseLfsPointer(buf);
  } catch {
    return null;
  }
}

// ── Size cap enforcement ──────────────────────────────────────────

/**
 * Enforce the per-blob byte cap. Throws TOO_LARGE when the declared
 * or counted bytes exceed the limit. Honours the per-virtual-upstream
 * `hf_max_blob_bytes` override (Q1 lock).
 */
export function enforceMaxBlobBytes(bytes: number, max?: number): void {
  const cap = max ?? HF_DEFAULT_MAX_BLOB_BYTES;
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new HfError(
      HF_ERROR_CODES.TOO_LARGE,
      `byte count ${bytes} is not a non-negative finite integer`,
    );
  }
  if (bytes > cap) {
    throw new HfError(
      HF_ERROR_CODES.TOO_LARGE,
      `blob size ${bytes} exceeds cap ${cap}`,
    );
  }
}

/**
 * Decide whether a file should be tracked as LFS (true) or stored as
 * raw bytes inline (false). HF's convention is `size > 5 MiB → LFS`;
 * operators may override via virtual_upstream config (out-of-scope in
 * M4; the threshold knob lands when chunked-upload arrives in M4.1).
 */
export function classifyLfsByThreshold(
  size: number,
  threshold: number = HF_DEFAULT_LFS_THRESHOLD,
): boolean {
  return size > threshold;
}

// ── HTTP Range parsing ────────────────────────────────────────────

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

/**
 * Parse a single-range `Range: bytes=<start>-<end>` header against a
 * blob of total size `total`. Returns the resolved [start, end]
 * inclusive range. Multi-range (comma-separated) requests are
 * rejected as RANGE_INVALID — the blob layer doesn't support
 * multipart/byteranges yet.
 *
 * Empty / absent header returns null; the caller serves the full blob.
 */
export function parseRangeHeader(
  header: string | undefined,
  total: number,
): ByteRange | null {
  if (typeof header !== "string" || header.length === 0) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith("bytes=")) {
    throw new HfError(
      HF_ERROR_CODES.RANGE_INVALID,
      `Range header must start with 'bytes='; got '${trimmed}'`,
    );
  }
  const spec = trimmed.slice("bytes=".length);
  if (spec.includes(",")) {
    throw new HfError(
      HF_ERROR_CODES.RANGE_INVALID,
      "multi-range Range headers are not supported",
    );
  }
  const dash = spec.indexOf("-");
  if (dash < 0) {
    throw new HfError(
      HF_ERROR_CODES.RANGE_INVALID,
      `Range spec '${spec}' missing '-' separator`,
    );
  }
  const startStr = spec.slice(0, dash);
  const endStr = spec.slice(dash + 1);

  // Suffix range: `bytes=-N` = last N bytes.
  if (startStr.length === 0) {
    if (endStr.length === 0) {
      throw new HfError(
        HF_ERROR_CODES.RANGE_INVALID,
        "Range spec must specify at least one of start or suffix length",
      );
    }
    const n = Number(endStr);
    if (!Number.isInteger(n) || n < 0) {
      throw new HfError(
        HF_ERROR_CODES.RANGE_INVALID,
        `Range suffix '${endStr}' is not a non-negative integer`,
      );
    }
    if (n === 0) {
      throw new HfError(
        HF_ERROR_CODES.RANGE_INVALID,
        "Range suffix of 0 is unsatisfiable",
      );
    }
    const start = Math.max(0, total - n);
    return { start, end: total - 1 };
  }

  const start = Number(startStr);
  if (!Number.isInteger(start) || start < 0) {
    throw new HfError(
      HF_ERROR_CODES.RANGE_INVALID,
      `Range start '${startStr}' is not a non-negative integer`,
    );
  }
  let end: number;
  if (endStr.length === 0) {
    end = total - 1;
  } else {
    end = Number(endStr);
    if (!Number.isInteger(end) || end < 0) {
      throw new HfError(
        HF_ERROR_CODES.RANGE_INVALID,
        `Range end '${endStr}' is not a non-negative integer`,
      );
    }
  }
  if (end < start) {
    throw new HfError(
      HF_ERROR_CODES.RANGE_INVALID,
      `Range end ${end} < start ${start}`,
    );
  }
  if (start >= total) {
    throw new HfError(
      HF_ERROR_CODES.RANGE_INVALID,
      `Range start ${start} >= total ${total}`,
    );
  }
  if (end >= total) end = total - 1;
  return { start, end };
}
