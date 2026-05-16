# WS10 starting prompt — Registry OCI distribution spec v1.1 (v0.5+)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. WS10 runs directly on `main` with a feature branch (`feat/v0.5-registry-oci`), not a separate worktree.

WS10 replaced the original macOS UI parity scope on 2026-05-16 because the operator does not currently have an Apple Silicon dev-host. The macOS UI work is preserved verbatim at `docs/workstreams/prompts/ws-future-macos-ui-parity.md` for pickup when Mac hardware becomes available.

**WS10 is design-gated.** Milestone 0 is the design doc + operator-question round. Do not write production code until the operator has explicitly approved §Locked design in `docs/design/registry-oci.md`.

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). The standalone artifact registry lives at
`registry/` in the repo root and is independently versioned. Main
carries v0.4.0 through 2026-05-15: auto-promotion, webhooks,
scheduled health, cross-platform parity, registry virtual-upstream
mirroring, full cloud + k8s support.

**Your branch:** `feat/v0.5-registry-oci` off `main`. Cut it from
the repo root. All git ops from that root. **Do NOT push to origin**
until the operator approves the design + first code milestone.

## What WS10 is

`@signalman/registry` today exposes a content-addressed blob store
+ signed-manifest catalog with two protocol facades (cargo, npm)
mounted on top:

- **Cargo sparse-index facade** at `/cargo/<org>/...` with virtual
  upstream pull-through against crates.io
- **npm packument + tarball facade** at `/npm/<org>/...` with
  virtual upstream pull-through against npmjs.com
- **`/v1/*` generic surface** for raw blob + signed-manifest ops
- **Forensic + provenance API** at `/v1/forensic/*`
- **Immutable audit log** with `action: 'upload' | 'proxy_cache' |
  'manifest_create'`
- **Per-org namespacing** baked into the storage schema
- **Ed25519 re-signing** on every cache write from a virtual upstream

WS10 adds the **OCI Distribution Spec v1.1** as a third protocol
facade. This is registry-ROADMAP.md §v0.1.2 — explicitly listed
there as *"the single most-requested feature for 'a real registry'."*

Concretely:

- **`/v2/*` route surface** alongside the existing `/v1/*` —
  the standard OCI HTTP API:
  - `GET /v2/` — support check
  - `GET|HEAD /v2/<name>/manifests/<reference>` — pull manifest
    (reference = tag or `sha256:<hex>` digest)
  - `PUT /v2/<name>/manifests/<reference>` — push manifest
  - `DELETE /v2/<name>/manifests/<reference>` — delete manifest
  - `GET|HEAD /v2/<name>/blobs/<digest>` — pull blob
  - `POST /v2/<name>/blobs/uploads/` — initiate chunked blob upload
  - `PATCH /v2/<name>/blobs/uploads/<uuid>` — append chunk
  - `PUT /v2/<name>/blobs/uploads/<uuid>?digest=<digest>` — finalize
  - `DELETE /v2/<name>/blobs/<digest>` — delete blob
  - `GET /v2/<name>/tags/list` — paginated tag list
  - `GET /v2/_catalog` — paginated repository list

- **OCI manifest types** — `application/vnd.oci.image.manifest.v1+json`
  (single-platform image), `application/vnd.oci.image.index.v1+json`
  (multi-platform index), config + layer media types. **Plus legacy
  Docker types** — `application/vnd.docker.distribution.manifest.v2+json`
  etc., because Docker CLI emits those.

- **Shared blob store** — OCI digests are `sha256:<hex>`; the
  existing `BlobRef` shape maps 1:1. Image layers ride on the same
  storage as cargo crates and npm tarballs.

- **Virtual upstream pull-through** against Docker Hub (v0.5 scope).
  GHCR + ECR queued for v0.6 per their distinct auth flows.

- **Cosign-style signing** aligned with the existing Ed25519
  keypair model. Signature manifests stored at `<digest>.sig` tag
  in the same repository (cosign convention). Notation / PKI variant
  explicitly deferred per registry-ROADMAP.md §v0.1.2.

- **OCI distribution-spec conformance suite** wired into the
  registry test lane. Upstream maintains
  `opencontainers/distribution-spec/conformance` as a
  conformance harness.

**Goal:** an operator can `docker pull
signalman-reg.acme.io/team/svc:v1.0` (or `crane copy`, or `cosign
verify`) against a Signalman registry, and the byte-identical image
flows through the same provenance + audit-log surface that cargo
and npm artifacts already use.

