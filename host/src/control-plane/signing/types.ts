/**
 * SigningProvider — versioned interface that decouples "what to sign"
 * from "how the key material is held."
 *
 * See `docs/design/signing-service.md` §The `SigningProvider` interface
 * for the locked design. v0.5.0 ships `LocalDiskProvider` here +
 * `AwsKmsProvider` in Milestone 3; v0.6+ adds Azure KV, GCP KMS, HSM,
 * and detached-operator providers without touching call sites.
 *
 * Milestone 1a (this module) ships:
 *   - The full interface (incl. ml-dsa-65 in SigAlgorithm for forward
 *     compatibility with the Milestone 1b hybrid layer).
 *   - LocalDiskProvider classical Ed25519 + ECDSA P-256 impls.
 *   - Existing host/registry signing call sites refactored to route
 *     through the provider while keeping their public API stable.
 *
 * Milestone 1a does NOT ship: ml-dsa-65 implementation, hybrid keys,
 * the signing_provider_key / signing_nonce migrations, audit-log
 * wiring, CLI/MCP surface. Each of those is its own milestone.
 */

/**
 * Signature algorithm. v0.5.0 supports three algorithms:
 *
 *   - "ed25519"           — matches v0.4.x; NOT quantum-safe.
 *   - "ecdsa-p256-sha256" — cloud-KMS interoperability; NOT quantum-safe.
 *   - "ml-dsa-65"         — NIST FIPS 204 post-quantum (lattice-based).
 *                           Default for the post-quantum half of every
 *                           new hybrid key in Milestone 1b+.
 *
 * Milestone 1a implements only the first two; ml-dsa-65 surfaces
 * NotImplementedError at sign/verify time. Hybrid keys (two linked
 * sub-keys, one classical + one PQ) land in Milestone 1b.
 *
 * RSA variants are deliberately omitted — larger signatures, slower
 * verification, no operator request driving them. SLH-DSA (FIPS 205)
 * is similarly omitted; signatures are 8–50 KB and operationally
 * heavy. Both remain additive changes if needed later.
 */
export type SigAlgorithm = "ed25519" | "ecdsa-p256-sha256" | "ml-dsa-65";

/**
 * Opaque key identifier. The provider decides the format:
 *
 *   LocalDiskProvider:  alias "default" → ~/.signalman/keys/signing.{pub,key};
 *                       custom paths via "/abs/path/to/key.pem";
 *                       inline-PEM (for legacy in-process callers) via
 *                       "inline:<sha256-of-key-bytes>".
 *   AwsKmsProvider:     KMS key ARN.
 *   AzureKvProvider:    "{vault-url}/keys/{name}/{version-or-empty}".
 *
 * Callers MUST treat KeyId as opaque. The provider parses it.
 */
export type KeyId = string;

/**
 * Public-key reference returned by listKeys() / available without a
 * provider round-trip after the first fingerprint lookup. The
 * public-key bytes are cached locally so verify() never needs network
 * access — verifiers can run wherever the audit consumer runs without
 * depending on the producing provider's backend (cloud KMS, HSM, …).
 */
export interface PublicKeyRef {
  readonly keyId: KeyId;
  /** Provider id ("local-disk" | "aws-kms" | …). */
  readonly provider: string;
  readonly algorithm: SigAlgorithm;
  /** DER SubjectPublicKeyInfo, base64-encoded, for Ed25519 / ECDSA.
   *  For ml-dsa-65 (Milestone 1b+) this carries the FIPS 204 raw
   *  public-key bytes (the FIPS 204 wire format has no DER wrapper). */
  readonly publicKeyB64: string;
  /** First 16 hex chars of sha256(publicKeyB64-decoded-bytes). Same
   *  fingerprint format the v0.4.x release row uses for `signed_by`. */
  readonly fingerprint: string;
}

/**
 * The actor that authored a sign request. The audit log records this
 * verbatim; per-key authorization (Milestone 2) gates on it. In
 * Milestone 1a, legacy in-process callers synthesize an actor of
 *   { kind: "service", cn: "legacy-signing", orgId: <caller-org-id> }
 * until Milestone 2 wires real actors from the WS8 identity-cert
 * payload.
 */
export interface ActorRef {
  readonly kind: "user" | "machine" | "service";
  readonly cn: string;
  readonly orgId: string;
}

/**
 * A sign request. `payload` is bytes — canonicalization has already
 * happened upstream (release-manifest canonicalizer, registry-manifest
 * canonicalizer, denylist canonicalizer). The provider does not parse
 * the payload; it signs the bytes.
 *
 * `nonce` + `requestedAt` are mandatory:
 *   - The audit log records both (Milestone 2 wiring).
 *   - Providers reject `requestedAt` skew > 60s (default;
 *     per-provider configurable via SigningPolicyDefaults below).
 *     Milestone 1a's LocalDiskProvider enforces the skew check but
 *     the audit-log dedup (signing_nonce table) lands in Milestone 2.
 */
