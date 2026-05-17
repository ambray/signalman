# `@signalman/registry` — multi-ecosystem facade (PyPI, Maven, NuGet, HuggingFace, Go, RubyGems)

**Status:** design proposal (2026-05-17). M0 gate locked — all 14
decisions confirmed by operator at M0 close. No code shipped yet;
M1 (PyPI) is the first code milestone.
**Owner:** WS13 (`docs/workstreams/prompts/ws13-multi-ecosystem.md`).
**Target release:** v0.6.0 (may split to v0.6 + v0.7 if audit quality
slips past M5 — see §Critique below).
**Predecessor:** the three protocol facades already in `main` —
cargo (M10 wave-3), npm (v0.1.1), OCI / Docker (WS10 v0.5). The
same `<kind>_metadata_json` storage column + `virtual_upstream`
table pattern carries through here unchanged.

## Context

After v0.5.0 (WS10) the registry hosts three protocol facades that
share one content-addressed blob store + manifest catalog + audit
log + forensic API: cargo, npm, OCI. Every facade meets three
operator criteria:

1. Virtual upstream support with auth flow (anonymous-token,
   PAT/Bearer, AWS SigV4 covered).
2. Pass-through cache with re-signing on cache write.
3. Internal publish post-build via the ecosystem's standard tool
   (`cargo publish`, `npm publish`, `docker push`).

WS13 extends this surface to **six more ecosystems** so signalman's
"bootstrap-from-signalman" loop covers the runtimes most enterprise
stacks use:

- **PyPI** (Python packages) — PEP 503 / PEP 691
- **Maven** (Java/Kotlin/Scala) — Maven Repository Layout 2
- **NuGet** (.NET) — NuGet v3 service-index
- **HuggingFace Hub** (ML models / datasets) — git-LFS + REST API
- **Go modules** (Go) — module proxy protocol (`golang.org/ref/mod`)
- **RubyGems** (Ruby) — compact-index + classic API

After WS13 ships, an operator can stand up Signalman as the
single artifact registry for a polyglot stack and have CI / CD /
agent flows mirror + publish + sign across all nine ecosystems
(cargo + npm + OCI + the six above) through the same audit,
provenance, and forensic surface.

## Goals

1. Operator-side parity with cargo / npm / OCI: every new ecosystem
   ships with virtual upstream + cache + publish.
2. Storage primitives stay unchanged. Each ecosystem gets exactly
   one new `<kind>_metadata_json` column on the manifest table; no
   new core tables.
3. CLI restructure to keep operator UX coherent as ecosystem count
   grows (per-kind subverbs with `--kind` retained as escape hatch).
4. MCP tool restructure to keep agentic-coder UX coherent (generic
   ecosystem-parameterized tools instead of per-ecosystem tool
   explosion).
5. Single workstream (operator-chosen), milestone-sequenced so each
   ecosystem ships independently within the workstream.
6. ≥80% lines AND ≥80% branches across new module dirs per the
   existing coverage gate.

## Non-goals

- **New core tables** — every ecosystem rides the existing
  `manifest` + `blob` + `oci_tag` (or equivalents) + `virtual_upstream`
  surface. Maven snapshot semantics, NuGet's service-index dispatch,
  and HF's git-LFS pointer files are all handled in the `<kind>_metadata_json`
  column on the existing manifest row.
- **Vulnerability scanning on ingest** — v0.1.3 ROADMAP milestone;
  out of scope here.
- **Per-tenant catalog scoping (RBAC)** — v0.2.1; out of scope.
- **Streaming PUT for blobs > 1 GiB** — ROADMAP §v0.2.0; relevant for
  HF model weights but defer the storage-layer rework to the
  Operational Hardening pass.
- **Generic web-UI / dashboard** — ROADMAP §v0.4.x; out of scope.

## Locked design (decisions required confirmed at M0 gate)

### Shared facade pattern (unchanged from cargo / npm / OCI)

Every ecosystem adds:

```
registry/src/<kind>/
  paths.ts        — name validators + storage-name composition
  types.ts        — wire-format types + media-type constants
  errors.ts       — protocol-spec error envelope (where applicable)
  guards.ts       — strict-validating parsers for untrusted input
  http.ts         — response writers
  publish.ts      — protocol-specific publish handler
  read.ts         — GET / HEAD handlers (metadata + binary)
  virtual.ts      — proxy-on-miss to upstream + cache
  upstream-auth.ts — adapter for the ecosystem's upstreams
  mount.ts        — composes the route block
  index.ts        — public barrel
```

