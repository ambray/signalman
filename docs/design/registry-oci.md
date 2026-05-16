# `@signalman/registry` — OCI Distribution Spec v1.1 facade

**Status:** design proposal (2026-05-16). No code shipped yet.
**Owner:** WS10 (`docs/workstreams/prompts/ws10-registry-oci.md`).
**Branch:** `feat/v0.5-registry-oci`.
**Predecessor:** the v0.4.0 generic blob + signed-manifest registry
(`registry/src/types.ts`), the cargo facade (M10.2–M10.4), and the
npm facade (v0.1.1). This doc is the third protocol facade promised
in `registry/ROADMAP.md` §v0.1.2.

## Context

`@signalman/registry` ships a content-addressed blob store + signed
manifest catalog with two protocol facades mounted on top: cargo
(`/cargo/<org>/...`, sparse-index + publish + virtual upstream
against crates.io, M10) and npm (`/npm/<org>/...`, packument + tarball
+ virtual upstream against npmjs.com, v0.1.1). Both rest on the
same `RegistryStorage` interface, the same Ed25519 signing port, the
same audit log, and the same forensic / provenance API.

`registry/ROADMAP.md` §v0.1.2 names OCI as **"the single
most-requested feature for 'a real registry'."** Operators publish
container images for half the deployable workloads they touch
(agent installers, scenario images, Helm-chart-shaped service
deploys). Today they cannot push those to Signalman; they push to
ghcr.io / Docker Hub / ECR and lose the provenance trail that cargo
+ npm already gives them.

This workstream adds a third protocol facade — the OCI Distribution
Spec v1.1 (`opencontainers/distribution-spec`) — under `/v2/*`,
alongside the existing `/v1/*` generic surface. After WS10:

- `docker pull signalman-reg.acme.io/team/svc:v1.0` works against a
  Signalman registry.
- `cosign sign --key signalman.key reg/team/svc:v1.0` produces a
  signature using the operator's existing Ed25519 keypair.
- Docker Hub / GHCR / ECR pulls flow through the registry's virtual
  upstream with re-signing and per-tenant audit.
- Every OCI manifest surfaces through the existing forensic API
  (`/v1/forensic/*`) under the same `provenance` shape that cargo
  and npm already use.

## Goals

1. **OCI Distribution Spec v1.1 conformance.** The upstream
   `opencontainers/distribution-spec/conformance` harness passes
   end-to-end. Spec-compliant on the wire — error envelope,
   `Docker-Content-Digest` header, `Range` semantics, paginated
   `_catalog` + `tags/list`.
2. **Single blob store.** OCI digests are `sha256:<hex>`; the existing
   `Blob` shape carries hex sha256 already. Container layers ride on
   the same content-addressed storage as cargo crates and npm
   tarballs. A polyglot artifact (e.g. an SDK published as both a
   crate and a container image with byte-identical bundled assets)
   deduplicates naturally.
3. **Provenance + audit parity with cargo + npm.** Every OCI manifest
   PUT, manifest DELETE, tag rotation, blob finalize, and blob
   DELETE writes an audit row with the same `action` codes the other
   facades already use.
4. **Cosign signing on day one.** The Ed25519 signing surface
   (`registry/src/signing.ts`) wraps thinly to produce the cosign
   `<digest>.sig` convention. Operators verify with `cosign verify
   --key signalman.pub` against the running registry.
5. **Pull-through against the three container registries operators
   actually use.** Docker Hub, GHCR, ECR. Each carries different auth
   machinery; the upstream-auth interface accommodates all three.

## Non-goals

- **Notation / PKI signing variant.** Cosign-style only at v0.5;
  Notation is queued for v0.6+ if operators ask.
- **Vulnerability scanning on ingest.** Trivy / Grype hookup belongs
  to v0.6 (post-OSV-integration scale-up per ROADMAP §v0.4.x).
- **Cross-mount (`POST .../uploads/?mount=<digest>&from=<repo>`).**
  Optimization — every cross-mount falls back to a regular upload
  per spec. Deferred until measured.
- **Multi-tag push (`PUT .../<digest>?tag=1.2.3&tag=1.2&tag=1`).**
  Optional spec feature; the workstream's tag-rotation surface
  handles operator-side equivalents.
- **HEAD on `/v1/blobs/<sha256>`.** Listed in ROADMAP §v0.2.0
  Operational Hardening. The OCI `/v2/<name>/blobs/<digest>` HEAD
  lands as part of this workstream, but the generic `/v1/` HEAD is
  out of scope.
