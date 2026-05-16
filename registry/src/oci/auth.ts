/**
 * OCI bearer-challenge handshake (workstream Q5 outcome).
 *
 * Two routes:
 *
 *   GET /v2/
 *     Spec-mandated "support check" endpoint. Returns 200 + an empty
 *     JSON body when the request carries a valid Bearer token (either
 *     sk_<prefix>_<secret> for direct callers or an Ed25519 JWT for
 *     Docker CLI's challenge-then-retry flow). Returns 401 with a
 *     `WWW-Authenticate: Bearer realm=<token-endpoint>, service=<svc>`
 *     header when not authenticated — Docker CLI hard-codes the
 *     expectation that registries respond exactly this shape.
 *
 *   GET /oci/token?service=<svc>&scope=<scope>
 *     The challenge realm. Accepts `Authorization: Basic <base64>`
 *     where the decoded username is the full `sk_<prefix>_<secret>`
 *     token the operator already holds. Issues an Ed25519-signed JWT
 *     bound to that operator + scope, valid for one hour (matches
 *     Docker Distribution's default). Returns 401 when Basic credentials
 *     are missing or malformed.
 *
 * `/v2/` and `/oci/token` are wired as router-public paths in
 * `mountOciAuthRoutes` — the global authenticator skips them so the
 * handlers can write their own auth-state responses.
 */

import type { ServerResponse } from "node:http";
import type { Router } from "../http/router.js";
import { parseBearerToken } from "../http/auth.js";
import { OciError } from "./errors.js";
import { OCI_ERROR_CODES } from "./types.js";
import { mintJwt, verifyJwt } from "./jwt.js";
import { writeOciError, asOciError } from "./http.js";

export interface MountOciAuthOptions {
  /**
   * Ed25519 PEM private key used to sign JWTs minted by /oci/token.
   * When absent the token endpoint returns 503 + the challenge endpoint
   * omits the WWW-Authenticate header (the registry falls back to
   * the direct sk_<prefix>_<secret> bearer flow only).
   */
  privateKeyPem?: string;
  /**
   * Matching public key for verifying the issued JWTs on subsequent
   * /v2/* requests. The authenticator in `registry/src/http/auth.ts`
   * is supplied this same key via AppOptions.
   */
  publicKeyPem?: string;
  /** Externally-resolvable base URL for the registry. */
  publicBaseUrl?: string;
  /** JWT lifetime, seconds. Default 3600. */
  ttlSeconds?: number;
  /** Service-claim value (matches Docker Distribution's default). */
  serviceName?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}

const DEFAULT_SERVICE = "signalman-registry";