Migration: `registry/src/storage/migrations/000N_<kind>_metadata.sql`
adds one new column on the `manifest` table. Block 0005-0010 is
reserved by the original design doc.

Storage manifest name: `<kind>/<org>/<package>` — same shape as
`cargo/<org>/<crate>`, `npm/<org>/<package>`, `oci/<org>/<repo>`.

Audit-log actions reuse the existing enum (`upload`, `proxy_cache`,
`manifest_create`, `delete`). No new actions required.

### Per-ecosystem protocol summaries (full design at each milestone gate)

#### M1 — PyPI / pip

```
GET  /pypi/<org>/simple/<pkg>/             HTML (PEP 503) or JSON (PEP 691)
GET  /pypi/<org>/files/<pkg>/<filename>    binary wheel (.whl) or sdist (.tar.gz)
POST /pypi/<org>/                          twine-compatible multipart upload
```

- Wire format: PEP 503 HTML for old-pip + PEP 691 JSON for modern
  pip (>= 22.3). Negotiated via `Accept` header; JSON is preferred.
- Files: wheels and sdists, content-addressed sha256, ≤ ~100 MB
  typical.
- Publish: `twine upload` POST multipart/form-data with
  `:action=file_upload`, content blob, and PEP 314 metadata fields.
- Virtual upstream: `pypi.org/simple/`. Anonymous; private indexes
  via Basic Auth (Nexus / Artifactory / GitHub Packages PyPI).
- Storage column: `pypi_metadata_json` with `{ requires_python,
  classifiers, requires_dist, yanked_reason }`.

#### M2 — Maven / Java

```
GET /maven/<org>/<group-path>/<artifact>/maven-metadata.xml
GET /maven/<org>/<group-path>/<artifact>/<version>/<artifact>-<version>.<ext>
PUT /maven/<org>/<group-path>/<artifact>/<version>/<file>
```

- Wire format: Maven Repository Layout 2 — directory-tree URLs,
  XML metadata (`maven-metadata.xml`). No central manifest.
- Files: JARs, POMs, sources, javadoc, `.asc` GPG signatures,
  `.md5` / `.sha1` / `.sha256` checksum sidecars.
- Snapshots: `<version>-SNAPSHOT` artifacts carry per-version
  `maven-metadata.xml` with timestamp + build number. Snapshot
  versions are mutable; release versions are immutable. Operator
  config knob: `snapshot_policy ∈ {allow, reject}`.
- Publish: `mvn deploy` PUTs each file individually + the per-version
  metadata XML. We accept all PUTs and rebuild `maven-metadata.xml`
  from row state on each GET.
- Virtual upstream: Maven Central (`repo1.maven.org/maven2/`),
  Sonatype OSS, GitHub Packages Maven. Auth: Basic.
- Storage column: `maven_metadata_json` with `{ group_id, artifact_id,
  packaging, classifier, snapshot_timestamp, snapshot_build_number,
  dependencies }`.

#### M3 — NuGet / .NET

```
GET /nuget/<org>/v3/index.json                                  service index
GET /nuget/<org>/v3-flatcontainer/<id>/index.json               version list
GET /nuget/<org>/v3-flatcontainer/<id>/<version>/<id>.<version>.nupkg
GET /nuget/<org>/v3/registration5-gz-semver2/<id>/index.json    registration page
PUT /nuget/<org>/api/v2/package                                 publish (X-NuGet-ApiKey)
```

- Wire format: NuGet v3 — service-index JSON dispatcher; clients
  fetch `/v3/index.json` once and follow the `@type`-keyed resource
  URLs. v2 OData legacy is **explicitly out of scope** at v0.6
  (modern `dotnet` clients prefer v3; legacy nuget.exe can be
  upgraded).
- Files: `.nupkg` zips with embedded `.nuspec` XML manifest.
- Publish: multipart with `X-NuGet-ApiKey` header.
- Virtual upstream: nuget.org (`api.nuget.org/v3/index.json`),
  GitHub Packages NuGet, Azure Artifacts NuGet.
- Storage column: `nuget_metadata_json` with `{ id, version,
  authors, dependencies_groups, target_frameworks, listed }`.

#### M4 — HuggingFace Hub

```
GET  /hf/<org>/<repo>/resolve/<rev>/<file>           file (LFS pointer auto-resolved)
GET  /hf/<org>/<repo>/api/models/<repo>              model metadata JSON
GET  /hf/<org>/<repo>/api/models/<repo>/tree/<rev>   file tree for a revision
POST /hf/<org>/<repo>.git/info/lfs/objects/batch     Git LFS Batch API
POST /hf/<org>/upload                                operator-uploaded model archive
```