- **Mutable cargo-style `dist-tags` for OCI.** Tags are mutable
  pointers to immutable digests; that's the OCI standard already.
  No additional layer needed.

## Locked design (decisions required confirmed 2026-05-16)

All eight open questions resolved before any code lands. Defaults
proposed by the workstream prompt and confirmed by the operator
shown below; deltas from the recommended default flagged.

### Q1 — Repository namespacing (per-org)

`/v2/<org>/<repo>/...` matches the cargo + npm pattern. The OCI
`<name>` spec regex
`[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*`
already allows multi-segment names with `/`, so the org prefix
imposes no spec-level constraint beyond what the spec defines.

Storage-layer manifest name: `oci/<org>/<repo>` — same shape as
`cargo/<org>/<crate>` and `npm/<org>/<package>`.

### Q2 — Pull-through upstreams (Docker Hub + GHCR + ECR)

**Delta from recommendation.** The workstream proposed Docker Hub
only at v0.5 with GHCR / ECR deferred to v0.6. Operator chose all
three on day one. M5 expands to deliver three upstream-auth
adapters:

| Upstream | Auth shape | Token endpoint |
|---|---|---|
| **Docker Hub** | Anonymous bearer for public images; Basic Auth → token exchange for private | `https://auth.docker.io/token?service=registry.docker.io&scope=repository:<name>:pull` |
| **GHCR** | GitHub PAT (or workload-identity token) | `https://ghcr.io/token?service=ghcr.io&scope=repository:<name>:pull` |
| **ECR** | AWS SigV4 → `ecr:GetAuthorizationToken` → token exchange | per-region `https://api.ecr.<region>.amazonaws.com/` |

All three adapters live behind one `UpstreamAuthAdapter` interface
in `registry/src/oci/upstream-auth.ts`:

```ts
export interface UpstreamAuthAdapter {
  readonly kind: 'dockerhub' | 'ghcr' | 'ecr';
  /** Compose the per-request Authorization header for an upstream pull. */
  authorize(scope: { repository: string; action: 'pull' }): Promise<{ authorization: string }>;
}
```

Adapter selection comes from the existing `virtual_upstream` row's
`kind = 'oci'` + a new `config_json.upstream_flavor` discriminator
(`'dockerhub' | 'ghcr' | 'ecr'`). Operator configures one adapter
per virtual-upstream row; the `config_json.auth_header_template`
field is reused for GHCR PAT tokens. ECR adapter reads its
credentials from the standard AWS env var chain
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
`AWS_REGION`) — no new config storage required.

### Q3 — Cosign-style signing in v0.5.0

Included in the same release as the spec implementation. M6 lands
`registry/src/oci/cosign.ts` plus CLI `oci sign` / `oci verify`
verbs. The Ed25519 surface (`registry/src/signing.ts`) is unchanged;
cosign is a thin payload-composition wrapper around `signManifest`.

If WS9 (signing service) merges before WS10 reaches M6, M6 routes
the cosign signing call through the WS9 `SigningProvider` interface
instead of `signManifest` directly. Coordinate with operator
before that milestone.

### Q4 — Conformance suite gated by env var

Wire `opencontainers/distribution-spec/conformance` (the upstream's
Docker-container test harness) into the registry CI lane gated by
`SIGNALMAN_OCI_CONFORMANCE=1`. The harness needs Docker + several
minutes of wall time, so it stays off the default fast-test path
and runs on push to `main` + nightly. Same gating pattern as the
existing cloud-integration tests.

Mapping the upstream env vars to the harness:

| Harness var | Wiring |
|---|---|
| `OCI_ROOT_URL` | The registry's externally-reachable URL (CI spins one up on `:8443`) |
| `OCI_NAMESPACE` | `conformance/test-image` (a reserved per-run namespace) |
| `OCI_USERNAME` / `OCI_PASSWORD` | Test fixture's `sk_<prefix>_<secret>` bearer wrapped as Basic Auth for the challenge flow |
| `OCI_CROSSMOUNT_NAMESPACE` | Skipped — cross-mount is non-goal (above) |

Per-category pass counts get recorded in `.workstream-status.md`
under §Conformance results when M7 closes.

### Q5 — Bearer challenge flow

