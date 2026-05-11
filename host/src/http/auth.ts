/**
 * Authentication for the HTTP control plane.
 *
 * Two paths into a request:
 *   1. `Authorization: Bearer sk_<prefix>_<secret>` — verified against
 *      the api_key table; the auth context carries that key's org.
 *   2. Loopback bypass — requests from `127.0.0.1` / `::1` with no
 *      bearer token resolve to the default org. Keeps local-mode
 *      CLI workflows working without minting a key first.
 *
 * Token format: `sk_<8-Crockford-b32>_<26-Crockford-b32>`
 *   * `sk_<prefix>` is stored verbatim and is enough to look up the
 *     row.
 *   * The secret half (26 b32 chars ≈ 130 bits of entropy) is hashed
 *     with SHA-256 and stored as hex. We never store the plaintext
 *     token, so `api-key create` is the only opportunity to display
 *     it to the operator.
 *
 * Verification uses `crypto.timingSafeEqual` to defend against timing
 * attacks on the hash compare.
 */

import * as crypto from "node:crypto";
import type { ControlPlane } from "../control-plane/index.js";
import type { ApiKey } from "../control-plane/types.js";
import { unauthorized } from "./errors.js";
import type { AuthContext, Authenticator, PreAuthContext } from "./router.js";

export interface AuthOptions {
  controlPlane: ControlPlane;
  /**
   * Force every request to carry a bearer token, even loopback. Use
   * in tests that need to exercise the auth path without binding the
   * server to a non-loopback interface.
   */
  disableLoopbackBypass?: boolean;
}

const TOKEN_RE = /^sk_([0-9A-HJKMNP-TV-Z]+)_([0-9A-HJKMNP-TV-Z]+)$/;

export function makeAuthenticator(opts: AuthOptions): Authenticator {
  return async (pre: PreAuthContext): Promise<AuthContext> => {
    const authHeader = pre.headers.authorization;
    if (typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)) {
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      const apiKey = await verifyToken(opts.controlPlane, token);
      if (!apiKey) throw unauthorized("invalid bearer token");
      return { orgId: apiKey.orgId, apiKeyId: apiKey.id };
    }

    // No bearer token — loopback bypass for local mode.
    if (!opts.disableLoopbackBypass && isLoopback(pre.remoteAddress)) {
      const { defaultOrg } = await opts.controlPlane.init();
      return { orgId: defaultOrg.id, apiKeyId: null };
    }

    throw unauthorized();
  };
}

async function verifyToken(
  cp: ControlPlane,
  token: string,
): Promise<ApiKey | null> {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const prefix = `sk_${m[1]}`;
  const secret = m[2];
  const apiKey = await cp.apiKeys.getByPrefix(prefix);
  if (!apiKey) return null;
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
    return null;
  }
  const computed = crypto.createHash("sha256").update(secret).digest("hex");
  const a = Buffer.from(computed);
  const b = Buffer.from(apiKey.hash);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return apiKey;
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  // node:http normalizes ipv4 loopback; ipv6 loopback can arrive as
  // ::1 or as the mapped ::ffff:127.0.0.1.
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr.startsWith("127.") ||
    addr === "::ffff:127.0.0.1"
  );
}

// ── Key generation ──────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX_LEN = 8;
const SECRET_LEN = 26;

export interface GeneratedApiKey {
  /** Display this to the operator once; never recoverable after. */
  token: string;
  /** Stored on the api_key row for fast lookup. */
  prefix: string;
  /** sha256 hex of the secret half. */
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefixChars = randomB32(PREFIX_LEN);
  const secretChars = randomB32(SECRET_LEN);
  const prefix = `sk_${prefixChars}`;
  const token = `${prefix}_${secretChars}`;
  const hash = crypto.createHash("sha256").update(secretChars).digest("hex");
  return { token, prefix, hash };
}

function randomB32(n: number): string {
  // Pull more bytes than we strictly need so we can reject-sample
  // without bias; in practice n*2 is plenty.
  const bytes = crypto.randomBytes(n * 2);
  let out = "";
  for (let i = 0; out.length < n && i < bytes.length; i++) {
    const v = bytes[i];
    // Mask to 5 bits (32 alphabet). Reject the wrap-around bias by
    // skipping bytes >= 32 * floor(256 / 32) = 256, i.e. never.
    out += CROCKFORD[v & 0x1f];
  }
  return out;
}