- Wire format: git-LFS + a REST metadata API. Each HF "repo" is a
  git repository with LFS pointer files for large weights.
- Files: model weights (`.safetensors`, `.bin`, `.gguf`) up to
  tens of GiB; tokenizer files; model cards. Content-addressed
  dedup is high-value here — fine-tunes often share base weights.
- Publish: operator pushes a model archive via the registry's
  upload endpoint. Sub-question: full git repo upload vs.
  flattened file upload. Recommend flattened for v0.6 simplicity;
  full git semantics is a v0.7 stretch.
- Virtual upstream: `huggingface.co`. Auth: Bearer `hf_<token>`
  for private repos; anonymous for public.
- Storage column: `hf_metadata_json` with `{ model_type, revision,
  file_tree, lfs_objects: [{oid, size}], pipeline_tag, tags }`.
- Critical for Loom: agent task-tracking needs to pull
  fine-tuned models from operator-published HF repos. M4 is the
  Loom-strategic milestone.

#### M5 — Go modules (Option A: non-standard PUT)

```
GET /gomod/<org>/<module>/@v/list                  newline-separated versions
GET /gomod/<org>/<module>/@v/<version>.info        JSON: {Version, Time}
GET /gomod/<org>/<module>/@v/<version>.mod         go.mod file
GET /gomod/<org>/<module>/@v/<version>.zip         module zip
GET /gomod/<org>/<module>/@latest                  latest version JSON
PUT /gomod/<org>/<module>/@v/<version>.zip         (non-standard) operator publish
```

- Wire format: Go module proxy protocol (read-only by spec).
- Publish: **Non-standard PUT** for v0.6 — operator publishes a
  pre-built module zip + computed `.mod` + `.info`. CI scripts wrap
  the publish; `go build` consumes via the standard module proxy
  protocol unchanged.
- Virtual upstream: `proxy.golang.org`. Anonymous.
- GOSUMDB: operator either disables (`GOSUMDB=off`) in their toolchain
  config or we run our own notary (M7 stretch).
- Storage column: `gomod_metadata_json` with `{ module, version,
  time, go_mod_hash, zip_hash }`.

#### M6 — RubyGems

```
GET /rubygems/<org>/versions                          master version index
GET /rubygems/<org>/info/<gem>                        per-gem compact text
GET /rubygems/<org>/gems/<name>-<version>.gem         binary .gem
POST /rubygems/<org>/api/v1/gems                      publish (binary in body, Auth header)
```

- Wire format: compact index (post-2016) + classic API.
- Files: `.gem` files (tar of `metadata.gz` + `data.tar.gz`).
- Publish: `gem push` POST with binary in body + API key in
  `Authorization` header.
- Virtual upstream: `rubygems.org`. Anonymous read, API key push.
- Storage column: `rubygems_metadata_json` with `{ name, version,
  platform, dependencies, checksum, yanked }`.

#### M7 — Go modules (Option C: VCS-integrated hybrid)

- Adds the proper Go module proxy behaviour: on miss, fetch from a
  configured internal git/hg host (Gitea/Forgejo/GitLab), compute
  the module zip, cache.
- Coexists with M5's non-standard PUT: PUT wins when both have the
  version; VCS path fills the gap for "pull-only" modules the
  operator hasn't explicitly pushed.
- Operator config: `git_hosts: [{base_url, auth_header_template}]`
  on virtual_upstream rows.

### Cross-cutting M8 — CLI restructure

Promote each ecosystem to a `virtual` subverb with kind-specific
flags:

```
signalman-registry virtual dockerhub --org acme \
    [--upstream-repo-template "library/{repo}"] [--resign]
signalman-registry virtual ghcr      --org acme [--pat-env GHCR_TOKEN]
signalman-registry virtual ecr       --org acme --aws-region us-east-1
signalman-registry virtual pypi      --org acme [--upstream https://pypi.org/simple/]
signalman-registry virtual maven     --org acme [--snapshot-policy allow|reject]
signalman-registry virtual nuget     --org acme [--upstream-service-index <url>]
signalman-registry virtual hf        --org acme [--token-env HF_TOKEN]
signalman-registry virtual gomod     --org acme [--gosumdb off]
signalman-registry virtual rubygems  --org acme [--api-key-env GEM_API_KEY]
signalman-registry virtual cargo     --org acme [--upstream https://index.crates.io]
signalman-registry virtual npm       --org acme [--upstream https://registry.npmjs.org]

# Escape hatch for ecosystems the operator wants to wire by hand:
signalman-registry virtual add --kind <k> --org <o> --upstream <url> --config '<json>'
```

