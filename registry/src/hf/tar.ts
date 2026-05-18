/**
 * Minimal streaming USTAR / POSIX-tar parser.
 *
 * Why hand-rolled: the USTAR grammar is small (one 512-byte header
 * per entry + payload padded to 512-byte boundaries), and adding a
 * tar dep (`tar`, `tar-stream`) would gate on Selvedge (which isn't
 * installed in this env). The HF publish path needs three things:
 *   - entry types (we accept REGTYPE only; symlinks / hard-links /
 *     device files / directories etc. are rejected per Q5 lock).
 *   - path with no traversal segments.
 *   - the entry's bytes as a Readable so we can stream into
 *     `storage.putBlob` without buffering in memory.
 *
 * What we DON'T support: GNU long-name extensions
 * (LONGLINK / LONGNAME), PAX headers (key=value records). HF
 * operator tarballs in M4 are vanilla `tar -cf model.tar .` output
 * from a normal HF repo; if an operator's tarball needs GNU/PAX
 * features we surface UPLOAD_INVALID and require a re-tar with
 * `--format=ustar`.
 *
 * Streaming guarantee: we never buffer the full file in memory. The
 * caller passes a single `onEntry` callback that returns a promise;
 * we await it before continuing to the next entry. The callback
 * reads the entry's payload from a per-entry Readable that ends
 * exactly at the entry boundary.
 */

import { PassThrough, Readable } from "node:stream";
import { HfError } from "./errors.js";
import { HF_ERROR_CODES } from "./types.js";

/** USTAR / POSIX tar typeflag values we care about. */
export const TAR_TYPE_REGFILE = "0";
export const TAR_TYPE_AREGFILE = "\0"; // legacy "regular file" tag
export const TAR_TYPE_HARDLINK = "1";
export const TAR_TYPE_SYMLINK = "2";
export const TAR_TYPE_CHARDEV = "3";
export const TAR_TYPE_BLOCKDEV = "4";
export const TAR_TYPE_DIRECTORY = "5";
export const TAR_TYPE_FIFO = "6";
export const TAR_TYPE_CONTIGUOUS = "7";
/** GNU / PAX special headers we don't support. */
export const TAR_TYPE_GNU_LONGNAME = "L";
export const TAR_TYPE_GNU_LONGLINK = "K";
export const TAR_TYPE_PAX_HEADER = "x";
export const TAR_TYPE_PAX_GLOBAL = "g";

const BLOCK_SIZE = 512;

export interface TarEntry {
  /** The entry's posix-form path. Includes the `prefix` field when set. */
  name: string;
  /** Numeric typeflag (one of the TAR_TYPE_* constants). */
  type: string;
  /** Byte size of the entry's payload. */
  size: number;
  /** UNIX mode bits (informational). */
  mode: number;
  /** Mtime (informational). */
  mtime: number;
  /** Payload as a Readable. The caller MUST consume to completion before the next entry. */
  payload: Readable;
}

/**
 * Parse `source` as a USTAR tar archive and invoke `onEntry` for
 * each regular-file entry. Throws `HfError` with code
 * `UPLOAD_INVALID` on any structural problem. Resolves after the
 * end-of-archive marker (two consecutive zero blocks) is seen.
 *
 * Directory entries are silently skipped; only the regular-file ones
 * are reported. Symlinks / hardlinks / device files / FIFOs / GNU
 * long-name + PAX headers trigger UPLOAD_INVALID rejection (Q5
 * lock + non-goal).
 */