Docker CLI hard-codes the expectation: on a 401, look for
`WWW-Authenticate: Bearer realm=<token-url>,service=<svc>,scope=<scope>`,
issue a request against `<token-url>` with Basic Auth, retry the
original request with `Authorization: Bearer <issued-token>`. Reusing
the existing `sk_<prefix>_<secret>` shape directly on `/v2/*`
breaks `docker login`.

WS10 implements the challenge flow:

```
GET /v2/  HTTP/1.1
→ 401 Unauthorized
  WWW-Authenticate: Bearer realm="https://signalman-reg/oci/token",
                    service="signalman-registry",
                    scope="registry:catalog:*"

GET /oci/token?service=signalman-registry&scope=repository:team/svc:pull  HTTP/1.1
Authorization: Basic <base64(sk_PREFIX_SECRET:)>
→ 200 OK
  { "token": "<jwt>", "access_token": "<jwt>", "expires_in": 3600, "issued_at": "<iso>" }

GET /v2/team/svc/manifests/v1  HTTP/1.1
Authorization: Bearer <jwt>
→ 200 OK
```

Token shape: a compact JWT signed with the operator's existing
Ed25519 key. Claims:

```json
{
  "iss": "signalman-registry",
  "sub": "<sk_prefix>",
  "aud": "signalman-registry",
  "scope": "repository:team/svc:pull,push",
  "iat": <unix>,
  "exp": <unix + 3600>
}
```

Verification on `/v2/*` requests: extract Bearer JWT → verify
signature with the registry's public key → resolve `sub` →
construct `AuthContext` with `tokenPrefix = sub`. The downstream
audit-log + RBAC machinery sees the same `sk_<prefix>` shape it
already handles; the challenge flow is transparent to existing
forensic code.

TTL: 1 hour, matching Docker Distribution's default.

Out-of-scope for v0.5: scope-narrowing the issued token below the
underlying bearer's permissions. Today every issued JWT inherits
the full `admin` scope of the underlying `sk_` token (consistent
with the current `acceptAnyValidShape` mode). v0.2.1's RBAC work
(per ROADMAP) layers proper per-scope token-issuance on top.

### Q6 — Manifest DELETE allowed, operator-configurable

Default-on, matching every Docker / OCI client's expectation. Disable
via a new `serve` config flag `--oci-disallow-manifest-delete`
(stored on `AppOptions` as `ociAllowManifestDelete?: boolean` with
default `true`). When disabled, DELETE returns spec-canonical
`UNSUPPORTED` with HTTP 405.

Storage: `deleteManifest(name, version)` already exists and is what
DELETE routes to. Blob GC is **not** triggered by manifest delete
(per the existing v0.1.4 retention/GC milestone — out of scope for
WS10).

### Q7 — Full multi-arch support

`application/vnd.oci.image.index.v1+json` (and its Docker v2.2
sibling `application/vnd.docker.distribution.manifest.list.v2+json`)
are accepted on PUT alongside single-platform manifests. The index
PUT validates that every `manifests[].digest` resolves to a known
child manifest (already stored, kind='oci'); fail with
`MANIFEST_BLOB_UNKNOWN` if not.

On GET, an `Accept: application/vnd.oci.image.index.v1+json` request
returns the index; an `Accept: application/vnd.oci.image.manifest.v1+json`
request resolves the platform via the standard `os` + `architecture`
fields and returns the matched child manifest. When Accept does not
disambiguate, return the stored representation verbatim and let the
client filter.

Storage row's `kind` stays `'oci'` for both single and index
manifests; the `oci_metadata_json` column carries an
`isIndex: boolean` discriminator plus the child-digest list when
applicable.

### Q8 — 24-hour persisted upload UUIDs with reaper

Matches Docker Distribution's default + survives registry restarts
mid-upload. New `pending_blob_uploads` table (schema below).
Reaper tick runs alongside the existing scheduled-health
infrastructure (the host's `cron-driver` shape, in-process
`setInterval` at 5-minute cadence). On each tick, rows older than
`now() - 24h` are deleted plus any orphan chunks on disk are
unlinked.

### Route table

