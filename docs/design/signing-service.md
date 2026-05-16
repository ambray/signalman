# Signing Service

**Status:** design proposal (2026-05-16). No code shipped yet.
**Owner:** WS9 (`docs/workstreams/prompts/ws9-signing-service.md`)
**Predecessor:** v0.4.x direct on-disk signing — `host/src/control-plane/build/signing.ts`, `registry/src/signing.ts`, `service/src/tls.rs` (CA-key + denylist signing path). This doc is the v0.5.0+ progression that introduces a provider abstraction over key-material custody.

## Problem statement

Today (v0.4.x) every Signalman signing operation assumes the operator holds the private key on disk and the calling process can load the bytes directly:

| Surface | What loads the key | What it signs |
|---|---|---|
| **Release-manifest signing** | `host/src/control-plane/build/signing.ts` — reads `~/.signalman/keys/signing.key` (PKCS#8 PEM) via Node `crypto.createPrivateKey`. | Canonical JSON of `ReleaseManifest` (full manifest; signature persisted on the `release` row as `signature_b64` / `signed_by`). |
| **Registry re-signing** | `registry/src/signing.ts` — reads the local Ed25519 key the registry was configured with. | Canonical JSON of the registry `Manifest` with the `signature` field **stripped** (signature signs everything except itself). |
| **Service CA-key usage** (WS8) | `service/src/tls.rs` — loads `ca.pem` + `ca.key` (ECDSA P-256 from `rcgen`); signs every identity-cert leaf and the Ed25519 sidecar of `revoked.json`. | X.509 leaf certs (CA-signed) plus canonical JSON of the denylist. |

This works for solo operators and small teams. It does not work for three operator personas:

1. **Regulated operators** who can't store private keys on disk — HSM / Cloud KMS / TPM is mandatory for audit + compliance.
2. **Multi-operator orgs** where the signing key is shared across multiple humans — the on-disk model records that *some key with this fingerprint* signed, never *who* held the disk at the moment of signing.
3. **Detached signing workflows** — the signer is a different process (or host) than the builder. Useful for air-gapped or review-gated release flows where the build host has no signing key at all.

WS9 introduces a **signing-service abstraction** — a small, versioned interface that decouples *what to sign* from *how the key material is held*. The current on-disk key model becomes one provider implementation (`LocalDiskProvider`); subsequent providers add Cloud KMS / HSM / detached-operator / hardware-token support without touching call sites.

This is **security-sensitive cryptographic infrastructure work**. Every interface decision in this document names the alternatives and explains the chosen path. Operator review of §Locked design is required before any code lands.

## Goals

1. **One interface, many providers.** A single `SigningProvider` interface that the three current signing call sites and every future provider speak. Adding a provider does not change call sites; adding a call site does not change providers.
2. **Byte-parity with v0.4.x for the legacy path.** `LocalDiskProvider` reading the existing `~/.signalman/keys/signing.{pub,key}` files emits a signature **byte-identical** to the v0.4.x output for the same input. A regression test locks this invariant.
3. **Audit-log every signing op.** Every `sign()` writes one audit row at minimum — request, completion (or failure), key fingerprint, actor, purpose. The audit log answers "who signed what when, with which key" without ambiguity even when the underlying key material is held off-host.
4. **Replay-safe by construction.** Every `SignRequest` carries a nonce + timestamp. The audit log dedups by `(provider, keyId, nonce)`. A captured request submitted twice is rejected the second time.
5. **Versioned envelope.** `SignEnvelope` carries `signatures: SigEntry[]` (always ≥1 in v0.5.0, exactly 1 in practice) so v0.6+ quorum/multi-sig is an additive change, not a schema break.
6. **Preserve the existing on-disk key model as the default.** Operators on v0.4.x with `~/.signalman/keys/signing.{pub,key}` continue to work after upgrading with **no config change**. `LocalDiskProvider` is the implicit default.
7. **Preserve per-call-site canonicalization.** Canonicalization (manifest → bytes) is a call-site concern (release vs. registry vs. denylist), not a provider concern. The provider is given bytes and a key id; it returns signature bytes. Call sites keep ownership of "what gets signed."

## Non-goals (v0.5.0)

- **Replacing the canonical signing surface.** The Ed25519+canonical-JSON model on the release/registry paths stays. WS9 wraps it; it does not rewrite it.
- **Auto-rotation policy / cadence engine.** The provider exposes `rotate()`; an operator runs it. Cron-driven auto-rotate is a v0.6+ extension.
- **Quorum / m-of-n signing.** The envelope leaves room for it (`signatures: SigEntry[]`), but v0.5.0 always emits exactly one entry.
- **Detached-operator signing** (review-gated release flow with a separate signer process). Deferred to v0.6 unless operator overrides Q3.
- **External-CA delegation** (Vault / Smallstep / AWS PCA) for the service CA. The provider interface accommodates it (`AwsPcaProvider` would implement `mintCert()`-style ops that v0.5.0 doesn't define), but it ships later.
- **CRL distribution / OCSP for the WS8 denylist.** Out of WS9 scope; WS8 owns the denylist transport.
- **Hardware-token providers** (YubiHSM, PKCS#11 smartcards, TPM). The interface accommodates them; an implementation ships in v0.6+.

## The `SigningProvider` interface

The interface is intentionally **small**. Four required methods, one optional (`rotate`).

```typescript
// host/src/control-plane/signing/types.ts

/**
 * Signature algorithm. v0.5.0 ships ed25519 (matches v0.4.x) and
 * ecdsa-p256-sha256 (so cloud-KMS providers that don't expose
 * Ed25519 still work).
 *
 * RSA variants are deliberately omitted — bigger signatures, slower
 * verification, no operator request driving them. Adding `rsa-2048`
 * is a future, additive change.
 */
export type SigAlgorithm = "ed25519" | "ecdsa-p256-sha256";

/**
 * Opaque key identifier. The provider decides the format:
 *
 *   LocalDiskProvider:  filesystem alias like "default" → maps to
 *                       ~/.signalman/keys/signing.{pub,key}. Custom
 *                       paths via "/abs/path/to/key.pem".
 *   AwsKmsProvider:     KMS key ARN
 *                       ("arn:aws:kms:us-east-1:1234:key/abc").
 *   AzureKvProvider:    "{vault-url}/keys/{name}/{version-or-empty}".
 *
 * Callers MUST treat keyId as opaque. The provider parses it.
 */
export type KeyId = string;

/**
 * Public-key reference. Always available without a provider call —
 * the public-key material is cached locally for fingerprint
 * verification and verify() short-circuits.
 */
export interface PublicKeyRef {
  readonly keyId: KeyId;
  readonly provider: string;        // provider.id
  readonly algorithm: SigAlgorithm;
  /** DER SubjectPublicKeyInfo, base64-encoded. */
  readonly publicKeyDerB64: string;
  /** First 16 hex chars of sha256(DER-SPKI). Same format as v0.4.x. */
  readonly fingerprint: string;
}

/**
 * The actor that authored the sign request. The provider authorizes
 * against this; the audit log records it; no surface accepts a
 * sign request without one. This is the WS8 identity-cert identity
 * when WS8 + WS9 both ship.
 */
export interface ActorRef {
  readonly kind: "user" | "machine" | "service";
  readonly cn: string;
  readonly orgId: string;
}

/**
 * A sign request. The payload is bytes — canonicalization has
 * already happened upstream (release-manifest canonicalizer,
 * registry-manifest canonicalizer, denylist canonicalizer). The
 * provider does not parse the payload; it signs the bytes.
 *
 * `nonce` + `requestedAt` are mandatory:
 *   - The audit log records both.
 *   - Providers reject a request with skew > 60s (default; per-provider
 *     configurable) — a captured request can't be replayed once its
 *     freshness window closes.
 *   - The audit log deduplicates by (provider, keyId, nonce) and
 *     rejects a second submission of the same nonce.
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
   *    "service.cert.mint:<subject-cn>"
   */
  readonly purpose: string;
  readonly actor: ActorRef;
}

/**
 * A single signature entry. v0.5.0 always emits exactly one;
 * SignEnvelope carries `SigEntry[]` (not `SigEntry`) so v0.6+ quorum
 * is an additive change.
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
 * row, denylist sidecar).
 */
export interface SignEnvelope {
  readonly signatures: SigEntry[];      // always length 1 in v0.5.0
  /** Echoed from the SignRequest. The audit log keys on this. */
  readonly nonce: string;
  /** sha256(payload), hex-encoded lowercase. Verifier recomputes
   *  and compares; mismatch is a fast-fail signal. */
  readonly payloadSha256: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Populated only when ok=false. Stable, machine-readable codes
   *  (e.g. "fingerprint-mismatch", "bad-signature", "unknown-algorithm"). */
  readonly reasonCode?: string;
  /** Optional human-readable reason. */
  readonly reason?: string;
}

export interface SigningProvider {
  /** Stable provider id: "local-disk" | "aws-kms" | "azure-key-vault" | ... */
  readonly id: string;

  /** Algorithms this provider can produce. The control plane uses this
   *  to pick a provider for a given algorithm requirement. */
  readonly supportedAlgorithms: readonly SigAlgorithm[];

  sign(req: SignRequest): Promise<SignEnvelope>;

  /** Verify a signature against payload bytes + a known public key.
   *  Verify can run on ANY provider for ANY envelope when the algorithm
   *  matches — verification does not require the producing provider.
   *  This keeps verifiers (CI, third parties) free of the cloud-KMS
   *  dependency that producers may have. */
  verify(
    env: SignEnvelope,
    payload: Uint8Array,
    key: PublicKeyRef,
  ): Promise<VerifyResult>;

  /** Compute the fingerprint of a key managed by this provider. The
   *  provider may fetch the public key over the network for cloud-KMS
   *  backends and cache it. */
  fingerprint(keyId: KeyId): Promise<string>;

  /** Enumerate the keys this provider knows about. For LocalDiskProvider:
   *  files in ~/.signalman/keys/. For cloud-KMS: keys tagged for
   *  signalman use in the configured account/vault. */
  listKeys(): Promise<readonly PublicKeyRef[]>;

  /** Rotate a key. Implementation is provider-specific:
   *    LocalDiskProvider: generate a fresh keypair, archive the old to
   *      ~/.signalman/keys/archive/<unix-ms>/, install the new at the
   *      same path. Returns the new PublicKeyRef.
   *    AwsKmsProvider:    create a new key in KMS, update the local key
   *      registry alias, archive the old key (KMS PendingDeletion or tag
   *      flip). Returns the new PublicKeyRef.
   *
   *  Rotation is operator-initiated in v0.5.0. v0.6+ may layer a
   *  policy-driven scheduler on top. Every rotation emits a
   *  `signing.key_rotated` audit row. */
  rotate?(keyId: KeyId): Promise<PublicKeyRef>;
}
```

### Why the interface is shaped this way

- **`payload: Uint8Array`, not `manifest: T`.** Canonicalization is a call-site concern. The release path canonicalizes a `ReleaseManifest`; the registry path strips `signature` from a registry `Manifest` then canonicalizes; the denylist path canonicalizes a `Revoked` shape. Mixing those into the provider would (a) couple the provider to the host's type system, and (b) blur the byte-parity invariant. Bytes in, bytes out.

- **`nonce` + `requestedAt` are mandatory.** They cost nothing for `LocalDiskProvider` and they're load-bearing for `AwsKmsProvider` and any future networked provider. Making them mandatory at the interface forces every call site to thread them, including the legacy path. The `signing.requested` audit row captures both verbatim.

- **`SigEntry[]`, not `SigEntry`.** Quorum/multi-sig becomes an additive change. v0.5.0 callers always read `env.signatures[0]`; v0.6+ callers iterate. The cost today is one extra array allocation per signature — trivial.

- **`verify()` runs on any provider.** A registry running `LocalDiskProvider` can verify a release manifest signed by `AwsKmsProvider` as long as the algorithm matches and the verifier has the public key. This keeps third-party verification free of cloud-KMS dependencies. Concretely: the verifier dispatches on `env.signatures[0].algorithm`, picks a provider that supports it (the `LocalDiskProvider` always supports the v0.4.x algorithms), and verifies in-process with Node `crypto.verify`.

- **`rotate()` is optional.** A future read-only provider (e.g. a verification-only proxy in front of a vault) doesn't need it.

### Per-call-site canonicalization preservation

WS9 changes **only** the cryptographic step. Canonicalization stays put.

| Call site | Pre-WS9 module | Post-WS9 |
|---|---|---|
| Release-manifest signing | `host/src/control-plane/build/signing.ts` — `canonicalManifestBytes()` + `crypto.sign(null, …)` | `canonicalManifestBytes()` stays; `crypto.sign(null, …)` becomes `provider.sign({ payload: bytes, … })`. |
| Registry re-signing | `registry/src/signing.ts` — strips `signature` field, then canonicalizes, then `crypto.sign(null, …)` | strip + canonicalize stays; `crypto.sign(null, …)` becomes `provider.sign({ payload: bytes, … })`. |
| Denylist signing (WS8) | `service/src/tls.rs` (when WS8 lands) — canonical JSON of revoked-list + `Ed25519` over the bytes | Rust-side analogue of the provider (see §Cross-language story). |

The **byte-parity test** at Milestone 1: take a fixed-input release manifest from a v0.4.x test fixture, run it through both the legacy direct path AND the new `provider.sign()` path with `LocalDiskProvider`, assert the resulting `signature_b64` strings are byte-identical. Same for the registry re-signing path with its signature-stripping variant.

### Cross-language story

Two of the three current signing surfaces are TypeScript (host + registry). The third is Rust (service CA-key and WS8 denylist). v0.5.0:

- **TypeScript** ships the full provider interface (`host/src/control-plane/signing/`).
- **Registry** mirrors the interface in its own module (`registry/src/signing/providers/`) — duplicated, not shared, for the same reason `registry/src/signing.ts` duplicated `host/src/control-plane/build/signing.ts` originally: registry is a standalone OSS sibling and must not depend on `host/`.
- **Rust** does NOT get a full provider abstraction in v0.5.0. Milestone 4 (which is gated on WS8 having merged) wires `service/src/tls.rs`'s CA-key load + denylist-sign paths through a minimal Rust shim that calls into the host's provider over the existing mTLS control-plane RPC. The Rust side does not need a generic provider abstraction; it needs *one* path — "ask the control plane to sign these bytes with the CA key" — and the control plane routes that to whichever provider holds the key.

This keeps the Rust surface tight and avoids reimplementing AWS KMS / Azure KV / GCP KMS clients in Rust. The cost is that the privileged Windows daemon now has a network dependency on the control plane for CA-key operations; the existing mTLS topology already supports that.

### Algorithm matrix per provider (v0.5.0)

| Provider | `ed25519` | `ecdsa-p256-sha256` |
|---|---|---|
| `LocalDiskProvider` | required (legacy parity) | optional (only when minted that way) |
| `AwsKmsProvider`     | iff KMS exposes Ed25519 in the operator's region; else require `ecdsa-p256-sha256` | required |
| `AzureKvProvider`    | NOT available on Azure Key Vault Standard; require `ecdsa-p256-sha256` | required |
| `GcpKmsProvider`     | NOT available on GCP Cloud KMS; require `ecdsa-p256-sha256` | required |

The reason §Open product questions Q1 + Q2 are coupled: if v0.5.0 ships any of the major cloud-KMS backends, we cannot stay Ed25519-only. The default recommendation below assumes ECDSA P-256 lands together with the first cloud provider.

## Provider implementations (v0.5.0 scope, subject to operator decision Q1)

### `LocalDiskProvider`

Ships in Milestone 1. Required regardless of Q1 outcome.

- **Default `keyId`:** `"default"` → `~/.signalman/keys/signing.{pub,key}`. Operators on v0.4.x with this layout require no config change.
- **Custom `keyId`:** absolute filesystem path to a PEM private key. The public-key path is inferred by stripping `.key` and appending `.pub`.
- **Wire format on disk:** unchanged — PKCS#8 PEM for private, SPKI PEM for public. v0.4.x byte-parity invariant requires it.
- **Algorithm detection:** read `keyObject.asymmetricKeyType` (Node `crypto` exposes it). Reject if not in `supportedAlgorithms`.
- **`rotate()`:** generate a fresh keypair via `crypto.generateKeyPairSync()`, archive the old `signing.{pub,key}` to `~/.signalman/keys/archive/<unix-ms>/` (preserving filesystem permissions), write the new pair to `signing.{pub,key}` with mode `0600`. Emit `signing.key_rotated`.
- **Authorization:** none beyond filesystem permissions. The local-disk path trusts whatever can read the key file. Same trust posture as v0.4.x.

### `AwsKmsProvider` (Q1=B recommendation)

Ships in Milestone 3 if Q1 lands on AWS KMS.

- **Credentials:** reuses `host/src/cloud/credentials.ts` per-org storage. AWS access key + secret + optional session token + region; encrypted at rest under `SIGNALMAN_CRED_KEY`. The provider does NOT introduce a new credential silo.
- **Key registry:** per-org table `signing_provider_key` (see §Storage) maps `keyId` → KMS ARN + cached public key. The cache is keyed by ARN; cache miss triggers `kms:GetPublicKey`.
- **Sign:** `kms:Sign` with `MessageType=RAW` (we sign canonical JSON bytes, not pre-hashed) and `SigningAlgorithm=ECDSA_SHA_256` for P-256.
- **Verify:** Node `crypto.verify` with the cached public key; no KMS round-trip needed. (This is what makes verify-anywhere work — verifiers never need KMS access.)
- **`rotate()`:** `kms:CreateKey` for a new key, update the local `signing_provider_key` row to point at the new ARN, schedule old ARN for `PendingWindowInDays=30` deletion via `kms:ScheduleKeyDeletion`. Emit `signing.key_rotated` with `old_arn` + `new_arn` in the detail blob.
- **Algorithm:** `ecdsa-p256-sha256` (always). AWS KMS Ed25519 availability is region-dependent; we don't conditionally enable it in v0.5.0.

### `AzureKvProvider` (Q1=C alternative)

Same shape as `AwsKmsProvider`, against `azure-keyvault-keys` SDK. Algorithm: `ecdsa-p256-sha256`. Credentials reuse the existing Azure plaintext shape in `cloud/credentials.ts`.

### `GcpKmsProvider` (Q1=D alternative)

Same shape, against `@google-cloud/kms` SDK. Algorithm: `ecdsa-p256-sha256`. **Requires new credential plumbing** — GCP isn't in `cloud/credentials.ts` today. Adds a `GcpCredentialPlaintext` shape.

## Audit-log integration

New canonical action codes (added to the table in `docs/supply-chain.md`):

| Action code | When written |
|---|---|
| `signing.requested` | At the entry to `provider.sign()`. Detail: `{provider, keyId, algorithm, nonce, requestedAt, purpose, payloadSha256}`. |
| `signing.completed` | After `provider.sign()` returns successfully. Detail: `{provider, keyId, signedBy, signedAt, nonce, payloadSha256}`. Pairs with `signing.requested` on `(actor, nonce)`. |
| `signing.failed` | When `provider.sign()` throws. Detail: `{provider, keyId, nonce, errorCode, errorMessage}`. |
| `signing.key_added` | `signalman signing keys add` (register a cloud-KMS key id with the local catalog). |
| `signing.key_revoked` | Operator marks a key as no longer usable for new sign requests. The key is not deleted — past signatures remain verifiable. |
| `signing.key_rotated` | `provider.rotate(keyId)` succeeds. Detail: `{provider, oldKeyId, newKeyId, oldFingerprint, newFingerprint}`. |

The audit-log row's `actor` is `req.actor.cn` (CN of the WS8 identity cert) or, in the absence of WS8 having merged, the v0.4.x bearer-token-prefix actor. `entity_type` is `signing_key`; `entity_id` is the key fingerprint.

**Nonce-based replay rejection.** Before writing `signing.requested`, the host queries the audit log for an existing row with `(action='signing.requested', actor=req.actor, detail.nonce=req.nonce)`. If found, the request is rejected with `signing.failed: replay-detected`. The lookup is indexed (see §Storage migration 0090).

## Storage (migration 0090)

```sql
-- migration 0090_signing_provider_key.sql (v0.5.0)
--
-- Catalog of provider-managed keys. The control plane reads this to
-- dispatch sign requests to the right provider. Rows are written by
-- `signalman signing keys add`.
CREATE TABLE signing_provider_key (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES org (id),
  provider        TEXT NOT NULL,           -- "local-disk" | "aws-kms" | ...
  key_id          TEXT NOT NULL,           -- provider-opaque
  algorithm       TEXT NOT NULL CHECK (algorithm IN ('ed25519', 'ecdsa-p256-sha256')),
  fingerprint     TEXT NOT NULL,           -- sha256(DER-SPKI), 16 hex chars
  public_key_der  TEXT NOT NULL,           -- base64-encoded; cached for verify
  label           TEXT,                    -- operator-supplied human label
  added_by        TEXT NOT NULL,           -- actor that called `keys add`
  added_at        TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT,
  rotated_to      TEXT,                    -- self-FK; populated on rotate
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE UNIQUE INDEX signing_provider_key_fingerprint_unique
  ON signing_provider_key (org_id, fingerprint)
  WHERE deleted_at IS NULL;

CREATE INDEX signing_provider_key_provider_idx
  ON signing_provider_key (org_id, provider)
  WHERE deleted_at IS NULL AND revoked_at IS NULL;

-- migration 0091_signing_nonce.sql (v0.5.0)
--
-- Replay-protection ledger. The audit log already records every
-- `signing.requested` row, but querying audit-log JSON-blob fields by
-- index is slow on SQLite; this table denormalizes (actor, nonce) for
-- O(1) replay detection at the sign hot path. Rows TTL out at 24h
-- (the maximum SignRequest skew tolerance × 1440).
CREATE TABLE signing_nonce (
  org_id      TEXT NOT NULL,
  actor_cn    TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (org_id, actor_cn, nonce)
);

CREATE INDEX signing_nonce_ttl_idx
  ON signing_nonce (requested_at);  -- for the GC sweeper
```

Migration block 0090–0099 is reserved for WS9 per `docs/workstreams/prompts/ws9-signing-service.md`. The two tables above use 0090 + 0091; 0092–0099 remain free for follow-up extensions (e.g., quorum-policy table when v0.6 lands).

## CLI + MCP surface

New top-level verb: `signalman signing <subcommand>`. All write audit-log rows.

```bash
# List configured providers + their per-org status.
signalman signing providers list
# Columns: provider, status (configured | not-configured), keys-count

# List keys per provider.
signalman signing keys list [--provider X] [--include-revoked]
# Columns: provider, key-id, algorithm, fingerprint, label, added-at

# Register a new cloud-KMS key with the local catalog.
signalman signing keys add \
  --provider aws-kms \
  --key-id arn:aws:kms:us-east-1:123:key/abc \
  [--label "release-signing-prod"]
# audit: signing.key_added

# Revoke a key (does NOT delete; past signatures stay verifiable).
signalman signing keys revoke <fingerprint-or-label> --reason "key compromised"
# audit: signing.key_revoked

# Rotate a key (provider implementation-specific).
signalman signing keys rotate <fingerprint-or-label>
# audit: signing.key_rotated

# Verify a signature using whichever provider holds the key.
signalman signing verify <release-id-or-manifest-file>
# audit: none (read-only; HTTP access log only)
```

The existing v0.4.x verbs (`signalman key generate`, `signalman key fingerprint`, `signalman release verify`) stay. v0.5.0 documents them as the `LocalDiskProvider` shortcut surface; they remain functional. A future v0.6+ deprecation pass folds them into `signalman signing keys add --provider local-disk --generate`.

MCP mirrors:

- `signalman_signing_keys_list`
- `signalman_signing_keys_add`
- `signalman_signing_keys_revoke`
- `signalman_signing_keys_rotate`
- `signalman_signing_verify`

## Migration story for existing surfaces

### Release-manifest signing (`host/src/control-plane/build/signing.ts`)

- The file becomes a thin shim that:
  1. Canonicalizes the manifest (`canonicalManifestBytes()` — unchanged).
  2. Resolves the provider via the new `pickProvider()` helper. v0.4.x default: `LocalDiskProvider` with `keyId="default"`.
  3. Calls `provider.sign({ payload, nonce, requestedAt, purpose: "release.manifest:…", actor })`.
  4. Persists `signature_b64` + `signed_by` on the release row (existing columns from migration 0004; no schema change).
- The `signManifest()` and `verifyManifest()` public exports keep their existing signatures (the `privateKeyPem: string` parameter is interpreted as "an inline LocalDiskProvider with this PEM as the key material" — preserves test-suite ergonomics).

### Registry re-signing (`registry/src/signing.ts`)

- Identical shape change. Canonicalization (with signature-strip) stays; `crypto.sign(...)` becomes `provider.sign(...)`.
- The provider abstraction in `registry/src/signing/providers/` is **duplicated**, not imported from `host/`. Same reasoning as the original duplication of `signing.ts`: registry is a standalone OSS sibling.

### WS8 denylist signing (`service/src/tls.rs`) — Milestone 4

- The privileged daemon calls the host's control-plane RPC `SignDenylist(bytes) → SignEnvelope` instead of loading `ca.key` directly.
- v0.5.0 default: the control plane routes this to `LocalDiskProvider` with `keyId="ca"` (a new alias to `%ProgramData%\Signalman\certs\ca.key`).
- A regulated operator who wants the CA key off disk reconfigures the control plane to route `keyId="ca"` to e.g. `AwsKmsProvider`. **No service code change needed.**

## Test taxonomy

- **Unit (TS):**
  - Canonicalization parity: pre-WS9 vs post-WS9 produces identical bytes for fixed-input manifests (release + registry).
  - Signature byte-equality: `LocalDiskProvider.sign(payload, key)` produces the exact same `signature_b64` as v0.4.x `crypto.sign(null, payload, key)` for fixed input.
  - Provider error taxonomy: each provider documents its error codes and unit tests cover each one (`fingerprint-mismatch`, `unknown-algorithm`, `replay-detected`, `clock-skew`, `key-revoked`, `key-not-found`).
  - Nonce / timestamp validation: rejects skew > 60s, rejects duplicate nonce, accepts fresh nonce.
  - Audit-row shape: the `signing.requested` row's `detail` blob contains exactly the documented fields.
- **Unit (Rust, Milestone 4 only):**
  - `service/src/tls.rs` denylist-sign call site shifts to RPC; mock the RPC and verify the bytes that go over match the canonical denylist.
- **Integration (TS):**
  - End-to-end `signalman release build --sign`: artifact written, audit row written, signature verifies.
  - End-to-end registry virtual-upstream re-sign: cache miss → upstream fetch → provider.sign → manifest stored with new signature.
  - End-to-end `signalman signing verify <release-id>`: returns ok=true; mutated input returns ok=false.
- **Integration (cloud, gated lane):**
  - `SIGNALMAN_KMS_TEST_AWS_KEY_ARN=…` env-var-gated test runs the AwsKmsProvider against a real KMS key. Same shape as the existing `cloud-integration` lane.
- **System (TS + Rust, Milestone 4 only):**
  - WS8 denylist signing: control plane configured with `LocalDiskProvider`; service requests a denylist sign; daemon writes the file with the matching signature; an independent verifier (the host CLI) accepts the file.
- **Smoke:**
  - `signalman signing --help` lists all subcommands.
  - MCP tool listing includes all new tools.
  - Byte-parity test on a fixed release manifest (the regression-canary for the whole epic).

Coverage gate: **≥80% lines / ≥70% branches** across new code (host signing module, registry signing-providers module, CLI signing verb, MCP signing tools).

## Definition of Done

1. Migration 0090 + 0091 land; SQLite + pg-mem both clean.
2. `LocalDiskProvider` ships and all v0.4.x signing call sites route through it.
3. The cloud provider from §Open product questions Q1 ships (or §Q1 lands on "defer all" with operator approval).
4. Audit log records `signing.*` action codes for every signing operation.
5. **Byte-parity test passes**: `LocalDiskProvider` output is byte-identical to v0.4.x `signing.ts` for a fixed input.
6. `cd host && npm test` — full suite green.
7. `cd host && npx tsc --noEmit` — zero errors.
8. `cd registry && npm test` — full suite green.
9. `cargo test --workspace` — zero failures.
10. Coverage holds per gate (≥80% lines / ≥70% branches).
11. **4-lens audit**: QA / Architecture / Product / Security all PASS or explicit operator-review concern flagged. **Security lens is non-negotiable here** — cryptographic infrastructure.
12. `docs/supply-chain.md` updated: §Key model expanded, §Audit log canonical action codes table gains the `signing.*` row, §Operator workflow gains a §"Switching providers" subsection.
13. `docs/design/signing-service.md` (this doc) §Status flipped to "shipped in v0.5.0".
14. Operator-led end-to-end test on Windows: build a release with `LocalDiskProvider`, verify with `LocalDiskProvider`; build a release with the new cloud provider, verify with the matching provider. Outcomes recorded in `.workstream-status.md`.

## Open product questions

The following eight questions require operator answers before any code lands. Each carries a recommended default and the reasoning behind it.

### Q1 — Provider set for v0.5.0

**Question:** Does v0.5.0 ship `LocalDiskProvider` only, or `LocalDiskProvider` + one cloud provider?

| Option | Rationale | Cost |
|---|---|---|
| A — `LocalDiskProvider` only | Smallest blast radius; lift-and-shift validates the abstraction without external dependency. | The abstraction stays untested against an *actually different* key-custody story until v0.6. The §Goal 1 promise ("adding a provider does not change call sites") is not exercised. |
| **B — `LocalDiskProvider` + `AwsKmsProvider`** (rec) | AWS KMS has the largest installed base of regulated operators. `cloud/credentials.ts` already has AWS plaintext shape. Cloud-KMS forces the interface to grapple with network failures, public-key caching, and ECDSA — discovering those in v0.5.0 is cheaper than v0.6. | Adds AWS SDK as a host dependency; adds the gated KMS test lane. |
| C — `LocalDiskProvider` + `AzureKvProvider` | Same shape as B; Azure credentials already in `cloud/credentials.ts`. | Same as B but for Azure SDK. |
| D — `LocalDiskProvider` + `GcpKmsProvider` | Same shape as B. | Requires new GCP credential plumbing (not in `cloud/credentials.ts` today). |

**Recommendation: B.** AWS KMS first, others as v0.6+ follow-ups. The interface choice is the load-bearing decision; AWS exercises it credibly.

### Q2 — Algorithm scope

**Question:** Ed25519-only (matches v0.4.x) or also ECDSA P-256? RSA-2048 too?

The answer is coupled to Q1. If Q1 = A (LocalDisk only), Ed25519-only suffices. If Q1 ∈ {B, C, D}, ECDSA P-256 is required because every major cloud KMS reliably supports ECDSA P-256 but not all of them support Ed25519 (Azure KV doesn't; GCP KMS doesn't; AWS KMS only in some regions).

| Option | Rationale | Cost |
|---|---|---|
| A — Ed25519 only | Matches v0.4.x exactly. Byte-parity is trivially satisfied for every provider. | Cloud-KMS providers in §Q1 options B/C/D become non-implementable. |
| **B — Ed25519 + ECDSA P-256** (rec, paired with Q1=B) | ECDSA P-256 is universally supported by cloud KMS. Existing release rows stay Ed25519 (the algorithm is per-key, not per-signature-call). | Verifier code path branches on algorithm. Test matrix doubles. |
| C — Ed25519 + ECDSA P-256 + RSA-2048 | Maximum cloud-KMS compatibility (including legacy keys). | RSA signatures are 256 bytes (vs 64 for Ed25519, 64 for P-256) — bigger release rows; slower verification. No operator request driving it. |

**Recommendation: B**, paired with Q1=B.

### Q3 — Detached-operator signing

**Question:** In scope for v0.5.0, or deferred?

| Option | Rationale | Cost |
|---|---|---|
| **A — Deferred to v0.6+** (rec) | Detached signing requires a transport (file-drop + watch, or HTTP POST + poll), an identity-binding mechanism (the signing host's identity may differ from the build host's), and a UX (operator approves a queued request). All non-trivial. v0.5.0's three providers already cover the regulated + multi-operator pain points. | Operators who specifically wanted "build host has no key" must wait. |
| B — In scope (file-drop transport) | Operator drops a JSON SignRequest into a watched directory; the signer host produces a SignEnvelope file. Simple, no network. | Polling latency; cross-host filesystem sync is operator's problem. |
| C — In scope (HTTP POST + poll) | Build host POSTs to a signer-host endpoint; signer host returns a queued request id; build host polls. | Network surface; needs its own auth (mTLS); duplicates a lot of the cloud-KMS shape with worse UX. |

**Recommendation: A.** Re-evaluate at v0.6 once at least one operator has asked specifically for this.

### Q4 — Per-signature audit trail location

**Question:** Existing audit-log table with new `sign.*` action codes, or a separate `signing_events` table?

| Option | Rationale | Cost |
|---|---|---|
| **A — Existing audit log** (rec) | Reuses query surface (`signalman audit list`, HTTP `/v1/audit`). Single source of truth. The audit-log table already records actor / entity / detail JSON — every field a signing event needs. | JSON-blob detail field is not directly indexable; replay-detection needs the separate `signing_nonce` table (migration 0091) for performance. |
| B — Separate `signing_events` table | Indexed-by-key-fingerprint queries are O(log n) on a typed column. Schema is self-documenting. | Duplicates audit log shape; query-time joins for cross-cutting reports; two tables to keep in sync. |

**Recommendation: A**, with `signing_nonce` (migration 0091) as the dedicated index for the replay-protection hot path.

### Q5 — Replay protection

**Question:** Does the protocol carry a nonce + timestamp so a captured sign request can't be replayed?

| Option | Rationale | Cost |
|---|---|---|
| **A — Yes, mandatory in `SignRequest`** (rec) | Cheap (16-byte random + RFC 3339 timestamp), critical for any networked provider (`AwsKmsProvider`, future detached-signing). Eliminates an entire class of attacks before they become possible. | Every caller threads two extra fields. Free for `LocalDiskProvider` (no benefit, no cost). |
| B — Optional | Callers that don't need it skip it. | "Optional security" is "absent security" in practice; networked-provider code paths can't trust the field is set. |
| C — No replay protection | Smaller interface. | Captured requests can be replayed indefinitely. Unacceptable for `AwsKmsProvider`. |

**Recommendation: A.**

### Q6 — Authorization

**Question:** Does the signing service authorize the caller, and if so, what's the policy model?

| Option | Rationale | Cost |
|---|---|---|
| **A — mTLS-based caller identity + per-key actor allow-list** (rec) | Reuses the WS8 identity-cert work. Each `signing_provider_key` row carries an `allowed_actors` JSON column (CN patterns) or, more conservatively, a separate `signing_key_acl` table. Authorization decision is a one-row lookup. | Requires WS8 having shipped (or a fallback to bearer-token-prefix actors). One extra table or column. |
| B — Bearer-token only | Simpler. Matches v0.4.x trust posture. | No per-key access control; any actor that can call `provider.sign()` can sign with any key. |
| C — Audit-log-only trust | No authorization; the audit log is the only record. | Inadequate for regulated operators (audit ≠ control). |

**Recommendation: A.** v0.5.0 can ship with a single-rule default (the org's primary actor) and let operators add ACL rules over time. If WS8 hasn't merged when WS9 reaches Milestone 2, the fallback is bearer-token-prefix.

### Q7 — Quorum / multi-sig

**Question:** In scope for v0.5.0, or deferred? If deferred, is the v0.5.0 envelope shape forward-compatible?

| Option | Rationale | Cost |
|---|---|---|
| **A — Deferred; envelope already shaped for it** (rec) | `SignEnvelope.signatures: SigEntry[]` always carries exactly one entry in v0.5.0; v0.6+ quorum adds entries without a schema break. Cost of forward-compat today: one array allocation per signature. | None to operators; trivial perf overhead. |
| B — In scope for v0.5.0 | Operators with strict m-of-n requirements get them earlier. | Needs a quorum-policy table, request-state machine (pending → partial → complete), and UX for the second/third signer. None of this is justified by an operator request today. |

**Recommendation: A.**

### Q8 — Key rotation

**Question:** Who initiates rotation, on what cadence? Provider concern or control-plane concern?

| Option | Rationale | Cost |
|---|---|---|
| **A — Provider concern; operator-initiated; v0.5.0 ships `provider.rotate(keyId)` + `signalman signing keys rotate <fp>`** (rec) | Each provider knows how to rotate its own custody (LocalDisk archives the file; AwsKms creates a new ARN). Control plane orchestrates the audit row. Operator picks cadence. | v0.5.0 has no auto-rotation scheduler. |
| B — Control-plane concern; control plane mints fresh keys and reassigns | Centralized policy. Easier to enforce "all keys rotate every 90 days". | Control plane needs provider-specific knowledge of "how do I rotate THIS provider's keys?" — leaks abstractions. Rejected by §Goal 1. |
| C — Both: provider exposes rotate, control plane runs a scheduler against it | The right v0.6+ shape. | v0.5.0 scope creep. |

**Recommendation: A** for v0.5.0; C as the v0.6+ extension.

## Decisions required

Operator answers required before §Locked design is finalized and any code lands:

1. **Q1** — Provider set for v0.5.0? (rec: B — `LocalDiskProvider` + `AwsKmsProvider`)
2. **Q2** — Algorithm scope? (rec: B — Ed25519 + ECDSA P-256; coupled to Q1)
3. **Q3** — Detached-operator signing in scope? (rec: deferred to v0.6+)
4. **Q4** — Per-signature audit trail location? (rec: existing audit log + `signing_nonce` index)
5. **Q5** — Replay protection mandatory? (rec: yes, mandatory nonce + timestamp)
6. **Q6** — Authorization model? (rec: mTLS caller identity + per-key actor allow-list, with bearer-token fallback if WS8 hasn't merged)
7. **Q7** — Quorum / multi-sig in v0.5.0? (rec: deferred, envelope shape forward-compatible)
8. **Q8** — Key rotation ownership? (rec: provider concern, operator-initiated in v0.5.0)

Once operator answers land, §Locked design above is updated to reflect them and this §Decisions required section is replaced with a §Resolved decisions changelog.

## Extension points (out of scope for WS9 v0.5.0)

- **`HsmProvider` / `Pkcs11Provider`** — same interface, talks to a PKCS#11 module instead of a cloud SDK. Hardware-token use cases (YubiHSM, smartcards).
- **`TpmProvider`** — Windows TPM via `ncrypt`. Solves "key bound to this host's hardware" without external network dependency.
- **`VaultProvider`** — HashiCorp Vault Transit. Same shape as cloud-KMS providers.
- **`DetachedProvider`** — file-drop or HTTP-POST transport for review-gated signing.
- **Quorum / m-of-n signing** — uses the existing `SigEntry[]` envelope; adds a quorum-policy table.
- **Auto-rotation scheduler** — control plane runs a tick that calls `provider.rotate(keyId)` per policy.
- **External CA delegation** — `AwsPcaProvider` / `VaultPkiProvider` for the WS8 CA key. Provider interface accommodates `mintCert()`-style ops not defined in v0.5.0.

## Cross-references

- `host/src/control-plane/build/signing.ts` — release-manifest signing surface (gets refactored to route through provider).
- `registry/src/signing.ts` — registry re-signing surface (gets the same treatment).
- `service/src/tls.rs` — WS8's CA-key + denylist-signing surface (Milestone 4 only; requires WS8 to have merged).
- `host/src/cloud/credentials.ts` — per-org credential storage; reused by cloud-KMS providers.
- `host/src/control-plane/storage/migrations/0004_release_signature.sql` — existing `signature_b64` / `signed_by` columns on the `release` row (no schema change required for the legacy path).
- `docs/supply-chain.md` — §Key model, §Audit-log canonical action codes, §Operator workflow (all updated at Milestone 5).
- `docs/design/per-user-identity-certs.md` §Out-of-scope — names WS9 as the destination for HSM / TPM / KMS work; this doc closes that ticket.
- `docs/workstreams/prompts/ws9-signing-service.md` — executable starting prompt for the implementation session.