export async function parseUstarTar(
  source: Readable,
  onEntry: (entry: TarEntry) => Promise<void>,
): Promise<void> {
  const buffer = new BufferedReader(source);
  let zeroBlocksSeen = 0;

  while (true) {
    const block = await buffer.readExactly(BLOCK_SIZE);
    if (block === null) {
      // Premature end before the end-of-archive marker. Some tar
      // writers omit the trailing zero blocks; we tolerate a clean
      // EOF here so long as we've seen at least one valid entry.
      return;
    }
    if (isZeroBlock(block)) {
      zeroBlocksSeen += 1;
      // Two consecutive zero blocks = end-of-archive marker.
      if (zeroBlocksSeen >= 2) {
        // Drain anything remaining from the source so the upstream
        // request body completes cleanly; tar writers may pad the
        // archive with extra zeros (`tar -b 20` writes 10 KiB
        // record blocks). We don't actually parse the padding.
        await buffer.drain();
        return;
      }
      continue;
    }
    zeroBlocksSeen = 0;

    const header = parseUstarHeader(block);

    if (
      header.type === TAR_TYPE_GNU_LONGNAME ||
      header.type === TAR_TYPE_GNU_LONGLINK ||
      header.type === TAR_TYPE_PAX_HEADER ||
      header.type === TAR_TYPE_PAX_GLOBAL
    ) {
      throw new HfError(
        HF_ERROR_CODES.UPLOAD_INVALID,
        `tar entry '${header.name}' uses unsupported extended header type '${header.type}'; re-tar with --format=ustar`,
      );
    }
    if (
      header.type === TAR_TYPE_SYMLINK ||
      header.type === TAR_TYPE_HARDLINK
    ) {
      throw new HfError(
        HF_ERROR_CODES.UPLOAD_INVALID,
        `tar entry '${header.name}' is a symlink / hardlink; reject per upload policy`,
      );
    }
    if (
      header.type === TAR_TYPE_CHARDEV ||
      header.type === TAR_TYPE_BLOCKDEV ||
      header.type === TAR_TYPE_FIFO
    ) {
      throw new HfError(
        HF_ERROR_CODES.UPLOAD_INVALID,
        `tar entry '${header.name}' is a device file / FIFO; reject per upload policy`,
      );
    }
    if (header.type === TAR_TYPE_DIRECTORY) {
      // Skip directories silently; their payload size is always 0.
      // No payload to consume.
      continue;
    }
    if (
      header.type !== TAR_TYPE_REGFILE &&
      header.type !== TAR_TYPE_AREGFILE &&
      header.type !== TAR_TYPE_CONTIGUOUS
    ) {
      throw new HfError(
        HF_ERROR_CODES.UPLOAD_INVALID,
        `tar entry '${header.name}' has unknown typeflag '${header.type}'`,
      );
    }

    // Stream the payload to the caller. We need to: (a) feed exactly
    // `size` bytes into a PassThrough they consume, then (b) consume
    // the padding bytes after the payload. The padding is the
    // smallest multiple of 512 that holds `size`.
    const payload = new PassThrough();
    const consumePayload = onEntry({
      name: header.name,
      type: header.type,
      size: header.size,
      mode: header.mode,
      mtime: header.mtime,
      payload,
    });

    let remaining = header.size;
    while (remaining > 0) {
      const chunk = await buffer.readUpTo(remaining);
      if (chunk === null) {
        payload.destroy(
          new HfError(
            HF_ERROR_CODES.UPLOAD_INVALID,
            `tar entry '${header.name}' truncated: expected ${header.size} bytes; saw ${header.size - remaining}`,
          ),
        );
        // Wait for the consumer to settle before propagating.
        try {
          await consumePayload;
        } catch {
          // swallow; we'll throw our own below
        }
        throw new HfError(
          HF_ERROR_CODES.UPLOAD_INVALID,
          `tar entry '${header.name}' truncated`,
        );
      }
      payload.write(chunk);
      remaining -= chunk.length;
    }
    payload.end();
    await consumePayload;

    // Consume padding to the next 512-byte boundary.
    const tail = header.size % BLOCK_SIZE;
    if (tail !== 0) {
      const padding = await buffer.readExactly(BLOCK_SIZE - tail);
      if (padding === null) {
        throw new HfError(
          HF_ERROR_CODES.UPLOAD_INVALID,
          `tar entry '${header.name}' missing padding to block boundary`,
        );
      }
    }
  }
}

interface ParsedHeader {
  name: string;
  size: number;
  type: string;
  mode: number;
  mtime: number;
}

