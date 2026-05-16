# Per-User Identity Certificates

**Status:** design proposal (2026-05-16). No code shipped yet.
**Owner:** WS8 (`docs/workstreams/prompts/ws8-per-user-identity-certs.md`)
**Predecessor:** v0.1.x cert-pin registry (`guest/src/cert_pin.rs`) — stopgap that turns the v0.1.0 "one-CA-many-VMs" trust model into "exact-leaf-hash-pinning per guest." This doc is the v0.2.0+ progression that the cert-pin module's header comment promised.

## Problem statement

Today (v0.4.x) Signalman ships **one-CA-many-VMs** mTLS:

1. The host install generates a CA + server cert + client cert at
   `%ProgramData%\Signalman\certs\` (see `service/src/tls.rs`).
2. The **same client cert** (`client.pem` + `client.key`) is read by
   the host MCP client to dial every guest agent it touches.
3. Provisioning copies the same `ca.pem` + `server.{pem,key}` +
   `client.{pem,key}` bundle to each newly-provisioned VM
   (`host/src/provisioning/provision.ts`).
4. The guest agent trusts any client cert chained to that CA. The
   v0.1.0 cert-pin module (`guest/src/cert_pin.rs`) layers on top:
   pin the exact SHA-256 of the client cert, refuse anything else.

This works for a single-operator lab. It breaks for any deployment
where more than one human (or service identity) talks to a guest:

| Problem | What it looks like today |
|---|---|
| **No audit-log actor identity from the wire.** | Audit rows record `actor=cli-default` or a bearer-token prefix. The CN of the cert is `signalman-client` for everyone. |
| **Revocation is all-or-nothing.** | If one operator's machine is compromised, the only fix is `rotate-certs` on every host + push the new cert to every VM. There is no "deactivate just alice." |
| **Provisioning gives every VM the operator's client key.** | A guest that gets cloned has the same `client.key` as the host. Lateral movement from a compromised guest is a single `cat client.key` away. |
| **Cert-pinning is per-guest manual config.** | Operators copy/paste SHA-256 hashes into each guest's startup flags. Rotation is "edit the hash in N places." |
| **No machine identity for unattended workflows.** | CI runners, scheduled-health workers, and webhook receivers all impersonate the operator. |

The v0.1.x cert-pin module's header comment names this explicitly:

> v0.1.0's mTLS configuration authenticates the **channel**, not the
> **caller**. Any cert chained to the configured `--tls-ca` is treated
> as a valid Signalman host. […] Per-user identity certs ship in
> v0.2.0+.

This design is that v0.2.0+ work.

## Goals

1. **Bind every mTLS request to a named identity.** The cert CN (and
   audit-log row) names a human operator (`alice`), a service
   (`ci-runner-build`), or a host (`signalman-host-prod-02`).
2. **Make revocation per-identity.** Compromising one operator's key
   triggers one revocation; the rest of the fleet continues.
3. **Preserve the existing CA topology.** No second CA. No external
   PKI dependency. The host install's existing `ca.{pem,key}` keeps
   serving as the trust root.
4. **Lay a SPIFFE/SVID-compatible path forward.** The subject naming
   convention should be a strict subset of what a SPIFFE URI SAN can
   carry, so v0.4+ can adopt SPIFFE-style short-lived SVIDs without a
   schema break.
5. **Migration is opt-in, then default, then sole.** Operators on the
   v0.1.x cert-pin model must be able to roll forward without
   downtime.

## Non-goals

- **Replacing the install-time CA.** The host install's bootstrap
  CA stays. A future "offline root + online intermediate" topology
  is left as an extension point (see §Extension points below).
- **External-CA delegation (Vault / Smallstep / AWS PCA).** Doc'd
  as a future plug-in seam; not shipped in v0.2.0.
- **Short-lived (< 1h) SVID-style certs.** A long-term direction;
  requires a daemon-style SVID-distribution path that's out of scope
  for this workstream. v0.2.0 ships hours-to-weeks lifetimes.
- **Cert distribution via guest-agent push.** Operators receive the
  minted .pem + .key out-of-band. v0.3.x can layer push.
- **TPM / HSM-backed keys.** Out of scope. The mint flow writes
  plaintext PKCS#8 to disk like the existing dev-cert flow.

## Identity model

Three identity kinds, distinguished by an `OrganizationalUnit` (OU)
in the cert subject + the URI SAN:

| Identity kind | OU value | URI SAN form | Default TTL | Example CN |
|---|---|---|---|---|
| **user** | `operators` | `spiffe://signalman/<org>/user/<cn>` | 30 days | `alice@team.example` |
| **machine** | `machines` | `spiffe://signalman/<org>/machine/<cn>` | 90 days | `signalman-host-prod-02` |
| **service** | `services` | `spiffe://signalman/<org>/service/<cn>` | 7 days | `ci-runner-build` |

