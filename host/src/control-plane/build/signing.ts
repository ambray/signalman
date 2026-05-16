/**
 * Manifest signing — Ed25519 over the canonical manifest JSON.
 *
 * This module is the **legacy public API surface** for release-manifest
 * signing. Its function signatures (`signManifest`, `verifyManifest`,
 * `generateKeypair`, `fingerprintPublicKey`) and exported types
 * (`Keypair`, `SignedManifest`, `SignatureVerificationError`) are
 * byte-stable with v0.4.x; downstream callers (build/executor.ts,
 * server.ts, cli.ts, verbs/control-plane.ts) compile and run
 * unchanged after WS9.
 *
 * Internally, signing and verifying route through the new
 * SigningProvider abstraction at `../signing/` (Milestone 1a of WS9 —
 * see docs/design/signing-service.md). The default provider is
 * `LocalDiskProvider.fromInlinePem(privateKeyPem)`, which preserves
 * the in-memory-key trust posture v0.4.x established. Subsequent
 * milestones add `AwsKmsProvider` and post-quantum hybrid keys; both
 * surface through the new `signing/` module, not through this shim.
 *
 * Byte-parity invariant: for the same (manifest, ed25519-private-key)
 * inputs, `signManifest()` produces signature bytes identical to its
 * v0.4.x output. The `signing.byte-parity.test.ts` regression test
 * locks this against future drift.
 *
 * Why keep this shim:
 *   - The v0.4.x callers (build/executor.ts, verbs/control-plane.ts)
 *     don't need to know about the provider abstraction; their
 *     workflow is "the operator handed me a PEM, sign with it."
 *   - Async ergonomics: this surface stays synchronous so existing
 *     callers don't need to be reworked to `await`.
 *   - The Ed25519-only contract is preserved here so an accidental
 *     ECDSA key doesn't silently pass — even though the underlying
 *     provider supports both, the legacy public surface remains
 *     Ed25519-only until call sites are explicitly opted-in.
 *
 * Why Ed25519 (historical, unchanged):
 *   * Compact (32-byte public key, 64-byte signature) and fast
 *     (sub-millisecond sign/verify).
 *   * Native: Node's built-in `crypto` supports Ed25519 since 12.0.
 *   * Deterministic: same key + message always produces the same
 *     signature, which is what makes the byte-parity invariant a
 *     stable test rather than a probabilistic one.
 *
 * Key on-disk format (unchanged):
 *   * Public key  → DER SubjectPublicKeyInfo, PEM-wrapped
 *     (`-----BEGIN PUBLIC KEY-----`).
 *   * Private key → DER PKCS#8, PEM-wrapped
 *     (`-----BEGIN PRIVATE KEY-----`).
 *
 * Signing identity:
 *   * `signed_by` is the first 16 hex chars of sha256(DER public key).
 */

import * as crypto from "node:crypto";

import {
  LocalDiskProvider,
  freshNonce,
  publicKeyRefFromPem,
} from "../signing/index.js";
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
 *
 * This helper does not route through the provider — it's a pure
 * PEM-to-fingerprint transformation that doesn't need key state.
 * Keeping it as a top-level function preserves the v0.4.x call
 * shape used by server.ts, cli.ts, and operator scripts.
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
 * Synthesize a SignRequest actor for legacy in-process callers.
 * Milestone 1a callers don't yet thread a WS8 identity-cert actor;
 * the synthetic actor is recorded in the audit log when Milestone 2
 * wires the audit path. The legacy shim's algorithm gate (Ed25519
 * only) preserves the v0.4.x contract regardless of what the
 * provider accepts.
 */
const LEGACY_ACTOR = {
  kind: "service" as const,
  cn: "legacy-build-signing",
  orgId: "default",
};

/**
 * Sign a manifest. Returns the base64 signature and the public-key
 * fingerprint to store alongside on the release row.
 *
 * Important: the caller is responsible for protecting the private key.
 * This module does not load keys from disk; that's the CLI verb's
 * job. Tests pass keys in-memory.
 *
 * Internally routes through `LocalDiskProvider.fromInlinePem(...)` so
 * the provider-side audit-log / replay-protection wiring (Milestone 2)
 * applies uniformly. The Ed25519-only contract is enforced at this
 * layer to preserve the v0.4.x error shape; opting into ECDSA P-256
 * or post-quantum hybrid requires using the new
 * `host/src/control-plane/signing/` surface directly.
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
  const provider = LocalDiskProvider.fromInlinePem(privateKeyPem);
  const envelope = provider.signSync({
    keyId: "inline",
    payload: bytes,
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "release.manifest.legacy",
    actor: LEGACY_ACTOR,
  });
  const entry = envelope.signatures[0];
  if (!entry) {
    // Defensive: signSync always returns at least one entry. If this
    // ever fires, the provider abstraction is broken.
    throw new Error("LocalDiskProvider.signSync returned an empty envelope");
  }
  return {
    signatureB64: entry.signatureB64,
    signedBy: entry.signedBy,
  };
}

/**
 * Verify a signed manifest. Returns true on success, throws
 * `SignatureVerificationError` on:
 *   * fingerprint mismatch (the public key the operator supplied
 *     isn't the one that signed this release)
 *   * cryptographic failure (manifest tampered, signature corrupt,
 *     or wrong key entirely)
 *
 * Internally routes through `LocalDiskProvider.verifySync(...)`. The
 * Ed25519-only contract is preserved here; the underlying provider
 * also supports ECDSA P-256 but the legacy `verifyManifest` shim
 * stays Ed25519-only to match v0.4.x.
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
  // Reuse fingerprintPublicKey's transformation so the v0.4.x error
  // shape (which named the supplied vs. expected fingerprints) stays
  // identical down to the variable order.
  const fp = fingerprintPublicKey(publicKeyPem);
  if (fp !== signedByFingerprint) {
    throw new SignatureVerificationError(
      `public-key fingerprint mismatch: release signed by ${signedByFingerprint}, you provided ${fp}`,
    );
  }
  const bytes = canonicalManifestBytes(manifest);
  // Run the cryptographic verify through the provider. The fingerprint
  // check above already gated the failure path with the v0.4.x error
  // message shape; the provider verify here covers the bad-signature
  // case. We pass the same fingerprint as signedBy + key.fingerprint
  // so the provider's internal fingerprint-match check is trivially
  // satisfied — the v0.4.x error message wins on mismatch above.
  const publicKeyRef = publicKeyRefFromPem(publicKeyPem);
  const payloadSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const envelope = {
    signatures: [
      {
        signatureB64,
        signedBy: signedByFingerprint,
        algorithm: "ed25519" as const,
        signedAt: new Date(0).toISOString(),
      },
    ],
    nonce: "00000000000000000000000000000000",
    payloadSha256,
  };
  const provider = new LocalDiskProvider();
  const result = provider.verifySync(envelope, bytes, [publicKeyRef], "strict");
  if (!result.ok) {
    throw new SignatureVerificationError(
      "signature is cryptographically invalid (manifest tampered or wrong key)",
    );
  }
  return true;
}