## Orientation reading (in order, before any code)

1. **`registry/ROADMAP.md`** — read all of it, but specifically:
   - §v0.1.2 OCI distribution spec — the scope this workstream
     implements
   - §"The bootstrap-from-signalman vision" — why OCI matters
   - §Cross-repo coordination — what `@signalman/host`'s
     `BlobDriver` consumes from the registry
2. **Existing protocol facades** — your work mirrors their shape:
   - `registry/src/cargo/{index,publish,read,virtual,paths}.ts`
   - `registry/src/npm/{index,publish,read,virtual,paths}.ts`
3. **`registry/src/http/app.ts`** — `buildApp()` at line 87 is the
   mount point. Your new `mountOciRoutes()` registers alongside
   `mountCargoReadRoutes` / `mountCargoPublishRoutes` /
   `mountNpmReadRoutes` / `mountNpmPublishRoutes` /
   `mountForensicRoutes`.
4. **`registry/src/http/router.ts`** — the path-pattern router.
   The `/v2/<name>/...` patterns have a wrinkle: OCI `<name>` is
   slash-delimited (`team/svc`), so the router must accept
   path segments inside a `:name` parameter without `%2F`-encoding.
   Confirm this works against the current router or surface a
   patch in Milestone 0.
5. **`registry/src/storage/registry-storage.ts`** +
   `registry/src/storage/sqlite-index.ts` +
   `registry/src/storage/local-fs.ts` — the blob + manifest
   storage layer. OCI blobs reuse the content-addressed store;
   OCI manifests get a new `oci_metadata_json` column following
   the cargo/npm pattern (see existing migration
   `0003_npm_metadata.sql` §"Future protocols (OCI, maven, pip,
   helm, conan) each get their own column under this pattern").
6. **`registry/src/storage/migrations/000{1,2,3}_*.sql`** — your
   new migration is `0004_oci_metadata.sql`.
7. **`registry/src/signing.ts`** — Ed25519 signing surface. Cosign
   integration extends this; do not fork it.
8. **`registry/src/http/forensic.ts`** + `registry/src/http/router.ts` —
   the provenance / forensic surface. OCI manifests must surface
   through `/v1/forensic/*` exactly like cargo + npm manifests.
9. **`docs/supply-chain.md`** — overall supply-chain posture; the
   §Artifact-registry-provenance section documents what every
   facade must surface.
10. **OCI Distribution Spec v1.1** (external): the canonical
    specification lives at `github.com/opencontainers/distribution-spec`.
    Read it end to end before writing the design doc; the route
    semantics, error format (`{errors: [{code, message, detail}]}`),
    and the `Docker-Content-Digest` response header are
    spec-mandated.
11. **OCI Image Spec v1.1** (external): manifest + index +
    config + layer media types live at
    `github.com/opencontainers/image-spec`.
12. **Cosign** (external): the signing convention at
    `github.com/sigstore/cosign` §"Signature Specification" tells
    you the `<digest>.sig` tag pattern + the simple-signing JSON
    shape.
13. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.

## Open product questions — resolve in the first hour

Use `AskUserQuestion`. Lock answers into `docs/design/registry-oci.md`.

1. **Repository name namespacing.** Mirror cargo / npm's per-org
   pattern (`/v2/<org>/<repo>/...`)? Or flat (`/v2/<repo>/...`,
   matching Docker Hub library behavior)? Default recommendation:
   per-org for parity with the rest of the registry.
2. **Pull-through upstream set for v0.5.** Docker Hub only (auth
   simplest), or also GHCR + ECR on day one? Default: Docker Hub
   only; GHCR + ECR scoped to v0.6 because their auth flows
   (GitHub PAT / workload identity vs AWS SigV4) are large enough
   to deserve their own design discussion.
3. **Cosign signing.** Include in v0.5 alongside the spec
   implementation, or land the spec first and add signing in
   v0.5.1? Default: include in v0.5 — the Ed25519 signing surface
   is already there for cargo/npm; cosign convention is a thin
   wrapper.
4. **Conformance suite in CI.** Wire the upstream
   `opencontainers/distribution-spec/conformance` Go harness into
   the registry test lane? Default: yes; it's the only way to
   credibly claim spec compliance and the upstream maintains it as
   a Docker container target.
5. **Authentication.** Reuse the existing
   `sk_<prefix>_<secret>` bearer model unchanged on `/v2/*`, or
   implement OCI's `Bearer realm=...` challenge flow (which Docker
   CLI expects when a request returns 401)? Default: implement the
   challenge flow because Docker CLI hard-codes the expectation;
   tokens issued by the challenge endpoint can wrap the same
   `sk_<prefix>_<secret>` shape underneath.
