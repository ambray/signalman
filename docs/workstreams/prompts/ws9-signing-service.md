# WS9 starting prompt — Signing service provider + infrastructure (v0.5+)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. WS9 runs directly on `main` with a feature branch (`feat/v0.5-signing-service`), not a separate worktree — the parallel-worktree pattern was retired after Wave-B + Wave-3 merged (see the 2026-05-15 cleanup notes).

**WS9 is design-gated.** The first milestone is the design doc, not code. Do not write production code until the operator has explicitly approved §Locked design in `docs/design/signing-service.md`.

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). Host is TypeScript (`host/`); guest agent
is Rust (`guest/`); the privileged Windows daemon is Rust
(`service/`). The standalone artifact registry is at `registry/`.
Main carries v0.4.0 through 2026-05-15: auto-promotion, webhooks,
scheduled health, cross-platform parity, registry virtual-upstream
mirroring, full cloud + k8s support.

**Your branch:** `feat/v0.5-signing-service` off `main`. Cut it from
the repo root. All git ops from that root. **Do NOT push to origin**
until the operator approves the design + first code milestone.

## What WS9 is

Today, every Signalman signing operation assumes the operator holds
the private key on disk and the calling process can load it directly:

- **Release-manifest signing** — `host/src/control-plane/build/signing.ts`
  reads `~/.signalman/keys/signing.key` (PKCS#8 PEM) and signs with
  Node's built-in `crypto.sign(null, ...)`. Ed25519 only.
- **Registry re-signing** — `registry/src/signing.ts` does the same
  for virtual-upstream cache writes; manifest provenance carries the
  fingerprint of whichever operator key did the re-sign.
- **CA-signed identity certs** (WS8, in flight) — `service/src/tls.rs`
  uses the CA private key on disk to mint per-identity leaf certs
  and to sign the revocation denylist (`revoked.json` + Ed25519 sig
  sidecar).

This works for solo operators and small teams. It does not work for:

1. **Regulated operators** who can't store private keys on disk —
   HSM / Cloud KMS / TPM is mandatory.
2. **Multi-operator orgs** where the signing key is shared across
   multiple humans — the on-disk model has no audit trail of *who*
   signed *what*, only that *some key with this fingerprint* did.
3. **Detached signing workflows** where the signer is a different
   process (or host) than the builder — useful for air-gapped or
   review-gated release flows.

WS9 introduces a **signing service abstraction** — a small,
versioned protocol that decouples "what to sign" from "how the key
material is held." The on-disk key model becomes one provider
(`LocalDiskProvider`) implementing the new interface; subsequent
providers add HSM / Cloud KMS / detached-operator / hardware-token
support without touching call sites.

This is **security-sensitive cryptographic infrastructure work**. Move
slowly. Every interface decision deserves a code comment that names
the alternatives and explains the chosen path.

## Orientation reading (in order, before any code)

1. **Existing signing surfaces** (read all three end to end):
   - `host/src/control-plane/build/signing.ts` — release-manifest signing.
   - `registry/src/signing.ts` — registry re-signing for virtual upstreams.
   - `service/src/tls.rs` (only the cert-mint + denylist-sign paths) —
     CA-key usage in the privileged daemon.
2. `docs/supply-chain.md` — overall supply-chain posture; §Key model
   names the operator workflow this design must preserve as the
   default for `LocalDiskProvider`.
3. `docs/design/per-user-identity-certs.md` §Out-of-scope — WS8
   explicitly defers HSM / TPM / KMS to "the signing-service epic"
   (i.e. you). Read what WS8 deferred and make sure WS9's design
   covers it.
4. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.
5. The Sigstore / Notation / SLSA reference documents are external
   context worth skimming, but **don't import them as dependencies**;
   the design must stay narrow to what Signalman actually signs.

## Milestone 0 (DESIGN GATE — ship before any code)

Produce `docs/design/signing-service.md`. The operator reviews this
in full before any production code lands. Mirror the structure of
`docs/design/per-user-identity-certs.md`:

- **Status** — `design proposal`, dated.
- **Context** — the three pain points named above (regulated /
  multi-operator / detached); the surfaces today that need to migrate.
- **Locked design** — the interface, the v0.5.0 provider set, the
  migration story. Once the operator approves this section, it is
  not re-litigated in implementation PRs.
- **Open product questions** — at least these:
  1. Provider set for v0.5.0: ship `LocalDiskProvider` only and
     defer others, or ship `LocalDiskProvider` + one cloud
     provider (AWS KMS / Azure Key Vault / GCP KMS) on day one?
  2. Algorithm scope: Ed25519-only (matches the current surface),
     or also add ECDSA P-256 / RSA-2048 so cloud KMS providers
     that don't expose Ed25519 still work?
  3. Detached-operator signing: in scope for v0.5.0, or deferred?
     If in scope, what's the transport — file drop + watch, or HTTP
     POST + poll?
  4. Per-signature audit trail: where does it live (existing
     audit-log table with new `sign.*` action codes, or a separate
     `signing_events` table)?
  5. Replay protection: does the protocol carry a nonce / timestamp
     so a captured signature request can't be re-submitted later?
  6. Authorization: does the signing service authorize the caller
     (mTLS client cert? bearer? audit-log-only trust?), and if so,
     what's the policy model — per-key allow-lists, per-key role
     bindings, or something else?
  7. Quorum / multi-sig: in scope for v0.5.0, or deferred? If
     deferred, does the interface leave room for it (e.g. a
     `signatures: SigEnvelope[]` shape) so v0.6 doesn't break v0.5
     clients?
  8. Key rotation: who initiates and on what cadence? Is rotation
     a provider concern (the provider exposes `rotate()`) or a
     control-plane concern (the control plane mints a new key and
     reassigns)?
- **Test taxonomy** — unit / integration / system layers matched to
  this work.
- **Definition of Done** — explicit gates the implementation must hit.

**Commit:** `docs(v0.5-signing-service): design doc + open questions`

**Operator gate:** post the design doc to the operator with a
`## Decisions required` section enumerating the 8 open questions.
Wait for explicit answers. Update the design doc to lock the
answers into §Locked design. Then proceed.

## Milestones — v0.5.0 ship (after design gate clears)

The exact milestone list depends on operator answers to §Open
product questions. The following is the *expected* shape; revise it
in `.workstream-status.md` once the design lands.

### Milestone 1: `SigningProvider` interface + `LocalDiskProvider` (lift + shift)

- New module `host/src/control-plane/signing/` with the interface
  and the local-disk impl.
- Mirror module in `registry/src/signing/providers/` so the registry
  re-signing path uses the same abstraction without depending on
  `host/`.
- The interface must be small. Recommend: `sign(req: SignRequest):
  Promise<SignEnvelope>`, `verify(env: SignEnvelope, key:
  PublicKeyRef): Promise<VerifyResult>`, `fingerprint(key:
  PublicKeyRef): Promise<string>`, `listKeys(): Promise<KeyRef[]>`.
- `LocalDiskProvider` wraps the existing `signing.ts` logic; default
  key path stays `~/.signalman/keys/signing.{pub,key}` so existing
  operator muscle memory works unchanged.
- All existing call sites (release-manifest signing, registry
  re-signing) now route through the provider interface.
- Tests: unit (provider impl), integration (end-to-end through the
  existing release-build flow), parity (verify output is
  byte-identical to the pre-WS9 `signing.ts` for a fixed input).

**Commit:** `feat(v0.5-signing-service): provider interface + LocalDiskProvider`

### Milestone 2: Audit-log integration + `signalman signing` CLI

- New audit-log action codes: `signing.requested`, `signing.completed`,
  `signing.failed`, `signing.key_added`, `signing.key_revoked`,
  `signing.key_rotated`. Add to the canonical action codes table in
  `docs/supply-chain.md`.
- New CLI verbs:
  - `signalman signing providers list` — enumerate configured providers.
  - `signalman signing keys list [--provider X]` — enumerate keys per provider.
  - `signalman signing verify <release-id|manifest-file>` — verify a
    signature using whichever provider holds the key.
- MCP mirrors: `signalman_signing_keys_list`, `signalman_signing_verify`.
- Tests: integration (audit row written for every sign / verify),
  unit (CLI argv composition), smoke (each verb returns sensible help).

**Commit:** `feat(v0.5-signing-service): audit + CLI/MCP surface`

### Milestone 3: First-class second provider (operator-chosen during design gate)

This is the milestone where the abstraction proves itself. Whichever
provider the operator picked in §Open product questions Q1 — most
likely `AwsKmsProvider` or `AzureKeyVaultProvider` — implements the
interface with no changes to the interface itself. If the interface
*does* need changes, that's a design-doc revision (operator approves)
before code lands.

- Provider impl in `host/src/control-plane/signing/providers/`.
- Credentials: reuse the per-org credential storage already in place
  for cloud backends (see `host/src/cloud/credentials.ts`); do NOT
  add a new credential silo.
- Tests: unit (mocked SDK), integration (against a real KMS via
  `SIGNALMAN_KMS_TEST_*` env vars, gated lane like the existing
  cloud-integration tests).

**Commit:** `feat(v0.5-signing-service): <provider> implementation`

### Milestone 4: Migration story for WS8 (per-user identity certs)

WS8 explicitly deferred TPM/HSM-backed CA keys to "the signing-service
epic" (i.e. you). Once WS8 has merged, wire `service/src/tls.rs`'s
CA-key load + denylist-sign paths through the new provider interface
so an operator can move their CA key off disk without a code change.

- If WS8 has not yet merged when WS9 reaches this milestone, **stop
  and surface to operator**. Either wait for WS8 or coordinate a
  joint integration commit.

**Commit:** `feat(v0.5-signing-service): route service CA-key through provider`

### Milestone 5: Doc + audit closure

- Update `docs/supply-chain.md`:
  - §Key model expanded to "providers, not just on-disk keys."
  - §Audit-log canonical action codes table gains the `signing.*` rows.
  - §Operator workflow gains a §"Switching providers" subsection.
- Update `docs/design/signing-service.md` — flip §Status from
  "design proposal" to "shipped in v0.5.0"; record any deviations
  the operator approved during execution.
- 4-lens audit in `.workstream-status.md`. **Security lens is
  non-negotiable.** Cryptographic infrastructure is exactly where
  security audits earn their keep.

**Commit:** `docs(v0.5-signing-service): supply-chain doc + design closure`

## Test taxonomy

Hit all four layers:

- **Unit (TS + Rust):** canonicalization parity, signature
  byte-equality with pre-WS9 implementation, provider-side error
  taxonomy, audit-row shape.
- **Integration (TS):** end-to-end through `signalman release build
  --sign`, end-to-end through registry virtual-upstream re-sign,
  audit-log writes on every signing path.
- **System (TS + Rust):** WS8 CA-key route through the provider once
  WS8 has merged; legacy `LocalDiskProvider` outputs verify
  byte-identical to v0.4.x.
- **Smoke:** CLI help text, MCP tool listings.

Coverage gate: ≥80% lines / ≥70% branches across the new code.

## Reserved blocks

- **Migration block 0090–0099** — for signing-event tables, per-key
  config, provider registry (if Q4 lands on a dedicated table).
- **Audit-log action codes** — `signing.*` namespace is reserved for
  WS9; no other workstream may write `signing.*` codes.

## Definition of Done

Per the design doc §Definition of Done. The non-negotiables:

1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd registry && npm test` — full suite green
4. `cargo test --workspace` — zero failures
5. `cd host && npm run coverage` — coverage holds per gate
6. **Byte-parity test** — `LocalDiskProvider` output is
   byte-identical to v0.4.x `signing.ts` for a fixed input (locks
   the abstraction against silent regression).
7. **Operator-led end-to-end test** on Windows: build a release with
   `LocalDiskProvider`, verify with `LocalDiskProvider`; build a
   release with the new cloud provider (if Q1 ships one), verify
   with the matching provider. Record steps + outcomes in
   `.workstream-status.md`.
8. **4-lens audit completed**, Security lens specifically PASS.
9. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**. Operator pushes
   after review.

## Commit pattern

- Milestone 0: design doc — 1 commit (operator gate before continuing)
- Milestone 1: interface + LocalDiskProvider — 1 commit
- Milestone 2: audit + CLI/MCP — 1 commit
- Milestone 3: first cloud provider — 1 commit
- Milestone 4: WS8 integration (if WS8 has merged) — 1 commit
- Milestone 5: docs — 1 commit
- Subject format: `feat(v0.5-signing-service): <what>` or
  `docs(v0.5-signing-service): <what>`
- No internal-product names in commit messages (history-rewrite was
  recent; don't reintroduce leaks).

## Status report (when complete)

Write `.workstream-status.md` at the repo root with sections:

- `## Commits` (5–7 expected depending on Q1 outcome + WS8 coordination)
- `## Open questions resolved` — operator answers + design-doc deltas
- `## Tests added` per layer
- `## Coverage` deltas
- `## 4-lens audit` — Security lens PASS or specific concern
- `## Manual end-to-end test log` — what you ran on Windows, outcomes
- `## Deferred to v0.6+` (with rationale)
- `## Operator review needed`

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without a justifying comment
- Rust: every `unsafe` block gets an explicit safety comment (there
  shouldn't be any new `unsafe` in WS9)
- No emojis in source or docs
- **Don't touch** the existing on-disk PEM file format — the
  `LocalDiskProvider` reads the exact same bytes v0.4.x does
- Don't push to origin without operator approval

## Parallel work to be aware of

WS7 (Claude Code plugin), WS8 (identity certs), WS10 (macOS UI),
WS11 (vmrun ↔ VMware convergence), WS12 (OSS-release-readiness) all
run in parallel cohorts. WS9 ↔ WS8 has a real coupling at
Milestone 4; coordinate with the operator before that milestone.
All other workstreams have no overlap with WS9's scope.

WS9 touches: `host/src/control-plane/signing/` (new module),
`host/src/control-plane/build/signing.ts` (refactor to route through
provider), `registry/src/signing.ts` (refactor),
`service/src/tls.rs` (Milestone 4 only),
`host/src/cli.ts` (new `signing` verb), `host/src/mcp/server.ts`
(new MCP tools), `host/src/control-plane/storage/migrations/`
(new 0090+), `docs/supply-chain.md`, `docs/design/signing-service.md`
(new).

If you find yourself touching anything outside that list, stop and
surface to the operator.

Start by reading the three signing surfaces end to end, then write
the design doc, then post the open questions to the operator.