```
public:
  GET    /v2/                                    (200 if authed, 401 challenge if not)
  GET    /oci/token                              (auth challenge endpoint)

blobs (per repository):
  GET    /v2/<org>/<repo>/blobs/<digest>         (pull blob bytes)
  HEAD   /v2/<org>/<repo>/blobs/<digest>         (existence check + Docker-Content-Digest)
  DELETE /v2/<org>/<repo>/blobs/<digest>         (admin-scope)
  POST   /v2/<org>/<repo>/blobs/uploads/         (initiate chunked upload, returns Location + UUID)
  PATCH  /v2/<org>/<repo>/blobs/uploads/<uuid>   (append chunk; Content-Range required)
  PUT    /v2/<org>/<repo>/blobs/uploads/<uuid>   (finalize; ?digest=<digest> mandatory)

manifests (per repository):
  GET    /v2/<org>/<repo>/manifests/<reference>  (reference = tag or sha256:<hex>)
  HEAD   /v2/<org>/<repo>/manifests/<reference>
  PUT    /v2/<org>/<repo>/manifests/<reference>
  DELETE /v2/<org>/<repo>/manifests/<reference>

catalog + tags:
  GET    /v2/_catalog?n=<count>&last=<repo>      (paginated, Link rel=next)
  GET    /v2/<org>/<repo>/tags/list?n=&last=     (paginated, Link rel=next)
```

All `/v2/*` and `/oci/token` routes use the new
`mountOciRoutes(router, ...)` block in `registry/src/http/app.ts`.
The router's existing `*name` wildcard (per
`registry/src/http/router.ts:96-106`) carries the `<org>/<repo>`
multi-segment capture without a router patch.

### Storage schema delta — `0004_oci_metadata.sql`

```sql
-- v0.5 OCI distribution spec facade.
--
-- 1. oci_metadata_json column on manifest (mirrors cargo_metadata_json
--    + npm_metadata_json — one column per facade per migration 0003's
--    "Future protocols ... each get their own column" pattern).
-- 2. oci_tag table — mutable pointers to immutable manifest digests.
-- 3. pending_blob_uploads table — chunked-upload state machine.

ALTER TABLE manifest ADD COLUMN oci_metadata_json TEXT;
-- kind CHECK constraint already includes 'oci' from migration 0002.

CREATE TABLE oci_tag (
  repository       TEXT NOT NULL,             -- 'oci/<org>/<repo>'
  tag              TEXT NOT NULL,             -- [a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}
  manifest_sha256  TEXT NOT NULL,             -- sha256(canonical_bytes), 64 hex
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (repository, tag)
);
CREATE INDEX oci_tag_repository_idx ON oci_tag (repository, tag);
CREATE INDEX oci_tag_digest_idx ON oci_tag (manifest_sha256);

CREATE TABLE pending_blob_uploads (
  upload_id    TEXT PRIMARY KEY,              -- ULID; used in Location URLs
  repository   TEXT NOT NULL,                 -- 'oci/<org>/<repo>'
  -- JSON array of { offset, length, sha256 } for each appended chunk.
  -- Persisted so resume-after-restart works.
  chunks_json  TEXT NOT NULL DEFAULT '[]',
  bytes_received INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,                 -- created_at + 24h
  actor        TEXT NOT NULL                  -- sk_<prefix> that opened the session
);
CREATE INDEX pending_blob_uploads_expires_idx
  ON pending_blob_uploads (expires_at);
CREATE INDEX pending_blob_uploads_repo_idx
  ON pending_blob_uploads (repository, created_at DESC);
```

`oci_metadata_json` shape (parsed lazily on read):

```ts
interface OciManifestMetadata {
  isIndex: boolean;
  // For single-platform manifests:
  configDigest?: string;        // sha256:<hex>
  configMediaType?: string;
  layerDigests?: string[];      // ordered
  totalSize?: number;
  // For image indexes:
  childManifests?: Array<{
    digest: string;
    mediaType: string;
    platform: { os: string; architecture: string; variant?: string };
    size: number;
  }>;
  // Legacy Docker v2.2 vs OCI v1 discriminator.
  schemaVariant: 'oci-v1' | 'docker-v2-2';
}
```

Chunked-upload chunk shape:

```ts
interface PendingUploadChunk {
  offset: number;       // byte offset where this chunk started
  length: number;       // bytes appended
  sha256: string;       // running sha of the chunk, for resume validation
}
```

### TypeScript types — `registry/src/oci/types.ts`

