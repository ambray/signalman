# @signalman/registry

Standalone OSS artifact registry. Content-addressed blob store +
signed manifest catalog. Federates with `@signalman/host` via the
existing `BlobDriver` interface.

Apache-2.0 licensed.

## What v0.5 ships

The registry now hosts **three protocol facades** on top of a single
content-addressed blob + manifest catalog:

- **cargo** (`/cargo/<org>/...`, v0.1.0 / wave-3) — sparse-index
  publish + virtual upstream against crates.io with operator re-signing.
- **npm** (`/npm/<org>/...`, v0.1.1) — packument + tarball publish +
  virtual upstream against npmjs.com.
- **OCI Distribution Spec v1.1** (`/v2/<org>/<repo>/...`, **v0.5 / WS10**) —
  full `docker push` / `docker pull` / `crane copy` / `cosign verify`
  compatibility. Multi-arch image indexes supported. Bearer challenge
  flow for Docker CLI compatibility. Virtual upstreams against
  Docker Hub, GHCR, and ECR.

Every facade rides the same blob store, manifest catalog, audit log,
and forensic / provenance API.

## OCI Distribution Spec v1.1 — operator workflow

```bash
# 1. Stand up a registry with an Ed25519 token-signing key.
signalman-registry serve \
  --port 8443 \
  --storage-root /var/lib/signalman \
  --token-signing-key ~/.signalman/keys/signing.key

# 2. Configure a virtual upstream for transparent Docker Hub mirroring.
signalman-registry virtual add \
  --org acme \
  --kind oci \
  --upstream https://registry-1.docker.io \
  --config '{"upstream_flavor":"dockerhub","upstream_repo_template":"library/{repo}","resign_on_cache":true}'

# 3. Login + pull. Docker CLI's bearer-challenge flow Just Works.
docker login signalman-reg.acme.io  # username = sk_PREFIX_SECRET
docker pull signalman-reg.acme.io/acme/alpine:3.20

# 4. Push a private image.
docker tag local/svc:v1 signalman-reg.acme.io/acme/team/svc:v1
docker push signalman-reg.acme.io/acme/team/svc:v1

# 5. Sign with cosign convention (the registry's existing Ed25519 key).
cosign sign \
  --key ~/.signalman/keys/signing.key \
  signalman-reg.acme.io/acme/team/svc:v1

# 6. Verify on the consumer side.
cosign verify \
  --key ~/.signalman/keys/signing.pub \
  signalman-reg.acme.io/acme/team/svc:v1

# 7. Enumerate.
curl https://signalman-reg.acme.io/v2/_catalog | jq
curl https://signalman-reg.acme.io/v2/acme/team/svc/tags/list | jq

# 8. Audit-trail forensics.
curl 'https://signalman-reg.acme.io/v1/audit?entity_type=manifest&since=2026-05-16T00:00:00Z'
```

## Route surface

### Generic blob + manifest (v0.4.0)

```
GET    /v1/healthz
GET    /v1/blobs/:sha256              pull blob bytes
PUT    /v1/blobs/:sha256              push blob bytes
GET    /v1/manifests/:name/:version   pull manifest body
PUT    /v1/manifests/:name/:version   push manifest body
GET    /v1/manifests/:name            list versions (newest first)
DELETE /v1/manifests/:name/:version   admin-only delete
```

### Cargo facade (v0.1.0 / wave-3)

```
GET  /cargo/:org/index/...                  sparse index
GET  /cargo/:org/api/v1/crates/:n/download  crate tarball
PUT  /cargo/:org/api/v1/crates/new          publish
DELETE/PUT /cargo/:org/api/v1/crates/:n/:v/yank|unyank
```

### npm facade (v0.1.1)

```
GET  /npm/:org/:package                                  packument
GET  /npm/:org/:package/-/:basename                       tarball
PUT  /npm/:org/:package                                  publish
```

### OCI Distribution Spec v1.1 (v0.5 / WS10)