6. **Manifest deletion.** Allow per OCI spec (Docker tooling
   expects `DELETE`)? Or mirror npm's conservative "no unpublish"
   stance? Default: allow per spec; an operator can disable via
   config but the default matches tooling expectations.
7. **Image-index / multi-arch.** Full support in v0.5, or
   single-platform manifests only? Default: full support — the
   spec routes are identical and storage is shape-compatible. The
   index just points at child manifest digests.
8. **Chunked-upload UUID lifetime.** OCI spec leaves this to the
   server. Operator policy: 24-hour TTL with a server-side reaper
   walking the pending-uploads table, or session-bound (in-memory
   only)? Default: 24-hour persisted; matches Docker Distribution's
   default and survives registry restarts mid-upload.

## Milestone 0 (DESIGN GATE — ship before any code)

Produce `docs/design/registry-oci.md`. Operator reviews this in
full before any production code lands. Mirror the structure of
`docs/design/per-user-identity-certs.md`:

- **Status** — `design proposal`, dated.
- **Context** — the registry-ROADMAP.md §v0.1.2 commitment; the
  bootstrap-from-signalman vision; how OCI fits the existing
  cargo + npm pattern.
- **Locked design** — the eight open-question outcomes; the
  route table; the storage schema delta (`0004_oci_metadata.sql`);
  the manifest-table shape; the auth flow (challenge endpoint
  shape, token cookie / header); cosign convention; pull-through
  topology; conformance-suite integration plan. Once approved,
  not re-litigated.
- **Test taxonomy** — unit / integration / system / conformance.
- **Definition of Done** — explicit gates.

**Commit:** `docs(v0.5-registry-oci): design doc + open questions`

**Operator gate.** Post the design doc to the operator with a
`## Decisions required` section enumerating the 8 open questions.
Wait for explicit answers. Update §Locked design. Then proceed.

## Milestones — v0.5.0 ship (after design gate clears)

### Milestone 1: Manifest schema + types

- New migration `registry/src/storage/migrations/0004_oci_metadata.sql`:
  - Add `oci_metadata_json TEXT` column on `manifest` (default NULL,
    mirrors the cargo + npm column pattern).
  - Add a `pending_blob_uploads` table for the chunked-upload
    state machine (`upload_id PRIMARY KEY`, `repository`,
    `created_at`, `chunks` (JSON array of `{offset, sha256}`),
    `expires_at`).
- TypeScript types in `registry/src/oci/types.ts`:
  - `OciManifest`, `OciIndex`, `OciDescriptor`, `OciConfig`
  - Media-type constants for OCI v1.1 + Docker v2.2 legacy types
  - Strict-validating type guards (manifests come from untrusted
    clients).
- Repository name parser in `registry/src/oci/paths.ts` —
  same shape as `registry/src/cargo/paths.ts`. Accept `team/svc`
  inside a single `:name` path param. Confirm the router supports
  this; surface a router patch if not.
- Tests: unit for type guards, unit for path parser, migration smoke.

**Commit:** `feat(v0.5-registry-oci): manifest schema + types`

### Milestone 2: Blob protocol — `/v2/<name>/blobs/*`

- `registry/src/oci/blobs.ts` exporting `mountOciBlobRoutes(...)`:
  - `GET|HEAD /v2/<name>/blobs/<digest>` — reuse the existing
    `RegistryStorage.getBlob` / `existsBlob`. Set
    `Docker-Content-Digest` response header per spec.
  - `POST /v2/<name>/blobs/uploads/` — issue UUID, write
    `pending_blob_uploads` row, return `202` with `Location:
    /v2/<name>/blobs/uploads/<uuid>` and `Docker-Upload-UUID`
    header.
  - `PATCH /v2/<name>/blobs/uploads/<uuid>` — append chunk;
    validate `Content-Range` continuity; update `pending_blob_uploads.chunks`.
  - `PUT /v2/<name>/blobs/uploads/<uuid>?digest=<digest>` —
    finalize: assemble chunks, verify digest, atomic move into the
    content-addressed store, delete pending row. Idempotent on
    digest collision (`201 Created` with same `Location`).
  - `DELETE /v2/<name>/blobs/<digest>` — delete from store. Idempotent.
- Pending-uploads reaper (cron-style in-process tick alongside
  the existing scheduler infrastructure) per Q8 outcome.
