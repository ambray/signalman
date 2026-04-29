/**
 * Template image fetch + verify pipeline (P9.5).
 *
 * Downloads a VHDX base image from an HTTPS URL, streams it to a temp
 * file, verifies the SHA-256 digest, and atomically renames into the
 * platform cache. Designed so a multi-GB download never exposes a
 * partial file with the final name — operators or the orchestrator
 * can re-invoke the function safely after a crash and get a clean
 * cache hit (or a clean re-download).
 *
 * # Locked design (do not re-litigate)
 *
 * - **HTTPS only.** http:// URLs are rejected hard; we don't silently
 *   upgrade. Plain HTTP for multi-GB system images is a TLS-stripping
 *   threat we're not willing to accept.
 * - **SHA-256 required.** No URL form without the digest. The threat
 *   model assumes the upstream host could be compromised; the digest
 *   is the second factor.
 * - **Atomic rename.** Stream -> `<sha>.vhdx.tmp` -> verify -> rename
 *   to `<sha>.vhdx`. A crash mid-stream leaves only `.tmp` (or
 *   nothing); the next run sees no `<sha>.vhdx` and re-downloads.
 * - **ISO-to-VHDX conversion is OUT of scope.** Operators provide
 *   pre-built VHDX. Document it in templates.ts and the eval YAML.
 *
 * # Cache layout
 *
 *   Windows:  %LOCALAPPDATA%\Signalman\templates\<name>\<sha-prefix>.vhdx
 *   macOS:    ~/Library/Caches/signalman/templates/<name>/<sha-prefix>.vhdx
 *   Linux:    ~/.cache/signalman/templates/<name>/<sha-prefix>.vhdx
 *
 * The filename is the SHA-256 prefix (first 16 hex chars) so multiple
 * versions of the same template can coexist. The full digest is
 * always re-verified on cache hit — a prefix collision can't fake a
 * cached image.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ── Types ──────────────────────────────────────────────────────────

/** Inputs to {@link fetchTemplateImage}. */
export interface FetchTemplateOptions {
  /** Logical template name (becomes a cache subdirectory). */
  templateName: string;
  /** HTTPS URL of the VHDX. http:// is rejected. */
  url: string;
  /** Lowercase 64-hex SHA-256 of the expected file. */
  expectedSha256: string;
  /** Override cache root. Defaults to {@link defaultCacheDir}. */
  cacheDir?: string;
  /** Re-download even when the cache is warm. Default false. */
  force?: boolean;
  /** Progress callback (0..1). Default: ~5% increments to stderr. */
  onProgress?: (fraction: number, bytesDownloaded: number) => void;
  /**
   * Injectable fetch implementation for tests. Defaults to globalThis.fetch
   * (Node 18+). Tests pass a vi.fn that returns controlled streams.
   */
  fetchImpl?: typeof fetch;
  /**
   * Hard cap on bytes to download. Defaults to {@link DEFAULT_MAX_BYTES}
   * (50 GiB). When the stream exceeds this, the partial file is shredded
   * and the call throws. Defends against:
   *   - operator paste-error pointing at a multi-TB URL,
   *   - upstream serving a malicious oversize file under a hash that
   *     happens to match (vanishingly unlikely but cheap to defend),
   *   - Content-Length spoofing followed by an unbounded body.
   *
   * Most VHDX templates are 8–25 GiB. 50 GiB is generous enough to
   * cover Windows Server with full updates while still catching
   * obvious abuse.
   *
   * Also rejected pre-flight: a Content-Length header that ALREADY
   * exceeds the cap, before we open a write stream.
   */
  maxBytes?: number;
}

/**
 * Default disk-fill cap for VHDX downloads. Tunable per-call via
 * {@link FetchTemplateOptions.maxBytes}. Sized to fit Windows Server
 * with full eval + service-pack content (~25 GiB) plus 2x headroom.
 */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GiB

/** Outputs of {@link fetchTemplateImage}. */
export interface FetchTemplateResult {
  /** Absolute path of the cached + verified VHDX. */
  vhdxPath: string;
  /** True if the cache was warm and no download happened. */
  cached: boolean;
  /** Size of the on-disk file in bytes. */
  sizeBytes: number;
  /** Wall-clock duration in ms (download + verify, or just verify on hit). */
  durationMs: number;
}

// ── Validators (reused by templates.ts) ───────────────────────────

/** A 64-character lowercase hex string. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Normalize a candidate SHA-256 (lowercase, trim) and validate. */
export function normalizeSha256(candidate: string): string {
  const norm = candidate.trim().toLowerCase();
  if (!SHA256_RE.test(norm)) {
    throw new Error(
      `Invalid SHA-256: expected 64 lowercase hex chars, got "${candidate}"`,
    );
  }
  return norm;
}

/** Throw if the URL is not https://. Returns the URL unchanged on success. */
export function requireHttpsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(`Invalid URL: "${url}" — ${(e as Error).message}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Refusing non-HTTPS template URL: "${url}" (protocol: ${parsed.protocol}). ` +
        `Plain HTTP is not allowed for VM base images — TLS-stripping risk.`,
    );
  }
  return url;
}