export interface SignRequest {
  readonly keyId: KeyId;
  readonly payload: Uint8Array;
  /** 16-byte cryptographic random, hex-encoded (32 hex chars). */
  readonly nonce: string;
  /** RFC 3339 UTC timestamp from the caller. */
  readonly requestedAt: string;
  /** Free-form purpose captured in the audit row. Recommended forms:
   *    "release.manifest:release-id=<id>"
   *    "registry.resign:<crate>/<version>"
   *    "service.denylist:<revoked-snapshot-id>"
   *    "service.cert.mint:<subject-cn>" */
  readonly purpose: string;
  readonly actor: ActorRef;
}

/**
 * A single signature entry. v0.5.0 always emits exactly one entry per
 * sign() call against a classical-only key. Hybrid keys (Milestone 1b+)
 * emit two entries — one classical, one ml-dsa-65 — packed into the
 * same SignEnvelope.signatures array.
 */
export interface SigEntry {
  /** Base64 raw signature bytes; algorithm-specific length. */
  readonly signatureB64: string;
  /** Fingerprint of the producing key — same format everywhere. */
  readonly signedBy: string;
  readonly algorithm: SigAlgorithm;
  /** RFC 3339 UTC timestamp the provider produced this signature. */
  readonly signedAt: string;
}

/**
 * Envelope returned by sign(). Persisted by call sites that need to
 * forward signatures across surfaces (release row, registry manifest
 * row, denylist sidecar). The `nonce` is echoed back from the request
 * for replay-detection bookkeeping; the `payloadSha256` lets verifiers
 * fast-fail on hash mismatch before doing the cryptographic work.
 */
export interface SignEnvelope {
  /** Length 1 for classical-only keys in v0.5.0; length 2 for hybrid
   *  keys (Milestone 1b+). Always ≥ 1. v0.6+ quorum/multi-sig can
   *  extend this without a schema break. */
  readonly signatures: readonly SigEntry[];
  /** Echoed from the SignRequest. The audit log keys on this. */
  readonly nonce: string;
  /** sha256(payload), hex-encoded lowercase. */
  readonly payloadSha256: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Populated only when ok=false. Stable, machine-readable codes —
   *  see SigningErrorCode for the canonical set. */
  readonly reasonCode?: SigningErrorCode;
  /** Optional human-readable reason. */
  readonly reason?: string;
}

/**
 * Verifier mode — operator-configurable per call site (release verify /
 * registry virtual-upstream / WS8 denylist). Affects how hybrid
 * envelopes are evaluated:
 *
 *   - "transition" (default in Milestone 1b+): at least ONE entry in
 *     signatures[] must verify. Tolerates a parameter-set break in
 *     either algorithm without immediate fleet-wide breakage.
 *   - "strict": EVERY entry must verify against its declared
 *     algorithm + key. The default once the PQ half hardens (v0.6+).
 *   - "classical-only": only the Ed25519 entry is checked; ml-dsa-65
 *     entries are ignored. Provided for verifiers that haven't yet
 *     linked the ML-DSA library. Explicitly NOT quantum-safe.
 *
 * Milestone 1a verify() takes a VerifyMode parameter but only "strict"
 * has meaningful behavior (there's only one entry to verify). The
 * three-way distinction matters in Milestone 1b+.
 */
export type VerifyMode = "transition" | "strict" | "classical-only";

/**
 * Stable, machine-readable error codes. The audit log and CLI surface
 * key on these so a fix in one place fixes everywhere. Add new codes
 * additively; never rename.
 */
export type SigningErrorCode =
  | "fingerprint-mismatch"
  | "bad-signature"
  | "unknown-algorithm"
  | "algorithm-not-implemented"
  | "key-not-found"
  | "key-revoked"
  | "clock-skew"
  | "nonce-replay"
  | "nonce-malformed"
  | "payload-empty"
  | "purpose-empty"
  | "actor-missing"
  | "hybrid-pair-incomplete"
  | "io-error"
  | "internal-error";

/**
 * Base error class. All provider errors inherit; carries a stable
 * machine-readable code plus a human message.
 *
 * The legacy v0.4.x `SignatureVerificationError` is re-exported from
 * the existing build/signing.ts and registry/signing.ts shims for
 * backwards compatibility; new code should catch SigningError and
 * dispatch on `code`.
 */
export class SigningError extends Error {
  readonly code: SigningErrorCode;

  constructor(code: SigningErrorCode, message: string) {
    super(message);
    this.name = "SigningError";
    this.code = code;
  }
}