- Spec-compliant error format on every failure path —
  `{errors: [{code, message, detail}]}` with the canonical codes
  (`BLOB_UNKNOWN`, `BLOB_UPLOAD_INVALID`, `BLOB_UPLOAD_UNKNOWN`,
  `DIGEST_INVALID`, `UNSUPPORTED`).
- Tests:
  - **Unit:** Content-Range parsing, digest verification, atomic
    finalize, error-code mapping.
  - **Integration:** end-to-end chunked upload via a stub HTTP
    client; resume-after-restart of the pending-uploads table.

**Commit:** `feat(v0.5-registry-oci): blob protocol + chunked upload`

### Milestone 3: Manifest protocol — `/v2/<name>/manifests/*`

- `registry/src/oci/manifests.ts` exporting `mountOciManifestRoutes(...)`:
  - `GET|HEAD /v2/<name>/manifests/<reference>` — reference is
    either `<tag>` or `sha256:<hex>`. By tag, look up the tag
    table; by digest, look up the manifest table directly.
    Respect `Accept` header to negotiate OCI v1 vs Docker v2.2
    manifest media type.
  - `PUT /v2/<name>/manifests/<reference>` — validate manifest
    (every referenced blob must exist; image-index entries must
    resolve to known child manifests); insert manifest row with
    `kind='oci'`; populate `oci_metadata_json` with layer count,
    config-blob digest, total size, child-manifest digests if it's
    an index.
  - `DELETE /v2/<name>/manifests/<reference>` per Q6.
- Tag table — `oci_tag (repository, tag, manifest_sha256,
  updated_at)` with a unique constraint on `(repository, tag)`.
  Mutable; updates replace.
- Provenance + audit-log integration: emit `action: 'upload'`
  rows for manifest PUTs, `action: 'manifest_create'` for tag
  rotations, exactly like cargo + npm.
- Tests:
  - **Unit:** reference parsing (tag vs digest), validation
    (missing-blob rejection, malformed-manifest rejection).
  - **Integration:** push + pull manifest round-trip; tag rotation;
    multi-arch index push + child-manifest resolution.

**Commit:** `feat(v0.5-registry-oci): manifest protocol + tag table`

### Milestone 4: Catalog + tags + auth challenge

- `GET /v2/_catalog?n=<count>&last=<repo>` — paginated repository
  list. Pull from the manifest table grouped by `repository`.
- `GET /v2/<name>/tags/list?n=<count>&last=<tag>` — paginated tags
  for one repo.
- `GET /v2/` — empty 200 if authenticated, 401 with `WWW-Authenticate:
  Bearer realm=<token-endpoint>` if not. Per Q5.
- `GET /<token-endpoint>?service=<svc>&scope=<scope>` — issue a
  short-lived JWT (or opaque token) wrapping the
  `sk_<prefix>_<secret>` bearer the operator already holds. Match
  the Docker CLI flow: read `Authorization: Basic <base64>` from
  the initial token request, validate, issue token; client retries
  with `Authorization: Bearer <token>`.
- Tests:
  - **Unit:** pagination cursor encoding, scope parsing
    (`repository:team/svc:pull,push`).
  - **Integration:** full challenge → token → authorized-request
    flow against an in-memory HTTP server.

**Commit:** `feat(v0.5-registry-oci): catalog + tags + bearer challenge`

### Milestone 5: Virtual upstream pull-through (Docker Hub)

- `registry/src/oci/virtual.ts` — same shape as
  `registry/src/cargo/virtual.ts` / `registry/src/npm/virtual.ts`.
- Pull-through topology: on cache miss for a manifest or blob,
  fetch from Docker Hub via the official `/v2/library/...` (or
  `/v2/<user>/<repo>/...`) endpoints; verify upstream digest;
  store + re-sign with the registry's Ed25519 key; serve to the
  client.
- Upstream auth abstraction in `registry/src/oci/upstream-auth.ts` —
  Docker Hub's token flow (`hub.docker.com/v2/users/login` + token
  exchange). The abstraction shape leaves room for GHCR / ECR
  adapters in v0.6.
- Audit-log rows: `action: 'proxy_cache'` with detail blob naming
  the upstream + the upstream digest (matches cargo + npm).
