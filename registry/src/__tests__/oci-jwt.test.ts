// WS10 M4 — Ed25519 JWT mint + verify.

import * as nodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeypair } from "../signing.js";
import {
  JwtError,
  looksLikeJwt,
  mintJwt,
  publicKeyPemFromPrivate,
  verifyJwt,
} from "../oci/index.js";

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

describe("mintJwt + verifyJwt", () => {
  const { privateKeyPem, publicKeyPem } = generateKeypair();

  it("round-trips a fresh token", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "repository:team/svc:pull",
      now: () => FIXED_NOW,
    });
    expect(minted.token.split(".")).toHaveLength(3);
    expect(minted.claims.sub).toBe("sk_TEST");
    expect(minted.claims.scope).toBe("repository:team/svc:pull");
    expect(minted.expiresIn).toBe(3600);
    const verified = verifyJwt({
      token: minted.token,
      publicKeyPem,
      now: () => FIXED_NOW,
    });
    expect(verified.claims.sub).toBe("sk_TEST");
  });

  it("uses custom TTL when supplied", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "",
      ttlSeconds: 60,
      now: () => FIXED_NOW,
    });
    expect(minted.expiresIn).toBe(60);
    expect(minted.claims.exp - minted.claims.iat).toBe(60);
  });

  it("rejects an expired token", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "",
      ttlSeconds: 60,
      now: () => FIXED_NOW,
    });
    const later = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
    let caught: unknown;
    try {
      verifyJwt({
        token: minted.token,
        publicKeyPem,
        now: () => later,
        clockSkewSeconds: 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("expired");
  });

  it("rejects a not-yet-valid token (iat in the future)", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "",
      now: () => new Date(FIXED_NOW.getTime() + 60 * 60 * 1000),
    });
    let caught: unknown;
    try {
      verifyJwt({
        token: minted.token,
        publicKeyPem,
        now: () => FIXED_NOW,
        clockSkewSeconds: 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("not_yet_valid");
  });

  it("rejects a tampered signature", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "",
      now: () => FIXED_NOW,
    });
    const parts = minted.token.split(".");
    // Flip a bit in the payload — signature won't verify.
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}a.${parts[2]}`;
    let caught: unknown;
    try {
      verifyJwt({
        token: tampered,
        publicKeyPem,
        now: () => FIXED_NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("signature_invalid");
  });

  it("rejects a token signed by a different key", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "",
      now: () => FIXED_NOW,
    });
    const other = generateKeypair();
    let caught: unknown;
    try {
      verifyJwt({
        token: minted.token,
        publicKeyPem: other.publicKeyPem,
        now: () => FIXED_NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("signature_invalid");
  });

  it("rejects a malformed token (wrong number of parts)", () => {
    expect(() =>
      verifyJwt({ token: "not.a.valid.jwt", publicKeyPem }),
    ).toThrowError(JwtError);
    expect(() =>
      verifyJwt({ token: "only-one-part", publicKeyPem }),
    ).toThrowError(JwtError);
  });

  it("rejects a malformed header", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "x",
      scope: "",
      now: () => FIXED_NOW,
    });
    const parts = minted.token.split(".");
    const bogusHeader = Buffer.from("not-json").toString("base64url");
    let caught: unknown;
    try {
      verifyJwt({
        token: `${bogusHeader}.${parts[1]}.${parts[2]}`,
        publicKeyPem,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("header_invalid");
  });

  it("rejects an unsupported alg", () => {
    const goodHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const goodPayload = Buffer.from(
      JSON.stringify({
        iss: "signalman-registry",
        sub: "x",
        aud: "signalman-registry",
        scope: "",
        iat: Math.floor(FIXED_NOW.getTime() / 1000),
        exp: Math.floor(FIXED_NOW.getTime() / 1000) + 60,
      }),
    ).toString("base64url");
    let caught: unknown;
    try {
      verifyJwt({
        token: `${goodHeader}.${goodPayload}.AAAA`,
        publicKeyPem,
        now: () => FIXED_NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("alg_unsupported");
  });

  it("rejects mismatched audience", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "x",
      scope: "",
      audience: "other-audience",
      issuer: "signalman-registry",
      now: () => FIXED_NOW,
    });
    let caught: unknown;
    try {
      verifyJwt({
        token: minted.token,
        publicKeyPem,
        now: () => FIXED_NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("wrong_audience");
  });

  it("rejects mismatched issuer", () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "x",
      scope: "",
      issuer: "different-issuer",
      now: () => FIXED_NOW,
    });
    let caught: unknown;
    try {
      verifyJwt({
        token: minted.token,
        publicKeyPem,
        now: () => FIXED_NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("wrong_issuer");
  });

  it("rejects payloads missing claims", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "signalman-registry" })).toString(
      "base64url",
    );
    // Have to actually sign this header.payload so we don't fail signature first.
    const signingInput = Buffer.from(`${header}.${payload}`);
    const sig = nodeCrypto.sign(
      null,
      signingInput,
      nodeCrypto.createPrivateKey(privateKeyPem),
    );
    const sigB64 = sig.toString("base64url");
    let caught: unknown;
    try {
      verifyJwt({
        token: `${header}.${payload}.${sigB64}`,
        publicKeyPem,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtError);
    expect((caught as JwtError).reason).toBe("payload_invalid");
  });
});

describe("looksLikeJwt", () => {
  it("recognises a JWT shape", () => {
    expect(looksLikeJwt("eyHeader.eyPayload.eySignature")).toBe(true);
  });

  it("rejects sk_<prefix>_<secret> bearers", () => {
    expect(looksLikeJwt("sk_TEST_0123456789ABCDEF")).toBe(false);
  });

  it("rejects shapes with the wrong number of parts", () => {
    expect(looksLikeJwt("a.b")).toBe(false);
    expect(looksLikeJwt("a.b.c.d")).toBe(false);
    expect(looksLikeJwt("a")).toBe(false);
  });
});

describe("publicKeyPemFromPrivate", () => {
  it("derives a usable public key from an Ed25519 private key", () => {
    const { privateKeyPem } = generateKeypair();
    const derived = publicKeyPemFromPrivate(privateKeyPem);
    expect(derived).toContain("-----BEGIN PUBLIC KEY-----");
    // Round-trip: a JWT signed with the private key verifies against
    // the derived public key.
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "",
      now: () => FIXED_NOW,
    });
    expect(() =>
      verifyJwt({
        token: minted.token,
        publicKeyPem: derived,
        now: () => FIXED_NOW,
      }),
    ).not.toThrow();
  });

  it("rejects non-Ed25519 keys", () => {
    const { privateKey } = nodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() => publicKeyPemFromPrivate(privateKey as string)).toThrow();
  });
});