```ts
export const OCI_MEDIA_TYPES = {
  MANIFEST_V1: 'application/vnd.oci.image.manifest.v1+json',
  INDEX_V1: 'application/vnd.oci.image.index.v1+json',
  CONFIG_V1: 'application/vnd.oci.image.config.v1+json',
  LAYER_TAR_GZ: 'application/vnd.oci.image.layer.v1.tar+gzip',
  LAYER_TAR_ZSTD: 'application/vnd.oci.image.layer.v1.tar+zstd',
  // Legacy Docker v2.2 — accepted on PUT, surfaced on GET when negotiated:
  DOCKER_MANIFEST_V2_2: 'application/vnd.docker.distribution.manifest.v2+json',
  DOCKER_MANIFEST_LIST_V2_2: 'application/vnd.docker.distribution.manifest.list.v2+json',
  DOCKER_CONFIG_V1: 'application/vnd.docker.container.image.v1+json',
  DOCKER_LAYER_TAR_GZ: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
  // Cosign signature payload + manifest:
  COSIGN_SIGNATURE_PAYLOAD: 'application/vnd.dev.cosign.simplesigning.v1+json',
} as const;

export interface OciDescriptor {
  mediaType: string;
  digest: string;       // sha256:<64-hex>
  size: number;
  annotations?: Record<string, string>;
  urls?: string[];
  platform?: OciPlatform;
}

export interface OciPlatform {
  architecture: string;        // e.g. 'amd64'
  os: string;                  // e.g. 'linux'
  'os.version'?: string;
  'os.features'?: string[];
  variant?: string;
}

export interface OciManifest {
  schemaVersion: 2;
  mediaType: string;          // 'application/vnd.oci.image.manifest.v1+json' or docker v2.2
  config: OciDescriptor;
  layers: OciDescriptor[];
  annotations?: Record<string, string>;
  subject?: OciDescriptor;    // OCI 1.1 referrers support — read-only at v0.5
}

export interface OciIndex {
  schemaVersion: 2;
  mediaType: string;          // 'application/vnd.oci.image.index.v1+json' or docker manifest-list
  manifests: OciDescriptor[];
  annotations?: Record<string, string>;
}

// Spec-compliant error envelope. `detail` is unstructured per spec.
export interface OciErrorEnvelope {
  errors: Array<{
    code: OciErrorCode;
    message: string;
    detail?: unknown;
  }>;
}

export const OCI_ERROR_CODES = {
  BLOB_UNKNOWN: 'BLOB_UNKNOWN',
  BLOB_UPLOAD_INVALID: 'BLOB_UPLOAD_INVALID',
  BLOB_UPLOAD_UNKNOWN: 'BLOB_UPLOAD_UNKNOWN',
  DIGEST_INVALID: 'DIGEST_INVALID',
  MANIFEST_BLOB_UNKNOWN: 'MANIFEST_BLOB_UNKNOWN',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  MANIFEST_UNKNOWN: 'MANIFEST_UNKNOWN',
  NAME_INVALID: 'NAME_INVALID',
  NAME_UNKNOWN: 'NAME_UNKNOWN',
  SIZE_INVALID: 'SIZE_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DENIED: 'DENIED',
  UNSUPPORTED: 'UNSUPPORTED',
  TOOMANYREQUESTS: 'TOOMANYREQUESTS',
} as const;
export type OciErrorCode = (typeof OCI_ERROR_CODES)[keyof typeof OCI_ERROR_CODES];
```

Strict-validating type guards (`isOciManifest`, `isOciIndex`,
`isOciDescriptor`) parse from `unknown` and throw `OciError` on
malformed input. Treat every manifest body as hostile until proven
otherwise — this is the same posture as `parseManifestBody` in
`registry/src/http/app.ts:339`.

### Path parser — `registry/src/oci/paths.ts`

```ts
// OCI Distribution Spec v1.1 §Pulling Manifests "name" grammar:
// [a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*
const OCI_NAME_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const OCI_REFERENCE_TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const OCI_REFERENCE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateOciRepositoryName(name: string): void {
  if (name.length < 1 || name.length > 255) {
    throw new OciError('NAME_INVALID', `invalid repository name length: ${name.length}`);
  }
  for (const segment of name.split('/')) {
    if (!OCI_NAME_COMPONENT.test(segment)) {
      throw new OciError('NAME_INVALID', `invalid repository name segment: ${segment}`);
    }
  }
}

export function ociManifestName(org: string, repo: string): string {
  validateCargoOrgName(org);        // reuse existing org-name validator
  // The "<org>/<repo>" portion goes through validateOciRepositoryName.
  validateOciRepositoryName(`${org}/${repo}`);
  return `oci/${org}/${repo}`;
}

export interface OciReference {
  kind: 'tag' | 'digest';
  value: string;
}

export function parseOciReference(s: string): OciReference {
  if (OCI_REFERENCE_DIGEST.test(s)) return { kind: 'digest', value: s };
  if (OCI_REFERENCE_TAG.test(s)) return { kind: 'tag', value: s };
  throw new OciError('MANIFEST_UNKNOWN', `invalid manifest reference: ${s}`);
}
```

