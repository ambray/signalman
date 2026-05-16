# WS8 starting prompt — Per-user identity certificates (v0.2.0)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. WS8 runs directly on `main` with a feature branch (`feat/v0.5-identity-certs`), not a separate worktree — the parallel-worktree pattern was retired after Wave-B + Wave-3 merged (see the 2026-05-15 cleanup notes).

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). Host is TypeScript (`host/`); guest agent
is Rust (`guest/`); the privileged Windows daemon is Rust
(`service/`). Main is at `22981d2` (post-WS7 planning); v0.4.0
shipped through 2026-05-15 with auto-promotion, webhooks, scheduled
health, cross-platform parity, registry virtual-upstream mirroring,
and full cloud + k8s support.

**Your branch:** `feat/v0.5-identity-certs` off `main`. Cut it from
the repo root. All git ops from that root. **Do NOT push to origin**
until the operator approves the design + first milestone.

## What WS8 is

Implement per-user identity certificates per
[`docs/design/per-user-identity-certs.md`](../../design/per-user-identity-certs.md).
This is the v0.2.0+ progression that `guest/src/cert_pin.rs`
explicitly references: turn the v0.1.x "one-CA-many-VMs" trust
model into named-identity mTLS with per-identity revocation.

This is **security-sensitive PKI work**. Move slowly. Every cryptographic
decision deserves a code comment that names the alternatives and explains
why the chosen path is right.

## Orientation reading (in order, before any code)

1. **`docs/design/per-user-identity-certs.md`** — the design doc. Read all of it.
   It names the model, the topology, the revocation strategy, the test
   taxonomy, and the open questions. Resolve the open questions with the
   operator before writing code.
2. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.
3. `guest/src/cert_pin.rs` — v0.1.x cert-pin module. The new
   `identity_verify.rs` lives alongside it and reuses its constant-time
   compare patterns.
4. `service/src/tls.rs` — current CA + cert generation + rotation surface.
   The mint flow extends `generate_certs` for per-identity issuance.
5. `host/src/provisioning/provision.ts` — provisioning currently copies
   the shared `client.{pem,key}` to every VM. Identity-mode flow needs
   to copy the CA only (no client cert) and rely on the operator-side
   mint flow.
6. `host/src/control-plane/storage/migrations/` — migration patterns.
   The new migration is `0080_user_certs.sql`.
7. `docs/mtls.md` and `docs/supply-chain.md` — doc surfaces that must
   be updated when WS8 ships.

## Open product questions — resolve these in the first hour

The design doc lists 8 open questions in §Open product questions.
Surface them to the operator at the start of the session and get
explicit answers before writing the migration. Use
`AskUserQuestion` to collect answers in one batch.

If an operator chooses a non-default for any question, **update the
design doc to match** before writing code. The design doc is the
contract WS8 is implementing; if it drifts, the code drifts.

## Milestones — v0.2.0 ship

Ship in this order. Each milestone is its own commit (or a small
commit cluster) and ends with a green test run.

### Milestone 1: Schema + storage repo (smallest, lowest risk — ship first)

- Migration `0080_user_certs.sql` per the design's §Storage section.
- `UserCertRepo` interface in `host/src/control-plane/storage/`.
- SQLite + Postgres impls. pg-mem test passes.
- Repo methods: `insert`, `findById`, `findByOrgAndKindAndCn`,
  `findBySerialHex`, `listActive(orgId, kind?)`, `revoke(id, reason, actorAt)`.
- Unit tests in `host/src/__tests__/user-cert-repo.test.ts`.

**Commit:** `feat(v0.5-identity-certs): user_cert schema + repo`

### Milestone 2: Mint flow (host + service)

- Extend `service/src/tls.rs` with a `mint_identity_cert(kind, cn,
  ttl, ca_bundle)` function. Returns `(pem, key, serial_hex,
  fingerprint, expires_at)`. Tests cover:
  - Kind-specific OU placement
  - URI SAN shape (`spiffe://signalman/<org>/<kind>/<cn>`)
  - ClientAuth-only EKU (no ServerAuth on identity certs)
  - TTL respected; MAX_TTL ceiling enforced
- Host-side: `signalman cert mint` CLI verb + `signalman_cert_mint`
  MCP tool. Writes both the catalog row AND the on-disk PEM files
  (atomic — repo insert + file write in a single try/catch with
  cleanup on failure).
