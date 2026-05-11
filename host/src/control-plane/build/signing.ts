/**
 * Manifest signing — Ed25519 over the canonical manifest JSON.
 *
 * Why Ed25519:
 *   * Pure crypto, no infrastructure (no Fulcio/Rekor like sigstore,
 *     no keyserver like classic GPG). Operators hold a keypair on
 *     disk; that's it.
 *   * Compact: 32-byte public key, 64-byte signature.
 *   * Fast: signing and verifying are sub-millisecond.
 *   * Native: Node's built-in `crypto` supports Ed25519 since 12.0;
 *     no third-party dep.
 *
 * Key on-disk format:
 *   * Public key  → DER (SubjectPublicKeyInfo), base64-wrapped PEM
 *     with `-----BEGIN PUBLIC KEY-----` markers.
 *   * Private key → DER (PKCS#8), PEM with `-----BEGIN PRIVATE KEY-----`.
 *   This is what Node's `crypto.generateKeyPairSync('ed25519')` emits
 *   when asked for `pem` format — interoperable with openssl and other
 *   Ed25519 toolchains.
 *
 * Signing identity:
 *   * `signed_by` on the release row stores the first 16 hex chars of
 *     sha256(DER-encoded public key). Sufficient to identify which
 *     key signed a given release; the full public key is what's
 *     needed to actually verify.
 *
 * Manifest canonicalization:
 *   * We sign the canonical JSON of the ReleaseManifest (sorted keys,
 *     no whitespace) produced by `hashManifest`'s upstream
 *     canonicalizer. The `manifestSha256` already commits to that
 *     canonical form; we sign the same bytes the hash was computed
 *     over, which means a release-row tuple of
 *     (manifest_sha256, signature_b64, signed_by) is self-consistent
 *     even when the original manifest JSON isn't stored verbatim.
 */

import * as crypto from "node:crypto";
import type { ReleaseManifest } from "./manifest.js";

export interface Keypair {
  /** PEM-encoded SPKI public key (begins `-----BEGIN PUBLIC KEY-----`). */
  publicKeyPem: string;
  /** PEM-encoded PKCS#8 private key (begins `-----BEGIN PRIVATE KEY-----`). */
  privateKeyPem: string;
}

export interface SignedManifest {
  /** Base64-encoded raw Ed25519 signature (88 base64 chars). */
  signatureB64: string;
  /** First 16 hex chars of sha256(DER public key). */
  signedBy: string;
}

export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureVerificationError";
  }
}

/** Generate a fresh Ed25519 keypair as PEM strings. */
export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKeyPem: publicKey as string,
    privateKeyPem: privateKey as string,
  };
}

/**
 * Compute the public-key fingerprint stored in `release.signed_by`.
 * Operators with the public-key PEM can compute this independently
 * and compare against the value the build executor wrote.
 */
export function fingerprintPublicKey(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Canonical JSON used as the signed bytes. Stable across runs. */
function canonicalManifestBytes(manifest: ReleaseManifest): Buffer {
  return Buffer.from(canonicalize(manifest), "utf-8");
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

/**
 * Sign a manifest. Returns the base64 signature and the public-key
 * fingerprint to store alongside on the release row.
 *
 * Important: the caller is responsible for protecting the private key.
 * This module does not load keys from disk; that's the CLI verb's
 * job. Tests pass keys in-memory.
 */
export function signManifest(
  manifest: ReleaseManifest,
  privateKeyPem: string,
): SignedManifest {
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `signing key must be Ed25519, got ${keyObject.asymmetricKeyType}`,
    );
  }
  const bytes = canonicalManifestBytes(manifest);
  const sig = crypto.sign(null, bytes, keyObject);
  const publicKey = crypto.createPublicKey(keyObject);
  const der = publicKey.export({ type: "spki", format: "der" });
  const fingerprint = crypto
    .createHash("sha256")
    .update(der)
    .digest("hex")
    .slice(0, 16);
  return {
    signatureB64: sig.toString("base64"),
    signedBy: fingerprint,
  };
}

/**
 * Verify a signed manifest. Returns true on success, throws
 * `SignatureVerificationError` on:
 *   * fingerprint mismatch (the public key the operator supplied
 *     isn't the one that signed this release)
 *   * cryptographic failure (manifest tampered, signature corrupt,
 *     or wrong key entirely)
 */
export function verifyManifest(
  manifest: ReleaseManifest,
  signatureB64: string,
  signedByFingerprint: string,
  publicKeyPem: string,
): boolean {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new SignatureVerificationError(
      `public key must be Ed25519, got ${keyObject.asymmetricKeyType}`,
    );
  }
  const der = keyObject.export({ type: "spki", format: "der" });
  const fp = crypto
    .createHash("sha256")
    .update(der)
    .digest("hex")
    .slice(0, 16);
  if (fp !== signedByFingerprint) {
    throw new SignatureVerificationError(
      `public-key fingerprint mismatch: release signed by ${signedByFingerprint}, you provided ${fp}`,
    );
  }
  const bytes = canonicalManifestBytes(manifest);
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch {
    throw new SignatureVerificationError("signature_b64 is not valid base64");
  }
  const ok = crypto.verify(null, bytes, keyObject, sig);
  if (!ok) {
    throw new SignatureVerificationError(
      "signature is cryptographically invalid (manifest tampered or wrong key)",
    );
  }
  return true;
}
