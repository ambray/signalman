# Supply Chain Notes

The Signalman supply-chain posture spans four concerns:

1. **Build-time toolchain reproducibility** — pinned `protoc` and
   MSI-builder binaries so CI + local builds + release artifacts
   stay byte-identical.
2. **Release-artifact signing** — Ed25519 over canonical manifest
   JSON for every build's release row, with operator-verifiable
   fingerprints.
3. **Artifact-registry provenance** — `@signalman/registry` records
   the source of every manifest it stores (`upload` / `proxy_cache` /
   `manifest_create`), re-signs virtual-upstream cache writes, and
   exposes a forensic HTTP API that traces an artifact back to its
   ingest event.
4. **Immutable audit log** — every artifact write, every
   credential / config change, every deploy / promotion / webhook
   event is recorded in a tamper-evident audit log with canonical
   action codes.

Together these answer three questions a regulated operator asks:

- **"Where did this artifact come from?"** — forensic API.
- **"Has anyone tampered with it since ingest?"** — Ed25519
  signature verification.
- **"Who did what when?"** — audit log query.

## Build-time toolchain

### `protoc-bin-vendored`

Signalman uses `protoc-bin-vendored` in the Rust guest and service
build scripts so Windows, Linux, and macOS contributors get a pinned
`protoc` binary through Cargo rather than relying on a mutable system
install.

This is an intentional tradeoff:

- It keeps proto generation reproducible across local development,
  CI, and release builds.
- It avoids asking Windows operators to install and place `protoc.exe`
  on `PATH` before they can build the service or guest.
- The package is present only as a build dependency; it is not
  shipped in the runtime service or guest binaries.
- The lockfile pins the exact crate versions and platform packages
  consumed by the build.

Operational guardrails:

- Treat any `protoc-bin-vendored*` version bump as a supply-chain
  event and review the Cargo diff before merging.
- Keep generated proto shape pinned with
  `host/src/__tests__/proto-shape.test.ts` and
  `host/src/__tests__/proto-contract.test.ts`.
- Prefer replacing this dependency with a checked-in, signed,
  release-managed `protoc` tool only if the vendored crate becomes
  unmaintained, starts pulling unexpected platforms, or blocks
  reproducible release builds.

### `cargo-wix`

Signalman uses `cargo-wix` only as release/build tooling for the
service and guest MSI packages.

Decision:

- CI installs the pinned version with `cargo install cargo-wix
  --locked --version 0.3.9`.
- The local `scripts/release-dry-run.ps1` does not auto-install it;
  operators must install it explicitly before building MSIs locally.
- `cargo-wix` is not linked into or shipped with the Signalman
  runtime binaries.

Operational guardrails:

- Keep the version pin synchronized between
  `.github/workflows/release.yaml`,
  `scripts/release-dry-run.ps1`, and `docs/bootstrap.md`.
- Re-check the pin before bumping it, and prefer `--locked` so
  transitive versions stay constrained by the crate's lockfile.

## Release-artifact signing (Ed25519)

Every release row written by the build executor optionally carries
an Ed25519 signature over the canonical manifest JSON. Verification
is part of the operator surface and shipped with the host CLI.

### Key model

- **One-CA-many-VMs** at v0.1.x; the cert-pin registry is the seed
  for per-VM identity certs in a follow-up.
- Signing keys are operator-managed; the default key file lives at
  `~/.signalman/keys/signing.{pub,key}`. The CLI never copies the
  private key off the operator's host.
- Fingerprint format: first 16 hex chars of `sha256(DER(public key))`.
  Surfaces as the `signed_by` column on every release this key signs.

### Operator workflow

```bash
# 1. Generate a keypair (default output ~/.signalman/keys/signing.*).
signalman key generate

# 2. Print the public-key fingerprint for distribution.
signalman key fingerprint ~/.signalman/keys/signing.pub
# → ff97da80c1be84c5...

# 3. Build with signing on.
signalman release build --product myapp --tag v1.0.0 \
  --sign --key ~/.signalman/keys/signing.key

# 4. Verify a release later (anyone with the public key).
signalman release verify <release-id> \
  --public-key ~/.signalman/keys/signing.pub
```

