---
name: signalman-npm-bootstrap
description: 'Set up the Signalman registry as an npm registry for the operator''s org — publish packages to it, install from it, and transparently mirror npmjs.com through it. Per-org namespacing under /npm/<org>/ with scoped + unscoped package support. Virtual upstreams with optional Ed25519 re-signing give compliance-grade provenance for proxied npmjs.com packages. Trigger when the user says "publish my npm package to signalman", "set up the registry to mirror npmjs.com", "configure npm virtual registry", "bootstrap node package hosting", or asks how to use the registry as an npm backend. CLI parity: `signalman-registry virtual {add,list,remove}` works for `--kind npm` exactly like for cargo.'
allowed-tools: Bash
---

# Bootstrap npm package hosting on a Signalman registry

v0.1.1 shipped an npm facade on `@signalman/registry`. Stock `npm
install` / `npm publish` works against a Signalman registry with
per-org namespacing + virtual-upstream pull-through against
npmjs.com. This skill covers the operator workflow end-to-end.

## What you need

- A running Signalman registry (`signalman-registry serve --storage-root <p> --port <n>`)
- An Ed25519 keypair for re-signing proxied packages (optional but
  recommended for compliance):
  `signalman-registry keygen --out-dir ~/.signalman/registry-keys`
- A bearer token shaped `sk_<4-16-Crockford-b32>_<16-64-Crockford-b32>`
  (real RBAC lands with v0.2.1 of the registry's roadmap)

## Step 1 — Configure npm to use the registry

Operator's `~/.npmrc`:

```ini
# Default registry for all packages — points at your org's namespace
registry=https://registry.example.com/npm/acme/
//registry.example.com/npm/acme/:_authToken=sk_TEST_0123456789ABCDEF
```

For scope-specific routing (recommended when you want only some
packages to come from Signalman):

```ini
# Only @acme/* packages go to Signalman; others use the default
# (typically npmjs.com)
@acme:registry=https://registry.example.com/npm/acme/
//registry.example.com/npm/acme/:_authToken=sk_TEST_0123456789ABCDEF
```

## Step 2 — Publish a package

Inside a node package directory:

```bash
# Set the publish target in package.json:
#   "publishConfig": { "registry": "https://registry.example.com/npm/acme/" }
npm publish
```

What happens server-side:

1. npm assembles the publish JSON (`name`, `versions[<version>]`, `_attachments`)
2. base64-encodes the .tgz tarball into `_attachments[<name>-<version>.tgz].data`
3. Sends `PUT /npm/acme/<name>` with that body
4. Registry decodes the tarball, hashes it (sha256 internal +
   sha512 for SRI integrity), stores as a content-addressed blob
5. Builds a manifest with `kind: 'npm'`, `name: 'npm/acme/<name>'`
6. Appends `action: 'upload', entityType: 'manifest', detail.kind: 'npm'`
   to the audit log

## Step 3 — Install a package

A consumer's `.npmrc` points at the same registry. Then:

```bash
npm install <package>
```

Or in `package.json`:

```jsonc
{
  "dependencies": {
    "@signalman/host": "^0.1.0"
  }
}
```

Resolved versions stream from the registry's blob store. The
packument response's `dist.tarball` URLs are auto-rewritten to
point at the registry (not the upstream) so subsequent installs
don't bypass the cache.

## Step 4 — Scoped packages

Both scoped (`@signalman/host`) and unscoped (`express`) names
work. URL-encode the slash for the request path:

```bash
# Manual curl example
curl https://registry.example.com/npm/acme/%40signalman%2Fhost
curl https://registry.example.com/npm/acme/%40signalman%2Fhost/-/host-1.0.0.tgz
```

(npm clients handle the encoding automatically; you only need it
for direct HTTP calls.)

## Step 5 — Mirror npmjs.com transparently (virtual upstream)

```bash
# On the host running the registry:
signalman-registry virtual add \
  --storage-root /var/lib/signalman \
  --org acme \
  --kind npm \
  --upstream https://registry.npmjs.org \
  --resign

# Optional: restrict to a subset of npm packages
signalman-registry virtual add \
  --storage-root /var/lib/signalman \
  --org acme \
  --kind npm \
  --upstream https://registry.npmjs.org \
  --allow "express,@types/*" \
  --deny "@internal/*"
```

After this, an `npm install express` against the Signalman
registry resolves transparently — even though Acme hasn't
published `express` to its own org. On first request:

- Packument call hits a local miss
- Registry proxy-fetches from npmjs.com
- Each version cached as a manifest with `provenance.source =
  'proxy_cache'` and `provenance.upstreamUrl = 'https://registry.npmjs.org'`
- If `--resign` set: re-signed with operator's Ed25519 key
- Audit-log entry per cached version

The second `npm install` hits the cache; npmjs.com is not consulted.

## Step 6 — Forensic + supply-chain trail

Same as the cargo facade (M10), the forensic API answers "what's
in my registry and where did it come from":

```bash
# Manifest counts by kind + source
signalman-registry forensic summary --storage-root /var/lib/signalman

# Which upstreams have packages been pulled from?
signalman-registry forensic upstreams --storage-root /var/lib/signalman

# Recent npm ingest events
signalman-registry audit \
  --storage-root /var/lib/signalman \
  --entity-type manifest \
  --since 2026-05-15T00:00:00Z
```

For a specific package, the HTTP API surfaces the provenance:

```bash
curl -H 'Authorization: Bearer <token>' \
  https://registry.example.com/v1/provenance/manifest/npm%2Facme%2Fexpress/4.18.0
```

Returns `{ manifest, provenance: { source: 'proxy_cache', upstreamUrl, fetchedAt, fetchedBy } }`.

## What NOT to do

- **Don't publish over an unencrypted endpoint.** The bearer token
  travels in the `Authorization` header on every request.
- **Don't operate without `--resign` for compliance use cases.**
  Without re-signing, proxied packages carry no operator
  attestation — only npmjs.com's integrity hash. For SBOM
  generation + supply-chain trail, always `--resign`.
- **Don't allow `*` (everything) from an untrusted upstream** in
  a regulated environment. Combine `--allow` (positive list)
  with `--deny` (sensitive prefixes) for defence-in-depth.
- **Don't share auth tokens across orgs.** Each org's
  `/npm/<org>/` namespace is opaque; tokens are global today
  (v0.4.0 acceptAnyValidShape) but real RBAC lands in v0.2.1 —
  treat tokens as least-privilege from day one.

## Follow-up suggestions

- After every CI build, run `signalman-registry audit --action
  upload --entity-type manifest --since <last-deploy>` to feed
  your SBOM generator the list of fresh npm publishes.
- Pair this with the cargo facade (`signalman-cargo-bootstrap`):
  the same registry hosts both your Rust crates AND your npm
  packages. One operator vehicle, one provenance trail.
- v0.1.3 of the registry roadmap (security integration) will
  let you plug in OSV / Veracode / Sonatype scanners as pre-cache
  filters. Today's `--deny <glob>` is the pattern-based stopgap.