- Audit-log row: `cert.minted` with actor, kind, cn, serial,
  expires_at.

**Commit:** `feat(v0.5-identity-certs): cert mint verb + service-side issuance`

### Milestone 3: List / show / revoke + audit-log integration

- CLI: `signalman cert list [--kind X] [--include-revoked] [--include-expired]`,
  `signalman cert show <serial-or-cn>`,
  `signalman cert revoke <serial-or-cn> --reason "..."`.
- MCP mirrors.
- Revoke writes:
  - `revoked_at` + `revoke_reason` on the row
  - Updated `revoked.json` to `<cert-dir>/identities/revoked.json`
    (signed with the CA private key — same Ed25519 pattern as release
    signing).
- Audit-log rows: `cert.revoked`.

**Commit:** `feat(v0.5-identity-certs): cert list/show/revoke + signed denylist`

### Milestone 4: Guest-side identity verification

- New module `guest/src/identity_verify.rs` (alongside `cert_pin.rs`).
- Parses leaf cert: extracts CN, OU, URI SAN; verifies they match the
  three-kind shape.
- Denylist loader: reads `<cert-dir>/identities/revoked.json` + its
  `.sig` sidecar; verifies the Ed25519 signature against the CA's
  public key (extracted from `ca.pem` at startup).
- Interceptor wiring: a new `--identity-mode={off,on,enforce}` flag.
  `on` is "verify but fall back to cert-pin if not present"; `enforce`
  is "verify and require — no fallback".
- Denylist reload: SIGHUP on Linux/macOS; 60s file-mtime poll on Windows.
- Tests cover: parse + verify happy path; denylist-revoked rejection;
  malformed-cert rejection; signature-tampered denylist rejection;
  coexistence with the existing cert-pin path.

**Commit:** `feat(v0.5-identity-certs): guest-side identity verifier + denylist`

### Milestone 5: Rotation + reaper

