# `@signalman/registry` roadmap

**Current version:** `0.1.1` (cargo + npm facades + virtual registry
+ forensic surface; **2026-05-15**).
**Source-of-truth design:** `docs/design/meta-build-system.md` §15 +
`docs/audit/capability-matrix-2026-05-wave3.md` for the operator-
facing bootstrap vision.

The v0.4.0 bootstrap (committed on `feat/v0.4.0-registry`) landed the
package skeleton, generic blob format, Ed25519 signing port, minimal
HTTP API, CLI, MCP surface, and the host-side
`signalman-registry` BlobDriver.

The **M10 wave** (WS6 wave-3 carve-out #9, shipped **2026-05-15**)
took the registry from "OSS scaffolding" to "operator-bootstrapping
substrate" by adding:

- Manifest `kind` discriminator + protocol-specific metadata
  (M10.1)
- Cargo sparse-index facade with per-org namespacing (M10.2 + M10.3)
- Virtual-registry pull-through with re-signing (M10.4)
- Forensic + provenance HTTP API + audit log (M10.5)
- Operator CLI + skill + this ROADMAP refresh (M10.6)

Everything below is the **forward roadmap** — what bootstrap-from-
signalman needs next.

## The bootstrap-from-signalman vision

The long-term goal is **signalman becomes its own CI/CD substrate**:

- CI builds publish artifacts (Rust crates, npm packages, container
  images, agent installers) to a self-hosted signalman registry.
- CD pulls from the registry to deploy via the existing host
  `BlobDriver` + cloud target kinds (M8).
- Public dependencies flow through virtual registries: crates.io,
  npm, Docker Hub, etc. The registry pins the bytes that hit each
  build (the "code-to-cloud" trace from M10.5).
- Security: package firewalls (Veracode, Sonatype Nexus) plug in
  as upstream proxies; OSV + commercial-vendor APIs scan on ingest
  and surface findings on every manifest.

The wave-3 work closes the **cargo** + **virtual** + **provenance**
foundation. The remaining roadmap delivers the rest of the
substrate.

## v0.1.x — close the bootstrap loop

### v0.1.1 — npm protocol facade ✅ SHIPPED (2026-05-15)

Same shape as the cargo facade, different protocol:

- Routes: `/npm/<org>/<package>` (packument),
  `/npm/<org>/<package>/-/<basename>-<version>.tgz` (tarball),
  `PUT /npm/<org>/<package>` (publish)
- Per-org namespacing (matches GitHub Packages' npm registry)
- Virtual-upstream pull-through against npmjs.com with Ed25519
  re-signing on cache write
- Scoped + unscoped package names supported (URL-encoded slash in
  scope separator)
- Per-package provenance + audit-log entries (`action: 'upload'`
  for publish; `action: 'proxy_cache'` for upstream pulls)

**Status**: `@signalman/host` becomes `npm install`-able from a
self-hosted registry. The cargo + npm pair gets signalman CI/CD
half-way to "all self-hosted" (still need OCI for container images
+ security integration for scanners).

**Operator surface**:
- Skill: `signalman-npm-bootstrap`
- CLI: existing `signalman-registry virtual {add,list,remove}` +
  `audit` + `forensic` verbs work for `--kind npm` exactly like
  cargo (the operator surface is protocol-agnostic)
- HTTP: `/npm/<org>/...` routes mounted in the buildApp router

**Storage**: new `npm_metadata_json` column on the manifest table
(migration `0003_npm_metadata.sql`). Existing rows unaffected.

**Not in v0.1.1**:
- Mutable `dist-tags` (`latest` / `staging`) beyond auto-`latest`
  on newest version — explicit tag rotation lands in v0.1.4
- Unpublish endpoint (npm typically disables this server-side
  for security; we follow the conservative default)
- npm audit endpoint (`POST /-/v1/security/audits`) — feeds the
  v0.1.3 OSV-integration milestone

### v0.1.2 — OCI distribution spec v1.1 ✅ SHIPPED (v0.5 / WS10, 2026-05-17)

The single most-requested feature for "a real registry" — operator
locked the eight open product questions on 2026-05-16 and the seven
milestones merged into local main across 2026-05-16 and 2026-05-17.
See `docs/design/registry-oci.md` for the full design + decision
record. Shipped surface:

- Container image manifests (`application/vnd.oci.image.manifest.v1+json`)
  + Docker v2.2 legacy types accepted on the same routes.
- Image index / manifest list (`application/vnd.oci.image.index.v1+json`)
  with child-manifest existence enforcement.
- `/v2/*` prefix routes mounted alongside the existing `/v1/*` surface
  via `mountOciRoutes`. Per-org namespacing matches cargo + npm.
- In-router namespacing via the `*name` wildcard — `team/svc` parses
  without `%2F` encoding.
- **Bearer-challenge auth flow** (`/v2/` + `/oci/token`) — Docker CLI
  works end to end. JWT minted with operator's Ed25519 key, verified
  inline by the global authenticator on subsequent `/v2/*` calls.
  `sk_<prefix>_<secret>` bearers still accepted directly for curl /
  oras / crane.
- **Cosign-style signing** at the `<digest>.sig` tag convention,
  signed with the operator's existing Ed25519 keypair. Notation /
  PKI variant remains deferred to v0.6+.
- **Virtual-upstream pull-through** against Docker Hub (anonymous
  token flow), GHCR (operator PAT or workload-identity), and ECR
  (AWS SigV4 GetAuthorizationToken). All three on day one per
  operator-locked Q2.
- Spec-compliant `OciErrorEnvelope` on every 4XX path. Spec
  `Docker-Content-Digest` header on every GET / HEAD success.
- `Link: <…>; rel="next"` pagination on `_catalog` + `tags/list`.
- 24-hour persisted chunked-upload UUIDs (Q8) with a 5-minute
  reaper that sweeps SQL row + tmp file as a pair.
- 562 tests across 32 files; coverage on `registry/src/oci/`
  92.64 / 85.89 / 96.71 / 92.64 (above the WS10 80/80 across-
  directory gate).

**Closed**: `docker push` / `docker pull` / `cosign sign|verify` /
`crane copy` all work against a Signalman registry today. Agent
installers + scenario images can ship as OCI artifacts through
the same audit + provenance surface that cargo + npm artifacts
already use.

**Pending**: distribution-spec conformance harness CI lane
scaffolded (`.github/workflows/oci-conformance.yaml`); first
gated nightly run is the v0.5.1 ship gate.

### v0.1.3 — security integration (OSV + firewall passthroughs)

The wave-3 design pre-baked provenance + virtual-upstream config
for this; v0.1.3 wires them up:

- OSV API integration: on every manifest ingest (publish OR
  proxy_cache), enqueue a scan job against `osv.dev`. Results land
  on a new `security_findings` field per manifest, queryable via
  `/v1/forensic/findings` or filtered on the existing
  `/v1/provenance/manifest/<name>/<version>` response.
- Commercial-vendor API plug points: the same `security_findings`
  field accepts results from Veracode SCA, Sonatype IQ, Snyk, etc.
  Operator configures a scanner adapter; the adapter posts findings
  back to the registry's audit log + manifest row.
- Package-firewall passthrough: virtual upstreams gain
  `pre_cache_scanner` config. On cache miss, the registry calls the
  scanner FIRST (e.g. Veracode Package Firewall, Sonatype Nexus
  Firewall API). Failed scans block the cache write; passed scans
  cache + tag with the scan ID.
- New audit-log action: `security_scan_*` with detail blob carrying
  scanner name + finding count + severity bucket.

**Closes**: an operator can answer "is this artifact safe to
deploy" without a manual lookup.

### v0.1.4 — mutable tags + retention/GC

Lower-priority but unblocks operator workflows:

- `latest`, `staging`, `production` — mutable pointers to immutable
  content addresses. New `PUT /v1/tags/:name/:tag` route + storage
  table.
- Retention policy: auto-expire by age, count, or tag policy.
- Reference-counted blob GC after configurable grace period.
- Blob `DELETE` endpoint lands (currently absent).
- Audit-log retention policy (currently unbounded; M10.5 known
  limitation).

## v0.2.x — operational hardening

### v0.2.0 — Operational hardening

- `HEAD /v1/blobs/:sha256` — replaces the GET-and-drain in
  `signalman-registry` BlobDriver's `exists()`.
- Streaming PUT path for blobs >1 GB. Current buffer-then-PUT is
  RAM-bound; the upgrade uses a temp-blob + server-side rename
  pattern, matching the v0.3.x S3 driver's planned shape.
- Streaming POST path for cargo publish (currently the publish
  body is buffered in 10 MiB chunks; large bundled assets push
  this limit).
- Short-lived URL signing on `presignGet` — currently returns the
  canonical URL and gates on bearer auth.
- Postgres-backed `ManifestIndex` driver implementing the same
  `RegistryStorage` interface (SQLite stays the local default).
- HTTP/2 + content-negotiation for client cargo / npm calls.

### v0.2.1 — RBAC + Cloud federation

The v0.4.0 server ships `acceptAnyValidShape: true` (any shape-
valid `sk_<prefix>_<secret>` bearer is admin). The M10.3 publish +
M10.5 forensic routes preserve this for back-compat. v0.2.1
introduces real RBAC:

- **OSS RBAC** — per-token scopes table inside the registry:
  - `read:<namespace>` / `write:<namespace>` / `admin:*`
  - `publish:<org>` for cargo + npm publish
  - `forensic:read` for `/v1/audit` + `/v1/forensic/*`
  - `proxy:<org>` to configure virtual upstreams
- Server boots with `acceptAnyValidShape: false` and a populated
  `registry_tokens` table.
- **Cloud federation** — defer RBAC to a fronting `signalman-cloud`
  proxy that injects scopes via a delegated bearer. Contract is
  documented in `signalman-cloud/docs/contracts/registry.md`.

Both paths cohabit: an operator can run the OSS registry with
either local RBAC, Cloud-fronted RBAC, or neither (single-tenant
dev mode).

## v0.3.x — additional protocol facades

Each is its own multi-PR engagement. Order TBD by demand:

- **maven** repository protocol — Java / Kotlin ecosystem
- **pip** simple index protocol — Python packages
- **Helm** chart repository — Kubernetes deploys
- **Conan** — C/C++

All follow the cargo + npm pattern: a thin protocol adapter on top
of the existing blob + manifest + provenance storage. The shared
blob store means a Maven JAR and an OCI layer can share content
addresses when they happen to be byte-identical (saves storage on
multi-protocol artifacts like polyglot SDKs).

## v0.4.x — advanced features

### Vulnerability scan jobs (post-OSV-integration scale-up)

Trivy / Grype integration: on blob ingest, optionally enqueue a
scan job; manifest list endpoint surfaces a `vulnerability_summary`
field with severity counts. CVE-level results stored alongside
the manifest row. Replaces the v0.1.3 sync-OSV-call pattern for
high-volume registries.

### Cross-region replication

Replicate the manifest catalog + selected blob subset to a
secondary region for failover / latency. Built on top of the
content-addressed blob store; manifests + audit log replicate
via a streaming SQL bi-directional sync.

## Cross-repo coordination

- **`@signalman/host`** — the `BlobDriver` contract stays stable
  across all roadmap milestones. The `signalman-registry` driver
  gains features (real `delete`, HEAD-backed `exists`, streaming
  `put`, cargo crate fetch, npm install) but the interface
  signature is fixed at v0.3.x.
- **`signalman-cloud`** — Cloud is the primary consumer of v0.2.1
  (RBAC federation) and the multi-tenant runtime concerns. See
  `signalman-cloud/docs/contracts/registry.md` for the API
  contract.
- **OSS design doc** — `docs/design/meta-build-system.md` §15 is
  the canonical design and gets updated when an open question
  resolves.
- **Wave-3 audit** — `docs/audit/capability-matrix-2026-05-wave3.md`
  tracks WS6 wave-3 closure. M10's done; v0.1.x is queued.

## What "bootstrap signalman from signalman" looks like end-state

Once v0.1.1–v0.1.4 ship, the operator workflow becomes:

```bash
# Day 0: operator stands up a signalman registry on their infra
signalman-registry serve --storage-root /var/lib/signalman --port 8443

# Configure virtual upstreams so the registry mirrors crates.io,
# npmjs.com, ghcr.io etc. with re-signing for compliance:
signalman-registry virtual add --org acme --kind cargo \
  --upstream https://index.crates.io --resign-on-cache

# Day 1: operator's CI builds the signalman binaries and publishes
# them back to the registry. Same registry hosts org-internal
# crates + mirrored public ones:
cargo publish --registry signalman --token $REG_TOKEN

# Day 2: operator's CD pulls signalman binaries from the registry
# onto fresh hosts via cloud_vm targets (M8) + runner deploy (M9):
signalman runner deploy --transport cloud \
  --binary-url https://signalman-reg.acme.io/v1/blobs/sha256:abc... \
  --provider aws --region us-east-1 ...

# Day 3: operator audits the supply chain via the forensic API:
curl https://signalman-reg.acme.io/v1/forensic/summary
curl https://signalman-reg.acme.io/v1/forensic/upstreams
curl https://signalman-reg.acme.io/v1/audit?since=2026-05-15T00:00:00Z
```

Every artifact in the deployed system traces back through the
registry's provenance API to its upstream source (crates.io,
npmjs.com, operator's own CI, etc.) with the audit log providing
the immutable ingest record.

That's the bootstrap loop. v0.1.x closes it; v0.2.x makes it
production-grade.