### Auth flow concretely

New module `registry/src/oci/auth.ts`:

- `GET /oci/token` — accepts `service=<svc>&scope=<scope>` + Basic Auth.
  Decodes Basic → reuses `parseBearerToken` shape on the decoded
  username (`sk_<prefix>_<secret>`). Issues a JWT with the claim set
  above. Token signed with the operator's Ed25519 private key.
- `mountOciChallengeMiddleware` — wraps every `/v2/*` route. On a
  missing/invalid `Authorization` header, returns 401 with
  `WWW-Authenticate: Bearer realm=<public-base-url>/oci/token,
  service=signalman-registry,scope=<derived-scope>`.
- The existing `makeAuthenticator` in `registry/src/http/auth.ts` is
  extended to recognize the `Bearer <jwt>` shape and validate
  signatures inline. `AuthContext.tokenPrefix` ends up `sk_<prefix>`
  exactly as before; downstream code never sees the JWT.

The challenge flow lives entirely under `/v2/*` + `/oci/token`. The
existing `/v1/*` routes keep their direct `sk_<prefix>_<secret>`
bearer flow.

### Cosign convention

`registry/src/oci/cosign.ts`:

- `signManifestCosign(manifest, privateKeyPem)` composes the simple-
  signing payload:

  ```json
  {
    "critical": {
      "identity": { "docker-reference": "signalman-reg/<org>/<repo>" },
      "image":    { "docker-manifest-digest": "sha256:<hex>" },
      "type":     "cosign container image signature"
    },
    "optional": null
  }
  ```

- Signs the payload bytes with the existing `signManifest` Ed25519
  surface. The payload becomes a regular layer blob; the signature
  is stored as a base64-encoded value under the
  `dev.cosignproject.cosign/signature` annotation on the layer.
- The signature manifest is pushed at tag
  `sha256-<hex>.sig` (cosign's tag-derivation rule: colon-to-dash).
- `verifyManifestCosign(manifest, publicKeyPem)` walks the same path
  in reverse — pull the `.sig`-tagged signature manifest, extract
  the payload blob + signature annotation, verify against the
  supplied public key.

CLI verbs:

```
signalman-registry oci sign   <repo>:<tag> [--key <pem>]
signalman-registry oci verify <repo>:<tag> [--key <pem>]
```

`--key` defaults to `~/.signalman/keys/signing.{pub,key}` per the
existing operator convention (cargo + npm use the same key).

### Pull-through topology

`registry/src/oci/virtual.ts` mirrors `registry/src/cargo/virtual.ts`:

```
client request → local lookup (RegistryStorage.getManifest / getBlob)
                  │
                  ├─ hit → serve
                  │
                  └─ miss → consult virtual_upstream rows for (org, kind='oci')
                              │
                              for each upstream:
                              │
                              ├─ pattern-match repo against allow/deny
                              ├─ resolve upstream-auth adapter (dockerhub|ghcr|ecr)
                              ├─ fetch upstream manifest/blob
                              ├─ verify upstream digest
                              ├─ store in local blob store (content-addressed)
                              ├─ store manifest with kind='oci' + provenance.source='proxy_cache'
                              ├─ re-sign with operator's Ed25519 key (when resign_on_cache)
                              ├─ append audit row (action='proxy_cache', entity_type='manifest', detail.kind='oci')
                              └─ serve
```

Upstream-adapter responsibilities (per Q2):

- Negotiate the upstream's auth challenge (the upstream's /v2/
  returns 401 + WWW-Authenticate, the adapter fetches a token).
- Compose pull URLs for the upstream's repo-name convention
  (Docker Hub's `library/alpine` → upstream URL
  `index.docker.io/v2/library/alpine/...`; GHCR's
  `ghcr.io/<owner>/<repo>` → `ghcr.io/v2/<owner>/<repo>/...`; ECR's
  `<acct>.dkr.ecr.<region>.amazonaws.com/<repo>` → the registry's
  own /v2/ endpoint).
