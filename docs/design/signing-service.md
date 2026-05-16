# Signing Service

**Status:** design proposal (2026-05-16) — **§Open product questions resolved 2026-05-16**; §Locked design below is operator-approved and not re-litigated in implementation PRs.
**Owner:** WS9 (`docs/workstreams/prompts/ws9-signing-service.md`)
**Predecessor:** v0.4.x direct on-disk signing — `host/src/control-plane/build/signing.ts`, `registry/src/signing.ts`, `service/src/tls.rs` (CA-key + denylist signing path). This doc is the v0.5.0+ progression that introduces a provider abstraction over key-material custody.

## Resolved decisions (operator-confirmed 2026-05-16)

Eight product questions originally surfaced in §Open product questions below; the operator approved the following resolutions. The full trade-off analysis remains in §Open product questions as historical context — that section is not re-litigated in implementation PRs.

1. **Q1 — Provider set for v0.5.0: `LocalDiskProvider` + `AwsKmsProvider`.** AWS KMS first exercises the abstraction against a credibly different key-custody model. Other cloud-KMS providers ship v0.6+.
2. **Q2 — Algorithm scope: Ed25519 + ECDSA P-256 + ML-DSA-65, with hybrid (Ed25519 + ML-DSA-65) as the default for new keys.** See §Quantum safety below for the rationale and mechanism. Legacy v0.4.x Ed25519-only keys stay valid for verification and signing; new keys default to hybrid; operator can opt classical-only or PQ-only per key.
3. **Q3 — Detached-operator signing: deferred to v0.6+.** The three v0.5.0 providers already cover regulated + multi-operator personas. Roadmap entry to land separately; the v0.5.0 envelope shape (`SigEntry[]`, mandatory nonce + timestamp) is forward-compatible with detached transports.
4. **Q4 — Per-signature audit trail: existing audit-log table with new `signing.*` action codes, plus dedicated `signing_nonce` index (migration 0091) for the replay-detection hot path.**
5. **Q5 — Replay protection: mandatory nonce + RFC 3339 timestamp on every `SignRequest`.** Providers reject skew > 60s; audit log dedups on `(provider, keyId, nonce)`.
6. **Q6 — Authorization: mTLS caller identity (WS8 identity cert) + per-key actor allow-list.** Bearer-token-prefix fallback if WS8 has not merged at Milestone 2.
7. **Q7 — Quorum / multi-sig: deferred to v0.6+; envelope already shaped as `SigEntry[]` so v0.6 addition is non-breaking.** Hybrid signing (Q2) is the first real use of the multi-entry shape — it validates the forward-compatibility before the quorum work begins.
8. **Q8 — Key rotation: provider concern (`provider.rotate(keyId)`), operator-initiated via `signalman signing keys rotate <fp>`.** Auto-rotation scheduler is a v0.6+ extension.

## Quantum safety

**Ed25519 and ECDSA P-256 are NOT quantum-safe.** Both are elliptic-curve discrete-log primitives and fall to Shor's algorithm on a sufficiently capable quantum computer. RSA is in the same family. As of 2026-05-16, the NIST post-quantum digital-signature standards are:

- **FIPS 204 — ML-DSA** (Module-Lattice-based Digital Signature Algorithm; formerly CRYSTALS-Dilithium). Lattice-based. Three parameter sets (ML-DSA-44 / -65 / -87). Signatures are 2.4–4.6 KB.
- **FIPS 205 — SLH-DSA** (Stateless Hash-Based Digital Signature Algorithm; formerly SPHINCS+). Hash-based. Conservative security assumptions but signatures are 8–50 KB.
- **FN-DSA** (formerly FALCON). Lattice-based with floating-point arithmetic. Not yet a NIST FIPS at the time of writing.

NIST guidance is migration by 2035 for general-purpose use; sooner for high-value or long-lived signatures (release manifests, supply-chain attestations).

**v0.5.0 stance: hybrid by default (Ed25519 + ML-DSA-65).** Every new key created in v0.5.0 defaults to a *hybrid* logical key: under the hood, two cryptographic keypairs (one Ed25519, one ML-DSA-65) that share a logical `keyId`. Every `provider.sign()` call against a hybrid key emits **two `SigEntry` rows** in the `SignEnvelope.signatures` array — one Ed25519, one ML-DSA-65.