### Canonical manifest shape

The Ed25519 signature is computed over the canonical-form JSON of a
ReleaseManifest object — `{ product, tag, commitSha, entries: [...] }`
— with deterministic ordering of object keys and array entries
(`entries` sorted by `component`). The manifest hash + signature +
signed-by fingerprint persist on the release row; the canonical-form
JSON itself can be reconstructed from the release row + artifact
rows at any time (verifiers do this and re-run the signature check).

### Verification semantics

`verifyManifest(manifest, signatureB64, signedBy, publicKeyPem)`
checks:

1. The supplied public key's fingerprint matches `signedBy` (so the
   verifier knows which key was used).
2. The Ed25519 signature is valid over the canonical manifest JSON.
3. The reconstructed manifest's hash matches the stored
   `manifest_sha256` on the release row (belt + suspenders against
   a tampered release row).

Any mismatch surfaces a `verified: false` outcome with a `reason`
string the caller can present.

## Artifact-registry provenance

`@signalman/registry` (the standalone OSS sibling) layers provenance
metadata onto every manifest it stores. The host's `signalman-registry`
BlobDriver routes blob writes through the registry, so this metadata
is captured whether artifacts originate from `release build`, a
virtual-upstream cache miss, or an explicit operator push.

### Provenance shape

Every manifest row in the registry carries:

```json
{
  "source":         "upload | proxy_cache | manifest_create",
  "ingest_at":      "<ISO-8601 timestamp>",
  "ingest_actor":   "<bearer-token prefix | upstream URL host>",
  "upstream_url":   "<URL or null>",
  "signed_by":      "<Ed25519 fingerprint or null>",
  "signature_b64":  "<base64 signature or null>"
}
```

- **`upload`** — direct write via `cargo publish` / `npm publish` /
  `PUT /v1/manifests/...`. `ingest_actor` is the bearer-token prefix.
- **`proxy_cache`** — virtual-upstream cache write. `upstream_url`
  records the source registry the artifact was pulled from. The
  registry re-signs the cached manifest with its local key on write
  (configurable per virtual upstream); `signed_by` becomes the
  registry's fingerprint.
- **`manifest_create`** — derived manifest (e.g. an aggregate index
  built from N existing manifest rows). `ingest_actor` is the
  service identity.

### Virtual-upstream re-signing

When a virtual upstream is configured with `re_sign: true`, the
registry re-signs the cached manifest with its local Ed25519 key on
cache write. The original upstream signature (if any) is preserved
on the provenance row; the new `signed_by` becomes the registry's
fingerprint. Downstream consumers verify against the registry's
public key.

### Forensic HTTP API

The registry exposes `/v1/forensic/manifest/<name>/<version>`:

```bash
curl -H "Authorization: Bearer $REGISTRY_TOKEN" \
  http://localhost:9876/v1/forensic/manifest/my-crate/1.0.0
```

Response:

```json
{
  "manifest": { /* full manifest */ },
  "provenance": { /* the provenance row above */ },
  "audit_trail": [
    {
      "action": "upload",
      "at": "2026-05-15T09:00:00.000Z",
      "actor": "sk_AAAAAAAA",
      "detail": { "size_bytes": 4096, "sha256": "..." }
    }
  ]
}
```

The audit-trail array is the filtered subset of the audit log
that touched this manifest — every write, every cache-promote,
every metadata patch. The trail is what answers "has anyone tampered
with this artifact since ingest?" — any unexpected entry surfaces
immediately.

## Immutable audit log

Every artifact write, credential / config change, deploy / rollback,
promotion decision, webhook delivery, and scheduled-health tick is
recorded in the host's audit-log table. The audit log is
append-only: there is no UPDATE or DELETE surface in the repository
interface, only `append()`. Rows are timestamped on the database
side (`created_at NOT NULL DEFAULT now()`) so backdating is not
possible from the host code path.

### Canonical action codes

The audit log uses canonical action codes namespaced by entity:

| Action prefix | Entity | Example |
|---|---|---|
| `product.*` | products | `product.added`, `product.removed` |
| `release.*` | releases | `release.built`, `release.signed`, `release.verified` |
| `deployment.*` | deployments | `deployment.started`, `deployment.completed`, `deployment.rolled_back` |
| `target.*` | targets | `target.added`, `target.removed` |
| `health.*` | health probes | `health.checked`, `health.scheduled.pass`, `health.scheduled.fail` |
| `health_schedule.*` | scheduled health | `health_schedule.added`, `health_schedule.removed` |
| `webhook.*` | webhooks | `webhook.added`, `webhook.removed`, `webhook.delivered`, `webhook.failed` |
| `promotion_policy.*` | promotion policies | `promotion_policy.added` |
| `approval.*` | approvals | `approval.approved`, `approval.rejected` |
| `cloud_creds.*` | cloud credentials | `cloud_creds.set`, `cloud_creds.removed` |
| `cloud_budget.*` | cloud budgets | `cloud_budget.set`, `cloud_budget.exceeded` |
| `cloud_usage.*` | cloud usage | `cloud_usage.recorded`, `cloud_usage.terminated` |
| Registry `upload` / `proxy_cache` / `manifest_create` / `delete` / `security_scan_*` | registry artifacts | WS10 adds `delete` (blob + manifest DELETE handlers, chunked-upload reaper). The OCI manifest PUT emits `upload` + a second `manifest_create` row when the PUT installs a tag pointer (so tag-rotation history is reconstructable from the audit log). |

Every audit row carries `actor` (CLI label, service identity, or
bearer-token prefix), `entity_type`, `entity_id`, and an optional
`detail` JSON blob with action-specific context.

### Query surface

CLI: `signalman audit list --org-id <id>`
(coming in the OSS-hygiene trio epic).

HTTP: `GET /v1/audit?entity_type=...&entity_id=...&limit=...`
on the host control plane.

Registry-side audit: `GET /v1/audit/query` on the registry plus
`signalman-registry audit query` CLI.

### Retention

v0.1.x: unbounded. Retention policies (auto-prune by age / count)
land alongside the v0.1.4 registry milestone (mutable tags +
retention/GC).

## Bootstrap-from-signalman

The long-term vision is **signalman becomes its own CI/CD substrate**:

- CI builds publish artifacts (Rust crates, npm packages, container
  images, agent installers) to a self-hosted signalman registry via
  `cargo publish` / `npm publish` / `docker push` (OCI queued for
  v0.1.2).
- CD pulls from the registry to deploy via the existing host
  `BlobDriver` + cloud / k8s / VM target kinds.
- Public dependencies flow through virtual registries: crates.io,
  npm, Docker Hub, etc. The registry pins the bytes that hit each
  build via the provenance trail above.
- Security: package firewalls (Veracode, Sonatype Nexus) plug in as
  upstream proxies; OSV + commercial-vendor APIs scan on ingest and
  surface findings via the forensic API.

The cargo + npm facades (v0.1.1) close the half of the loop most
operators reach for first (signalman publishes itself). OCI
(v0.1.2 / v0.5 / WS10, **shipped 2026-05-17**) closes the container
side: every `docker push` / `docker pull` / `cosign sign|verify`
ride the same blob store, manifest catalog, audit log, and
forensic / provenance API as cargo + npm. Pull-through against
Docker Hub, GHCR, and ECR transparently mirrors public images;
re-signing on cache write attaches the registry's Ed25519
attestation to upstream bytes. Security integration (v0.1.3) plugs
the scanner adapters in. See `registry/ROADMAP.md` for the full
forward roadmap.

## Cross-references

- [Ed25519 signing implementation](../host/src/control-plane/build/signing.ts)
- [Registry provenance schema](../registry/src/manifest/types.ts)
- [Registry forensic HTTP API](../registry/src/http/forensic.ts)
- [Audit log repo (host)](../host/src/control-plane/storage/driver.ts) (search `AuditLogRepo`)
- [Audit log repo (registry)](../registry/src/storage/driver.ts)
- [registry/ROADMAP.md](../registry/ROADMAP.md) — forward roadmap for
  the registry / supply-chain stack.
