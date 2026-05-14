# @signalman/registry

Standalone OSS artifact registry. Content-addressed blob store +
signed manifest catalog. Federates with `@signalman/host` via the
existing `BlobDriver` interface.

Apache-2.0 licensed.

## v0.4.0 scope

This bootstrap milestone ships the **package skeleton + generic blob
format + Ed25519 signing port + minimal HTTP API + host federation
driver**. The next releases are tracked in [`ROADMAP.md`](./ROADMAP.md).

Highlights of what's coming in v0.4.x (each is its own release —
see the roadmap for ordering and detail):

- **v0.4.1 — OCI distribution spec v1.1.** `docker push` / `oras push`
  work unchanged; in-router namespacing makes the v0.4.0 `%2F`
  encoding requirement go away.
- **v0.4.2 — Mutable tags + retention / GC.** `latest` / `staging`,
  age + count policies, reference-counted blob GC, real blob DELETE.
- **v0.4.3 — Operational hardening.** HEAD route, streaming PUT for
  >1 GB artifacts, short-lived URL signing, Postgres-backed manifest
  index.
- **v0.4.4 — RBAC + Cloud federation.** OSS row-level token table
  AND a contract with `signalman-cloud` so Cloud can front the
  registry with delegated bearer auth + multi-tenant scoping.
- **v0.4.x — Protocol facades.** npm, crates.io, maven, pip, Helm
  registry protocols. Each is its own workstream on top of the
  shared blob + manifest storage.
- **v0.4.x — Virtual registries.** Mirror + cache upstream public
  registries (npm, Docker Hub, Maven Central) for air-gapped,
  compliance, and latency use cases.
- **v0.4.x — Vulnerability scanning.** Trivy / Grype on ingest.

See `docs/design/meta-build-system.md` §15 for the full design and
[`ROADMAP.md`](./ROADMAP.md) for the phased plan.

## Surfaces

- **CLI** — `signalman-registry serve --port 8443 --storage-root ./data`
- **CLI** — `signalman-registry verify <manifest-path> --public-key <pem>`
- **MCP** — `npm run mcp` exposes `registry_serve`, `registry_push_manifest`,
  `registry_pull_manifest`, `registry_list_versions`, `registry_verify` for
  agent integration.
- **HTTP API** — `/v1/manifests/:name/:version`, `/v1/blobs/:sha256`,
  `/v1/manifests/:name` (list versions). All routes require a federated
  bearer token (`sk_<prefix>_<secret>`) except `/v1/healthz`.

  Namespaced manifest names (`team/svc`) MUST URL-encode the internal
  `/` as `%2F` in path segments at v0.4.0; the bootstrap router treats
  each segment as one path component. OCI distribution spec v1.1
  compliance (which handles namespacing in-router) is deferred to
  v0.4.x.

## Layout

```
registry/
  src/
    types.ts                 # Blob / Manifest / RegistryStorage / RegistryError
    signing.ts               # Ed25519 manifest signing (ported from host)
    storage/
      local-fs.ts            # filesystem blob driver
      sqlite-index.ts        # manifest catalog index
      migrations/            # SQLite migration ledger
    http/
      app.ts                 # route table
      router.ts              # node:http dispatch
      auth.ts                # bearer-token validation
      errors.ts              # HTTP error mapping
    cli.ts                   # `signalman-registry`
    mcp.ts                   # MCP server entrypoint
    index.ts                 # programmatic entrypoint
    __tests__/               # unit + integration + system suites
```
