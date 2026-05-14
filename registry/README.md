# @signalman/registry

Standalone OSS artifact registry. Content-addressed blob store +
signed manifest catalog. Federates with `@signalman/host` via the
existing `BlobDriver` interface.

Apache-2.0 licensed.

## v0.4.0 scope

This bootstrap milestone ships the **package skeleton + generic blob
format + Ed25519 signing port + minimal HTTP API + host federation
driver**. The following features are explicitly deferred to v0.4.x:

- OCI distribution spec v1.1 (push/pull container images)
- Mutable tags (`latest`, `staging`, `production`)
- Retention / GC by age, count, or tag policy
- npm / crates.io / maven / pip / Helm protocols
- Vulnerability scanning (Trivy / Grype integration)
- Mirroring + caching upstream public registries

See `docs/design/meta-build-system.md` §15 for the full design.

## Surfaces

- **CLI** — `signalman-registry serve --port 8443 --storage-root ./data`
- **CLI** — `signalman-registry verify <manifest-path> --public-key <pem>`
- **MCP** — `npm run mcp` exposes `registry_serve`, `registry_push_manifest`,
  `registry_pull_manifest`, `registry_list_versions`, `registry_verify` for
  agent integration.
- **HTTP API** — `/v1/manifests/:name/:version`, `/v1/blobs/:sha256`,
  `/v1/manifests/:name` (list versions). All routes require a federated
  bearer token (`sk_<prefix>_<secret>`) except `/v1/healthz`.

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