// ── Cache directory ────────────────────────────────────────────────

/**
 * Platform-appropriate cache root for downloaded VHDX templates.
 *
 *   Windows:  %LOCALAPPDATA%\Signalman\templates
 *   macOS:    ~/Library/Caches/signalman/templates
 *   Linux:    ~/.cache/signalman/templates
 */
export function defaultCacheDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local && local.length > 0) {
      return path.join(local, "Signalman", "templates");
    }
    // Fallback: %USERPROFILE%\AppData\Local\Signalman\templates
    return path.join(os.homedir(), "AppData", "Local", "Signalman", "templates");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "signalman", "templates");
  }
  // Linux + everything else: XDG_CACHE_HOME or ~/.cache
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "signalman", "templates");
}

/** Resolve the cache file path for a (templateName, sha256) pair. */
export function cachePathFor(
  templateName: string,
  sha256: string,
  cacheDir: string = defaultCacheDir(),
): string {
  const norm = normalizeSha256(sha256);
  // Use a 16-char prefix for the filename — keeps paths short while
  // staying collision-resistant in practice. The full SHA is re-verified
  // on every cache hit, so a prefix collision can't be exploited.
  const prefix = norm.slice(0, 16);
  return path.join(cacheDir, templateName, `${prefix}.vhdx`);
}

// ── SHA-256 helper ────────────────────────────────────────────────

/**
 * Compute the SHA-256 of a file by streaming it in 1 MiB chunks.
 * Used by the cache-hit path to re-verify integrity before trusting
 * an existing on-disk file. Incremental — never loads the whole file.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

// ── Default progress reporter ─────────────────────────────────────

/**
 * Default progress callback factory — emits one stderr line every ~5%
 * so multi-GB downloads don't appear hung. Returns a no-op when stderr
 * isn't a TTY *and* SIGNALMAN_QUIET=1 (CI by default still gets the
 * lines, which is desirable for log post-mortem).
 */