The TTLs are defaults; every mint accepts `--ttl <duration>` to
override. The lifetimes are bounded by a `MAX_TTL` constant
(`365 days` in v0.2.0 — hard ceiling).

Why three kinds, not one:

- Different rotation cadence (services rotate weekly; machines
  rotate quarterly; users sit in between).
- Audit-log readability — "deployment.rolled_back actor=alice@team"
  is unambiguous; "actor=ci-runner-build" tells you it was the CI
  pipeline, not a human.
- Future RBAC (signalman-cloud) can policy-gate on OU without
  re-parsing the CN.

The OU is also the discriminator for the guest-side denylist:
machine certs and service certs **must not** appear in user-cert
contexts and vice versa.

## CA topology — keep what works

No change to the install-time CA. The existing
`%ProgramData%\Signalman\certs\ca.{pem,key}` (or
`/etc/signalman/certs/ca.{pem,key}` on Linux) keeps signing every
identity cert.

What changes is **what gets minted from the CA**:

- v0.1.x: `client.pem` + `client.key` — one shared client cert.
- v0.2.0+: `client.pem` + `client.key` stays at install time for
  backwards compat (legacy clients keep working through the
  migration), **plus** per-identity certs minted into
  `%ProgramData%\Signalman\certs\identities\<kind>/<cn>.{pem,key}`.

The legacy `client.{pem,key}` is deprecated in v0.2.x and removed
in v0.3.0 once the migration window closes.

The CA private key still lives on the host. This is the same trust
posture as today — anyone with `ca.key` can mint identities. The
existing ACL hardening (`harden_cert_dir_acls`) covers it.

### Extension point: offline root + online intermediate

A future v0.3+ pass can introduce a two-tier CA:

```
ca-offline.{pem,key}   # generated once, key archived offline
└── ca-online.{pem,key} # short-lived intermediate, signs identity certs
    └── identities/<kind>/<cn>.{pem,key}
```

When that lands, identity-cert verification uses chain validation
(rustls already supports it). The `RootCertStore` in
`build_rustls_server_config` accepts the offline root only; the
intermediate ships in every identity cert's chain. Out of scope for
WS8 — flagged here so the schema doesn't paint into a corner.

## Cert subject + SAN shape

Required fields in every identity cert:

```
Subject:
  CN  = <cn>              # e.g. "alice@team.example" or "signalman-host-prod-02"
  O   = "Signalman"
  OU  = operators | machines | services

SubjectAltName:
  URI = spiffe://signalman/<org-id>/<kind>/<cn>
  DNS = <cn>              # mirror of CN for tools that look at SANs only

Extended Key Usage:
  ClientAuth              # mandatory for every identity cert
  ServerAuth              # OMITTED — identity certs are clients, not servers

Key Usage:
  DigitalSignature
  KeyEncipherment

Validity:
  notBefore = <issue time>
  notAfter  = notBefore + <ttl from --ttl or kind default>

Serial:
  128-bit random (rcgen default; sufficient for revocation by serial)
```

The `<org-id>` in the URI SAN is the same `org_id` that's already
threaded through the host's storage / control plane. Local-mode
single-org deployments hard-code `default`.

## Revocation model

**Serial-number denylist on the guest, pushed by the host.**

Why not CRLs:

- CRLs require a distribution channel (HTTP endpoint on the host)
  and a fetch loop on every guest. That's a v0.4+ ask.
- CRLs handle 1000s of revocations gracefully; for a fleet of dozens
  of operators, a serial denylist is simpler and bounded.

Why not OCSP:

- OCSP adds a network round-trip per handshake. Latency + failure
  modes (must-staple, soft-fail) are worse than the denylist's
  push-once-then-cache model.

Why not short-lived certs (no revocation at all):