export function mountOciAuthRoutes(
  router: Router,
  opts: MountOciAuthOptions,
): void {
  const baseUrl = opts.publicBaseUrl ?? "";
  const service = opts.serviceName ?? DEFAULT_SERVICE;
  const ttlSeconds = opts.ttlSeconds ?? 3600;
  const now = opts.now ?? (() => new Date());
  const privateKeyPem = opts.privateKeyPem;
  const publicKeyPem = opts.publicKeyPem;
  const tokenEndpoint = `${baseUrl}/oci/token`;

  // ── GET /v2/ ────────────────────────────────────────────────────
  // Support-check + challenge issuer. The router's `publicPaths` list
  // (set in `buildApp`) routes around the global authenticator here
  // so this handler owns the auth-state response.
  router.get(
    "/v2/",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const authHeader = headerString(ctx.headers.authorization);
        if (authHeader && /^Bearer\s+/i.test(authHeader)) {
          // Try sk_<prefix>_<secret> first, then JWT.
          try {
            parseBearerToken(authHeader);
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader("content-length", "2");
            res.end("{}");
            return;
          } catch {
            // Fall through to JWT path.
          }
          if (publicKeyPem) {
            const raw = authHeader.replace(/^Bearer\s+/i, "").trim();
            try {
              verifyJwt({ token: raw, publicKeyPem, now });
              res.statusCode = 200;
              res.setHeader("content-type", "application/json; charset=utf-8");
              res.setHeader("content-length", "2");
              res.end("{}");
              return;
            } catch {
              // Fall through to challenge response.
            }
          }
        }
        // Auth missing or invalid — emit the challenge.
        if (privateKeyPem) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer realm="${tokenEndpoint}",service="${service}"`,
          );
        }
        writeOciError(
          res,
          new OciError(
            OCI_ERROR_CODES.UNAUTHORIZED,
            "authentication required",
          ),
        );
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── GET /oci/token ──────────────────────────────────────────────
  // Docker CLI's expected token endpoint shape (matches the
  // distribution-token-auth spec):
  //   GET /oci/token?service=<svc>&scope=<scope>
  //   Authorization: Basic <base64(username:password)>
  // The username carries the full sk_<prefix>_<secret> bearer; we
  // ignore the password half (Docker CLI sends an empty value or
  // the same secret again — clients vary).
  router.get(
    "/oci/token",
    async (ctx) => {
      const res = ctx.res!;
      try {
        if (!privateKeyPem) {
          throw new OciError(
            OCI_ERROR_CODES.UNSUPPORTED,
            "token issuance is not configured on this registry",
          );
        }
        const requestedService = headerString(ctx.query.service);
        if (requestedService !== undefined && requestedService !== service) {
          throw new OciError(
            OCI_ERROR_CODES.DENIED,
            `service ${requestedService} not served; expected ${service}`,
          );
        }
        const scope = headerString(ctx.query.scope) ?? "";
        const authHeader = headerString(ctx.headers.authorization);
        if (!authHeader || !/^Basic\s+/i.test(authHeader)) {
          throw new OciError(
            OCI_ERROR_CODES.UNAUTHORIZED,
            "Basic Authentication required",
          );
        }
        const decoded = decodeBasic(authHeader);
        if (!decoded) {
          throw new OciError(
            OCI_ERROR_CODES.UNAUTHORIZED,
            "Basic Authentication credentials malformed",
          );
        }
        // The username MUST be a sk_<prefix>_<secret> bearer that
        // the existing operator-side flow already knows about. We
        // reuse `parseBearerToken` against the synthesized `Bearer <username>`
        // value so the shape check + 401 mapping stay consistent.
        let parsed: ReturnType<typeof parseBearerToken>;
        try {
          parsed = parseBearerToken(`Bearer ${decoded.username}`);
        } catch {
          throw new OciError(
            OCI_ERROR_CODES.UNAUTHORIZED,
            "Basic Authentication username is not a recognised registry bearer",
          );
        }
        const minted = mintJwt({
          privateKeyPem,
          subject: parsed.prefix,
          scope,
          ttlSeconds,
          audience: service,
          issuer: service,
          now,
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        const body = JSON.stringify({
          token: minted.token,
          access_token: minted.token,
          expires_in: minted.expiresIn,
          issued_at: minted.issuedAt,
        });
        res.setHeader("content-length", Buffer.byteLength(body).toString());
        res.end(body);
      } catch (err) {
        const oci = asOciError(err);
        if (oci.code === OCI_ERROR_CODES.UNAUTHORIZED) {
          res.setHeader(
            "WWW-Authenticate",
            `Basic realm="${service}"`,
          );
        }
        writeOciError(res, oci);
      }
    },
    { rawResponse: true },
  );
}

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

interface DecodedBasic {
  username: string;
  password: string;
}

function decodeBasic(header: string): DecodedBasic | null {
  const b64 = header.replace(/^Basic\s+/i, "").trim();
  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return null;
  }
  const colonIndex = decoded.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    username: decoded.slice(0, colonIndex),
    password: decoded.slice(colonIndex + 1),
  };
}

// `ServerResponse` is referenced in the handler-body typing; keep
// the import-side type live by re-exporting nothing.
export type _ServerResponse = ServerResponse;