**Why ML-DSA-65 and not -44 / -87 / SLH-DSA:**
- **ML-DSA-65** targets NIST security category 3 (~AES-192). It's the conservative middle ground — comfortable margin without ballooning signature size. Signature is ~3.3 KB; release rows absorbing one of these are not a storage concern.
- **ML-DSA-44** is security category 2 (~AES-128); we prefer the headroom of category 3 for long-lived signatures.
- **ML-DSA-87** is security category 5 (~AES-256); the extra margin doesn't justify the 4.6 KB signature size for the use cases v0.5.0 targets.
- **SLH-DSA** sigs are an order of magnitude larger (8–50 KB), which is operationally meaningful when release rows + provenance entries multiply across a fleet. Reserved as a v0.6+ extension if an operator needs hash-based-only assumptions.

**Why hybrid, not PQ-only:**
- Preserves v0.4.x byte-parity for the Ed25519 half — legacy keys, legacy releases, legacy tooling all keep working.
- ML-DSA is young in production; if a parameter-set break is announced, the Ed25519 half still authenticates the signature (in "transition" verifier mode).
- Inverse case: if a future Ed25519 weakness emerges, the ML-DSA half authenticates the signature.
- The cost is two signatures per release (~3.4 KB total instead of 64 bytes) — meaningful only at fleet scale, and operators who don't need PQ can opt out per key.

**Verifier modes** (operator-configurable per release / per registry virtual-upstream / per WS8 denylist):

| Mode | Hybrid envelope accept criteria |
|---|---|
| **transition** (default) | At least ONE of `signatures[]` verifies. Tolerates a parameter-set break in either algorithm without immediate fleet-wide breakage. |
| **strict** | EVERY entry in `signatures[]` must verify against its declared algorithm + key. The default once the PQ half has hardened (probably v0.6+). |
| **classical-only** | Only the Ed25519 entry is checked. Provided for verifiers that haven't yet linked an ML-DSA library; explicitly NOT quantum-safe. Emits a warning on the CLI surface. |

**Library choice (Milestone 1 risk to surface now):** Node's stable `crypto` module does not ship ML-DSA as of January 2026. The implementation will need either `liboqs-node` (libsodium-style binding to liboqs) or `@noble/post-quantum` (pure-JS, audited but slower). Decision deferred to Milestone 1; design doc only commits to the *interface* exposure of ML-DSA, not the implementation library. The byte-shape of an ML-DSA-65 signature is defined by FIPS 204 and is library-independent.