function defaultOnProgress(
  templateName: string,
  totalBytes: number | undefined,
): (f: number, bytes: number) => void {
  if (process.env.SIGNALMAN_QUIET === "1") return () => undefined;
  let lastPct = -5;
  return (fraction, bytes) => {
    const pct = Math.floor(fraction * 100);
    if (pct >= lastPct + 5 || fraction >= 1) {
      lastPct = pct;
      const sizeMB = (bytes / (1024 * 1024)).toFixed(1);
      const totalStr =
        totalBytes && totalBytes > 0
          ? ` / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
          : "";

      process.stderr.write(
        `[fetch-template ${templateName}] ${pct}% (${sizeMB} MB${totalStr})\n`,
      );
    }
  };
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Ensure a verified VHDX is available in the local cache, downloading
 * if necessary, and return its absolute path.
 *
 * Idempotent. On cache hit, re-verifies the SHA-256 by streaming the
 * existing file — a corrupted cache file (truncated, modified) is
 * treated as a miss, deleted, and re-downloaded.
 *
 * On download failure (network error, mid-stream abort, SHA mismatch),
 * the `.tmp` file is deleted and the original error rethrown. The
 * `<sha>.vhdx` final name never appears unless the SHA verification
 * passed — that's the atomic-rename invariant the rest of the system
 * relies on.
 *
 * @throws Error when URL is not https://, when expectedSha256 is malformed,
 *   when the network request fails, or when the downloaded SHA differs
 *   from the expected SHA.
 */
export async function fetchTemplateImage(
  opts: FetchTemplateOptions,
): Promise<FetchTemplateResult> {
  const start = Date.now();

  // ── Validate inputs hard before touching the network or disk ──
  requireHttpsUrl(opts.url);
  const expectedSha = normalizeSha256(opts.expectedSha256);

  const cacheRoot = opts.cacheDir ?? defaultCacheDir();
  const finalPath = cachePathFor(opts.templateName, expectedSha, cacheRoot);
  const tmpPath = `${finalPath}.tmp`;
  const dir = path.dirname(finalPath);

  // ── Cache hit path ──
  if (!opts.force && fs.existsSync(finalPath)) {
    // Re-verify before trusting the cache: a partial-file or tampered
    // cache entry is a real failure mode (disk corruption, manual
    // edit, prior crash that bypassed the rename). We pay the read
    // cost rather than ship a wrong VM.
    try {
      const actual = await sha256File(finalPath);
      if (actual === expectedSha) {
        const stat = fs.statSync(finalPath);
        return {
          vhdxPath: finalPath,
          cached: true,
          sizeBytes: stat.size,
          durationMs: Date.now() - start,
        };
      }
      // SHA mismatch on cache: evict and fall through to re-download.
      // Surface this as a stderr line — operators want to know their
      // cache was corrupt.

      process.stderr.write(
        `[fetch-template ${opts.templateName}] cache file ${finalPath} ` +
          `failed SHA verification (expected ${expectedSha.slice(0, 12)}…, ` +
          `got ${actual.slice(0, 12)}…) — re-downloading\n`,
      );
      fs.unlinkSync(finalPath);
    } catch (e) {
      // Read failure on cache file — evict and fall through.
      try {
        fs.unlinkSync(finalPath);
      } catch {
        /* swallow */
      }
      if (process.env.SIGNALMAN_DEBUG === "1") {

        process.stderr.write(
          `[fetch-template] cache read failed: ${(e as Error).message}\n`,
        );
      }
    }
  }

  // ── Download path ──
  fs.mkdirSync(dir, { recursive: true });

  // Best-effort: clean any stale .tmp from a prior crashed run before
  // we open the new write stream. Without this, repeated crashes leak
  // .tmp files indefinitely.
  if (fs.existsSync(tmpPath)) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* swallow */
    }
  }

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error(
      "fetch is not available — Signalman requires Node 18+ for the built-in fetch API",
    );
  }

  let response: Response;
  try {
    response = await fetchFn(opts.url);
  } catch (e) {
    throw new Error(
      `Failed to GET ${opts.url}: ${(e as Error).message}. ` +
        `Check network, proxy, and that the upstream host is reachable over HTTPS.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Template URL ${opts.url} returned HTTP ${response.status} ${response.statusText}. ` +
        `Verify the URL is correct and that the resource is publicly downloadable.`,
    );
  }

  if (!response.body) {
    throw new Error(
      `Template URL ${opts.url} returned no response body (status ${response.status})`,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // Pre-flight: refuse before opening a write stream when Content-Length
  // is already over the cap. Saves us from creating an empty .tmp that
  // we'll have to clean up on the very next chunk.
  if (totalBytes !== undefined && totalBytes > maxBytes) {
    throw new Error(
      `Refusing to download ${opts.url}: Content-Length ${totalBytes} bytes ` +
        `exceeds maxBytes cap ${maxBytes}. If this template legitimately ` +
        `needs more, pass maxBytes explicitly to fetchTemplateImage().`,
    );
  }
  const reportProgress =
    opts.onProgress ?? defaultOnProgress(opts.templateName, totalBytes);

  const hash = crypto.createHash("sha256");
  let bytesWritten = 0;

  // Stream body -> tmp file, hashing as we go. fetch's body is a Web
  // ReadableStream; Readable.fromWeb adapts it to a Node stream so
  // pipeline() can handle backpressure for us.
  const nodeStream = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );

  const writeStream = fs.createWriteStream(tmpPath);

  // Simpler than juggling a Transform: async-iterate the body, hash
  // and count each chunk inline, then yield to the pipeline that
  // pushes into the file write stream. pipeline() handles
  // backpressure for us.
  try {
    await pipeline(
      (async function* () {
        for await (const chunk of nodeStream) {
          const buf = chunk as Buffer;
          hash.update(buf);
          bytesWritten += buf.length;
          // Disk-fill defense: if a hostile or misconfigured server
          // serves more bytes than the cap, abort hard. The pipeline()
          // catch path below shreds the partial file. Throwing inside
          // the generator surfaces as a rejected pipeline.
          if (bytesWritten > maxBytes) {
            throw new Error(
              `Download exceeded maxBytes cap ${maxBytes} after ` +
                `${bytesWritten} bytes — aborted to avoid disk-fill.`,
            );
          }
          if (totalBytes && totalBytes > 0) {
            reportProgress(Math.min(bytesWritten / totalBytes, 1), bytesWritten);
          } else {
            // Unknown total — pass fraction = 0 so the default
            // reporter still emits periodic byte counts.
            reportProgress(0, bytesWritten);
          }
          yield buf;
        }
      })(),
      writeStream,
    );
  } catch (e) {
    // Mid-stream failure: delete the tmp file (no partial garbage
    // left behind) and rethrow.
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* swallow */
    }
    throw new Error(
      `Download of ${opts.url} failed mid-stream after ${bytesWritten} bytes: ${(e as Error).message}`,
    );
  }

  const actualSha = hash.digest("hex");
  if (actualSha !== expectedSha) {
    // Delete partial file before throwing — we never want a wrong-SHA
    // file to linger on disk under any name.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* swallow */
    }
    throw new Error(
      `SHA-256 mismatch for ${opts.templateName}: expected ${expectedSha}, ` +
        `got ${actualSha}. The downloaded file has been deleted. ` +
        `Possible causes: (1) the template manifest's SHA is wrong, ` +
        `(2) the upstream file changed, (3) man-in-the-middle tampering. ` +
        `Re-check the SHA from a trusted source before retrying.`,
    );
  }

  // ── Atomic rename ──
  // fs.renameSync is atomic on the same filesystem on Windows + POSIX.
  // The .vhdx final name only ever appears after the SHA verified.
  fs.renameSync(tmpPath, finalPath);

  return {
    vhdxPath: finalPath,
    cached: false,
    sizeBytes: bytesWritten,
    durationMs: Date.now() - start,
  };
}