- The right long-term move. Out of scope for v0.2.0 (no SVID daemon).

### Denylist format

A JSON file at
`%ProgramData%\Signalman\certs\identities\revoked.json` on the host
+ in every guest's cert dir:

```json
{
  "version": 1,
  "revoked": [
    {
      "serial":  "0x1a2b3c4d...",
      "cn":      "alice@team.example",
      "kind":    "user",
      "revoked_at": "2026-05-16T10:00:00Z",
      "reason":  "key compromised on 2026-05-15"
    }
  ]
}
```

- The host writes this file on `signalman cert revoke`.
- Guests load it at startup and re-load on SIGHUP (Linux/macOS) or
  on a 60s poll (Windows, where SIGHUP isn't native).
- The denylist is signed with the install-time CA's private key
  using Ed25519 over the canonical JSON (same pattern as release
  signing) — a guest refuses to load an unsigned or
  bad-signature denylist.

### Distribution

v0.2.0: out-of-band. Operator copies `revoked.json` (and its `.sig`
sidecar) to each guest's cert dir via the existing
`signalman vm copy-file` verb. This is the same model as v0.1.x
cert pinning — operators are already in this groove.

v0.3.x: a `signalman cert push-denylist` verb that walks all
registered targets and copies the file. Out of scope for WS8.

## Storage — new table

```sql
-- migration 0080_user_certs.sql (v0.2.0)
CREATE TABLE user_cert (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES org (id),
  kind          TEXT NOT NULL CHECK (kind IN ('user', 'machine', 'service')),
  cn            TEXT NOT NULL,
  serial_hex    TEXT NOT NULL,                     -- lowercase hex, 0x-prefixed
  fingerprint   TEXT NOT NULL,                     -- sha256(DER), 64-hex
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoke_reason TEXT,
  issued_by     TEXT NOT NULL,                     -- actor that minted it
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE UNIQUE INDEX user_cert_serial_unique
  ON user_cert (org_id, serial_hex)
  WHERE deleted_at IS NULL;

CREATE INDEX user_cert_cn_idx
  ON user_cert (org_id, kind, cn)
  WHERE deleted_at IS NULL;

CREATE INDEX user_cert_active_idx
  ON user_cert (org_id, expires_at)
  WHERE deleted_at IS NULL AND revoked_at IS NULL;
```

Migration block: **0080–0089** is the next reserved block per the
0040–0079 allocations already in use. WS8 claims 0080–0084 for
identity-cert tables.

`user_cert` is the catalog. The actual `.pem` + `.key` are
filesystem artifacts at
`%ProgramData%\Signalman\certs\identities\<kind>/<cn>.{pem,key}`.
The DB row + the filesystem files are the two halves of the truth;
the integration tests must assert they stay in sync (the same
pattern as release-row + blob-content today).

## CLI + MCP surface

Five verbs. All take `--org-id` (defaults to the active org); all
write audit-log rows.

```bash
# Mint a new identity cert.
signalman cert mint \
  --kind user --cn alice@team.example \
  --ttl 30d \
  --out ./alice.pem --out-key ./alice.key
# audit: cert.minted

# List identity certs (active by default; --include-revoked + --include-expired flags).
signalman cert list [--kind user] [--include-revoked] [--include-expired]
# audit: cert.listed (no row written — read-only, audit is via HTTP access log)

# Show one cert by serial or CN.
signalman cert show <serial-or-cn>
# audit: cert.viewed (only when --include-secret is set; otherwise no row)

# Revoke a cert by serial or CN.
signalman cert revoke <serial-or-cn> --reason "key compromised"
# audit: cert.revoked

# Push the updated denylist (v0.3.x; out of scope for WS8 MVP).
signalman cert push-denylist [--targets <ids>]
# audit: cert.denylist_pushed
```

MCP surface mirrors the CLI: `signalman_cert_mint`,
`signalman_cert_list`, `signalman_cert_show`, `signalman_cert_revoke`.

Audit action codes added to the canonical table in
`docs/supply-chain.md`:

| `cert.*` | identity certs | `cert.minted`, `cert.revoked`, `cert.denylist_pushed` |

## Guest-agent integration

The existing `guest/src/cert_pin.rs` module gets a sibling:
`guest/src/identity_verify.rs`. The interceptor now runs three
checks in order, after the bearer-token check:

```rust
// pseudo-code
fn verify_request(req, leaf_cert_der, leaf_cert_x509) -> Result<()> {
    // 1. Bearer token (existing).
    verify_bearer_token(req)?;

    // 2. mTLS chain (existing).
    // Already performed by rustls before the interceptor runs.

    // 3. Identity-cert verification (new; opt-in via --identity-mode):
    //    a) Subject OU is one of (operators | machines | services).
    //    b) URI SAN matches spiffe://signalman/<org>/<kind>/<cn>.
    //    c) Cert serial is NOT in the denylist.
    if identity_mode_enabled() {
        verify_identity_cert(leaf_cert_x509, &denylist)?;
    }

    // 4. Cert-pin verification (existing; remains the v0.1.x fallback).
    if !pin_set.is_empty() {
        verify_cert_pin(leaf_cert_der, pin_set)?;
    }

    Ok(())
}
```

`--identity-mode` is opt-in in v0.2.0 (operators must enable it
per-guest). v0.2.1 enables it by default with cert-pinning as the
fallback. v0.3.0 removes the cert-pin path.

The `verify_identity_cert` function reads the denylist from
`<cert-dir>/identities/revoked.json` once at startup. SIGHUP
(Linux/macOS) and a 60s poll (Windows) re-read it; the file's
Ed25519 signature is verified against the bundle's `ca.pem` public
key before the contents are trusted.

When `--identity-mode` is on and **no `revoked.json` exists**, the
guest treats the denylist as empty (not as an error). This is
deliberate: a fresh install has nothing to revoke; demanding the
file would brick first-boot.

The actor extracted from the cert subject is plumbed into the
existing audit-log call site at the guest-side RPC handler, where
it overrides the bearer-token-prefix actor that's currently
recorded. The host's outbound MCP call site is updated similarly so
audit rows recorded on the host side see the same actor identity.

## Rotation flow

```bash
# Rotate alice's user cert with a 7-day overlap window.
signalman cert rotate alice@team.example --overlap 7d
# audit: cert.rotated (records both old + new serials)
```

Under the hood:

1. Mint a new cert with the same CN, fresh serial.
2. Record both old + new rows in `user_cert`.
3. **Do NOT** revoke the old cert immediately. Mark it
   `revoke_after = now + overlap`.
4. The host runs a "cert reaper" tick (alongside the existing
   cloud-VM reaper) that revokes overlap-expired old certs and
   rewrites `revoked.json` accordingly.

The overlap pattern is the same as the cert-pin module's
multi-pin support — both old + new are valid during the window.

## Migration from cert-pinning

Three-phase rollout:

| Phase | Version | `--identity-mode` default | cert-pin path |
|---|---|---|---|
| **Opt-in** | v0.2.0 | off | active, default verifier |
| **Default-on** | v0.2.1 | on | active, fallback verifier |
| **Sole** | v0.3.0 | on | removed |

During phases 1 + 2, both verifiers run. A request passes if
**either** verifier accepts it. This lets operators flip the flag
without coordinating cert-rotation across the fleet on the same day.

A `signalman cert migration-status` verb (also v0.2.0) reports
per-target which verifier is in use and how many requests have
hit each path in the last hour. Operators use this to decide when
their fleet is ready for the v0.2.1 default flip.

## Test taxonomy

- **Unit (Rust guest, host TS):**
  - Cert subject parsing (kind + cn + URI SAN extraction).
  - Denylist load + signature verification.
  - Per-kind TTL defaults + MAX_TTL ceiling.
  - Constant-time serial comparison in the denylist hot path.
- **Integration (host TS):**
  - Mint → list → show → revoke round-trip with SQLite.
  - Rotation: mint v1, rotate, both serials present, overlap window
    works, old serial revoked after window.
  - Audit-log rows have the right actor when minting from an
    operator-signed mTLS call vs. from a bearer-token call.
- **System (host TS + Rust):**
  - End-to-end: mint a user cert on the host; copy `.pem`/`.key`
    to a tempdir; spin up a `signalman-guest` with
    `--identity-mode=on` and `--tls-cert`/`--tls-key` pointing at
    the new cert; assert RPC succeeds. Revoke the cert; push the
    new denylist; assert RPC fails.
  - **Coexistence:** v0.2.0 phase — boot guest with both
    `--identity-mode=on` AND a legacy `--client-cert-sha256` pin;
    assert legacy pin path still works.
- **Smoke:** schema validation (no rotted migration), proto-shape
  pinning (no new RPC), CLI help text presence.

## Definition of Done (for WS8 v0.2.0 ship)

1. Migration 0080 lands; SQLite + pg-mem both clean.
2. `signalman cert mint|list|show|revoke|rotate` work end-to-end.
3. Guest agent honours `--identity-mode`; denylist verified by
   signature; coexistence with cert-pin path works.
4. Audit log records `cert.*` action codes with the right actor.
5. `docs/supply-chain.md` updated: §Key model expanded, §Audit-log
   canonical-action-codes table gains the `cert.*` row.
6. `docs/mtls.md` updated: new §Per-user identity certs section
   replacing the current implicit one-cert-per-host model.
7. Coverage holds: ≥80% lines / ≥70% branches across the new code.
8. 4-lens audit: QA / Architecture / Product / Security all PASS or
   explicit operator-review concern flagged. **Security lens is
   non-negotiable here** — this is a PKI primitive.

## Open product questions

### Resolved (operator-confirmed 2026-05-16)

1. **Identity-kind set:** three kinds — `user` / `machine` /
   `service`. Per the kind table in §Identity model above.
2. **CN format for users:** constrained to **RFC 5322 local-part
   syntax** (`alice`, `alice.smith`, `alice+tag`, `alice@team`).
   Rejects spaces, unicode, and free-form text. Audit-log search
   by CN is unambiguous.
3. **TTL defaults:** **30 days user / 90 days machine / 7 days
   service.** Every mint accepts `--ttl <duration>` to override.
4. **Denylist signing key:** **install-time CA key.** Same key
   that signed every identity cert. Minimizes new surface; the
   trust root already authorizes both roles. Guests verify
   against `ca.pem` they already have.

### Carry forward (WS8 to confirm)

5. **MAX_TTL ceiling.** 365 days feels right. Alternatives: 90
   days (forces a quarterly mint cycle for everyone), no
   ceiling (back to certificate-managed-elsewhere). Default
   rec: **365.**
6. **Migration-window length.** v0.2.0 ships with cert-pin
   coexistence; v0.2.1 flips the default. How long between?
   Default rec: **one minor (one month after v0.2.0
   stabilizes).**
7. **Org-id in URI SAN.** The SPIFFE-style URI SAN includes
   `<org-id>`. For local-mode single-org deployments this is
   `default`. Alternative: omit the org-id segment entirely
   (`spiffe://signalman/<kind>/<cn>`). Default rec: **keep
   org-id even in local mode** — costs nothing today, saves a
   schema break later.
8. **Out-of-scope confirmation.** This design defers TPM/HSM,
   external-CA delegation, OCSP, and full SVID. Confirm these
   stay out for v0.2.0.

## Extension points (out of scope for WS8)

- **Two-tier CA** (offline root + online intermediate) — schema
  + chain validation already compatible; ship as v0.3+ if/when
  operators ask.
- **External CA delegation** — `signalman cert mint` grows a
  `--issuer external://vault?role=signalman` form; the existing
  catalog stores the cert without minting locally.
- **SPIFFE SVID daemon** — short-lived auto-rotating identity
  certs distributed by a workload API. The URI SAN convention
  is already SPIFFE-compatible.
- **Per-target denylist** — `cert revoke` grows a
  `--targets <ids>` form to push denylist deltas only to
  certain VMs (e.g. dev-tier vs prod-tier).
- **OCSP responder** — a `/v1/ocsp` endpoint on the host
  for real-time revocation checks.

## Cross-references

- `guest/src/cert_pin.rs` — v0.1.x cert-pin module; the
  predecessor pattern this design replaces.
- `service/src/tls.rs` — current CA + cert generation +
  rotation surface.
- `host/src/provisioning/provision.ts` — provisioning copies
  certs to new VMs.
- `docs/mtls.md` — operator-facing mTLS doc; gains a new
  §Per-user identity certs section when WS8 ships.
- `docs/supply-chain.md` §Key model — gains the per-user
  topology; §Audit log canonical action codes — gains the
  `cert.*` row.
- `docs/workstreams/prompts/ws8-per-user-identity-certs.md` —
  the executable starting prompt for the implementation
  session.
