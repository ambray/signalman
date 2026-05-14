# `@signalman/registry` roadmap

**Current version:** `0.0.1` (bootstrap milestone shipping in WS5).
**Source-of-truth design:** `docs/design/meta-build-system.md` §15.

The v0.4.0 bootstrap (committed on `feat/v0.4.0-registry`) lands the
package skeleton, generic blob format, Ed25519 signing port, minimal
HTTP API, CLI, MCP surface, and the host-side
`signalman-registry` BlobDriver. Everything below is **roadmap, not
yet implemented**.

## v0.4.x — followup releases

Each bullet is a discrete release. Ordering is roughly by user
demand × engineering size, not committed dates.

### v0.4.1 — OCI distribution spec v1.1

The single most-requested feature for a registry: speak the OCI
distribution-spec push/pull dialect so `docker push` and
`oras push` work unchanged.

- Container image manifests (`application/vnd.oci.image.manifest.v1+json`)
- Index / manifest list (`application/vnd.oci.image.index.v1+json`)
- In-router namespacing — `team/svc` parses without the v0.4.0
  `%2F` URL-encoding requirement (router gets a greedy-name regex
  variant for the `/v2/<name>/manifests/<reference>` shape).
- `/v2/` prefix routes alongside the v0.4.0 `/v1/` surface; both
  hit the same `RegistryStorage`.
- Cosign-style signing aligns with the existing Ed25519 keypair
  model. Notation / PKI variant deferred.

**Cross-repo dependency**: none. OSS-only.

### v0.4.2 — Mutable tags + retention/GC

- `latest`, `staging`, `production` — mutable pointers to immutable
  content addresses. New `PUT /v1/tags/:name/:tag` route + storage
  table.
- Retention policy: auto-expire by age, count, or tag policy.
- Reference-counted blob GC after configurable grace period.
- Blob `DELETE` endpoint lands (currently absent at v0.4.0).
- `signalman-registry` BlobDriver's `delete()` becomes a real call
  rather than the v0.4.0 no-op.

**Cross-repo dependency**: `@signalman/host` BlobDriver
contract is unchanged; only the underlying driver implementation
swaps.

### v0.4.3 — Operational hardening

- `HEAD /v1/blobs/:sha256` — replaces the GET-and-drain in
  `signalman-registry` BlobDriver's `exists()`.
- Streaming PUT path for blobs >1 GB. Current buffer-then-PUT is
  RAM-bound; the upgrade uses a temp-blob + server-side rename
  pattern, matching the v0.3.x S3 driver's planned shape.
- Short-lived URL signing on `presignGet` — v0.4.0 returns the
  canonical URL and gates on bearer auth.
- Postgres-backed `ManifestIndex` driver implementing the same
  `RegistryStorage` interface (SQLite stays the local default).

### v0.4.4 — RBAC + Cloud federation

The v0.4.0 server ships `acceptAnyValidShape: true` (any
shape-valid `sk_<prefix>_<secret>` bearer is admin). Two paths
forward, designed in parallel:

1. **OSS RBAC** — row-level token table inside the registry. Per-
   token scopes: `read:<namespace>`, `write:<namespace>`,
   `admin:*`. Server boots with `acceptAnyValidShape: false` and
   a populated `registry_tokens` table.
2. **Cloud federation** — defer the RBAC implementation to
   `signalman-cloud`, which fronts the registry and injects
   scopes via a delegated bearer. Contract is documented in
   `signalman-cloud/docs/contracts/registry.md`.

Both paths cohabit: an operator can run the OSS registry with
either local RBAC, Cloud-fronted RBAC, or neither (single-tenant
dev mode).

### v0.4.x — Protocol facades (separate workstreams)

Each is its own multi-PR engagement and follows the OCI work in
v0.4.1. Order TBD by demand:

- **npm** registry protocol — publish + install with `npm`.
- **crates.io**-compatible — publish + install with `cargo`.
- **maven** repository protocol.
- **pip** simple index protocol.
- **Helm** chart repository.

All five follow the same pattern: a thin protocol adapter layer
on top of the existing blob + manifest storage. The shared blob
store means a Maven JAR and an OCI layer can share content
addresses when they happen to be byte-identical.

### v0.4.x — Virtual registries

Mirror + cache mode: the registry sits between consumers and an
upstream public registry (npm, Docker Hub, Maven Central). On a
miss, it fetches from upstream, caches locally, and serves
subsequent requests from the cache. Useful for:

- Air-gapped deploys.
- Compliance: pin the bytes that hit a build, not just the name.
- Latency: serve from a regional cache rather than the public
  origin.

Per-upstream config: caching policy, allow / deny rules, optional
re-signing with the operator's Ed25519 key on cache write.

### v0.4.x — Vulnerability scanning

Trivy / Grype integration. On blob ingest, optionally enqueue a
scan job; manifest list endpoint surfaces a `vulnerability_summary`
field with severity counts. CVE-level results are stored alongside
the manifest row.

## Cross-repo coordination

- **`@signalman/host`** — the `BlobDriver` contract stays stable
  across all v0.4.x work. The `signalman-registry` driver gains
  features (real `delete`, HEAD-backed `exists`, streaming `put`)
  but the interface signature is fixed at v0.3.x.
- **`signalman-cloud`** — Cloud is the primary consumer of v0.4.4
  (RBAC federation) and the multi-tenant runtime concerns. See
  `signalman-cloud/docs/contracts/registry.md` for the API contract.
- **OSS design doc** — `docs/design/meta-build-system.md` §15 is
  the canonical design and gets updated when an open question
  resolves (e.g. "first protocol is OCI" was an open question at
  v0.4.0, resolved by this roadmap as v0.4.1).
