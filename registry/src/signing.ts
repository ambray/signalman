/**
 * Manifest signing — Ed25519 over the canonical manifest JSON.
 *
 * Ported from `host/src/control-plane/build/signing.ts`. The two
 * modules share the canonicalization algorithm (sorted keys, no
 * whitespace, no `undefined` fields) and the public-key fingerprint
 * format (first 16 hex chars of sha256(DER-SPKI public key)). A
 * release manifest signed by the host's CI executor verifies
 * unchanged through the registry's verify endpoint.
 *
 * Why a separate port rather than a shared package: the registry is
 * a standalone OSS product. A future user who wants only the
 * registry should not have to pull in `@signalman/host` as a dep.
 * The duplicated code is small (~100 lines) and self-contained.
 *
 * Key on-disk format (matches host):
 *   - Public key  → PEM SubjectPublicKeyInfo (-----BEGIN PUBLIC KEY-----).
 *   - Private key → PEM PKCS#8 (-----BEGIN PRIVATE KEY-----).
 * Both produced by Node's `crypto.generateKeyPairSync('ed25519')`
 * with PEM encoding; interoperable with openssl.
 */

import * as crypto from "node:crypto";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Manifest,
  type ManifestSignature,
} from "./types.js";

export interface Keypair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface SignedManifest extends ManifestSignature {
  /** The canonical JSON bytes the signature was computed over. */
  canonicalBytes: Buffer;
}

export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureVerificationError";
  }
}

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
 * Compute the public-key fingerprint stored in `manifest.signature.signedBy`.
 * Verifiers compute this from their copy of the public key and compare;
 * a mismatch is surfaced before any cryptographic work happens.
 */
export function fingerprintPublicKey(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/**
 * Produce the canonical JSON bytes for a manifest. Sorted keys, no
 * whitespace, no `undefined` properties. Identity-stable across
 * runs: the same logical manifest always serializes to the same
 * bytes regardless of object-key insertion order.
 *
 * The signature field is deliberately stripped before signing: the
 * signature signs everything *except* itself. The verify path must
 * strip the same field before recomputing.
 */
export function canonicalManifestBytes(manifest: Manifest): Buffer {
  const stripped: Record<string, unknown> = { ...manifest };
  delete stripped.signature;
  return Buffer.from(canonicalize(stripped), "utf-8");
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

export function signManifest(
  manifest: Manifest,
  privateKeyPem: string,
): SignedManifest {
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.SIGNATURE_INVALID,
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
    canonicalBytes: bytes,
  };
}

/**
 * Verify a signed manifest. Returns true on success, throws
 * `SignatureVerificationError` on:
 *   - fingerprint mismatch (the operator-supplied public key does
 *     not match the one that signed the manifest)
 *   - cryptographic failure (manifest tampered, signature corrupt,
 *     or wrong key altogether)
 *   - bad base64 in the signature field
 *
 * `canonicalBytes` is the exact bytes recorded by the registry at
 * push time. The caller supplies them rather than recomputing
 * because canonicalization is deterministic but the registry has
 * the bytes already and feeding them through saves one
 * canonicalization on hot paths.
 *
 * For convenience tests use `verifyManifestInline` which derives the
 * canonical bytes from the manifest itself.
 */
export function verifyManifest(
  canonicalBytes: Buffer,
  signature: ManifestSignature,
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
  if (fp !== signature.signedBy) {
    throw new SignatureVerificationError(
      `public-key fingerprint mismatch: manifest signed by ${signature.signedBy}, you provided ${fp}`,
    );
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(signature.signatureB64, "base64");
  } catch {
    throw new SignatureVerificationError(
      "signatureB64 is not valid base64",
    );
  }
  const ok = crypto.verify(null, canonicalBytes, keyObject, sig);
  if (!ok) {
    throw new SignatureVerificationError(
      "signature is cryptographically invalid (manifest tampered or wrong key)",
    );
  }
  return true;
}

/**
 * Convenience for verifying a `Manifest` object directly — derives
 * canonical bytes from the manifest and asserts the signature
 * field is populated.
 */
export function verifyManifestInline(
  manifest: Manifest,
  publicKeyPem: string,
): boolean {
  if (!manifest.signature) {
    throw new SignatureVerificationError(
      "manifest carries no signature; cannot verify",
    );
  }
  return verifyManifest(
    canonicalManifestBytes(manifest),
    manifest.signature,
    publicKeyPem,
  );
}