- Surface a stable `originalDigest` so the registry can verify the
  upstream's bytes hash to what the upstream advertised before
  caching.

Adapter selection from `virtual_upstream.config_json`:

```jsonc
{
  "upstream_flavor": "dockerhub" | "ghcr" | "ecr",
  "allow_patterns": ["*"],
  "deny_patterns": [],
  "resign_on_cache": true,
  "auth_header_template": "Bearer <ghcr-pat>"  // GHCR only; ECR reads AWS env vars
}
```

### Conformance suite integration

CI lane (gated by `SIGNALMAN_OCI_CONFORMANCE=1`):

```yaml
# .github/workflows/ci.yml addition
oci-conformance:
  if: ${{ vars.SIGNALMAN_OCI_CONFORMANCE == '1' }}
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Start registry
      run: |
        cd registry
        npm ci && npm run build
        node dist/cli.js serve --port 8443 --storage-root /tmp/conf &
        # Mint a conformance bearer
        TOKEN=$(node dist/cli.js token mint --label conformance)
        echo "OCI_USERNAME=$TOKEN" >> $GITHUB_ENV
        echo "OCI_PASSWORD=conformance" >> $GITHUB_ENV
    - name: Run upstream conformance harness
      run: |
        docker run --rm --network host \
          -e OCI_ROOT_URL=http://localhost:8443 \
          -e OCI_NAMESPACE=conformance/test-image \
          -e OCI_USERNAME -e OCI_PASSWORD \
          ghcr.io/opencontainers/distribution-spec/conformance:v1.1.0
```

Conformance harness categories (recorded per-category pass counts
in `.workstream-status.md` at M7 close):

- pull / push / content discovery / content management

Categories explicitly deferred:
- cross-mount (per spec, optional)
- multi-tag push (per spec, optional)

## Test taxonomy

| Layer | Where | Examples |
|---|---|---|
| Unit | Any host | Type guards (`isOciManifest` rejecting hostile input), repository-name + tag-name validation, `parseOciReference`, Content-Range parser, digest-equality check, error-envelope shape |
| Integration | Any host | Chunked-upload state machine (init → patch → patch → finalize, plus 416 on out-of-order); manifest CRUD round-trip; image-index push + child-manifest resolution; bearer-challenge → token-endpoint → authorized-request flow; virtual upstream against three stubbed upstream HTTP servers |
| System | Any host w/ Docker | `docker push` / `docker pull` / `crane copy` / `cosign sign` / `cosign verify` against the running registry |
| Conformance | CI lane gated by `SIGNALMAN_OCI_CONFORMANCE=1` | Upstream `opencontainers/distribution-spec/conformance` harness |
| Smoke | Any host | Existing cargo + npm + forensic surfaces remain unaffected (re-run the v0.4.0 contract tests byte-identical) |

Coverage gate: **≥80% lines / ≥70% branches** across new
`registry/src/oci/`.

## Definition of Done

1. `cd registry && npm test` — full suite green.
2. `cd registry && npx tsc --noEmit` — zero errors.
3. `cd registry && npm run coverage` — coverage holds at gate.
4. `cd host && npm test` — full host suite still green (no
   registry-side change should perturb host).
5. **Conformance:** `SIGNALMAN_OCI_CONFORMANCE=1 npm test` passes the
   upstream harness end to end. Per-category pass counts recorded
   in `.workstream-status.md`.
6. **System smoke:** on an operator dev-host with Docker + cosign
   installed, push `alpine:3.20`, pull it back, sign it, verify it,
   list catalog, list tags, delete manifest. Commands + outcomes
   recorded in `.workstream-status.md`.
7. Existing cargo + npm + forensic contract tests pass byte-identical
   to v0.4.0.
8. 4-lens audit completed. **Security lens specifically PASS** —
   covers: untrusted-client manifest validation, upload-UUID
   enumeration risk, chunked-upload exhaustion DoS, signature-
   verification trust path, cross-tenant repository enumeration
   via `/v2/_catalog`.
9. Commits ready (each with
   `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`)
   but **NOT pushed**. Operator pushes after review.

## Decisions required (operator gate)

Confirmed by operator 2026-05-16:

1. **Repository namespacing** — per-org (`/v2/<org>/<repo>/...`).
2. **Pull-through upstreams** — Docker Hub + GHCR + ECR on day one.
   **Delta from recommendation:** the workstream proposed Docker Hub
   only at v0.5; the operator chose all three. M5 expands to three
   adapters.
