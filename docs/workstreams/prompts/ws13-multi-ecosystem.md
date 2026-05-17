# WS13 — multi-ecosystem registry facades

Workstream prompt for the v0.6 expansion of `@signalman/registry`
to cover six additional package ecosystems (PyPI, Maven, NuGet,
HuggingFace, Go modules, RubyGems) plus a cross-cutting CLI + MCP
restructure.

Sister doc: `docs/design/registry-multi-ecosystem.md` — full design
+ locked decisions + per-ecosystem protocol summaries.

## What WS13 is

After v0.5.0 (WS10) the registry hosts three protocol facades that
share one content-addressed blob store + manifest catalog + audit
log + forensic API:

- cargo (`/cargo/<org>/...`, M10 wave-3)
- npm (`/npm/<org>/...`, v0.1.1)
- OCI / Docker (`/v2/<org>/<repo>/...`, WS10 v0.5)

Each meets three operator criteria: virtual upstream support,
pass-through caching with re-signing, and internal publish via
the ecosystem's standard tool.

WS13 extends this surface to six more ecosystems:

| # | Ecosystem | Wire protocol | Estimated effort |
|---|---|---|---|
| 1 | PyPI / pip | PEP 503 + PEP 691 | M2-sized (~npm complexity) |
| 2 | Maven / Java | Maven Repository Layout 2 | M3-sized (XML metadata + snapshots) |
| 3 | NuGet / .NET | NuGet v3 service-index | M3-sized (resource dispatcher) |
| 4 | HuggingFace Hub | git-LFS + REST | M3-sized (LFS + multi-GB weights) |
| 5 | Go modules (PUT) | Module proxy protocol + non-standard PUT | M2-sized |
| 6 | RubyGems | Compact index + classic API | M2-sized |