Each subverb is a thin shim that validates kind-specific flags and
calls the existing `addVirtualUpstream` SQL helper. `virtual list`
+ `virtual remove` stay generic (they don't care about kind).

Artifact-level verbs stay HTTP-only — operator's `twine`, `mvn`,
`dotnet`, `huggingface-cli`, etc. continue to drive publish + pull
through the standard protocol surface. Registry-only verbs (`oci
sign`, `cargo yank`) keep their existing `<kind> <action> <ref>`
shape.

### Cross-cutting M8 — MCP restructure

Add six generic ecosystem-parameterized tools:

```typescript
registry_list_ecosystems():
  { ecosystem, status: 'active'|'unused', manifest_count, last_activity_at }[]

registry_search_packages(ecosystem: Ecosystem, query: string, limit?: number):
  { name, latest_version, source: 'local'|'cached', upstream_url? }[]

registry_get_manifest(ecosystem, package, version):
  { metadata, dependencies, signed_by?, upstream_url?, audit_entries }

registry_resolve_version(ecosystem, package, version_spec):
  { resolved: string, would_proxy: boolean }

registry_prefetch(ecosystem, package, version):
  { cached: boolean, blob_sha256: string }

registry_provenance(ecosystem, package, version):
  { source: 'upload'|'proxy_cache'|'manifest_create',
    upstream_url?: string,
    signed_by?: string,
    audit_trail: AuditEntry[] }
```

Existing tools (`registry_serve`, `registry_push_manifest`,
`registry_pull_manifest`, `registry_list_versions`,
`registry_verify`) stay unchanged.

Type-token cost for agents: 6 generic tools vs. ~45 per-ecosystem
tools. Schema documentation teaches `ecosystem` reasoning once;
the parameter dispatches.

### Storage schema deltas

```
0005_pypi_metadata.sql       ALTER manifest ADD pypi_metadata_json TEXT
0006_maven_metadata.sql      ALTER manifest ADD maven_metadata_json TEXT
0007_nuget_metadata.sql      ALTER manifest ADD nuget_metadata_json TEXT
0008_hf_metadata.sql         ALTER manifest ADD hf_metadata_json TEXT;
                             plus hf_revision table (rev → root tree digest)
0009_gomod_metadata.sql      ALTER manifest ADD gomod_metadata_json TEXT
0010_rubygems_metadata.sql   ALTER manifest ADD rubygems_metadata_json TEXT
```

The `manifest.kind` CHECK constraint extends to include the six
new kinds.

### Audit-log actions

No new actions required. The existing five
(`upload` / `proxy_cache` / `manifest_create` / `delete` / `yank-unyank`)
cover every flow. Detail-blob shapes documented per-ecosystem at
each milestone gate.

## Test taxonomy

| Layer | Where | Examples |
|---|---|---|
| Unit | Any host | Name validators per ecosystem, metadata-XML / metadata-JSON parsers, error-envelope shape, upstream-auth state machines |
| Integration | Any host | Per-ecosystem publish + virtual upstream against stubbed HTTP servers; multi-version listing; tag / version rotation |
| System | Any host w/ ecosystem tooling | `twine upload` against running registry; `mvn deploy` round-trip; `dotnet nuget push`; `huggingface-cli download`; `go get`; `gem push` |
| Conformance | Where applicable | PyPI: PEP 503 + PEP 691 well-formedness; NuGet: service-index dispatch; HF: git-LFS batch endpoint conformance |
| Smoke | Any host | Existing cargo + npm + OCI + forensic surfaces remain unaffected per-milestone |

**Coverage gate**: ≥80% lines AND ≥80% branches across each new
`registry/src/<kind>/` directory, mirroring the WS10 gate.

## Definition of Done (per milestone)

1. `cd registry && npm test` — full suite green.
2. `cd registry && npx tsc --noEmit` — zero errors.
3. `cd registry && npm run coverage` — coverage holds per gate.
4. Existing cargo + npm + OCI + forensic contract tests pass
   byte-identical.
5. 4-lens audit completed (QA / Architecture / Product / Security)
   per milestone. **Security lens is non-negotiable** for any
   ecosystem that accepts upload bodies (i.e. all six).
6. Per-ecosystem manual smoke against the real client tool
   (`twine`, `mvn`, etc.) recorded in `.workstream-status.md`.
7. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   <noreply@anthropic.com>) but NOT pushed until operator
   approves.