3. **Cosign signing** — included in v0.5.0 alongside spec
   implementation.
4. **Conformance suite** — wired into CI, gated by
   `SIGNALMAN_OCI_CONFORMANCE=1`.
5. **Auth** — full OCI Bearer challenge flow (Docker CLI compat).
6. **Manifest DELETE** — allowed per spec, operator-config flag
   `--oci-disallow-manifest-delete` to disable.
7. **Image-index / multi-arch** — full support (single manifests
   and indexes both accepted on PUT).
8. **Chunked-upload UUID lifetime** — 24-hour persisted, in-process
   reaper at 5-min cadence.

If any of these need to change before code lands, update §Locked
design and re-link this section.

## Extension points (out of scope for WS10)

- **Cross-mount** (`POST .../uploads/?mount=<digest>&from=<repo>`) —
  optimization; OCI clients fall back to a regular upload when the
  registry returns 202 on the cross-mount POST. Land in v0.6 if
  measured to matter.
- **Multi-tag push** (`PUT .../<digest>?tag=...&tag=...`) — operator
  tag-rotation surface handles equivalent needs.
- **OCI 1.1 referrers API** (`GET /v2/<name>/referrers/<digest>`) —
  the storage already records the `subject` field on every manifest;
  the route can be added later without schema change.
- **Notation / PKI signing variant** — cosign-only at v0.5; queued
  for v0.6+ if operators ask.
- **Cargo-style `dist-tags` semantics layered over OCI tags** — OCI
  tags are already mutable; no extra surface needed.

## Cross-references

- `registry/ROADMAP.md` §v0.1.2 — the OCI commitment this workstream
  delivers. Status flips to "shipped" at M7.
- `registry/src/types.ts` — `Manifest` shape, `ManifestKind`
  discriminator (already includes `'oci'`), `Provenance`.
- `registry/src/cargo/{index,publish,virtual,paths}.ts` — the cargo
  facade pattern that WS10 mirrors.
- `registry/src/npm/{index,publish,virtual,paths}.ts` — the npm
  facade pattern that WS10 mirrors.
- `registry/src/storage/sqlite-index.ts` — manifest catalog,
  audit log, virtual upstream config; WS10 adds `oci_tag` +
  `pending_blob_uploads` plus methods to populate / drain them.
- `registry/src/storage/migrations/0004_oci_metadata.sql` — new.
  Reserved block `0004` per the existing
  `0001_init / 0002_kind_provenance_cargo / 0003_npm_metadata`
  ordering. `0005+` remains free for the next protocol (maven /
  pip / helm).
- `registry/src/signing.ts` — Ed25519 surface reused for cosign.
- `registry/src/http/{app,router,auth,forensic}.ts` — WS10 adds a
  `mountOciRoutes` block plus the bearer-challenge middleware.
- `docs/supply-chain.md` §Canonical action codes — WS10 reuses the
  existing `upload` / `proxy_cache` / `manifest_create` codes; no
  new namespace required.
- OCI Distribution Spec v1.1 (`opencontainers/distribution-spec`) —
  the wire-format spec the `/v2/*` surface implements.
- OCI Image Spec v1.1 (`opencontainers/image-spec`) — manifest +
  index + config + layer media types.
- Cosign (`sigstore/cosign`) §"Signature Specification" — the
  `<digest>.sig` tag convention + simple-signing JSON shape.
- `docs/workstreams/prompts/ws10-registry-oci.md` — the executable
  starting prompt for this workstream.

## Known parallel work

- **WS7 (Claude Code plugin)** — no overlap.
- **WS8 (per-user identity certs)** — no overlap. WS10 reuses the
  existing `sk_<prefix>_<secret>` bearer flow; identity-cert
  integration is out of scope.
- **WS9 (signing service)** — minor adjacency. WS10's cosign signing
  uses `registry/src/signing.ts` directly at design time. If WS9
  merges before WS10 reaches M6, route cosign through the WS9
  `SigningProvider` interface; coordinate with operator before that
  milestone.
- **WS11 (libvirt enablement)** — no overlap.
- **WS12 (OSS-release-readiness)** — adjacency at version-bump time.
  WS12 Milestone 3 bumps version pins; the registry's
  `package.json` is currently at `0.0.1` despite ROADMAP claiming
  v0.1.1 shipped. WS10 surfaces this drift at M7; resolution
  belongs to WS12 unless the operator directs otherwise.