- Tests:
  - **Unit:** upstream auth state machine, re-signing parity.
  - **Integration:** end-to-end pull through against a stubbed
    Docker Hub upstream HTTP server (vitest's mock-fetch pattern).

**Commit:** `feat(v0.5-registry-oci): Docker Hub virtual upstream + re-signing`

### Milestone 6: Cosign-style signing

- `registry/src/oci/cosign.ts` — sign / verify a manifest using the
  cosign convention: write a sibling signature manifest at the
  `<digest>.sig` tag in the same repository.
- The signature manifest payload is the cosign simple-signing JSON
  shape: `{ critical: { identity, image: { docker-manifest-digest },
  type: cosign container image signature }, optional }`.
- Signed by the existing Ed25519 keypair the operator already holds
  (`~/.signalman/keys/signing.{pub,key}` by default).
- CLI: `signalman-registry oci sign <repository>:<tag>` +
  `signalman-registry oci verify <repository>:<tag>`.
- Verification endpoint: `GET /v2/<name>/manifests/<digest>.sig`
  returns the signature manifest; clients verify locally with the
  operator's public key.
- Tests:
  - **Unit:** simple-signing payload composition, signature
    round-trip.
  - **Integration:** end-to-end sign → push manifest →
    `cosign verify --key <pub>` against the running registry.

**Commit:** `feat(v0.5-registry-oci): cosign-style signing on OCI manifests`

### Milestone 7: Conformance suite + doc closure

- Wire the upstream
  `opencontainers/distribution-spec/conformance` Go harness into
  the registry CI lane. The upstream ships it as a Docker container
  with env-var configuration; map registry env vars to the
  harness expectations (`OCI_ROOT_URL`, `OCI_NAMESPACE`,
  `OCI_USERNAME`, `OCI_PASSWORD`, `OCI_CROSSMOUNT_NAMESPACE`).
- Gate the lane behind `SIGNALMAN_OCI_CONFORMANCE=1` like the
  existing cloud-integration tests; run on push to main + nightly.
- Update `registry/README.md` — new §OCI section walking through
  `docker login` + `docker push` + `docker pull` + `cosign verify`.
- Update `registry/ROADMAP.md` §v0.1.2 — flip status to
  "shipped 2026-05-XX"; cross-link the design doc.
- Update `docs/supply-chain.md` §Artifact-registry-provenance —
  note OCI is now a third protocol surface with provenance + audit
  parity.
- Update `docs/design/registry-oci.md` — flip §Status from
  "design proposal" to "shipped in v0.5.0"; record operator-approved
  deviations.
- 4-lens audit in `.workstream-status.md`. **Security lens** must
  cover: untrusted-client manifest validation, upload-UUID
  enumeration risk, chunked-upload exhaustion DoS surface,
  signature-verification trust path, cross-tenant repository
  enumeration via `/v2/_catalog`.

**Commit:** `docs(v0.5-registry-oci): conformance suite + README + design closure`

## Test taxonomy

| Layer | Where it runs | Examples |
|---|---|---|
| **Unit** | Any host | Type guards, path parsing, digest verification, error-code mapping, signing payloads |
| **Integration** | Any host | Chunked upload state machine; manifest CRUD; multi-arch index; bearer-challenge flow; virtual upstream against stubbed Docker Hub |
| **System** | Any host with Docker | `docker push` + `docker pull` + `crane copy` + `cosign verify` against the running registry |
| **Conformance** | CI lane gated by `SIGNALMAN_OCI_CONFORMANCE=1` | upstream `opencontainers/distribution-spec/conformance` harness |
| **Smoke** | Any host | Existing cargo + npm + forensic surfaces remain unaffected |

Coverage gate: ≥80% lines / ≥70% branches across new `registry/src/oci/`.

## Reserved blocks

- **Registry migration block**: `0004_oci_metadata.sql` is yours;
  `0005`+ stays free for the next protocol (maven / pip / helm).
- **Audit-log action codes**: the existing `upload` / `proxy_cache`
  / `manifest_create` codes are reused for OCI (a manifest is a
  manifest regardless of facade). No new namespace required —
  parity with cargo + npm.
- **HTTP route namespace**: `/v2/*` is reserved for WS10.
- **TypeScript module namespace**: `registry/src/oci/` is reserved
  for WS10; mirror the cargo / npm directory structure.

## Definition of Done

1. `cd registry && npm test` — full suite green
2. `cd registry && npx tsc --noEmit` — zero errors
3. `cd registry && npm run coverage` — coverage holds per gate
4. `cd host && npm test` — full host suite still green (no
   registry-side change should perturb host)
5. **Conformance**: `SIGNALMAN_OCI_CONFORMANCE=1 npm test` passes
   the upstream harness end to end (record per-category pass counts
   in `.workstream-status.md`)
6. **System smoke**: on an operator dev-host with Docker + cosign
   installed, push a real image (`alpine:3.20` is the reference
   target), pull it back, sign it, verify it, list catalog, list
   tags, delete manifest. Record commands + outcomes in
   `.workstream-status.md`.
7. **Existing cargo + npm + forensic surfaces unchanged**: the
   `proto`/`registry-storage`/`forensic` contract tests still pass
   byte-identical to v0.4.0.
8. **4-lens audit completed**, Security lens specifically PASS.
9. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**. Operator pushes
   after review.

## Commit pattern

- Milestone 0: design doc — 1 commit (operator gate)
- Milestone 1: schema + types — 1 commit
- Milestone 2: blob protocol — 1 commit
- Milestone 3: manifest protocol — 1 commit
- Milestone 4: catalog + tags + auth — 1 commit
- Milestone 5: virtual upstream — 1 commit
- Milestone 6: cosign signing — 1 commit
- Milestone 7: conformance + docs — 1 commit
- Subject format: `feat(v0.5-registry-oci): <what>` or
  `docs(v0.5-registry-oci): <what>`
- No internal-product names in commit messages.

## Status report (when complete)

`.workstream-status.md` with sections:

- `## Commits` (8 expected)
- `## Open questions resolved` — operator answers + design-doc deltas
- `## Tests added` per layer
- `## Coverage` deltas
- `## Conformance results` — pass counts by category from the
  upstream harness; any spec sections deferred (with rationale)
- `## 4-lens audit` — Security lens PASS or concern
- `## Manual end-to-end test log` — Docker / cosign commands run +
  outcomes
- `## Deferred to v0.6+` (with rationale) — GHCR + ECR upstreams,
  Notation signing variant, any spec sections not implemented
- `## Operator review needed`

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment.
- No emojis in source or docs.
- **Manifest validation is untrusted-input parsing** — every field
  is validated before persistence. Treat the OCI manifest JSON as
  hostile until proven otherwise.
- **Digest verification is non-negotiable** — every blob finalize
  verifies the computed sha256 against the client-supplied digest.
  Reject mismatches with `DIGEST_INVALID`.
- **Audit-log every state change** — manifest PUT, manifest DELETE,
  tag rotation, blob upload finalize, blob DELETE. Parity with cargo
  + npm.
- Don't push to origin without operator approval.

## Parallel work to be aware of

- **WS7 (Claude Code plugin)** — no overlap.
- **WS8 (per-user identity certs)** — no overlap. WS10 reuses the
  existing bearer-auth flow; identity-cert integration is out of
  scope here.
- **WS9 (signing service)** — minor adjacency. WS10's cosign
  signing uses the existing Ed25519 surface (`registry/src/signing.ts`)
  directly. **If WS9 has merged when WS10 reaches Milestone 6**,
  route the cosign signing through the WS9 `SigningProvider`
  interface instead; coordinate with the operator before that
  milestone.
- **WS11 (vmrun ↔ VMware convergence)** — no overlap.
- **WS12 (OSS-release-readiness)** — adjacent only at version-bump
  time. WS12 Milestone 3 will bump version pins; the registry's
  `package.json` is currently at `0.0.1` despite registry-ROADMAP.md
  claiming v0.1.1 shipped — there's an existing version drift to
  resolve in WS12 or as part of WS10 Milestone 7. Surface to
  operator.

WS10 touches: `registry/src/oci/` (new module), `registry/src/http/app.ts`
(mount block), `registry/src/http/router.ts` (path-param fix if
needed), `registry/src/storage/migrations/0004_oci_metadata.sql`
(new), `registry/src/storage/sqlite-index.ts` (manifest-kind
queries + oci_tag table + pending_blob_uploads table),
`registry/src/cli.ts` (new `oci sign` / `oci verify` verbs if Q3
lands "include cosign"), `registry/src/mcp.ts` (new MCP tools if
operator-relevant; default: skip — OCI tooling is standard CLI),
`registry/README.md`, `registry/ROADMAP.md`,
`docs/supply-chain.md`, `docs/design/registry-oci.md` (new).

If you find yourself touching anything outside that list, stop and
surface to the operator.

Start by reading `registry/ROADMAP.md` end to end, then the two
existing protocol facades (cargo + npm), then the OCI Distribution
Spec v1.1, then write the design doc, then post the 8 open
questions to the operator.