```
GET    /v2/                                  support check + bearer challenge
GET    /oci/token                            JWT mint endpoint (Basic Auth)
GET    /v2/_catalog                          paginated repository list
GET    /v2/<org>/<repo>/tags/list            paginated tag list

PUT    /v2/<org>/<repo>/blobs/uploads/       initiate chunked upload
PATCH  /v2/<org>/<repo>/blobs/uploads/<uuid> append chunk
PUT    /v2/<org>/<repo>/blobs/uploads/<uuid>?digest=sha256:... finalize
GET    /v2/<org>/<repo>/blobs/<digest>       pull blob
HEAD   /v2/<org>/<repo>/blobs/<digest>       existence check
DELETE /v2/<org>/<repo>/blobs/<digest>       delete blob

PUT    /v2/<org>/<repo>/manifests/<reference>   push (tag or sha256:hex)
GET    /v2/<org>/<repo>/manifests/<reference>   pull manifest body
HEAD   /v2/<org>/<repo>/manifests/<reference>   existence check
DELETE /v2/<org>/<repo>/manifests/<reference>   delete (tag or digest)
```

Every 4XX response on `/v2/*` carries the spec-mandated envelope:

```json
{ "errors": [{ "code": "MANIFEST_UNKNOWN", "message": "…", "detail": null }] }
```

### Forensic + provenance

```
GET /v1/provenance/manifest/:name/:version  per-manifest provenance row
GET /v1/audit                               paginated audit log
GET /v1/forensic/summary                    counts by (kind, source)
GET /v1/forensic/upstreams                  per-upstream artifact counts
```

## Surfaces

- **CLI** — `signalman-registry serve --port 8443 --storage-root ./data --token-signing-key <pem>`
- **CLI** — `signalman-registry verify <manifest-path> --public-key <pem>`
- **MCP** — `npm run mcp` exposes `registry_serve`, `registry_push_manifest`,
  `registry_pull_manifest`, `registry_list_versions`, `registry_verify` for
  agent integration.

## Storage layout

```
registry/
  src/
    types.ts                            # Blob / Manifest / RegistryStorage / RegistryError
    signing.ts                          # Ed25519 manifest signing (ported from host)
    storage/
      local-fs.ts                       # filesystem blob driver + cosign tmp uploads dir
      sqlite-index.ts                   # manifest catalog + audit log + virtual_upstream
      migrations/
        0001_init.sql                   # v0.4.0 baseline
        0002_kind_provenance_cargo.sql  # cargo metadata + provenance + audit
        0003_npm_metadata.sql           # npm metadata column
        0004_oci_metadata.sql           # WS10 — OCI metadata + tag table + chunked uploads
    http/
      app.ts                            # route table aggregator
      router.ts                         # node:http dispatch
      auth.ts                           # bearer-token + JWT validation
      errors.ts                         # HTTP error mapping
      forensic.ts                       # /v1/audit + provenance + summary routes
    cargo/                              # cargo sparse-index facade (wave-3)
    npm/                                # npm packument facade (v0.1.1)
    oci/                                # OCI distribution-spec facade (v0.5 / WS10)
      types.ts                          # OciManifest / OciIndex / OciDescriptor / OCI_ERROR_CODES
      paths.ts                          # repo-name + tag + digest parsers
      errors.ts                         # spec-compliant error envelope
      guards.ts                         # strict-validating untrusted-input parsers
      http.ts                           # response writers + Content-Range parsing
      blobs.ts                          # GET/HEAD/DELETE blob + chunked upload routes
      manifests.ts                      # PUT/GET/HEAD/DELETE manifest routes
      catalog.ts                        # /v2/_catalog + tags/list
      auth.ts                           # /v2/ challenge + /oci/token JWT issuer
      jwt.ts                            # compact JWS over Ed25519
      tag-store.ts                      # oci_tag table SQL helpers
      upload-store.ts                   # pending_blob_uploads SQL helpers
      upload-fs.ts                      # chunked-upload tmp-file store
      reaper.ts                         # 24-hour pending-upload sweeper
      virtual.ts                        # pull-through proxy for upstreams
      upstream-auth.ts                  # Docker Hub + GHCR + ECR adapters
      sigv4.ts                          # AWS SigV4 (ECR GetAuthorizationToken)
      cosign.ts                         # cosign-style sign / verify
      mount.ts                          # composes the OCI route blocks
    cli.ts                              # `signalman-registry`
    mcp.ts                              # MCP server entrypoint
    index.ts                            # programmatic entrypoint
    __tests__/                          # unit + integration + system suites (560+ cases)
```

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the forward plan. v0.6+
priorities:

- Conformance harness wired into CI (currently scaffolded; first
  nightly run pending).
- Notation / PKI signing variant.
- Cross-mount (`POST .../uploads/?mount=&from=`).
- Per-tenant catalog scoping (RBAC; v0.2.1 territory).
- Notation 2.0 / vulnerability-scan-on-ingest integration.
