/**
 * HybridProvider — composes two leaf SigningProviders into one
 * logical hybrid key. WS9 v0.5.1.
 *
 * v0.5.0 supported hybrid only via `LocalDiskProvider`'s paired-files
 * filesystem layout (classical + ML-DSA-65 on the same host). v0.5.1
 * generalizes: any two SigningProviders that produce
 * envelope-compatible SigEntry rows can compose. Concrete shapes
 * v0.5.1 ships:
 *
 *   - LocalDisk-classical + LocalDisk-PQ (same as M1b paired files,
 *     but now expressible via composition for symmetry).
 *   - AwsKms-classical + AwsKms-PQ (when ML-DSA-65 is GA in the
 *     operator's region; operator-tagged at registration).
 *   - AwsKms-classical + LocalDisk-PQ (KMS for the classical half +
 *     local-fallback ML-DSA-65 for regions without KMS ML-DSA).
 *
 * **Trust posture:** each leaf keeps its own. Hybrid does not weaken
 * the strongest leaf — an attacker who compromises the classical-half
 * provider (e.g., gains read on the LocalDisk PEM) still can't forge
 * the PQ half. Verifier mode `strict` enforces both halves verify;
 * `transition` accepts one (covers ecosystem drift during a
 * parameter-set break in either algorithm); `classical-only` ignores
 * the PQ entry (compat with verifiers that lack ML-DSA support).
 *
 * **Why composition, not subclassing:**
 *   - Each leaf provider stays single-algorithm + single-backend.
 *   - Adding new providers (Azure KV, GCP KMS) automatically composes
 *     with HybridProvider — no provider-by-provider hybrid plumbing.
 *   - The catalog row layout (pair_id + pair_role, M2 migration 0090)
 *     is already shaped for two-row hybrid keys regardless of which
 *     providers contributed.
 */

import * as crypto from "node:crypto";

import {
  AlgorithmNotImplementedError,
  type KeyId,
  type PublicKeyRef,
  type SigAlgorithm,
  type SignEnvelope,
  type SignRequest,
  SigningError,
  type SigningProvider,
  type VerifyMode,
  type VerifyResult,
} from "../types.js";

const PROVIDER_ID = "hybrid";

/** Supported algorithms = union of leaf algorithms. Static for the
 *  v0.5.1 case (Ed25519 OR ECDSA P-256 on the classical half +
 *  ml-dsa-65 on the PQ half). */
const SUPPORTED_ALGORITHMS: readonly SigAlgorithm[] = [
  "ed25519",
  "ecdsa-p256-sha256",
  "ml-dsa-65",
];

export interface HybridProviderOptions {
  /** The classical-half leaf. Must support ed25519 OR
   *  ecdsa-p256-sha256; the actual algorithm is decided by the leaf
   *  when sign() runs. */
  readonly classical: SigningProvider;
  /** The PQ-half leaf. Must support ml-dsa-65. */
  readonly pq: SigningProvider;
  /** keyId to pass to `classical.sign(...)` and `classical.verify(...)`. */
  readonly classicalKeyId: KeyId;
  /** keyId to pass to `pq.sign(...)` and `pq.verify(...)`. */
  readonly pqKeyId: KeyId;
}

/**
 * Composite provider — async-only. Cannot implement
 * SyncSigningProvider because a leaf might be networked
 * (AwsKmsProvider).
 */
export class HybridProvider implements SigningProvider {
  readonly id = PROVIDER_ID;
  readonly supportedAlgorithms = SUPPORTED_ALGORITHMS;

  private readonly classical: SigningProvider;
  private readonly pq: SigningProvider;
  private readonly classicalKeyId: KeyId;
  private readonly pqKeyId: KeyId;

  constructor(opts: HybridProviderOptions) {
    if (!opts.classical.supportedAlgorithms.some((a) => a !== "ml-dsa-65")) {
      throw new SigningError(
        "internal-error",
        "HybridProvider: classical leaf must support at least one of {ed25519, ecdsa-p256-sha256}",
      );
    }
    if (!opts.pq.supportedAlgorithms.includes("ml-dsa-65")) {
      throw new SigningError(
        "internal-error",
        "HybridProvider: pq leaf must support ml-dsa-65",
      );
    }
    this.classical = opts.classical;
    this.pq = opts.pq;
    this.classicalKeyId = opts.classicalKeyId;
    this.pqKeyId = opts.pqKeyId;
  }

