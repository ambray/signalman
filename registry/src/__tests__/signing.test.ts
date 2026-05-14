import { describe, expect, it } from "vitest";
import {
  canonicalManifestBytes,
  fingerprintPublicKey,
  generateKeypair,
  SignatureVerificationError,
  signManifest,
  verifyManifest,
  verifyManifestInline,
} from "../signing.js";
import { RegistryError } from "../types.js";
import type { Manifest } from "../types.js";

const ZERO_SHA = "0".repeat(64);
const ALL_F = "f".repeat(64);

function manifestFixture(): Manifest {
  return {
    name: "demo/svc",
    version: "1.0.0",
    mediaType: "application/vnd.signalman.manifest+json",
    blobs: [
      { mediaType: "application/octet-stream", sha256: ZERO_SHA, size: 1 },
      { mediaType: "application/zip", sha256: ALL_F, size: 4096 },
    ],
    annotations: { team: "platform", "build.commit": "deadbeef" },
    createdAt: "2026-05-14T12:00:00.000Z",
  };
}

describe("canonicalManifestBytes", () => {
  it("is order-independent", () => {
    const a = manifestFixture();
    const b: Manifest = {
      mediaType: a.mediaType,
      version: a.version,
      blobs: a.blobs,
      name: a.name,
      annotations: a.annotations,
      createdAt: a.createdAt,
    };
    expect(canonicalManifestBytes(a).equals(canonicalManifestBytes(b))).toBe(
      true,
    );
  });

  it("strips the signature field", () => {
    const unsigned = manifestFixture();
    const signed: Manifest = {
      ...unsigned,
      signature: {
        signatureB64: "AAAA",
        signedBy: "abc",
      },
    };
    expect(
      canonicalManifestBytes(signed).equals(canonicalManifestBytes(unsigned)),
    ).toBe(true);
  });

  it("differs when content differs", () => {
    const a = manifestFixture();
    const b = manifestFixture();
    b.version = "1.0.1";
    expect(canonicalManifestBytes(a).equals(canonicalManifestBytes(b))).toBe(
      false,
    );
  });
});

describe("signManifest + verifyManifest", () => {
  it("round-trips a signed manifest", () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m = manifestFixture();
    const sig = signManifest(m, privateKeyPem);
    expect(sig.signedBy).toBe(fingerprintPublicKey(publicKeyPem));
    expect(verifyManifest(sig.canonicalBytes, sig, publicKeyPem)).toBe(true);
  });

  it("rejects a tampered manifest", () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m = manifestFixture();
    const sig = signManifest(m, privateKeyPem);
    const tampered = canonicalManifestBytes({ ...m, version: "9.9.9" });
    expect(() => verifyManifest(tampered, sig, publicKeyPem)).toThrowError(
      SignatureVerificationError,
    );
  });

  it("rejects the wrong public key", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const m = manifestFixture();
    const sig = signManifest(m, a.privateKeyPem);
    expect(() => verifyManifest(sig.canonicalBytes, sig, b.publicKeyPem)).toThrowError(
      SignatureVerificationError,
    );
  });

  it("rejects a non-Ed25519 signing key", () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(() =>
      signManifest(manifestFixture(), privateKey as string),
    ).toThrowError(RegistryError);
  });

  it("rejects a non-Ed25519 verify key", () => {
    const a = generateKeypair();
    const sig = signManifest(manifestFixture(), a.privateKeyPem);
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(() =>
      verifyManifest(sig.canonicalBytes, sig, publicKey as string),
    ).toThrowError(SignatureVerificationError);
  });
});

describe("verifyManifestInline", () => {
  it("returns true on a manifest with a valid embedded signature", () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m = manifestFixture();
    const sig = signManifest(m, privateKeyPem);
    const signed: Manifest = {
      ...m,
      signature: {
        signatureB64: sig.signatureB64,
        signedBy: sig.signedBy,
      },
    };
    expect(verifyManifestInline(signed, publicKeyPem)).toBe(true);
  });

  it("throws when the manifest is unsigned", () => {
    const { publicKeyPem } = generateKeypair();
    expect(() => verifyManifestInline(manifestFixture(), publicKeyPem)).toThrowError(
      SignatureVerificationError,
    );
  });
});

describe("fingerprintPublicKey", () => {
  it("is stable across re-imports of the same key", () => {
    const { publicKeyPem } = generateKeypair();
    expect(fingerprintPublicKey(publicKeyPem)).toBe(
      fingerprintPublicKey(publicKeyPem),
    );
  });

  it("differs across distinct keys", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(fingerprintPublicKey(a.publicKeyPem)).not.toBe(
      fingerprintPublicKey(b.publicKeyPem),
    );
  });
});

// node:crypto is imported lazily inside one test to keep the
// top-level imports focused on the module-under-test.
import * as crypto from "node:crypto";
