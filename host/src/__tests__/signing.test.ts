/**
 * Tests for the manifest-signing module (PR 10a).
 *
 * Covers the Ed25519 round trip, fingerprint derivation, tamper
 * detection, and the cross-key rejection path.
 */

import { describe, expect, it } from "vitest";
import {
  SignatureVerificationError,
  fingerprintPublicKey,
  generateKeypair,
  signManifest,
  verifyManifest,
} from "../control-plane/build/signing.js";
import { buildManifest } from "../control-plane/build/manifest.js";

function makeManifest() {
  return buildManifest({
    product: "example-product",
    tag: "v1.2.3",
    commitSha: "abc1234deadbeef",
    entries: [
      { component: "agent", kind: "blob", sha256: "a".repeat(64) },
      {
        component: "backend",
        kind: "image_ref",
        image_ref: "example-backend:v1.2.3",
      },
    ],
  });
}

describe("generateKeypair + fingerprintPublicKey", () => {
  it("produces a PEM keypair + a deterministic 16-hex fingerprint", () => {
    const kp = generateKeypair();
    expect(kp.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(kp.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    const fp = fingerprintPublicKey(kp.publicKeyPem);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Same key → same fingerprint.
    expect(fingerprintPublicKey(kp.publicKeyPem)).toBe(fp);
  });

  it("different keypairs have different fingerprints", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(fingerprintPublicKey(a.publicKeyPem)).not.toBe(
      fingerprintPublicKey(b.publicKeyPem),
    );
  });
});

describe("signManifest + verifyManifest round trip", () => {
  it("signs and verifies cleanly with the matching public key", () => {
    const kp = generateKeypair();
    const manifest = makeManifest();
    const signed = signManifest(manifest, kp.privateKeyPem);
    expect(signed.signatureB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(signed.signedBy).toBe(fingerprintPublicKey(kp.publicKeyPem));
    const ok = verifyManifest(
      manifest,
      signed.signatureB64,
      signed.signedBy,
      kp.publicKeyPem,
    );
    expect(ok).toBe(true);
  });

  it("rejects a manifest that has been tampered with", () => {
    const kp = generateKeypair();
    const manifest = makeManifest();
    const signed = signManifest(manifest, kp.privateKeyPem);
    const tampered = buildManifest({
      product: "example-product",
      tag: "v1.2.3",
      commitSha: "abc1234deadbeef",
      entries: [
        // Substitute the agent's sha256 → signature should no longer
        // verify.
        { component: "agent", kind: "blob", sha256: "b".repeat(64) },
        {
          component: "backend",
          kind: "image_ref",
          image_ref: "example-backend:v1.2.3",
        },
      ],
    });
    expect(() =>
      verifyManifest(
        tampered,
        signed.signatureB64,
        signed.signedBy,
        kp.publicKeyPem,
      ),
    ).toThrow(SignatureVerificationError);
  });

  it("rejects when the supplied public key doesn't match the signer fingerprint", () => {
    const signerKp = generateKeypair();
    const otherKp = generateKeypair();
    const manifest = makeManifest();
    const signed = signManifest(manifest, signerKp.privateKeyPem);
    // signed.signedBy is signerKp's fingerprint; passing otherKp's
    // public key triggers the fingerprint-mismatch path BEFORE the
    // crypto check.
    expect(() =>
      verifyManifest(
        manifest,
        signed.signatureB64,
        signed.signedBy,
        otherKp.publicKeyPem,
      ),
    ).toThrow(/fingerprint mismatch/);
  });

  it("rejects a syntactically-valid but cryptographically-wrong signature", () => {
    const kp = generateKeypair();
    const manifest = makeManifest();
    const fakeSig = Buffer.alloc(64, 0xab).toString("base64");
    expect(() =>
      verifyManifest(
        manifest,
        fakeSig,
        fingerprintPublicKey(kp.publicKeyPem),
        kp.publicKeyPem,
      ),
    ).toThrow(/cryptographically invalid/);
  });

  it("refuses a non-Ed25519 private key", () => {
    // RSA key — signManifest should reject before invoking crypto.sign.
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() => signManifest(makeManifest(), privateKey as string)).toThrow(
      /must be Ed25519/,
    );
  });

  it("canonicalization is order-independent (signature unaffected by entry input order)", () => {
    // buildManifest sorts entries by component name, so passing them
    // in either order produces the same canonical bytes and thus the
    // same signature given the same key.
    const kp = generateKeypair();
    const a = buildManifest({
      product: "p",
      tag: "v1",
      commitSha: "c",
      entries: [
        { component: "agent", kind: "blob", sha256: "a".repeat(64) },
        { component: "backend", kind: "image_ref", image_ref: "x:v1" },
      ],
    });
    const b = buildManifest({
      product: "p",
      tag: "v1",
      commitSha: "c",
      entries: [
        { component: "backend", kind: "image_ref", image_ref: "x:v1" },
        { component: "agent", kind: "blob", sha256: "a".repeat(64) },
      ],
    });
    const sigA = signManifest(a, kp.privateKeyPem);
    const sigB = signManifest(b, kp.privateKeyPem);
    expect(sigA.signatureB64).toBe(sigB.signatureB64);
  });
});
