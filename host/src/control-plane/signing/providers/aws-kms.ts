/**
 * AwsKmsProvider — WS9 Milestone 4.
 *
 * AWS KMS-backed signing for ECDSA P-256. Implements the async
 * SigningProvider interface only (no SyncSigningProvider) — `kms:Sign`
 * is a network call.
 *
 * Trust + cost posture:
 *   - sign() = ONE network call (`kms:Sign`) per signing operation.
 *   - verify() = LOCAL `crypto.verify` against the cached public-key
 *     bytes. NO KMS round-trip required. This is the "verify
 *     anywhere" property — third-party verifiers (CI, audit
 *     consumers, registry mirrors) NEVER need KMS access.
 *   - fingerprint() = ONE `kms:GetPublicKey` on first call per ARN;
 *     cached thereafter for the lifetime of the provider instance.
 *     Catalog rows persist the cached public-key bytes so even a
 *     fresh process boot doesn't re-fetch.
 *   - listKeys() = pure catalog read; no KMS round-trip.
 *
 * **Milestone 4 scope:** ECDSA P-256 only. Ed25519 in AWS KMS is
 * region-dependent and ml-dsa-65 GA is operator-tagged at credential
 * setup — both deferred to a future milestone when those expansions
 * land on the algorithm matrix. AwsKmsProvider currently rejects sign
 * requests against keys whose catalog row carries ed25519 or
 * ml-dsa-65 algorithms.
 *
 * **Hybrid via AWS KMS** is similarly deferred. The design doc's
 * hybrid story for AwsKmsProvider is "operator-tagged: KMS ECDSA +
 * (KMS ML-DSA when GA OR local-fallback ML-DSA)". Building the
 * coordinator that blends two providers into one envelope is a
 * separate milestone; M4 ships classical-only AWS KMS signing.
 *
 * **Credentials:** per-org via the existing `cloud/credentials.ts`
 * encrypted-at-rest store (AES-GCM, env-key). No new credential silo.
 * Operators configure once via `signalman cloud creds set --provider
 * aws --org-id <id>` and any AwsKmsProvider for that org reuses them.
 */

import * as crypto from "node:crypto";

