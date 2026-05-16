/**
 * Compact JWS (Ed25519) — the token format the OCI bearer-challenge
 * flow issues and the /v2/* authenticator verifies.
 *
 * Shape:
 *   <base64url(header)>.<base64url(payload)>.<base64url(signature)>
 *
 * Header (`EdDSA` per RFC 8037 §3.1):
 *   { "alg": "EdDSA", "typ": "JWT" }
 *
 * Payload (registered claims per RFC 7519 §4.1 + the spec-mandated
 * "scope" claim from Docker Distribution's token-auth shape):
 *   {
 *     "iss":   "signalman-registry",
 *     "sub":   "sk_<prefix>",          // identity of the operator
 *     "aud":   "signalman-registry",
 *     "scope": "repository:team/svc:pull,push",
 *     "iat":   <unix-seconds>,
 *     "exp":   <unix-seconds>           // iat + ttlSeconds
 *   }
 *
 * Signed with the registry's Ed25519 private key. The verifier uses
 * the matching public key (derived from the private key if only the
 * private was supplied at boot).
 *
 * This module is intentionally small — no external JWT library. The
 * existing Ed25519 surface (`registry/src/signing.ts`) carries the
 * signing primitive; we just compose the base64url framing here.
 */

import * as crypto from "node:crypto";

export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string;
  scope: string;
  iat: number;
  exp: number;
}

export interface MintJwtOptions {
  privateKeyPem: string;
  subject: string;
  scope: string;
  /** Token lifetime in seconds. Default 3600 (1 hour) — Docker Distribution's default. */
  ttlSeconds?: number;
  /** Audience claim. Default `signalman-registry`. */
  audience?: string;
  /** Issuer claim. Default `signalman-registry`. */
  issuer?: string;
  /** Deterministic clock — tests pass a frozen `now`. */
  now?: () => Date;
}

export interface MintedJwt {
  token: string;
  /** Claims that ended up on the token (useful for callers logging). */
  claims: JwtClaims;
  expiresIn: number;
  issuedAt: string;
}

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_ISSUER = "signalman-registry";
const DEFAULT_AUDIENCE = "signalman-registry";

/**
 * Mint a JWT signed with the registry's Ed25519 private key.
 * Returns the compact JWS string + the claim set the caller can
 * log for forensic purposes.
 */
export function mintJwt(opts: MintJwtOptions): MintedJwt {
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const issuer = opts.issuer ?? DEFAULT_ISSUER;
  const audience = opts.audience ?? DEFAULT_AUDIENCE;

  const iatDate = now();
  const iat = Math.floor(iatDate.getTime() / 1000);
  const exp = iat + ttl;

  const header = { alg: "EdDSA", typ: "JWT" };
  const payload: JwtClaims = {
    iss: issuer,
    sub: opts.subject,
    aud: audience,
    scope: opts.scope,
    iat,
    exp,
  };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), "utf-8"));
  const payloadB64 = base64UrlEncode(
    Buffer.from(JSON.stringify(payload), "utf-8"),
  );
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = crypto.createPrivateKey(opts.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `JWT signing key must be Ed25519; got ${key.asymmetricKeyType}`,
    );
  }
  const signature = crypto.sign(null, Buffer.from(signingInput, "utf-8"), key);
  const signatureB64 = base64UrlEncode(signature);
  const token = `${signingInput}.${signatureB64}`;
  return {
    token,
    claims: payload,
    expiresIn: ttl,
    issuedAt: iatDate.toISOString(),
  };
}

export interface VerifyJwtOptions {
  token: string;
  publicKeyPem: string;
  /** Audience the verifier expects. Default `signalman-registry`. */
  audience?: string;
  /** Deterministic clock for tests. */
  now?: () => Date;
  /** Clock-skew tolerance in seconds. Default 60. */
  clockSkewSeconds?: number;
}

export interface VerifiedJwt {
  claims: JwtClaims;
}