**Provider impact:**
- **`LocalDiskProvider`** — a hybrid key stores TWO PEM keypairs under the same logical alias: `~/.signalman/keys/<alias>-ed25519.{pub,key}` + `~/.signalman/keys/<alias>-mldsa65.{pub,key}`. The legacy `~/.signalman/keys/signing.{pub,key}` files are treated as a classical-only key with alias `"default"` to preserve v0.4.x muscle memory.
- **`AwsKmsProvider`** — hybrid is operator-tagged. The classical half is an AWS KMS ECDSA P-256 key (universally available); the PQ half is either an AWS KMS ML-DSA key (if GA in the operator's region) OR a local-fallback ML-DSA-65 keypair stored alongside the cred config (clearly marked in the catalog row as "kms+local-hybrid"). The operator confirms in the credentials setup which path applies in their region. If neither region availability nor local-fallback is acceptable, the operator may opt the AWS-KMS key to classical-only — explicit, audited, not silently downgraded.
- **WS8 denylist signing** (Milestone 4) — emits hybrid by default. The denylist sidecar grows from a single Ed25519 signature to a hybrid envelope; the on-disk format is described in WS8's design doc and gets a §Hybrid envelope subsection in Milestone 4. Guest agents in transition mode accept either signature; strict mode requires both.

**Operator opt-out paths:**
- `signalman signing keys add --algorithm ed25519` — classical-only Ed25519 (v0.4.x parity; not quantum-safe).
- `signalman signing keys add --algorithm ecdsa-p256-sha256` — classical-only ECDSA (cloud-KMS interoperability; not quantum-safe).
- `signalman signing keys add --algorithm ml-dsa-65` — PQ-only (no classical fallback; rejects classical-only verifiers).
- `signalman signing keys add` (no flag) — hybrid Ed25519 + ML-DSA-65 (the default).

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
 * Signature algorithm. v0.5.0 ships:
 *   - ed25519           — matches v0.4.x; not quantum-safe.
 *   - ecdsa-p256-sha256 — cloud-KMS interoperability; not quantum-safe.
 *   - ml-dsa-65         — NIST FIPS 204 post-quantum (lattice-based).
 *                         Default for the post-quantum half of every
 *                         new hybrid key. See §Quantum safety above.
 *
 * Hybrid keys are represented by TWO key rows in
 * `signing_provider_key` linked by a shared `pair_id`, each carrying
 * its own algorithm value (one `ed25519`, one `ml-dsa-65`).
 * `provider.sign()` against a hybrid logical key emits one SigEntry
 * per linked row.
 *
 * RSA variants are deliberately omitted — bigger signatures, slower
 * verification, no operator request driving them. SLH-DSA (FIPS 205)
 * is similarly omitted — sigs are 8–50 KB and operationally heavy.
 * Both are additive changes if needed later.
 */
export type SigAlgorithm = "ed25519" | "ecdsa-p256-sha256" | "ml-dsa-65";

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

  /** Verify a signature envelope against payload bytes + the public
   *  keys that produced it. `keys` is an array because hybrid envelopes
   *  (Milestone 1b+) carry one SigEntry per algorithm and each entry
   *  needs its own public key. Classical-only callers pass a
   *  single-element array. The provider matches entries to keys by
   *  (algorithm, fingerprint).
   *
   *  Verify can run on ANY provider for ANY envelope when the algorithm
   *  matches — verification does not require the producing provider.
   *  This keeps verifiers (CI, third parties) free of the cloud-KMS
   *  dependency that producers may have. */
  verify(
    env: SignEnvelope,
    payload: Uint8Array,
    keys: readonly PublicKeyRef[],
    mode?: VerifyMode,
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

| Provider | `ed25519` | `ecdsa-p256-sha256` | `ml-dsa-65` | Hybrid (Ed25519 + ML-DSA-65) |
|---|---|---|---|---|
| `LocalDiskProvider` | supported (legacy parity) | supported | supported | **default for new keys** |
| `AwsKmsProvider`    | iff KMS exposes Ed25519 in the operator's region | supported | iff KMS exposes ML-DSA-65 in the operator's region | **default for new keys**; PQ half is KMS ML-DSA when available, otherwise local-fallback (operator-confirmed at credential setup) |
| `AzureKvProvider` (v0.6+) | NOT available on Azure Key Vault Standard | supported | TBD (Azure roadmap) | TBD |
| `GcpKmsProvider` (v0.6+)  | NOT available on GCP Cloud KMS | supported | TBD (GCP roadmap) | TBD |

The cloud-KMS PQ availability columns are operator-verified at credential-setup time per §Quantum safety above — the design does not assume any specific region's KMS ML-DSA GA status. Operators in regions without KMS ML-DSA can either accept the local-fallback PQ half (clearly marked in the catalog row) or opt the AWS-KMS key to classical-only with an explicit, audited acknowledgment that the key is not quantum-safe.

## Provider implementations (v0.5.0 scope, per Q1 = LocalDisk + AwsKms)

### `LocalDiskProvider`

Ships in Milestone 1.

- **Legacy alias:** `keyId="default"` resolves to `~/.signalman/keys/signing.{pub,key}` (classical Ed25519, v0.4.x layout). No config change required for operators on v0.4.x; verification continues to work; new signing operations on this alias emit a CLI warning that the key is classical-only.
- **New hybrid keys** (the v0.5.0 default — see §Quantum safety): `signalman signing keys add` (no flags) creates a hybrid key under alias `<alias>`. On disk, **two** keypairs live side-by-side:
  - `~/.signalman/keys/<alias>-ed25519.{pub,key}` (PKCS#8 PEM, classical half)
  - `~/.signalman/keys/<alias>-mldsa65.{pub,key}` (ML-DSA-65 key blob; FIPS 204 byte format)
  The two share a `pair_id` in `signing_provider_key` (see §Storage).
- **Single-algorithm keys:** `--algorithm ed25519` / `--algorithm ecdsa-p256-sha256` / `--algorithm ml-dsa-65` create one PEM (or FIPS 204 blob) under `~/.signalman/keys/<alias>.{pub,key}`. Single-row catalog entry; no `pair_id`.
- **Custom paths:** an absolute path as `keyId` is treated as a single-algorithm key (the legacy `--key <path>` form). Hybrid keys must be created via the new alias-based form so the two halves stay co-located.
- **Wire format on disk:** unchanged for the Ed25519 half — PKCS#8 PEM private + SPKI PEM public. v0.4.x byte-parity invariant requires it. The ML-DSA-65 half uses the raw FIPS 204 byte format (no PEM wrapper) since PEM ASN.1 for ML-DSA is not yet standardized across libraries as of 2026-05-16.
- **Algorithm detection:** read `keyObject.asymmetricKeyType` for Ed25519/ECDSA; ML-DSA blobs carry an explicit 4-byte magic header (`MLDA`) followed by FIPS-204 wire bytes.
- **`rotate()`:** for hybrid keys, rotate both halves atomically; for single-algorithm keys, rotate the one. In both cases, archive the previous bytes to `~/.signalman/keys/archive/<unix-ms>/` with the original filenames preserved. Emit `signing.key_rotated` with detail listing each rotated sub-key.
- **Authorization:** none beyond filesystem permissions. The local-disk path trusts whatever can read the key files. Same trust posture as v0.4.x.

### `AwsKmsProvider`

Ships in Milestone 3 (Q1=B).

- **Credentials:** reuses `host/src/cloud/credentials.ts` per-org storage. AWS access key + secret + optional session token + region; encrypted at rest under `SIGNALMAN_CRED_KEY`. The provider does NOT introduce a new credential silo.
- **Key registry:** per-org table `signing_provider_key` (see §Storage) maps `keyId` → KMS ARN + cached public key. The cache is keyed by ARN; cache miss triggers `kms:GetPublicKey`. Hybrid keys store two linked rows sharing `pair_id` — typically one KMS ARN (classical ECDSA P-256) plus one second row that is either a second KMS ARN (when KMS ML-DSA is GA in the operator's region) or a local-fallback ML-DSA-65 keypair on the host (operator-confirmed at credential setup, clearly marked in the catalog row).
- **Sign (classical half):** `kms:Sign` with `MessageType=RAW` and `SigningAlgorithm=ECDSA_SHA_256` for P-256.
- **Sign (PQ half):** when the second row is a KMS ARN, `kms:Sign` with `SigningAlgorithm=ML_DSA_65` (or the AWS-blessed name when GA); when the second row is local-fallback, `LocalDiskProvider`-style ML-DSA-65 signing against the host-resident key blob.
- **Verify:** Node `crypto.verify` (classical) / the ML-DSA library decided in Milestone 1 (PQ) with the cached public keys; no KMS round-trip needed. Verifiers never need KMS access — same "verify anywhere" property as v0.4.x.
- **`rotate()`:** `kms:CreateKey` for the new classical key, separate rotation for the PQ half (either `kms:CreateKey` again or LocalDisk-style rotation depending on the second row's kind). Update the linked `signing_provider_key` rows atomically. Schedule old ARNs for `PendingWindowInDays=30` deletion via `kms:ScheduleKeyDeletion`. Emit `signing.key_rotated` with `old_pair`/`new_pair` detail listing both halves.
- **Classical-only opt-out:** operator can create a key with `--algorithm ecdsa-p256-sha256` explicitly. The catalog row records `algorithm=ecdsa-p256-sha256, hybrid=false`, and every sign operation surfaces a CLI warning that the key is not quantum-safe. Audited; explicit; not silently downgraded.

### `AzureKvProvider` (v0.6+)

Same shape as `AwsKmsProvider`, against `azure-keyvault-keys` SDK. Classical algorithm: `ecdsa-p256-sha256`. Credentials reuse the existing Azure plaintext shape in `cloud/credentials.ts`. PQ availability tracked separately; v0.6+ adds when Azure Key Vault's ML-DSA support GA's.

### `GcpKmsProvider` (v0.6+)

Same shape, against `@google-cloud/kms` SDK. Classical algorithm: `ecdsa-p256-sha256`. **Requires new credential plumbing** — GCP isn't in `cloud/credentials.ts` today. Adds a `GcpCredentialPlaintext` shape. PQ availability tracked separately.

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
  algorithm       TEXT NOT NULL CHECK (algorithm IN ('ed25519', 'ecdsa-p256-sha256', 'ml-dsa-65')),
  fingerprint     TEXT NOT NULL,           -- sha256(public-key bytes), 16 hex chars
  public_key_der  TEXT NOT NULL,           -- base64-encoded; cached for verify.
                                           -- Ed25519/ECDSA: DER SubjectPublicKeyInfo.
                                           -- ML-DSA-65: FIPS 204 raw public-key bytes.
  pair_id         TEXT,                    -- nullable; non-null for hybrid sub-keys.
                                           -- Two rows sharing pair_id form one
                                           -- logical hybrid key. The pair MUST have
                                           -- exactly one row with algorithm='ed25519'
                                           -- (the classical half) and one with
                                           -- algorithm='ml-dsa-65' (the PQ half).
  pair_role       TEXT CHECK (pair_role IN ('classical', 'post-quantum') OR pair_role IS NULL),
                                           -- nullable; non-null iff pair_id is set.
  hybrid_alias    TEXT,                    -- nullable; the operator-facing alias for
                                           -- the hybrid logical key (e.g. "default",
                                           -- "release-signing-prod"). Both rows in a
                                           -- pair share the same hybrid_alias.
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

-- A hybrid pair must carry exactly two rows with distinct pair_role.
-- Enforced by application code (the migration cannot CHECK across rows
-- on SQLite); covered by integration tests at Milestone 1.
CREATE INDEX signing_provider_key_pair_idx
  ON signing_provider_key (org_id, pair_id)
  WHERE deleted_at IS NULL AND pair_id IS NOT NULL;

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
# Columns: provider, key-id, algorithm, fingerprint, label, added-at, hybrid

# Add a key to the catalog. Default algorithm is hybrid (Ed25519+ML-DSA-65).
# Operator can opt to a single-algorithm key with --algorithm.
signalman signing keys add \
  --provider local-disk \
  --alias release-signing-prod \
  [--algorithm hybrid|ed25519|ecdsa-p256-sha256|ml-dsa-65]    # default: hybrid
# audit: signing.key_added (one row per logical key; hybrid pairs link two
#        signing_provider_key rows under a shared pair_id)

# Register an existing cloud-KMS key with the local catalog (hybrid pairing
# is resolved from the operator's credential setup — see §AwsKmsProvider).
signalman signing keys add \
  --provider aws-kms \
  --key-id arn:aws:kms:us-east-1:123:key/abc \
  [--pq-half arn:aws:kms:us-east-1:123:key/mldsa-abc | --pq-half local-fallback | --classical-only] \
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
  - Signature byte-equality (Ed25519 half): `LocalDiskProvider.sign(payload, ed25519-key)` produces the exact same Ed25519 `signatureB64` as v0.4.x `crypto.sign(null, payload, key)` for fixed input. Hybrid sign() against the same Ed25519 sub-key produces the same bytes in the `signatures[ed25519]` entry.
  - Hybrid envelope shape: `provider.sign()` against a hybrid key emits exactly two SigEntry rows — one Ed25519, one ML-DSA-65 — both verifiable against the linked public-key pair. Tampering one signature byte fails strict-mode verify but passes transition-mode (the other signature still verifies). Tampering both fails both modes.
  - Verifier modes: transition / strict / classical-only each produce the documented accept/reject outcomes against a hybrid envelope, a tampered hybrid envelope, and a legacy Ed25519-only envelope.
  - Provider error taxonomy: each provider documents its error codes and unit tests cover each one (`fingerprint-mismatch`, `unknown-algorithm`, `replay-detected`, `clock-skew`, `key-revoked`, `key-not-found`, `hybrid-pair-incomplete`).
  - Nonce / timestamp validation: rejects skew > 60s, rejects duplicate nonce, accepts fresh nonce.
  - Audit-row shape: the `signing.requested` row's `detail` blob contains exactly the documented fields; hybrid signing emits one `signing.completed` row with both sub-fingerprints in detail.
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
3. `AwsKmsProvider` ships (Q1=B locked).
4. **Hybrid (Ed25519 + ML-DSA-65) is the default** for new keys created via `signalman signing keys add` (no `--algorithm` flag). Single-algorithm opt-outs work for all three algorithms.
5. Verifier modes (transition / strict / classical-only) all produce the documented outcomes against hybrid, tampered-hybrid, and legacy envelopes.
6. Audit log records `signing.*` action codes for every signing operation.
7. **Byte-parity test passes**: `LocalDiskProvider` Ed25519 output is byte-identical to v0.4.x `signing.ts` for a fixed input (locks the abstraction against silent regression on the classical path).
8. `cd host && npm test` — full suite green.
9. `cd host && npx tsc --noEmit` — zero errors.
10. `cd registry && npm test` — full suite green.
11. `cargo test --workspace` — zero failures.
12. Coverage holds per gate (≥80% lines / ≥70% branches).
13. **4-lens audit**: QA / Architecture / Product / Security all PASS or explicit operator-review concern flagged. **Security lens is non-negotiable here** — cryptographic infrastructure.
14. `docs/supply-chain.md` updated: §Key model expanded (providers + hybrid stance), §Audit log canonical action codes table gains the `signing.*` row, §Operator workflow gains a §"Switching providers" subsection, new §Quantum safety subsection explains the hybrid default and verifier modes.
15. `docs/design/signing-service.md` (this doc) §Status flipped to "shipped in v0.5.0".
16. Operator-led end-to-end test on Windows: build a release with `LocalDiskProvider` (hybrid), verify with `LocalDiskProvider`; build a release with `AwsKmsProvider`, verify with the matching provider; tamper one signature byte and confirm transition-mode accepts (other half verifies) and strict-mode rejects. Outcomes recorded in `.workstream-status.md`.

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
