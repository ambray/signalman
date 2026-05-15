/**
 * WS6 M9 — runner binary distribution.
 *
 * Per design decision, the canonical store for runner binaries is the
 * `@signalman/registry` service: operators push pre-built binaries
 * with `registry push` and consume them in transports via
 * `https://<registry-host>/v1/blobs/sha256:<hash>` URLs. The
 * registry's signed-manifest path is the long-term plan for
 * version/os-arch selection; this milestone keeps the resolver
 * narrow ("operator gives an URL; we pass it through").
 *
 * Any HTTP(S) URL is accepted — registry URLs are a convention, not
 * a requirement. The optional `sha256` field lets the operator pin
 * to a specific blob; transports verify on download.
 */

/** Operator-supplied reference to the runner binary. */
export interface RunnerBinaryRef {
  /**
   * HTTP(S) URL where the binary can be downloaded. Typically a
   * `@signalman/registry` blob URL of the form
   * `https://<registry>/v1/blobs/sha256:<hash>`, but any URL the
   * remote host can `curl` works.
   */
  url: string;
  /**
   * Optional sha256 (hex). When set, transports verify after
   * download and refuse to install on mismatch. When using a
   * `@signalman/registry` blob URL, the hash is encoded in the
   * URL — `parseBlobUrlSha256(url)` extracts it for convenience.
   */
  sha256?: string;
  /**
   * Optional operator-named version string for audit-log clarity.
   * Defaults to `"unspecified"` when omitted.
   */
  version?: string;
}

/** Throw an operator-friendly error if the ref is malformed. */
export function validateBinaryRef(ref: RunnerBinaryRef): void {
  if (typeof ref.url !== "string" || ref.url.length === 0) {
    throw new Error("runner binary ref: url must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(ref.url);
  } catch {
    throw new Error(`runner binary ref: url is not a valid URL: ${ref.url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `runner binary ref: url must be http(s); got ${parsed.protocol}`,
    );
  }
  if (ref.sha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(ref.sha256)) {
      throw new Error(
        `runner binary ref: sha256 must be 64 lowercase hex chars (got ${ref.sha256.length})`,
      );
    }
  }
}

/**
 * Extract sha256 from a `@signalman/registry` blob URL of the form
 * `https://host/v1/blobs/sha256:<hash>`. Returns null when the URL
 * isn't a blob URL.
 *
 * Useful for transports that want to verify a download even when the
 * operator didn't explicitly pass `ref.sha256` — if the URL itself
 * encodes the hash, we have the value for free.
 */
export function parseBlobUrlSha256(url: string): string | null {
  try {
    const u = new URL(url);
    const m = /\/v1\/blobs\/sha256:([0-9a-f]{64})$/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Pick the effective sha256 verification target for a binary ref:
 *   1. explicit ref.sha256 wins
 *   2. otherwise, if the URL is a registry blob URL, extract from path
 *   3. otherwise null (no verification possible)
 */
export function resolveExpectedSha256(ref: RunnerBinaryRef): string | null {
  if (ref.sha256) return ref.sha256;
  return parseBlobUrlSha256(ref.url);
}
