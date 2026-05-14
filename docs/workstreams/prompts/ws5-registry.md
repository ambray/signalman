# WS5 starting prompt — Artifact registry (v0.4.0+ OSS product)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman-registry`.

---

You are working on Signalman, an agent-first DevOps platform. Today Signalman has an internal `BlobDriver` interface with local-FS and S3 impls (`host/src/control-plane/blobs/`). v0.4.0+ lifts that into a **standalone OSS artifact registry product** (`@signalman/registry`) competing with JFrog Artifactory, Sonatype Nexus, and GitHub Packages. Main is at `558e0ed`.

**Your worktree**: `C:\Users\ucale\source\repos\signalman-registry` — branch `feat/v0.4.0-registry`. `cd` there. All git ops from inside that worktree. **Do NOT push to origin.**

## Orientation reading (in order, before any code)

1. `docs/workstreams/PLAN.md` in your worktree if present — cross-stream coordination rules
2. `CLAUDE.md` at repo root — Loom protocol
3. `host/src/control-plane/blobs/` — existing `BlobDriver` interface + S3 + local-FS impls
4. `host/src/control-plane/build/signing.ts` — Ed25519 signing patterns; you'll port to the registry
5. `host/src/http/app.ts`, `auth.ts`, `router.ts`, `errors.ts` — Fastify-style HTTP shell + bearer-token auth pattern
6. `host/package.json` — npm package metadata convention; reuse dep versions where possible
7. `host/src/control-plane/storage/sqlite.ts` and `postgres.ts` — storage-driver pattern; you'll mirror with a SQLite manifest index
8. `docs/design/meta-build-system.md` §15 — full registry design (scope, phasing, architecture, open questions)

## Your milestone — registry bootstrap (v0.4.0 scope)

Stand up the **package skeleton + generic blob format + signing port + minimal HTTP API + host integration**. OCI distribution spec compliance, mutable tags, retention/GC, npm/maven/crates protocols, vuln scanning are **all deferred** to v0.4.x followups — note each explicitly in `.workstream-status.md` under `## Deferred`.

### Deliverable

1. New package directory `registry/` at the repo root with:
   - `package.json` (name `@signalman/registry`, version `0.0.1`, Apache-2.0 license)
   - `tsconfig.json`, `vitest.config.ts`, `src/`, `src/__tests__/`
   - LICENSE + NOTICE files at package root matching the rest of the repo
2. **Generic blob format** (`src/types.ts`):
   - `Blob` = `{ sha256, size, contentType?, createdAt }`
   - `Manifest` = `{ name, version, mediaType, blobs: BlobRef[], annotations?, signature? }`
   - `RegistryStorage` interface
   - `RegistryError` class with stable codes
3. **Storage layer**:
   - `src/storage/local-fs.ts` mirroring `host/src/control-plane/blobs/local-fs.ts` plus manifest index
   - `src/storage/sqlite-index.ts` — simple `manifests` + `blobs` tables
4. **Signing** (`src/signing.ts`) — Ed25519 ported from `host/src/control-plane/build/signing.ts`
5. **HTTP API** (`src/http/`):
   - `PUT /v1/manifests/:name/:version` (push manifest)
   - `GET /v1/manifests/:name/:version` (pull manifest)
   - `PUT /v1/blobs/:sha256` (push blob)
   - `GET /v1/blobs/:sha256` (pull blob)
   - `GET /v1/manifests/:name` (list versions)
   - `DELETE /v1/manifests/:name/:version` (admin-only RBAC stub for now)
6. **Auth** — federated Bearer-token shape (`sk_<prefix>_<secret>`); shared shape validation helper; TODO comment for full RBAC
7. **CLI** — `registry serve --port 8443 --storage-root ./data` and `registry verify <manifest-path>`
8. **`signalman-registry` BlobDriver** in `@signalman/host` — new file `host/src/control-plane/blobs/signalman-registry.ts` that talks to the registry over HTTP; drop-in for S3. Wire into the `createBlobDriver` switch in `host/src/control-plane/blobs/index.ts`. Proves federation works.

### Explicitly deferred to v0.4.x

- OCI distribution spec v1.1 compliance (push/pull container images via `docker push` / `oras push`)
- Mutable tags (`latest`, `staging`, `production`)
- Retention / GC by age, count, or tag policy
- npm / crates.io / maven / pip / Helm protocols
- Vulnerability scanning (Trivy / Grype integration)
- Mirroring + caching upstream public registries

## Reserved blocks

- Migration numbers: registry owns its own schema (SQLite migrations under `registry/src/storage/migrations/`)
- No conflict with host's migration block

## Test taxonomy — write all three layers

- **Unit**: manifest schema validation; signature verify (good + bad signatures); sha256 addressing; `BlobRef` parser; CLI argv parsing
- **Integration**: `LocalFsStorage` round-trip (write manifest → read → verify); HTTP API push/pull via injected request client (or Fastify's `app.inject()`)
- **System**: full `registry serve` boot → push signed manifest → pull → verify signature; `signalman-registry` BlobDriver against a live in-memory registry instance

Tests under `registry/src/__tests__/` matching host's conventions.

## Definition of Done (must pass before milestone completes)

1. `cd registry && npm test` — full suite green
2. `cd registry && npx tsc --noEmit` — zero errors
3. `cd registry && npm run coverage -- --testTimeout=30000` — ≥80% lines / ≥70% branches / ≥80% functions / ≥80% statements
4. **Host suite still green**: `cd host && npm test` — no regression from the `signalman-registry` BlobDriver wiring
5. **4-lens audit completed** — write a `## 4-lens audit` section in `.workstream-status.md` covering QA / Architecture / Product / Security, each ending **PASS** or **specific concern**. This is a new OSS product — Security lens deserves careful attention (auth, signature validation, path traversal in storage keys).
6. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>) but **NOT pushed**.

## Commit pattern

- Commit 1: package skeleton (package.json, tsconfig, vitest config, README, LICENSE, NOTICE) + green-on-empty vitest
- Commit 2: types (Blob, Manifest, RegistryStorage, RegistryError) + unit tests
- Commit 3: LocalFsStorage + tests
- Commit 4: SQLite manifest index + tests
- Commit 5: signing port + tests
- Commit 6: HTTP server + tests (integration + system)
- Commit 7: CLI verbs + tests
- Commit 8: `signalman-registry` BlobDriver in @signalman/host + integration tests
- Subject format: `feat(registry): <what>` for registry-internal; `feat(host): signalman-registry BlobDriver` for the host integration

## Dependency hygiene

- Reuse versions already in `host/package.json` where possible (Fastify, vitest, @noble/ed25519, etc) to keep transitive deps aligned
- New deps: justify each in the commit message
- License: Apache-2.0 / MIT / BSD only — no GPL or AGPL

## Status report (when complete)

Write `.workstream-status.md` at the worktree root with sections:
- `## Commits`, `## Tests added` (with paths + counts), `## Coverage` (registry % AND host % to confirm no regression), `## 4-lens audit`, `## Deferred` (be explicit — many v0.4.x followups), `## Operator review needed`

Return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment
- No emojis
- Apache-2.0 license matching the rest of the repo
- Read CLAUDE.md; use Loom MCP tools if available

Start by `cd C:\Users\ucale\source\repos\signalman-registry`, read orientation files, then plan, then implement.
