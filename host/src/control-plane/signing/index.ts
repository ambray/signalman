/**
 * Public entry point for the host signing module.
 *
 * Re-exports the SigningProvider interface types + the v0.5.0
 * `LocalDiskProvider` implementation. Subsequent providers
 * (AwsKmsProvider in Milestone 3, plus v0.6+ Azure KV / GCP KMS /
 * HSM) live under `./providers/` and get re-exported from here.
 *
 * Call sites that already had a stable v0.4.x public API
 * (`host/src/control-plane/build/signing.ts`, callers of
 * `signManifest` / `verifyManifest` / `generateKeypair` /
 * `fingerprintPublicKey`) keep using those functions unchanged; this
 * module is the surface for code that wants the full provider
 * abstraction.
 */

export type {
  ActorRef,
  KeyId,
  PublicKeyRef,
  SigAlgorithm,
  SigEntry,
  SignEnvelope,
  SignRequest,
  SigningPolicyDefaults,
  SigningProvider,
  SyncSigningProvider,
  SigningErrorCode,
  VerifyMode,
  VerifyResult,
} from "./types.js";

export {
  AlgorithmNotImplementedError,
  DEFAULT_SIGNING_POLICY,
  SigningError,
  isSyncSigningProvider,
} from "./types.js";

export {
  LocalDiskProvider,
  freshNonce,
  publicKeyRefFromMldsa65,
  publicKeyRefFromPem,
} from "./providers/local-disk.js";

export type {
  GenerateHybridKeyResult,
  LocalDiskProviderOptions,
} from "./providers/local-disk.js";
