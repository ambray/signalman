---
name: signalman-cargo-bootstrap
description: 'Set up the Signalman registry as a cargo registry for the operator''s org — publish Rust crates to it, install from it, and transparently mirror crates.io through it. Per-org sparse-index namespacing keeps multi-tenant orgs isolated; virtual upstreams with optional Ed25519 re-signing give compliance-grade provenance for proxied crates.io packages. Trigger when the user says "publish my crate to signalman", "set up the registry to mirror crates.io", "configure a cargo virtual registry", "bootstrap rust crate hosting", or asks how to use the registry as a cargo backend. CLI parity: `signalman-registry virtual {add,list,remove}` + `audit` + `forensic`.'
allowed-tools: Bash
---

# Bootstrap cargo crate hosting on a Signalman registry

WS6 wave-3 M10 shipped a cargo facade on `@signalman/registry`. Stock
`cargo publish` / `cargo install` works against a Signalman registry
with per-org namespacing + virtual-upstream pull-through. This skill
covers the operator workflow end-to-end.

## What you need

- A running Signalman registry (`signalman-registry serve --storage-root <p> --port <n>`)
- An Ed25519 keypair for re-signing proxied crates (optional but
  recommended for compliance):
  `signalman-registry keygen --out-dir ~/.signalman/registry-keys`
- A bearer token shaped `sk_<4-16-Crockford-b32>_<16-64-Crockford-b32>`
  (the v0.4.0 server accepts any shape-valid token; real RBAC lands
  with v0.2.1 of the registry's roadmap)

## Step 1 — Configure cargo to use the registry

Operator's `~/.cargo/config.toml`:

```toml
[registries.signalman]
index = "sparse+https://registry.example.com/cargo/acme/index/"

# When publishing privately:
[registries.signalman.token]
value = "Bearer sk_TEST_0123456789ABCDEF"
```

(Replace `acme` with the org name. Each org gets its own sparse-index
URL; the registry routes by URL path, not bearer token.)

## Step 2 — Publish a crate

```bash
# From the crate directory:
cargo publish --registry signalman --token sk_TEST_0123456789ABCDEF
```

What happens server-side:

1. Cargo builds the .crate tarball + serialises the publish metadata
2. Sends a length-prefixed binary body to
   `PUT /cargo/acme/api/v1/crates/new`
3. Registry hashes the tarball (sha256), stores it as a
   content-addressed blob
4. Builds a manifest with `kind: 'cargo'` and
   `name: 'cargo/acme/<crate>'`
5. Appends `action: 'upload', entityType: 'cargo_crate'` to the
   audit log with the operator's token prefix as the actor

## Step 3 — Install a crate

A consumer's `~/.cargo/config.toml` points at the same sparse-index:

```toml
[registries.signalman]
index = "sparse+https://registry.example.com/cargo/acme/index/"
```

Then `cargo install <crate> --registry signalman` works. So does adding
a dep:

```toml
# Cargo.toml
[dependencies]
mycrate = { version = "1.0", registry = "signalman" }
```

## Step 4 — Mirror crates.io transparently (virtual upstream)

Now the powerful bit. Configure the registry to proxy-fetch any
crate the local index doesn't have:

```bash
# On the host running the registry:
signalman-registry virtual add \
  --storage-root /var/lib/signalman \
  --org acme \
  --kind cargo \
  --upstream https://index.crates.io \
  --resign

# Optional: restrict to a subset of crates.io
signalman-registry virtual add \
  --storage-root /var/lib/signalman \
  --org acme \
  --kind cargo \
  --upstream https://index.crates.io \
  --allow "tokio*,serde,async-*" \
  --deny "internal-*"
```

With this configured, a `cargo build` against `registry = "signalman"`
resolves **both** org-owned crates AND any crates.io crate transparently.
On first request:

- Sparse-index call hits a local miss
- Registry proxy-fetches from crates.io
- Cached as a manifest with `provenance.source = 'proxy_cache'` and
  `provenance.upstreamUrl = 'https://index.crates.io'`
- If `--resign` was set: re-signed with the operator's Ed25519 key
  (operator's CI can verify with `signalman-registry verify ...`)
- Audit-log entry recorded for forensic traceability

The second call hits the cache; the upstream is not consulted.

## Step 5 — Yank / unyank

Standard cargo:

```bash
cargo yank --vers 1.0.0 mycrate --registry signalman
cargo unyank --vers 1.0.0 mycrate --registry signalman
```

The registry flips `cargoMetadata.yanked` in the manifest row and
audits the event. Yanked crates remain downloadable (Cargo.lock
pinned installs still work) but new resolutions skip them.

## Step 6 — Forensic queries (the "code-to-cloud" trace)

```bash
# What's in the registry, grouped by kind + provenance source?
signalman-registry forensic summary --storage-root /var/lib/signalman

# Which upstreams have we pulled from?
signalman-registry forensic upstreams --storage-root /var/lib/signalman

# Recent ingest events (filter by action, entity, actor, time):
signalman-registry audit \
  --storage-root /var/lib/signalman \
  --action proxy_cache \
  --since 2026-05-15T00:00:00Z \
  --limit 100

# What's the provenance of a specific crate version?
curl -H 'Authorization: Bearer <token>' \
  https://registry.example.com/v1/provenance/manifest/cargo/acme/tokio/1.0.0
```

The `audit` log is immutable + append-only. The forensic API surfaces
every artifact's origin (`upload` = operator's CI published it;
`proxy_cache` = mirrored from upstream).

## What NOT to do

- **Don't reuse org names with different upstream configs.** If
  Acme's CI publishes `acme-internal` and the same org's index also
  mirrors crates.io, the deny-pattern `internal-*` should be set on
  the virtual upstream to prevent a typo from auto-fetching a
  malicious `acme-internal` from crates.io.
- **Don't operate without `--resign` for compliance use cases.**
  Without re-signing, the proxied crate has no operator attestation
  — only the upstream's signature (if any). For compliance-grade
  supply-chain trail, always `--resign` and verify the operator's
  signature in CI.
- **Don't run the registry on an unencrypted endpoint** when
  publishing private crates. Tokens travel in the `Authorization`
  header on every request; an MITM can capture them.
- **Don't re-publish the same crate version with different bytes.**
  The registry rejects this with HTTP 409 (cargo's publish-once-
  per-version protocol). Operators that need to fix a bad publish
  should yank + publish a new version.

## Follow-up suggestions

- After every CI build, run `signalman-registry audit --action upload
  --since <last-deploy>` to surface every crate that made it into
  the registry since the last deploy. Feed this into your SBOM
  generator.
- Pair this skill with `signalman-deploy-runner` (M9): the runner
  binary URL can be a `@signalman/registry` blob URL, closing the
  "bootstrap signalman from signalman" loop.
- Wave-3 roadmap (`registry/ROADMAP.md`): the **v0.1.3 security
  integration** milestone will let you plug in OSV / Veracode /
  Sonatype scanners as upstream firewalls. Today's `--deny <glob>`
  is the pattern-based stopgap.
