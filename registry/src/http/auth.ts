/**
 * Federated bearer-token authentication for `@signalman/registry`.
 *
 * The v0.4.0 milestone uses the same `sk_<prefix>_<secret>` token
 * shape as `@signalman/host` (host/src/http/auth.ts). Tokens that
 * pass shape validation are accepted; a future RBAC commit lands
 * the real per-token row + scope check. The TODO is explicit:
 * v0.4.0 ships a registry deployed behind an authn proxy or with
 * a single bootstrap token; v0.4.x adds row-level RBAC.
 *
 * Until then this module exposes:
 *   - `parseBearerToken(header)`: rejects malformed tokens with a
 *     RegistryError(UNAUTHORIZED). Useful in tests + CLI.
 *   - `makeAuthenticator(opts)`: returns a Router-compatible
 *     `Authenticator` that pulls the token off the Authorization
 *     header and resolves an AuthContext. Loopback-bypass is
 *     opt-in via `allowLoopbackBypass: true` so the CLI can run
 *     against `localhost` without minting a token first.
 */

import { unauthorized } from "./errors.js";
import type { AuthContext, Authenticator } from "./router.js";

// Same shape as host/src/http/auth.ts:
//   sk_<8-Crockford-b32>_<26-Crockford-b32>
const TOKEN_RE = /^sk_([0-9A-HJKMNP-TV-Z]{4,16})_([0-9A-HJKMNP-TV-Z]{16,64})$/;

export interface ParsedToken {
  /** `sk_<prefix>` — stored verbatim, opaque outside the auth layer. */
  prefix: string;
  /** Secret half (hashed before storage in the future RBAC table). */
  secret: string;
}

/**
 * Parse a bearer header into a `ParsedToken`. Throws an
 * `unauthorized` HttpError on shape mismatch. Does NOT verify the
 * token against any storage; that's the authenticator's job.
 */
export function parseBearerToken(authHeader: string | undefined): ParsedToken {
  if (typeof authHeader !== "string" || !/^Bearer\s+/i.test(authHeader)) {
    throw unauthorized();
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const m = TOKEN_RE.exec(token);
  if (!m) {
    throw unauthorized("token does not match the federated sk_<prefix>_<secret> shape");
  }
  return {
    prefix: `sk_${m[1]}`,
    secret: m[2],
  };
}

export interface AuthOptions {
  /**
   * Accept loopback requests without an Authorization header.
   * False by default — operators must opt in explicitly. The CLI
   * `serve` command flips this on when bound to 127.0.0.1.
   */
  allowLoopbackBypass?: boolean;
  /**
   * Accept any shape-valid bearer token. v0.4.0 default until RBAC
   * lands. Operators who want real isolation deploy the registry
   * behind an authn proxy and set this to false plus supply
   * `validateToken` below.
   */
  acceptAnyValidShape?: boolean;
  /**
   * Optional token validator. When provided, the parsed token's
   * prefix is passed in; returning null denies the request.
   * Reserved for the v0.4.x RBAC commit; bootstrap servers leave it
   * undefined and rely on `acceptAnyValidShape`.
   */
  validateToken?: (token: ParsedToken) => Promise<AuthContext | null> | AuthContext | null;
}

export function makeAuthenticator(opts: AuthOptions = {}): Authenticator {
  const acceptAnyValidShape = opts.acceptAnyValidShape ?? true;
  const allowLoopback = opts.allowLoopbackBypass ?? false;
  const validateToken = opts.validateToken;

  return async (pre): Promise<AuthContext> => {
    const authHeader = pre.headers.authorization;
    if (typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)) {
      const token = parseBearerToken(authHeader);
      if (validateToken) {
        const ctx = await validateToken(token);
        if (!ctx) throw unauthorized("invalid bearer token");
        return ctx;
      }
      if (acceptAnyValidShape) {
        return { tokenPrefix: token.prefix, scopes: ["admin"] };
      }
      throw unauthorized();
    }

    if (allowLoopback && isLoopback(pre.remoteAddress)) {
      return { tokenPrefix: null, scopes: ["admin"] };
    }
    throw unauthorized();
  };
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr.startsWith("127.") ||
    addr === "::ffff:127.0.0.1"
  );
}