import {
  GetPublicKeyCommand,
  type KMSClient as IKmsClient,
  KMSClient as KmsClientCtor,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";

import type { AwsCredentialPlaintext } from "../../../cloud/credentials.js";
import {
  type KeyId,
  type PublicKeyRef,
  type SigAlgorithm,
  type SigEntry,
  type SignEnvelope,
  type SignRequest,
  SigningError,
  type SigningPolicyDefaults,
  DEFAULT_SIGNING_POLICY,
  type SigningProvider,
  type VerifyMode,
  type VerifyResult,
} from "../types.js";

const PROVIDER_ID = "aws-kms";

const SUPPORTED_ALGORITHMS_M4: readonly SigAlgorithm[] = ["ecdsa-p256-sha256"];

/** Minimal subset of the KMS client surface AwsKmsProvider uses. The
 *  full client is large; this is the shape mocks need to satisfy. */
export interface KmsClientLike {
  send(command: SignCommand): Promise<{ Signature?: Uint8Array }>;
  send(
    command: GetPublicKeyCommand,
  ): Promise<{ PublicKey?: Uint8Array; SigningAlgorithms?: string[] }>;
}

export interface AwsKmsProviderOptions {
  region: string;
  credentials: AwsCredentialPlaintext;
  /** Override the KMS client for tests. Production code passes
   *  nothing and AwsKmsProvider builds a real client from region +
   *  credentials. */
  client?: KmsClientLike;
  policy?: SigningPolicyDefaults;
}

interface CachedKey {
  /** SubjectPublicKeyInfo DER bytes (base64-encoded for catalog parity). */
  publicKeyDer: Buffer;
  algorithm: SigAlgorithm;
  fingerprint: string;
}

export class AwsKmsProvider implements SigningProvider {
  readonly id = PROVIDER_ID;
  readonly supportedAlgorithms = SUPPORTED_ALGORITHMS_M4;

  private readonly client: KmsClientLike;
  private readonly policy: SigningPolicyDefaults;
  /** Public-key cache keyed by KMS ARN (or alias-arn). Populated on
   *  first fingerprint() / sign() per key; never invalidated within a
   *  process — KMS keys are immutable (rotation = new ARN). */
  private readonly pubKeyCache = new Map<string, CachedKey>();

  constructor(opts: AwsKmsProviderOptions) {
    this.client =
      opts.client ??
      (new KmsClientCtor({
        region: opts.region,
        credentials: {
          accessKeyId: opts.credentials.access_key_id,
          secretAccessKey: opts.credentials.secret_access_key,
          sessionToken: opts.credentials.session_token,
        },
      }) as unknown as KmsClientLike);
    this.policy = opts.policy ?? DEFAULT_SIGNING_POLICY;
  }

  // ──────────────────────────────────────────────────────────────
  //  Public interface
  // ──────────────────────────────────────────────────────────────

  async sign(req: SignRequest): Promise<SignEnvelope> {
    const now = Date.now();
    this.validateRequest(req, now);

    const cached = await this.publicKeyFor(req.keyId);
    if (cached.algorithm !== "ecdsa-p256-sha256") {
      throw new SigningError(
        "algorithm-not-implemented",
        `AwsKmsProvider only supports ecdsa-p256-sha256 in M4; key ${req.keyId} is ${cached.algorithm}`,
      );
    }

    let result: { Signature?: Uint8Array };
    try {
      result = await this.client.send(
        new SignCommand({
          KeyId: req.keyId,
          Message: req.payload,
          MessageType: MessageType.RAW,
          SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
        }),
      );
    } catch (err) {
      const code = (err as { name?: string }).name ?? "internal-error";
      const mapped = mapKmsErrorCode(code);
      throw new SigningError(
        mapped,
        `kms:Sign failed for ${req.keyId}: ${(err as Error).message}`,
      );
    }
    if (!result.Signature || result.Signature.length === 0) {
      throw new SigningError(
        "io-error",
        `kms:Sign for ${req.keyId} returned an empty signature`,
      );
    }

    const sigBytes = Buffer.from(result.Signature);
    const payloadSha256 = crypto
      .createHash("sha256")
      .update(req.payload)
      .digest("hex");
    const entry: SigEntry = {
      signatureB64: sigBytes.toString("base64"),
      signedBy: cached.fingerprint,
      algorithm: "ecdsa-p256-sha256",
      signedAt: new Date().toISOString(),
    };
    return {
      signatures: [entry],
      nonce: req.nonce,
      payloadSha256,
    };
  }

  async verify(
    env: SignEnvelope,
    payload: Uint8Array,
    keys: readonly PublicKeyRef[],
    mode: VerifyMode = "strict",
  ): Promise<VerifyResult> {
    // Verify is purely local — no KMS round-trip. The cached public-key
    // bytes (provided via PublicKeyRef.publicKeyB64 from the catalog)
    // are sufficient. This keeps verifiers free of cloud-KMS deps,
    // per the design doc's §verify() runs on any provider invariant.
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
      if (entry.algorithm !== "ecdsa-p256-sha256") {
        const failure: VerifyResult = {
          ok: false,
          reasonCode: "algorithm-not-implemented",
          reason: `AwsKmsProvider.verify() only supports ecdsa-p256-sha256; got ${entry.algorithm}`,
        };
        if (mode === "strict" || mode === "classical-only") return failure;
        firstFailure ??= failure;
        continue;
      }
      const key = keys.find(
        (k) => k.algorithm === entry.algorithm && k.fingerprint === entry.signedBy,
      );
      if (!key) {
        const failure: VerifyResult = {
          ok: false,
          reasonCode: "fingerprint-mismatch",
          reason: `no PublicKeyRef matched entry (algorithm=${entry.algorithm}, signedBy=${entry.signedBy})`,
        };
        if (mode === "strict" || mode === "classical-only") return failure;
        firstFailure ??= failure;
        continue;
      }
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(key.publicKeyB64, "base64"),
        format: "der",
        type: "spki",
      });
      const sigBytes = Buffer.from(entry.signatureB64, "base64");
      const ok = crypto.verify("sha256", payload, publicKey, sigBytes);
      if (ok) {
        anyVerified = true;
        if (mode === "transition") return { ok: true };
      } else {
        const failure: VerifyResult = {
          ok: false,
          reasonCode: "bad-signature",
          reason: `signature is cryptographically invalid for ${entry.algorithm} entry`,
        };
        if (mode === "strict" || mode === "classical-only") return failure;
        firstFailure ??= failure;
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
    const cached = await this.publicKeyFor(keyId);
    return cached.fingerprint;
  }

  async listKeys(): Promise<readonly PublicKeyRef[]> {
    // AwsKmsProvider doesn't enumerate KMS-side; the catalog (M2) is
    // the source of truth for "which KMS keys does this org use".
    // CLI verbs that need to list keys go through
    // SigningProviderKeyRepo.list(orgId, {provider: 'aws-kms'}) —
    // that returns full PublicKeyRef-equivalent rows already.
    return [];
  }

  /**
   * Pre-populate the public-key cache for a known key. Used by the
   * registration flow (`signing keys add --provider aws-kms`) so
   * subsequent sign() calls don't need to hit `kms:GetPublicKey`
   * again. Idempotent.
   */
  cachePublicKey(args: {
    keyId: KeyId;
    publicKeyDer: Buffer;
    algorithm: SigAlgorithm;
    fingerprint: string;
  }): void {
    if (args.algorithm !== "ecdsa-p256-sha256") {
      throw new SigningError(
        "algorithm-not-implemented",
        `AwsKmsProvider.cachePublicKey: only ecdsa-p256-sha256 supported in M4; got ${args.algorithm}`,
      );
    }
    this.pubKeyCache.set(args.keyId, {
      publicKeyDer: args.publicKeyDer,
      algorithm: args.algorithm,
      fingerprint: args.fingerprint,
    });
  }

  /**
   * Fetch the public key for a KMS ARN. First call goes through
   * `kms:GetPublicKey`; subsequent calls return the cached entry.
   * The CLI flow calls this directly during `signing keys add` so
   * the result lands in both the in-memory cache AND the catalog
   * row's `public_key_b64` column.
   */
  async fetchPublicKey(keyId: KeyId): Promise<CachedKey> {
    return this.publicKeyFor(keyId);
  }

  // ──────────────────────────────────────────────────────────────
  //  Internals
  // ──────────────────────────────────────────────────────────────

  private async publicKeyFor(keyId: KeyId): Promise<CachedKey> {
    const cached = this.pubKeyCache.get(keyId);
    if (cached) return cached;
    let result: { PublicKey?: Uint8Array; SigningAlgorithms?: string[] };
    try {
      result = await this.client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    } catch (err) {
      const code = (err as { name?: string }).name ?? "internal-error";
      const mapped = mapKmsErrorCode(code);
      throw new SigningError(
        mapped,
        `kms:GetPublicKey failed for ${keyId}: ${(err as Error).message}`,
      );
    }
    if (!result.PublicKey || result.PublicKey.length === 0) {
      throw new SigningError(
        "io-error",
        `kms:GetPublicKey for ${keyId} returned an empty key`,
      );
    }
    const algorithm = detectAlgorithmFromSpki(Buffer.from(result.PublicKey));
    if (algorithm !== "ecdsa-p256-sha256") {
      throw new SigningError(
        "algorithm-not-implemented",
        `KMS key ${keyId} is ${algorithm}; AwsKmsProvider M4 supports only ecdsa-p256-sha256`,
      );
    }
    const publicKeyDer = Buffer.from(result.PublicKey);
    const fingerprint = crypto
      .createHash("sha256")
      .update(publicKeyDer)
      .digest("hex")
      .slice(0, 16);
    const entry: CachedKey = { publicKeyDer, algorithm, fingerprint };
    this.pubKeyCache.set(keyId, entry);
    return entry;
  }

  private validateRequest(req: SignRequest, now: number): void {
    if (!req.payload || req.payload.length === 0) {
      throw new SigningError(
        "payload-empty",
        "SignRequest.payload must be a non-empty Uint8Array",
      );
    }
    if (!req.purpose || req.purpose.trim().length === 0) {
      throw new SigningError(
        "purpose-empty",
        "SignRequest.purpose must be a non-empty string",
      );
    }
    if (!req.actor || !req.actor.cn || !req.actor.orgId) {
      throw new SigningError(
        "actor-missing",
        "SignRequest.actor must be populated with cn + orgId",
      );
    }
    if (
      typeof req.nonce !== "string" ||
      req.nonce.length !== this.policy.nonceLengthBytes * 2 ||
      !/^[0-9a-fA-F]+$/.test(req.nonce)
    ) {
      throw new SigningError(
        "nonce-malformed",
        `SignRequest.nonce must be ${this.policy.nonceLengthBytes * 2} hex chars`,
      );
    }
    const requestedAtMs = Date.parse(req.requestedAt);
    if (Number.isNaN(requestedAtMs)) {
      throw new SigningError(
        "clock-skew",
        `SignRequest.requestedAt not RFC 3339: "${req.requestedAt}"`,
      );
    }
    const skew = Math.abs(now - requestedAtMs);
    if (skew > this.policy.clockSkewToleranceMs) {
      throw new SigningError(
        "clock-skew",
        `requestedAt skew ${skew}ms exceeds policy ${this.policy.clockSkewToleranceMs}ms`,
      );
    }
  }
}

