/**
 * HMAC-SHA256 signing for the generic webhook driver (v0.4.0-2).
 *
 * Receivers verify by recomputing HMAC-SHA256 over the raw request
 * body using the shared secret and comparing against the hex-encoded
 * value in `X-Signalman-Signature: sha256=<hex>`.
 *
 * Time-constant comparison is exposed for the same audience (matches
 * the verifier's responsibility).
 */

import * as crypto from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

/** Compute the canonical `sha256=<hex>` signature for `body` with `secret`. */
export function signBody(secret: string, body: string | Buffer): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  return `${SIGNATURE_PREFIX}${hmac.digest("hex")}`;
}

/**
 * Time-constant verify. Returns true iff `signature` was produced by
 * `signBody(secret, body)`. Tolerates both the `sha256=<hex>` form and
 * a bare `<hex>` to give upstream consumers some flexibility.
 */
export function verifySignature(
  secret: string,
  body: string | Buffer,
  signature: string,
): boolean {
  const expected = signBody(secret, body);
  const actual = signature.startsWith(SIGNATURE_PREFIX)
    ? signature
    : `${SIGNATURE_PREFIX}${signature}`;
  // Node's timingSafeEqual requires equal-length buffers; if the
  // lengths differ we fail closed without leaking the comparison
  // outcome to the wall clock.
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(actual, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const SIGNALMAN_SIGNATURE_HEADER = "x-signalman-signature";