export class JwtError extends Error {
  constructor(
    readonly reason:
      | "malformed"
      | "header_invalid"
      | "payload_invalid"
      | "alg_unsupported"
      | "signature_invalid"
      | "expired"
      | "not_yet_valid"
      | "wrong_audience"
      | "wrong_issuer",
    message: string,
  ) {
    super(message);
    this.name = "JwtError";
  }
}

/**
 * Verify a JWT against the registry's Ed25519 public key. Throws
 * `JwtError` on any failure (caller maps to 401 UNAUTHORIZED + the
 * OCI error envelope).
 */
export function verifyJwt(opts: VerifyJwtOptions): VerifiedJwt {
  const now = opts.now ?? (() => new Date());
  const expectedAudience = opts.audience ?? DEFAULT_AUDIENCE;
  const skew = opts.clockSkewSeconds ?? 60;

  const parts = opts.token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("malformed", `JWT must have 3 dot-separated parts`);
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf-8"));
  } catch {
    throw new JwtError("header_invalid", "JWT header is not valid JSON");
  }
  if (header.typ !== "JWT") {
    throw new JwtError("header_invalid", `JWT typ must be 'JWT'; got ${String(header.typ)}`);
  }
  if (header.alg !== "EdDSA") {
    throw new JwtError(
      "alg_unsupported",
      `JWT alg must be 'EdDSA'; got ${String(header.alg)}`,
    );
  }

  const key = crypto.createPublicKey(opts.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `JWT verification key must be Ed25519; got ${key.asymmetricKeyType}`,
    );
  }
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf-8");
  const signature = base64UrlDecode(signatureB64);
  const ok = crypto.verify(null, signingInput, key, signature);
  if (!ok) {
    throw new JwtError("signature_invalid", "JWT signature did not verify");
  }

  let payload: Partial<JwtClaims>;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8")) as Partial<JwtClaims>;
  } catch {
    throw new JwtError("payload_invalid", "JWT payload is not valid JSON");
  }
  if (
    typeof payload.iss !== "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.scope !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new JwtError("payload_invalid", "JWT payload missing required claims");
  }
  if (payload.aud !== expectedAudience) {
    throw new JwtError(
      "wrong_audience",
      `JWT audience ${payload.aud} != expected ${expectedAudience}`,
    );
  }
  if (payload.iss !== DEFAULT_ISSUER) {
    throw new JwtError(
      "wrong_issuer",
      `JWT issuer ${payload.iss} != expected ${DEFAULT_ISSUER}`,
    );
  }
  const nowSeconds = Math.floor(now().getTime() / 1000);
  if (payload.exp + skew < nowSeconds) {
    throw new JwtError(
      "expired",
      `JWT expired at ${payload.exp}; now is ${nowSeconds}`,
    );
  }
  if (payload.iat - skew > nowSeconds) {
    throw new JwtError(
      "not_yet_valid",
      `JWT iat ${payload.iat} is ahead of now ${nowSeconds}`,
    );
  }
  return { claims: payload as JwtClaims };
}

/**
 * Recognize a Bearer header value as having a JWT shape (three dot-
 * separated base64url chunks). Used by the authenticator to choose
 * between the sk_<prefix>_<secret> path and the JWT path. Returns
 * false for sk_-shaped tokens (which use a different separator and
 * different alphabet).
 */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Derive the SubjectPublicKeyInfo PEM for the supplied Ed25519
 * private-key PEM. Lets the operator supply only the private key at
 * boot — the verifier derives the public key on first use.
 */
export function publicKeyPemFromPrivate(privateKeyPem: string): string {
  const priv = crypto.createPrivateKey(privateKeyPem);
  if (priv.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `cannot derive public key — input is not Ed25519 (${priv.asymmetricKeyType})`,
    );
  }
  const pub = crypto.createPublicKey(priv);
  return pub.export({ type: "spki", format: "pem" }).toString();
}

// ── base64url helpers ─────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  // Reverse the encoder. Pad with '=' to multiple of 4.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padding), "base64");
}