## Decisions required (operator gate — M0)

**Status:** all 14 decisions locked 2026-05-17 (4 pre-locked in chat
+ 10 surfaced at M0 gate; every answer accepted the recommendation).

| # | Topic | Decision (locked) |
|---|---|---|
| Priority | Ecosystem order | PyPI → Maven → NuGet → **HuggingFace** → Go-A → RubyGems → Go-C |
| Go publish | Strategy | Phased: A (non-standard PUT) in M5, C (VCS-integrated hybrid) in M7 |
| CLI | Shape | Per-ecosystem subverbs under `virtual`; `--kind` retained as escape hatch |
| MCP | Shape | 6 generic ecosystem-parameterized tools added in M8 |
| WS split | Cadence | Single workstream (10 milestones); PM-checkpoint at M5 close re. split |
| Q1 | PyPI serving format | **Serve both PEP 503 HTML + PEP 691 JSON** with Accept-header negotiation. pip 22.3+ gets JSON; older pip gets HTML. |
| Q2 | Maven snapshot policy | **Reject `-SNAPSHOT` PUTs by default.** Operators flip per-repo `snapshot_policy: allow` for projects that need them. Immutable-by-default preserves the supply-chain story. |
| Q3 | NuGet v2 OData | **Out of scope for v0.6.** Modern `dotnet` prefers v3. v2 lands in v0.7 if operators ask. |
| Q4 | HF publish shape | **Flattened file upload for v0.6.** Operator POSTs a tarball or per-file. Full `git push` semantics deferred to v0.7. |
| Q5 | HF blob-size cap | **Extend M2's chunked-upload state machine to the HF flow.** No per-blob cap raise (single-shot stays at 5 GiB). HF uploads > 5 GiB chunk through POST/PATCH/PUT just like OCI blobs. |
| Q6 | Go GOSUMDB | **Document `GOSUMDB=off` for internal modules at M5 ship.** Notary endpoint inside Signalman deferred to v0.7 stretch. Internal modules are trusted-by-org. |
| Q7 | Maven .asc | **Accept-and-store verbatim.** GPG verification is the consumer's job (`mvn verify`). Matches Maven Central's own behaviour. |
| Q8 | HF LFS pull-through | **Stream-mirror on first GET.** Transparent proxy semantics. Operators with bandwidth/storage concerns set `deny_patterns` on the virtual_upstream row. |
| Q9 | Conformance CI | **PyPI + NuGet conformance lanes gated by env var** (`SIGNALMAN_PYPI_CONFORMANCE=1` + `SIGNALMAN_NUGET_CONFORMANCE=1`). Manual smoke for Maven + HF + Go + RubyGems (no official upstream harnesses for those four). |
| Q10 | MCP tool timing | **All 6 added in M8 cross-cutting**, after M1–M7 ship the ecosystems. Uniform tool schema across all ecosystems. |

## Cross-references

- `registry/ROADMAP.md` — current state of the registry roadmap.
  v0.1.4 (mutable tags + retention) is the natural follow-on to
  v0.6; WS13's storage shape leaves room for it.
- `docs/design/registry-oci.md` — WS10 design doc, the immediate
  prior art for this workstream's facade pattern.
- `docs/design/meta-build-system.md` §15 — canonical "bootstrap-
  from-signalman" design.
- `docs/supply-chain.md` — audit-log + provenance documentation
  that WS13 extends rather than replaces.
- PEP 503 / 691 / 658 — PyPI Simple Repository API specs.
- Maven Repository Layout 2 — Apache Maven documentation.
- NuGet v3 protocol — `learn.microsoft.com/en-us/nuget/api`.
- HuggingFace Hub API — `huggingface.co/docs/hub`.
- Go Modules Reference — `go.dev/ref/mod#module-proxy`.
- RubyGems Compact Index — `guides.rubygems.org/rubygems-org-api-v2/`.

## Extension points (out of scope for WS13)

- **Cargo registries v2** — RFC 3724 alternative registry protocol
  with API tokens + dependency-graph metadata; the v0.6+ cargo
  facade may want to support it.
- **OCI 1.1 referrers API** — already storage-ready (subject column);
  the route is a thin addition.
- **Conan / vcpkg / Hex / opam / CRAN** — additional ecosystems for
  v0.7+ as operator demand emerges.
- **Streaming uploads for blobs >5 GiB** — ROADMAP §v0.2.0
  Operational Hardening; relevant for HF model weights at scale.