/**
 * Detect the algorithm of a SubjectPublicKeyInfo DER blob via Node's
 * crypto. Used after `kms:GetPublicKey` returns SPKI bytes. Throws if
 * the key is anything other than the algorithms AwsKmsProvider M4
 * supports — caller rewraps as SigningError.
 */
function detectAlgorithmFromSpki(spki: Buffer): SigAlgorithm {
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
  } catch (err) {
    throw new SigningError(
      "io-error",
      `failed to parse SPKI from KMS: ${(err as Error).message}`,
    );
  }
  const kind = publicKey.asymmetricKeyType;
  if (kind === "ed25519") return "ed25519";
  if (kind === "ec") {
    const details = publicKey.asymmetricKeyDetails;
    if (
      details?.namedCurve === "prime256v1" ||
      details?.namedCurve === "P-256"
    ) {
      return "ecdsa-p256-sha256";
    }
    throw new SigningError(
      "unknown-algorithm",
      `KMS public key uses curve ${details?.namedCurve ?? "unknown"}; only P-256 supported`,
    );
  }
  throw new SigningError(
    "unknown-algorithm",
    `KMS public key has asymmetricKeyType ${kind ?? "unknown"}; only ed25519/ec(P-256) supported`,
  );
}

/**
 * Map AWS SDK error class names to SigningErrorCode values. The list
 * is conservative — anything not explicitly mapped falls through to
 * `io-error` so audit logs flag it for operator follow-up.
 */
function mapKmsErrorCode(name: string): SigningError["code"] {
  switch (name) {
    case "AccessDeniedException":
      return "key-revoked"; // closest match — caller can't use this key
    case "DisabledException":
    case "KMSInvalidStateException":
      return "key-revoked";
    case "NotFoundException":
      return "key-not-found";
    case "ValidationException":
      return "unknown-algorithm";
    case "ThrottlingException":
    case "LimitExceededException":
    default:
      return "io-error";
  }
}

/**
 * Type guard: detect if a KmsClientLike is actually a real KMSClient
 * instance (for test/diagnostic introspection). Useful for tests that
 * want to assert the mocked client was actually called.
 */
export function isRealKmsClient(client: KmsClientLike): client is IKmsClient {
  return client instanceof KmsClientCtor;
}
