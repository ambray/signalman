/**
 * Byte-parity regression — the load-bearing test for WS9 Milestone 1a.
 *
 * The v0.4.x `signManifest()` ran `crypto.sign(null, payload, key)`
 * directly. v0.5.0's `signManifest()` shim routes through
 * `LocalDiskProvider.signSync()`, which internally also calls
 * `crypto.sign(null, payload, key)` with the same inputs. Ed25519 is
 * deterministic (same key + same message always produces the same
 * signature), so the output bytes are stable.
 *
 * If this test breaks, the WS9 abstraction has silently introduced an
 * Ed25519 output divergence — the design's most fundamental
 * invariant. Investigate before merging.
 */

import * as crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildManifest } from "../control-plane/build/manifest.js";
import {
  fingerprintPublicKey,
  generateKeypair,
  signManifest,
  verifyManifest,
} from "../control-plane/build/signing.js";
import {
  LocalDiskProvider,
  freshNonce,
  publicKeyRefFromPem,
} from "../control-plane/signing/index.js";

// A fixed manifest used as the canary input. Any change to buildManifest
// or its canonicalization affects the test fixtures; that's intentional
// — the manifest shape is part of the byte-parity contract.
function fixtureManifest() {
  return buildManifest({
    product: "byte-parity-fixture",
    tag: "v1.0.0",
    commitSha: "1234567890abcdef1234567890abcdef",
    entries: [
      { component: "agent", kind: "blob", sha256: "a".repeat(64) },
      { component: "backend", kind: "image_ref", image_ref: "fixture:1.0" },
    ],
  });
}

// Canonical-JSON bytes mirror of what `signing.ts` produces internally.
// Kept here so the test exercises the SAME canonicalization the
// production path uses.
function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf-8");
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

describe("WS9 byte-parity invariants", () => {
  it("provider.signSync(Ed25519) emits exactly the same bytes as direct crypto.sign(null, ...)", () => {
    const kp = generateKeypair();
    const manifest = fixtureManifest();
    const bytes = canonicalBytes(manifest);

    // Path A: the way v0.4.x did it.
    const directKey = crypto.createPrivateKey(kp.privateKeyPem);
    const directBytes = crypto.sign(null, bytes, directKey);

    // Path B: the way v0.5.0 routes it through the provider.
    const provider = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const env = provider.signSync({
      keyId: "inline",
      payload: bytes,
      nonce: freshNonce(),
      requestedAt: new Date().toISOString(),
      purpose: "test.byte-parity",
      actor: { kind: "service", cn: "test", orgId: "default" },
    });
    const providerBytes = Buffer.from(env.signatures[0]!.signatureB64, "base64");

    expect(providerBytes).toEqual(directBytes);
  });

  it("signManifest legacy shim emits the same signature.bytes as direct crypto.sign(null, ...)", () => {
    const kp = generateKeypair();
    const manifest = fixtureManifest();
    const bytes = canonicalBytes(manifest);

    const directKey = crypto.createPrivateKey(kp.privateKeyPem);
    const directBytes = crypto.sign(null, bytes, directKey);

    const shimmed = signManifest(manifest, kp.privateKeyPem);
    const shimmedBytes = Buffer.from(shimmed.signatureB64, "base64");

    expect(shimmedBytes).toEqual(directBytes);
  });

  it("signManifest legacy shim emits signed_by matching fingerprintPublicKey(...)", () => {
    const kp = generateKeypair();
    const manifest = fixtureManifest();
    const shimmed = signManifest(manifest, kp.privateKeyPem);
    expect(shimmed.signedBy).toBe(fingerprintPublicKey(kp.publicKeyPem));
  });

  it("verifyManifest accepts a v0.4.x-shaped signature payload", () => {
    const kp = generateKeypair();
    const manifest = fixtureManifest();
    const shimmed = signManifest(manifest, kp.privateKeyPem);
    expect(
      verifyManifest(manifest, shimmed.signatureB64, shimmed.signedBy, kp.publicKeyPem),
    ).toBe(true);
  });

  it("provider.verifySync accepts the bytes signManifest produced and the matching public key", () => {
    const kp = generateKeypair();
    const manifest = fixtureManifest();
    const bytes = canonicalBytes(manifest);
    const shimmed = signManifest(manifest, kp.privateKeyPem);

    const provider = new LocalDiskProvider();
    const publicKeyRef = publicKeyRefFromPem(kp.publicKeyPem);
    const envelope = {
      signatures: [
        {
          signatureB64: shimmed.signatureB64,
          signedBy: shimmed.signedBy,
          algorithm: "ed25519" as const,
          signedAt: new Date(0).toISOString(),
        },
      ],
      nonce: "00000000000000000000000000000000",
      payloadSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    const result = provider.verifySync(envelope, bytes, publicKeyRef, "strict");
    expect(result.ok).toBe(true);
  });

  it("Ed25519 signing is deterministic: same key+payload yields the same signature twice", () => {
    const kp = generateKeypair();
    const manifest = fixtureManifest();
    const a = signManifest(manifest, kp.privateKeyPem);
    const b = signManifest(manifest, kp.privateKeyPem);
    expect(a.signatureB64).toBe(b.signatureB64);
    expect(a.signedBy).toBe(b.signedBy);
  });
});