- `signalman cert rotate <serial-or-cn> --overlap <duration>`
  - Mint new cert with the same CN
  - Mark the old row with `revoke_after = now + overlap` (new column;
    rolls into the same migration so we don't add 0081 just for this)
  - **Decision needed in operator question round:** does the reaper run
    in-process with the existing scheduler, or as a separate verb?
    Design rec: in-process tick alongside scheduled health.
- Reaper: walks `user_cert` for rows with `revoke_after IS NOT NULL AND
  revoke_after <= now AND revoked_at IS NULL`; revokes them; rewrites
  the signed denylist.
- Audit rows: `cert.rotated` (records old + new serials), `cert.reaped`
  (when the reaper auto-revokes).

**Commit:** `feat(v0.5-identity-certs): cert rotate + reaper`

### Milestone 6: Migration status + coexistence verification

- `signalman cert migration-status` verb — reports per-target which
  verifier path requests are hitting. Implementation needs the guest
  to report counters back to the host on a periodic ping (use the
  existing runner heartbeat channel).
- System test: end-to-end rotation flow (mint → rotate → assert both
  serials valid during overlap → reaper kicks → old serial denied).
- System test: legacy-coexistence (boot guest with both
  `--identity-mode=on` AND `--client-cert-sha256` pin; assert legacy
  pin path still works).

**Commit:** `feat(v0.5-identity-certs): migration-status verb + coexistence tests`

### Milestone 7: Doc + audit closure

- Update `docs/mtls.md` — add §Per-user identity certs section.
  Replace the implicit one-cert-per-host model. Document the three
  identity kinds, the mint/list/revoke/rotate CLI surface, the
  `--identity-mode` flag.
- Update `docs/supply-chain.md` — §Key model expanded for per-user
  topology; §Audit-log canonical action codes table gains the
  `cert.*` row.
- Update `docs/design/per-user-identity-certs.md` — flip §Status from
  "design proposal" to "shipped in v0.5.0"; record any design
  deviations operator-approved during execution.
- 4-lens audit in `.workstream-status.md`. **Security lens is
  non-negotiable.** PKI + key material + revocation are exactly
  where security audits earn their keep.

**Commit:** `docs(v0.5-identity-certs): mtls + supply-chain + design closure`

## Test taxonomy

Per the design doc §Test taxonomy. Hit all four layers:

- **Unit (Rust + TS):** subject parsing, OU placement, URI SAN shape,
  denylist signature verification, TTL ceiling, constant-time serial
  compare.
- **Integration (TS):** repo round-trip on both SQLite + pg-mem;
  mint/list/show/revoke verb integration with mocked filesystem;
  rotation + reaper with a fake clock; audit-log actor plumbed from
  cert subject.
- **System (Rust + TS):** end-to-end mint → guest accepts → revoke →
  guest rejects; coexistence with cert-pin path; rotation overlap
  window.
- **Smoke:** migration validation, proto shape (no new RPC required),
  CLI help text.

Coverage gate: ≥80% lines / ≥70% branches across the new code.

## Reserved migration block

**0080–0089.** WS8 claims 0080–0084 for identity-cert tables and
column-add migrations. 0085+ stays free for follow-on work.

## Definition of Done

Per the design doc §Definition of Done (for WS8 v0.2.0 ship). The
non-negotiables:

1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cargo test --workspace` — zero failures
4. `cd host && npm run coverage` — coverage holds per gate
5. End-to-end manual test on Windows: mint → copy to a libvirt or
   Hyper-V VM → guest accepts → revoke → guest rejects. Record steps
   + outcomes in `.workstream-status.md`.
6. **4-lens audit completed**, Security lens specifically PASS — write
   a `## 4-lens audit` section in `.workstream-status.md` per the
   standing workstream rules.
7. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**. Operator pushes
   after review.

## Commit pattern

- Milestone 1: schema + repo — 1 commit
- Milestone 2: mint — 1 commit
- Milestone 3: list/show/revoke + denylist — 1 commit
- Milestone 4: guest verifier — 1 commit
- Milestone 5: rotate + reaper — 1 commit
- Milestone 6: migration-status + coexistence tests — 1 commit
- Milestone 7: docs — 1 commit
- Subject format: `feat(v0.5-identity-certs): <what>` or
  `docs(v0.5-identity-certs): <what>`
- Commit messages must NOT mention internal-product names — the
  history-rewrite is recent; don't reintroduce leaks.
- If bash heredoc commit messages hit quoting issues, use
  `.commit-msg-temp.txt` + `git commit -F`.

## Status report (when complete)

Write `.workstream-status.md` at the repo root with sections:

- `## Commits` (7 expected)
- `## Open questions resolved` — answers + any design-doc deltas
- `## Tests added` per layer
- `## Coverage` deltas
- `## 4-lens audit` — Security lens explicitly PASS or specific concern
- `## Manual end-to-end test log` — what you ran on Windows, outcomes
- `## Deferred to v0.3.0+` (with rationale)
- `## Operator review needed` — anything that requires a human call
  before push

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment
- Rust: every `unsafe` block gets an explicit safety comment (there
  shouldn't be any new `unsafe` in WS8, but flag if you find yourself
  reaching for it)
- No emojis in source or docs
- Use Loom MCP tools if available (per project memory, Loom is
  currently broken — skip its approval surface)
- **Don't touch** the existing `cert_pin.rs` module's public surface —
  v0.2.0 keeps it intact for coexistence; v0.3.0 deprecates it.
- **Don't change** the install-time CA generation (`generate_certs`
  in `service/src/tls.rs`) — extend with new functions, don't modify
  the existing dev-cert flow.
- Don't push to origin without operator approval.

## Parallel work to be aware of

The operator is working through other roadmap items in parallel:

- **WS7 (Claude Code plugin)** — in `plugin/` and a separate branch.
  No overlap.
- **Signing-service epic** — Loom drafting requirements; gated.
- **Mac UI automation** — `guest/src/platform/macos/` and
  `host/src/uia/`. No overlap with WS8.
- **OSS-hygiene trio** — CI / docs. No overlap.

WS8 touches: `service/src/tls.rs` (extend), `service/src/`
(new modules), `guest/src/` (new `identity_verify.rs`),
`host/src/control-plane/storage/migrations/` (new 0080),
`host/src/control-plane/identity/` (new module),
`host/src/verbs/` (new cert verbs), `host/src/cli.ts` (new verb
wiring), `host/src/mcp/server.ts` (new MCP tools), `docs/mtls.md`,
`docs/supply-chain.md`, `docs/design/per-user-identity-certs.md`.

If you find yourself touching anything outside that list, stop and
surface to the operator.

Start by reading `docs/design/per-user-identity-certs.md` end to
end, then ask the operator the 8 open questions, then begin
Milestone 1.