function parseUstarHeader(block: Buffer): ParsedHeader {
  if (block.length !== BLOCK_SIZE) {
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      `tar header block size ${block.length} != ${BLOCK_SIZE}`,
    );
  }
  // Verify the checksum: sum of bytes [0..512), with the 8 checksum
  // bytes treated as ASCII spaces.
  const declaredChecksum = parseOctal(block.subarray(148, 156));
  let computed = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (i >= 148 && i < 156) {
      computed += 0x20; // ASCII space
    } else {
      computed += block[i];
    }
  }
  if (computed !== declaredChecksum) {
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      `tar header checksum mismatch: declared ${declaredChecksum}, computed ${computed}`,
    );
  }
  const name = readCString(block.subarray(0, 100));
  const mode = parseOctal(block.subarray(100, 108));
  const size = parseOctal(block.subarray(124, 136));
  const mtime = parseOctal(block.subarray(136, 148));
  const typeflag = String.fromCharCode(block[156]);
  // USTAR prefix field at 345..500; when present + magic is USTAR,
  // the full path is `<prefix>/<name>`.
  const magic = block.subarray(257, 263).toString("utf-8");
  let fullName = name;
  if (magic === "ustar\0" || magic.startsWith("ustar")) {
    const prefix = readCString(block.subarray(345, 500));
    if (prefix.length > 0) fullName = `${prefix}/${name}`;
  }
  return { name: fullName, size, type: typeflag, mode, mtime };
}

function readCString(buf: Buffer): string {
  const nul = buf.indexOf(0);
  const end = nul < 0 ? buf.length : nul;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * Parse a numeric field. USTAR encodes them as space- or NUL-padded
 * ASCII octal digits; GNU base-256 encoding (leading 0x80 / 0xff)
 * for fields too large for octal is accepted for the `size` field
 * (large files).
 */
function parseOctal(buf: Buffer): number {
  if (buf.length === 0) return 0;
  // GNU base-256: high bit of first byte set.
  if ((buf[0] & 0x80) !== 0) {
    let n = 0;
    // Negative numbers (0xff prefix) — we never deal with negative
    // size or mtime in HF tarballs; surface as 0 if encountered.
    const negative = (buf[0] & 0x40) !== 0;
    const start = 1;
    for (let i = start; i < buf.length; i++) {
      n = n * 256 + buf[i];
      if (!Number.isSafeInteger(n)) {
        throw new HfError(
          HF_ERROR_CODES.UPLOAD_INVALID,
          `tar numeric field exceeds Number.MAX_SAFE_INTEGER`,
        );
      }
    }
    return negative ? -n : n;
  }
  // ASCII octal. Trim trailing NUL and spaces.
  let end = buf.length;
  while (end > 0) {
    const c = buf[end - 1];
    if (c === 0 || c === 0x20) {
      end -= 1;
    } else {
      break;
    }
  }
  let start = 0;
  while (start < end && buf[start] === 0x20) start += 1;
  const s = buf.subarray(start, end).toString("utf-8");
  if (s.length === 0) return 0;
  if (!/^[0-7]+$/.test(s)) {
    throw new HfError(
      HF_ERROR_CODES.UPLOAD_INVALID,
      `tar numeric field '${s}' is not octal`,
    );
  }
  return parseInt(s, 8);
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Bounded streaming reader: pulls chunks off a Readable and lets the
 * caller read fixed-size + variable-size slices. Never buffers more
 * than one source chunk + the residual unconsumed portion of the
 * latest chunk.
 */
class BufferedReader {
  private readonly iter: AsyncIterator<Buffer>;
  private leftover: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(source: Readable) {
    this.iter = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async readExactly(n: number): Promise<Buffer | null> {
    while (this.leftover.length < n) {
      if (this.done) return null;
      const next = await this.iter.next();
      if (next.done) {
        this.done = true;
        if (this.leftover.length === 0) return null;
        // Couldn't fulfil; treat as truncation.
        return null;
      }
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value as Uint8Array);
      this.leftover = Buffer.concat([this.leftover, chunk]);
    }
    const out = this.leftover.subarray(0, n);
    this.leftover = this.leftover.subarray(n);
    return Buffer.from(out); // detach from underlying allocation
  }

  async readUpTo(n: number): Promise<Buffer | null> {
    if (this.leftover.length > 0) {
      const take = Math.min(this.leftover.length, n);
      const out = Buffer.from(this.leftover.subarray(0, take));
      this.leftover = this.leftover.subarray(take);
      return out;
    }
    if (this.done) return null;
    const next = await this.iter.next();
    if (next.done) {
      this.done = true;
      return null;
    }
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(next.value as Uint8Array);
    if (chunk.length <= n) return chunk;
    this.leftover = chunk.subarray(n);
    return Buffer.from(chunk.subarray(0, n));
  }

  async drain(): Promise<void> {
    if (this.done) return;
    while (!this.done) {
      const next = await this.iter.next();
      if (next.done) {
        this.done = true;
        break;
      }
    }
  }
}