/**
 * Convenience subclass used when an algorithm is in the SigAlgorithm
 * union but not yet implemented by the current provider. Milestone 1a
 * throws this for `ml-dsa-65`; Milestone 1b removes the throw site
 * when liboqs-node lands.
 */
export class AlgorithmNotImplementedError extends SigningError {
  constructor(algorithm: SigAlgorithm) {
    super(
      "algorithm-not-implemented",
      `algorithm "${algorithm}" is declared in the SigAlgorithm union but not yet implemented in this provider. Ed25519 + ECDSA P-256 ship in Milestone 1a; ml-dsa-65 + hybrid ship in Milestone 1b.`,
    );
    this.name = "AlgorithmNotImplementedError";
  }
}

/**
 * Per-provider defaults. Concrete providers may override via
 * constructor options; the values here are the policy floor.
 */
export interface SigningPolicyDefaults {
  /** Maximum acceptable skew between SignRequest.requestedAt and the
   *  provider's clock-at-receipt. Defaults to 60s. Tightening below
   *  10s is risky on systems without NTP. */
  readonly clockSkewToleranceMs: number;
  /** Nonce byte length. 16 bytes (32 hex chars) is the design-doc
   *  default. Increasing has no security cost; decreasing below 16
   *  weakens replay protection. */
  readonly nonceLengthBytes: number;
}

export const DEFAULT_SIGNING_POLICY: SigningPolicyDefaults = {
  clockSkewToleranceMs: 60_000,
  nonceLengthBytes: 16,
};

/**
 * The core signing-provider interface. Async by construction so that
 * networked providers (`AwsKmsProvider` and friends) fit naturally;
 * `LocalDiskProvider` returns `Promise.resolve(...)` to satisfy the
 * shape.
 *
 * Legacy in-process call sites that require synchronous semantics
 * (the v0.4.x build/signing.ts shim, the v0.4.x registry/signing.ts
 * shim) use the optional sync escape hatch on `SyncSigningProvider`
 * below. Provider implementations that can be sync (e.g.
 * LocalDiskProvider for Ed25519/ECDSA) implement both interfaces;
 * networked providers implement only `SigningProvider`.
 */
export interface SigningProvider {
  /** Stable provider id: "local-disk" | "aws-kms" | "azure-key-vault" | ... */
  readonly id: string;

  /** Algorithms this provider can produce. The control plane uses
   *  this to dispatch keys to a provider that can handle them. */
  readonly supportedAlgorithms: readonly SigAlgorithm[];

  sign(req: SignRequest): Promise<SignEnvelope>;

  /** Verify a signature against payload bytes + a known public key.
   *  Verify can run on ANY provider for ANY envelope when the
   *  algorithm matches — verification does not require the producing
   *  provider. */
  verify(
    env: SignEnvelope,
    payload: Uint8Array,
    key: PublicKeyRef,
    mode?: VerifyMode,
  ): Promise<VerifyResult>;

  /** Compute the fingerprint of a key managed by this provider. */
  fingerprint(keyId: KeyId): Promise<string>;

  /** Enumerate keys the provider knows about. For LocalDiskProvider:
   *  files under ~/.signalman/keys/. For cloud-KMS: keys tagged for
   *  signalman use in the configured account/vault. */
  listKeys(): Promise<readonly PublicKeyRef[]>;

  /** Rotate a key. Operator-initiated in v0.5.0; auto-rotation is a
   *  v0.6+ extension. Optional — read-only / verification-only
   *  providers don't implement it. */
  rotate?(keyId: KeyId): Promise<PublicKeyRef>;
}

/**
 * Optional sync companion. Implementations that can run synchronously
 * (LocalDiskProvider for Ed25519/ECDSA — Node's `crypto.sign` is
 * already sync) expose this in parallel to the async surface so
 * legacy in-process callers that aren't async-ready can still route
 * through the provider abstraction without breaking byte-parity.
 *
 * Networked providers MUST NOT implement this. Throwing on the sync
 * path would leak provider-specific implementation details into call
 * sites and is exactly what the abstraction is meant to prevent.
 */
export interface SyncSigningProvider {
  signSync(req: SignRequest): SignEnvelope;
  verifySync(
    env: SignEnvelope,
    payload: Uint8Array,
    key: PublicKeyRef,
    mode?: VerifyMode,
  ): VerifyResult;
}

/**
 * Type guard for runtime feature detection.
 */
export function isSyncSigningProvider(
  p: SigningProvider,
): p is SigningProvider & SyncSigningProvider {
  const candidate = p as Partial<SyncSigningProvider>;
  return (
    typeof candidate.signSync === "function" &&
    typeof candidate.verifySync === "function"
  );
}