Plus M7 brings Go modules to full hybrid (VCS-integrated proxy
on top of M5's non-standard PUT), M8 lands the CLI + MCP
restructure, M9 closes docs + conformance.

Goal: an operator stands up Signalman as the single artifact
registry for a polyglot stack — `pip install`, `mvn deploy`,
`dotnet nuget push`, `huggingface-cli download`, `go get`,
`gem push`, and the existing `cargo` / `npm` / `docker` clients
all flow through the same audit + provenance + forensic surface.

Your branch: **`feat/v0.6-multi-ecosystem`** off main. All git
ops from the dedicated worktree at
`/home/aaron/repos/signalman-ws13-multi-ecosystem`. Do NOT push
to origin until the operator approves at milestone close.

## Orientation reading (in order, before any code)

1. `docs/design/registry-multi-ecosystem.md` — read end to end.
2. `docs/design/registry-oci.md` — the M10 design doc this one
   extends. Same "facade pattern" carries through.
3. The three existing facades — your work mirrors their shape:
   - `registry/src/cargo/{index,publish,read,virtual,paths}.ts`
   - `registry/src/npm/{index,publish,read,virtual,paths}.ts`
   - `registry/src/oci/{paths,types,blobs,manifests,virtual,upstream-auth,cosign,mount,...}.ts`
4. `registry/src/http/app.ts` — `buildApp()` mount points.
5. `registry/src/storage/{registry-storage,sqlite-index}.ts` +
   `registry/src/storage/migrations/000{1,2,3,4}_*.sql` — schema
   you extend.
6. `registry/src/storage/sqlite-index.ts` — `VirtualUpstreamConfig`
   type you extend per-ecosystem.
7. Ecosystem protocol specs:
   - **PyPI**: PEP 503, PEP 691, PEP 658
   - **Maven**: `maven.apache.org/repository/layout.html`
   - **NuGet**: `learn.microsoft.com/en-us/nuget/api`
   - **HuggingFace**: `huggingface.co/docs/hub/api`
   - **Go modules**: `go.dev/ref/mod#module-proxy`
   - **RubyGems**: `guides.rubygems.org/rubygems-org-api-v2/`
8. CLAUDE.md at repo root — Loom protocol + selvedge guardrails.

## Open product questions — resolve in M0

Use AskUserQuestion. Lock answers into
`docs/design/registry-multi-ecosystem.md` §Locked design.

Operator-pre-locked decisions (from chat):
- Priority: PyPI → Maven → NuGet → HuggingFace → Go-A → RubyGems → Go-C
- Go publish: phased A → C
- CLI: per-kind subverbs under `virtual` + `--kind` escape hatch
- MCP: 6 generic ecosystem-parameterized tools added in M8
- Single workstream (10 milestones), PM-flag at M5 for split consideration

Remaining questions (recap of design doc §Decisions required):

1. **PEP 691 JSON only or PEP 503 HTML + PEP 691 JSON?** Default
   rec: serve both with `Accept` negotiation.
2. **Maven snapshot policy default** — accept `-SNAPSHOT` PUTs by
   default or opt-in? Default rec: opt-in (`snapshot_policy:
   reject` default).
3. **NuGet v2 OData legacy** — required / optional / out of scope?
   Default rec: out of scope for v0.6.
4. **HF publish shape** — flattened file upload or full git push?
   Default rec: flattened for v0.6.
5. **HF blob-size cap** — bump per-blob to 50 GiB, or extend the
   M2 chunked-upload state machine to HF? Default rec: extend
   chunked-upload (no per-blob cap raise).
6. **Go GOSUMDB** — operator-side `GOSUMDB=off`, or run own
   notary? Default rec: document `GOSUMDB=off`; notary as v0.7
   stretch.
7. **Maven .asc GPG signatures** — verify on upload, or
   accept-and-store verbatim? Default rec: accept-and-store
   (matches Maven Central behaviour).
8. **HF LFS pull-through** — stream-mirror on first GET, or
   require explicit `prefetch`? Default rec: stream-mirror;
   operators with bandwidth/storage concerns set `deny_patterns`.
9. **PyPI + NuGet conformance suites in CI** — gated lanes like
   WS10's `SIGNALMAN_OCI_CONFORMANCE=1`? Default rec: yes for
   both; Maven + RubyGems + HF + Go use manual smoke.
10. **MCP tool timing** — M8 cross-cutting or per-ecosystem
    inline? Default rec: M8 cross-cutting.

## Milestone 0 (DESIGN GATE — ship before any code)

Produce + commit `docs/design/registry-multi-ecosystem.md`. The
operator reviews this in full before any production code lands.

Commit: `docs(v0.6-multi-ecosystem): design doc + open questions`.

Operator gate. Post the design doc to the operator with a
`## Decisions required` section enumerating the 10 open questions.
Wait for explicit answers. Update §Locked design. Then proceed.

## Milestones — v0.6.0 ship (after design gate clears)

Each milestone follows the WS10 pattern: build, test, 4-lens audit,
commit, merge to local main with `--no-ff`. **Coverage gate**:
≥80% lines AND ≥80% branches across each new
`registry/src/<kind>/` directory.

### M1: PyPI (Python)

- `registry/src/pypi/` — paths.ts, types.ts, guards.ts,
  read.ts (PEP 503 + PEP 691), publish.ts (twine multipart),
  virtual.ts (pypi.org pull-through), index.ts.
- Migration `0005_pypi_metadata.sql` — `pypi_metadata_json` column.
- Tests: PEP 503 HTML well-formedness, PEP 691 JSON shape, multipart
  upload parsing, virtual pull-through, hash-pinning, content-
  negotiation.
- Manual smoke: `twine upload` + `pip install` against running
  registry.

Commit: `feat(v0.6-multi-ecosystem): PyPI facade + virtual upstream`

### M2: Maven (Java)

- `registry/src/maven/` — paths.ts (group/artifact/version
  composition), types.ts, guards.ts, read.ts, publish.ts,
  virtual.ts (Maven Central), maven-metadata.ts (XML
  parser/composer), index.ts.
- Migration `0006_maven_metadata.sql`.
- Tests: metadata XML round-trip, snapshot semantics, classifier
  handling, virtual pull-through, .asc passthrough.
- Manual smoke: `mvn deploy` + `mvn dependency:resolve` against
  running registry.

Commit: `feat(v0.6-multi-ecosystem): Maven facade + virtual upstream`

### M3: NuGet (.NET)

- `registry/src/nuget/` — paths.ts, types.ts, guards.ts,
  service-index.ts, flat-container.ts, registration.ts,
  publish.ts, virtual.ts (nuget.org), index.ts.
- Migration `0007_nuget_metadata.sql`.
- Tests: service-index dispatch, flat-container version listing,
  registration-page shape, multipart push, virtual pull-through.
- Manual smoke: `dotnet nuget push` + `dotnet restore` against
  running registry.

Commit: `feat(v0.6-multi-ecosystem): NuGet facade + virtual upstream`

### M4: HuggingFace Hub

- `registry/src/hf/` — paths.ts, types.ts, guards.ts,
  resolve.ts (file fetch + LFS pointer resolution),
  metadata.ts (model/dataset API), lfs.ts (Git LFS Batch API),
  publish.ts (flattened operator upload), virtual.ts
  (huggingface.co), index.ts.
- Migration `0008_hf_metadata.sql` — `hf_metadata_json` column
  + `hf_revision` table for rev → root-tree-digest.
- Tests: LFS pointer resolution, batch endpoint conformance,
  multi-GB content-addressed dedup, virtual pull-through with
  Bearer token, revision pinning.
- Manual smoke: `huggingface-cli download` of a small model;
  operator publish of a fine-tuned model archive.
- **Strategic for Loom** — Loom uses HF for agent fine-tunes;
  M4 is the gating milestone for that integration.

Commit: `feat(v0.6-multi-ecosystem): HuggingFace facade + virtual upstream`

### M5: Go modules (Option A — non-standard PUT)

- `registry/src/gomod/` — paths.ts (module path validation,
  version validation per `golang.org/ref/mod#versions`),
  types.ts, guards.ts, read.ts (list / info / mod / zip /
  latest), publish.ts (non-standard PUT), virtual.ts
  (proxy.golang.org), index.ts.
- Migration `0009_gomod_metadata.sql`.
- Tests: zip layout per spec, version-string validation
  (pre-release + +meta), virtual pull-through, GOSUMDB=off
  operator docs.
- Manual smoke: `go get` against running registry; operator
  publish of an internal module via CI script.

Commit: `feat(v0.6-multi-ecosystem): Go modules facade (Option A — PUT publish)`

### M6: RubyGems

- `registry/src/rubygems/` — paths.ts, types.ts, guards.ts,
  compact-index.ts (versions + info text format), gems.ts
  (binary .gem fetch), publish.ts (gem push API), virtual.ts
  (rubygems.org), index.ts.
- Migration `0010_rubygems_metadata.sql`.
- Tests: compact-index text format, .gem tarball parsing,
  virtual pull-through, API-key auth.
- Manual smoke: `gem push` + `gem install` against running
  registry.

Commit: `feat(v0.6-multi-ecosystem): RubyGems facade + virtual upstream`

### M7: Go modules (Option C — VCS-integrated hybrid)

- Extends M5 with VCS-fetch resolver: on miss, fetch from a
  configured internal git/hg host, compute module zip, cache.
- Operator config knob on virtual_upstream row:
  `git_hosts: [{base_url, auth_header_template}]`.
- Hybrid resolver: PUT-published version wins; VCS path fills
  the gap.
- Tests: VCS-fetch end to end against stubbed Gitea / Forgejo /
  GitLab fixtures; hybrid coexistence (PUT precedence).

Commit: `feat(v0.6-multi-ecosystem): Go modules Option C — VCS-integrated hybrid`

### M8: CLI + MCP restructure

- Promote each ecosystem to a `virtual <kind>` subverb:
  `dockerhub`, `ghcr`, `ecr`, `cargo`, `npm`, `pypi`, `maven`,
  `nuget`, `hf`, `gomod`, `rubygems`. Each subverb is a thin
  shim over `addVirtualUpstream` with kind-specific flag
  validation.
- `virtual add --kind <k> --config '<json>'` retained as escape
  hatch.
- `virtual list` + `virtual remove` stay generic.
- MCP additions:
    registry_list_ecosystems
    registry_search_packages(ecosystem, query, limit?)
    registry_get_manifest(ecosystem, package, version)
    registry_resolve_version(ecosystem, package, version_spec)
    registry_prefetch(ecosystem, package, version)
    registry_provenance(ecosystem, package, version)
- Existing 5 MCP tools unchanged.
- Tests: each new subverb's flag-validation, MCP tool round-
  trip, registry_search_packages cross-ecosystem.

Commit: `feat(v0.6-multi-ecosystem): CLI per-kind subverbs + MCP ecosystem tools`

### M9: Conformance suites + README + docs closure

- Wire PyPI conformance (`pypa/warehouse` test suite) + NuGet
  v3 conformance into CI lanes gated by
  `SIGNALMAN_PYPI_CONFORMANCE=1` + `SIGNALMAN_NUGET_CONFORMANCE=1`.
- Update `registry/README.md` — new §PyPI / §Maven / §NuGet /
  §HuggingFace / §Go modules / §RubyGems sections each walking
  through `pip install` / `mvn deploy` / etc.
- Update `registry/ROADMAP.md` §v0.6 — flip status to "shipped
  2026-XX-XX".
- Update `docs/supply-chain.md` §Artifact-registry-provenance
  — note six additional protocol surfaces with provenance +
  audit parity.
- Update `docs/design/registry-multi-ecosystem.md` — flip
  §Status from "design proposal" to "shipped in v0.6.0";
  record operator-approved deviations.
- 4-lens audit in `.workstream-status.md` covering the full
  workstream. Security lens MUST cover, per-ecosystem:
  untrusted-payload validation, upload-DOS surface area,
  upstream digest integrity, audit-trail completeness.

Commit: `docs(v0.6-multi-ecosystem): conformance suites + README + closure`

## Test taxonomy

| Layer | Where | Examples |
|---|---|---|
| Unit | Any host | Per-ecosystem name + version validators, XML / JSON parsers, error envelope shapes, upstream-auth state machines |
| Integration | Any host | Per-ecosystem publish flow via stub HTTP client; virtual pull-through against stubbed upstream; multi-version listing; tag / version rotation; LFS batch endpoint |
| System | Any host w/ tooling | `twine upload`, `mvn deploy`, `dotnet nuget push`, `huggingface-cli download`, `go get`, `gem push` against the running registry |
| Conformance | CI lane | PyPI: PEP-conformance harness gated by `SIGNALMAN_PYPI_CONFORMANCE=1`; NuGet: v3-conformance gated by `SIGNALMAN_NUGET_CONFORMANCE=1` |
| Smoke | Any host | Existing cargo + npm + OCI + forensic surfaces remain unaffected per-milestone |

Coverage gate: **≥80% lines AND ≥80% branches** across each new
`registry/src/<kind>/`.

## Reserved blocks

- Registry migration block: **0005-0010** is yours (one per
  ecosystem); 0011+ stays free for v0.7 ecosystems
  (conan, vcpkg, hex, opam, CRAN).
- Audit-log action codes: existing five
  (`upload` / `proxy_cache` / `manifest_create` / `delete` /
  `yank` / `unyank`) cover every flow. **No new namespace
  required.**
- HTTP route namespaces: `/pypi/*`, `/maven/*`, `/nuget/*`,
  `/hf/*`, `/gomod/*`, `/rubygems/*` are reserved for WS13.
- TypeScript module namespaces: `registry/src/{pypi, maven,
  nuget, hf, gomod, rubygems}/` are reserved for WS13.

## Definition of Done

1. `cd registry && npm test` — full suite green.
2. `cd registry && npx tsc --noEmit` — zero errors.
3. `cd registry && npm run coverage` — coverage holds.
4. `cd host && npm test` — full host suite still green (no
   registry-side change should perturb host).
5. Conformance: gated PyPI + NuGet lanes pass per-category.
6. System smoke: per-ecosystem manual end-to-end (record
   commands + outcomes in `.workstream-status.md`).
7. Existing cargo + npm + OCI + forensic contract tests pass
   byte-identical.
8. 4-lens audit completed, Security lens specifically PASS
   for each new ecosystem.
9. Commits ready (`Co-Authored-By: Claude Opus 4.7 (1M context)
   <noreply@anthropic.com>`) but NOT pushed. Operator pushes
   after review.

## Commit pattern

- M0: design doc — 1 commit (operator gate).
- M1–M7: feature commits — 1 commit each (7 total).
- M8: CLI + MCP — 1 commit.
- M9: docs closure + conformance — 1 commit.
- Total: 10 commits on `feat/v0.6-multi-ecosystem`.
- Subject format: `feat(v0.6-multi-ecosystem): <what>` or
  `docs(v0.6-multi-ecosystem): <what>`.
- No internal-product names in commit messages.

## Status report (when complete)

`.workstream-status.md` appended section with:

- `## Commits` (10 expected)
- `## Open questions resolved` — operator answers + design-doc
  deltas
- `## Tests added per layer`
- `## Coverage deltas` (per ecosystem + aggregate)
- `## Conformance results` — pass counts by category (PyPI +
  NuGet)
- `## 4-lens audit` — Security lens PASS per ecosystem
- `## Manual end-to-end test log` — per-ecosystem client tool
  smoke
- `## Deferred to v0.7+` (Conan, vcpkg, Hex, opam, CRAN, OCI
  referrers API, mutable cargo tags, etc.)
- `## Operator review needed`

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment.
- No emojis in source or docs.
- Treat every ecosystem's upload body as **hostile until proven
  otherwise** — strict-validating parsers before persistence.
- Digest verification non-negotiable for any ecosystem that
  carries content-hashes (PyPI sha256, Maven sha256/sha1/md5,
  NuGet sha512, RubyGems sha256, Go modules zip hash, HF LFS
  oids). Reject mismatches.
- Audit-log every state change — publish, proxy_cache, delete.
- Don't push to origin without operator approval.

## Parallel work to be aware of

- WS10 (v0.5 OCI) — shipped 2026-05-17. No overlap.
- WS9 (signing-service) — shipped. The cosign re-sign flow in
  WS10 used the provider abstraction; WS13 ecosystems that
  support re-sign-on-cache go through the same surface.
- WS11 (libvirt-parity) — shipped. No overlap.
- WS12 (oss-release-readiness) — shipped. Version-bump pin
  resolved.

If a new workstream lands on the cargo / npm / OCI facades
during WS13's run, coordinate via the operator before touching
shared `registry/src/storage/` files. Migration block 0005-0010
is yours; the existing `<kind>_metadata_json` columns stay
unchanged.

## PM checkpoint at M5

The single-workstream choice carries 6-9 weeks of branch drift
risk. The operator was warned at draft time. At M5 close (after
Go-A ships), reassess:

- Are audits still passing first-time, or are reviews finding
  defects?
- Has any other workstream collided with the WS13 worktree?
- Is the cohort branch lagging origin/main by > 100 commits?

If two or more answers say "yes", recommend splitting the
remaining work (M6-M9) into a fresh `v0.7-multi-ecosystem-finish`
workstream rather than risking quality on the long-running
branch.
