/**
 * Manifest signing — Ed25519 over the canonical manifest JSON.
 *
 * This module is the **legacy public API surface** for registry-manifest
 * signing. Its function signatures (`signManifest`, `verifyManifest`,
 * `verifyManifestInline`, `generateKeypair`, `fingerprintPublicKey`,
 * `canonicalManifestBytes`) and exported types (`Keypair`,
 * `SignedManifest`, `SignatureVerificationError`) are byte-stable with
 * v0.4.x; downstream callers compile and run unchanged after WS9.
 *
 * Internally, signing and verifying route through the new
 * SigningProvider abstraction at `./signing/` (Milestone 1a of WS9 —
 * see docs/design/signing-service.md). The default provider is
 * `LocalDiskProvider.fromInlinePem(privateKeyPem)`, which preserves
 * the in-memory-key trust posture v0.4.x established. Subsequent
 * milestones add `AwsKmsProvider` and post-quantum hybrid keys; both
 * surface through the new `signing/` module, not through this shim.
 *
 * Byte-parity invariant: for the same (manifest, ed25519-private-key)
 * inputs, `signManifest()` produces signature bytes identical to its
 * v0.4.x output. Crucially, the canonicalization step strips the
 * `signature` field before serialization — the signature signs
 * everything *except* itself. This stripping stays in THIS file
 * (`canonicalManifestBytes`) rather than being pushed into the
 * provider; the provider operates on payload bytes and is agnostic to
 * what those bytes contain.
 *
 * Why a separate port rather than a shared package: the registry is
 * a standalone OSS product. A future user who wants only the
 * registry should not have to pull in `@signalman/host` as a dep.
 * The signing provider abstraction is duplicated under `./signing/`
 * for the same reason; the code is small and self-contained.
 *
 * Key on-disk format (matches host):
 *   - Public key  → PEM SubjectPublicKeyInfo (-----BEGIN PUBLIC KEY-----).
 *   - Private key → PEM PKCS#8 (-----BEGIN PRIVATE KEY-----).
 * Both produced by Node's `crypto.generateKeyPairSync('ed25519')`
 * with PEM encoding; interoperable with openssl.
 *
 * Why Ed25519-only at this shim layer: the underlying provider
 * supports both Ed25519 and ECDSA P-256, but the legacy `signManifest`
 * / `verifyManifest` surface stays Ed25519-only to match v0.4.x.
 * Opting into ECDSA P-256 or post-quantum hybrid requires using the
 * new `./signing/` surface directly.
 */

import * as crypto from "node:crypto";

import {
  LocalDiskProvider,
  SigningError,
  freshNonce,
  publicKeyRefFromPem,
} from "./signing/index.js";
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
 *
 * This stripping stays at the call-site level (here, before the
 * provider sees the bytes) rather than being pushed into the
 * provider; the SigningProvider abstraction operates on opaque
 * payload bytes and is intentionally agnostic to what those bytes
 * represent. The byte-parity invariant for the registry runs against
 * its v0.4.x output, which signed the stripped form.
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
  cn: "legacy-registry-signing",
  orgId: "default",
};

/**
 * Sign a manifest. Returns the base64 signature, the public-key
 * fingerprint, and the canonical bytes the signature was computed
 * over (so callers can persist them alongside on the manifest row).
 *
 * Important: the caller is responsible for protecting the private key.
 * This module does not load keys from disk; that's the CLI verb's
 * job. Tests pass keys in-memory.
 *
 * Internally routes through `LocalDiskProvider.fromInlinePem(...)` so
 * the provider-side audit-log / replay-protection wiring (Milestone 2)
 * applies uniformly. The Ed25519-only contract is enforced at this
 * layer to preserve the v0.4.x error shape; opting into ECDSA P-256
 * or post-quantum hybrid requires using the new `./signing/` surface
 * directly.
 */
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
  const provider = LocalDiskProvider.fromInlinePem(privateKeyPem);
  const envelope = provider.signSync({
    keyId: "inline",
    payload: bytes,
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "registry.manifest.legacy",
    actor: LEGACY_ACTOR,
  });
  const entry = envelope.signatures[0];
  if (!entry) {
    // Defensive: signSync always returns at least one entry. If this
    // ever fires, the provider abstraction is broken.
    throw new RegistryError(
      REGISTRY_ERROR_CODES.SIGNATURE_INVALID,
      "LocalDiskProvider.signSync returned an empty envelope",
    );
  }
  return {
    signatureB64: entry.signatureB64,
    signedBy: entry.signedBy,
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
 *
 * Internally routes through `LocalDiskProvider.verifySync(...)`. The
 * Ed25519-only contract is preserved here; the underlying provider
 * also supports ECDSA P-256 but the legacy `verifyManifest` shim
 * stays Ed25519-only to match v0.4.x. Provider-side `SigningError`s
 * are caught and re-thrown as `SignatureVerificationError` so the
 * v0.4.x error type contract is preserved.
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
  // Validate base64 up front so the v0.4.x error message wins over any
  // provider-side decode-failure surface.
  try {
    Buffer.from(signature.signatureB64, "base64");
  } catch {
    throw new SignatureVerificationError("signatureB64 is not valid base64");
  }
  // Run the cryptographic verify through the provider. The fingerprint
  // check above already gated the failure path with the v0.4.x error
  // message shape; the provider verify here covers the bad-signature
  // case. We pass the same fingerprint as signedBy + key.fingerprint
  // so the provider's internal fingerprint-match check is trivially
  // satisfied — the v0.4.x error message wins on mismatch above.
  const publicKeyRef = publicKeyRefFromPem(publicKeyPem);
  const payloadSha256 = crypto
    .createHash("sha256")
    .update(canonicalBytes)
    .digest("hex");
  const envelope = {
    signatures: [
      {
        signatureB64: signature.signatureB64,
        signedBy: signature.signedBy,
        algorithm: "ed25519" as const,
        signedAt: new Date(0).toISOString(),
      },
    ],
    nonce: "00000000000000000000000000000000",
    payloadSha256,
  };
  const provider = new LocalDiskProvider();
  let result;
  try {
    result = provider.verifySync(envelope, canonicalBytes, publicKeyRef, "strict");
  } catch (err) {
    if (err instanceof SigningError) {
      throw new SignatureVerificationError(err.message);
    }
    throw err;
  }
  if (!result.ok) {
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