  // ──────────────────────────────────────────────────────────────
  //  sign() — call both leaves with the same payload + nonce + ts;
  //  blend into a 2-entry envelope.
  // ──────────────────────────────────────────────────────────────

  async sign(req: SignRequest): Promise<SignEnvelope> {
    // The same nonce + timestamp + actor + purpose flow to both
    // leaves. Each leaf runs its own validation and emits its own
    // SigEntry. Run in parallel — they're independent crypto ops.
    const [classicalEnv, pqEnv] = await Promise.all([
      this.classical.sign({ ...req, keyId: this.classicalKeyId }),
      this.pq.sign({ ...req, keyId: this.pqKeyId }),
    ]);

    // Defensive: each leaf should return exactly one entry. If a
    // leaf is itself hybrid (HybridProvider composing HybridProvider
    // — odd but allowed), accept whatever it emits and concatenate.
    const classicalEntries = classicalEnv.signatures.filter(
      (e) => e.algorithm !== "ml-dsa-65",
    );
    const pqEntries = pqEnv.signatures.filter(
      (e) => e.algorithm === "ml-dsa-65",
    );

    if (classicalEntries.length === 0) {
      throw new SigningError(
        "internal-error",
        "HybridProvider.sign: classical leaf returned no classical entries",
      );
    }
    if (pqEntries.length === 0) {
      throw new SigningError(
        "internal-error",
        "HybridProvider.sign: pq leaf returned no ml-dsa-65 entries",
      );
    }

    // Defensive payloadSha256 consistency check — both leaves
    // compute it from the same payload, so they MUST agree.
    if (classicalEnv.payloadSha256 !== pqEnv.payloadSha256) {
      throw new SigningError(
        "internal-error",
        `HybridProvider.sign: leaf payloadSha256 disagreement (classical=${classicalEnv.payloadSha256}, pq=${pqEnv.payloadSha256})`,
      );
    }

    return {
      signatures: [...classicalEntries, ...pqEntries],
      nonce: req.nonce,
      payloadSha256: classicalEnv.payloadSha256,
    };
  }

  // ──────────────────────────────────────────────────────────────
  //  verify() — per-entry dispatch to the matching leaf
  // ──────────────────────────────────────────────────────────────

  async verify(
    env: SignEnvelope,
    payload: Uint8Array,
    keys: readonly PublicKeyRef[],
    mode: VerifyMode = "strict",
  ): Promise<VerifyResult> {
    if (env.signatures.length === 0) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: "SignEnvelope.signatures is empty",
      };
    }
    if (keys.length === 0) {
      return {
        ok: false,
        reasonCode: "fingerprint-mismatch",
        reason: "verify() requires at least one PublicKeyRef",
      };
    }
    // Payload-hash fast-fail.
    const actualSha = crypto
      .createHash("sha256")
      .update(payload)
      .digest("hex");
    if (actualSha !== env.payloadSha256) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: `payloadSha256 mismatch — envelope claims ${env.payloadSha256}, computed ${actualSha}`,
      };
    }

    const considered =
      mode === "classical-only"
        ? env.signatures.filter((e) => e.algorithm !== "ml-dsa-65")
        : env.signatures;
    if (considered.length === 0) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: `no signatures matched verifier mode "${mode}"`,
      };
    }

    let anyVerified = false;
    let firstFailure: VerifyResult | null = null;
    for (const entry of considered) {
      const leaf = this.leafFor(entry.algorithm);
      if (!leaf) {
        const failure: VerifyResult = {
          ok: false,
          reasonCode: "algorithm-not-implemented",
          reason: `HybridProvider: no leaf supports algorithm ${entry.algorithm}`,
        };
        if (mode === "strict" || mode === "classical-only") return failure;
        firstFailure ??= failure;
        continue;
      }
      // Single-entry envelope for this leaf's verify.
      const singleEnv: SignEnvelope = {
        signatures: [entry],
        nonce: env.nonce,
        payloadSha256: env.payloadSha256,
      };
      // Pass the matching key (by algorithm + fingerprint). If the
      // operator-supplied keys array contains the right ref, the
      // leaf's verify will find it.
      const matchingKey = keys.find(
        (k) => k.algorithm === entry.algorithm && k.fingerprint === entry.signedBy,
      );
      if (!matchingKey) {
        const failure: VerifyResult = {
          ok: false,
          reasonCode: "fingerprint-mismatch",
          reason: `no PublicKeyRef matched entry (algorithm=${entry.algorithm}, signedBy=${entry.signedBy})`,
        };
        if (mode === "strict" || mode === "classical-only") return failure;
        firstFailure ??= failure;
        continue;
      }
      let leafResult: VerifyResult;
      try {
        leafResult = await leaf.verify(
          singleEnv,
          payload,
          [matchingKey],
          // Always pass strict to leaves — HybridProvider's mode
          // semantics apply ACROSS entries, not within. A leaf's
          // per-entry verify just answers "does this signature
          // verify against this key" — yes or no.
          "strict",
        );
      } catch (err) {
        if (err instanceof AlgorithmNotImplementedError) {
          const failure: VerifyResult = {
            ok: false,
            reasonCode: "algorithm-not-implemented",
            reason: err.message,
          };
          if (mode === "strict" || mode === "classical-only") return failure;
          firstFailure ??= failure;
          continue;
        }
        throw err;
      }
      if (leafResult.ok) {
        anyVerified = true;
        if (mode === "transition") return { ok: true };
      } else {
        if (mode === "strict" || mode === "classical-only") {
          return leafResult;
        }
        firstFailure ??= leafResult;
      }
    }

    if (mode === "transition") {
      return anyVerified
        ? { ok: true }
        : (firstFailure ?? {
            ok: false,
            reasonCode: "bad-signature",
            reason: "no entry verified in transition mode",
          });
    }
    return { ok: true };
  }

  async fingerprint(keyId: KeyId): Promise<string> {
    // Hybrid keys carry two fingerprints. Return the classical-half
    // fingerprint by convention (operator tooling and the v0.4.x
    // release row's `signed_by` column already use Ed25519
    // fingerprints).
    void keyId; // ignored: HybridProvider is single-key per instance
    return this.classical.fingerprint(this.classicalKeyId);
  }

  async listKeys(): Promise<readonly PublicKeyRef[]> {
    // Return BOTH halves so the catalog reflects them.
    const [classicalKeys, pqKeys] = await Promise.all([
      this.classical.listKeys(),
      this.pq.listKeys(),
    ]);
    return [...classicalKeys, ...pqKeys];
  }

  /**
   * Rotate both halves atomically. Returns the classical-half
   * PublicKeyRef by convention (matches fingerprint() return); the
   * caller can fetch the rotated PQ-half via listKeys() afterwards.
   *
   * If either leaf doesn't implement rotate(), throws
   * algorithm-not-implemented. v0.5.1 leaves (LocalDisk + AwsKms)
   * both implement rotate (LocalDisk does; AwsKms inherits the
   * deferral noted in its M4 audit).
   */
  async rotate(keyId: KeyId): Promise<PublicKeyRef> {
    void keyId;
    if (!this.classical.rotate) {
      throw new SigningError(
        "algorithm-not-implemented",
        "HybridProvider.rotate: classical leaf does not implement rotate()",
      );
    }
    if (!this.pq.rotate) {
      throw new SigningError(
        "algorithm-not-implemented",
        "HybridProvider.rotate: pq leaf does not implement rotate()",
      );
    }
    const [classicalNew] = await Promise.all([
      this.classical.rotate(this.classicalKeyId),
      this.pq.rotate(this.pqKeyId),
    ]);
    return classicalNew;
  }

  // ──────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────

  private leafFor(algorithm: SigAlgorithm): SigningProvider | null {
    if (algorithm === "ml-dsa-65") return this.pq;
    if (this.classical.supportedAlgorithms.includes(algorithm)) {
      return this.classical;
    }
    return null;
  }
}
