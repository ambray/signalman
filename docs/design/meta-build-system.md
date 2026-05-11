# Meta Build System — Design

**Status**: Draft, awaiting operator review
**Target**: v0.2.0 (MVP, local mode); v0.3.0 (self-hosted); v0.4.0+ (hosted commercial)
**Author**: 2026-05-10 design pass
**Locks down**: Architecture, storage interface, release-catalog shape, CLI/MCP surface additions, phasing.

## TL;DR

Signalman is being expanded from a scenario runner into a full release-lifecycle platform for an externally-developed product (initially Example). It will deterministically **build** the product from a tag, **verify** through a tiered pipeline (test VM → test Docker → tagged release → demo deploy), **deploy** to test or demo surfaces, **roll back** atomically, and **health-check** every component, with the LLM removed from the load-bearing path.

Architecturally, signalman becomes a **control plane + runner** product, modeled on GitHub Actions (control plane ↔ runner). The control plane owns the release catalog, deployment ledger, scenario library, artifact metadata, audit log, and tenant model, behind a REST API. Runners are stateless executors that talk HTTP to the control plane and gRPC/mTLS to the existing privileged host service ([service/](../../service/)). All storage is pluggable (SQLite | Postgres for relational, local FS | S3 for blobs); multi-tenant is baked in from day one (every entity carries `org_id`); single-tenant deployments pin to a default org. Three deployment shapes are supported: **local** (single binary, in-process control plane, on-laptop dev loop), **self-hosted** (separately-deployed control plane, registered runners), **hosted commercial** (multi-tenant SaaS with free tier and dashboard).

The `signalman.build.yaml` contract checked into the *product* repo (Example) declares how to build each component; signalman clones the product repo at a tag, executes the declared steps, captures artifacts into the catalog, and records a signed manifest. From then on, deploys, rollbacks, and health checks operate on catalog entries, not on a working tree.

---

## 1. Goals and non-goals

### Goals (v0.2 MVP)

1. **Deterministic whole-stack build** for a given Example revision. Catches the "forgot to build the dashboard" / "shipped stale driver" failure class by making artifact production declarative and verified.
2. **Tiered verification** with explicit gates: local 4-lens (in product repo) → test VM smoke + torture → test Docker E2E → tag → demo deploy.
3. **Atomic deploy and rollback** of an entire release onto a target VM (test or demo).
4. **Per-component health probes** with a uniform interface (agent service, driver minifilter, backend `/health`, dashboard SPA load, NMH pipe, browser extension).
5. **LLM skills** so future Claude/Codex sessions invoke the above without re-reading the CLI surface.
6. **Storage that scales from local laptop to commercial multi-tenant** without a rewrite.

### Non-goals (v0.2 MVP)

- Web dashboard UI. (v0.4+.)
- OAuth / session auth. Bearer-token API keys only. (v0.4+.)
- Real multi-tenant operations (org switching, RBAC, billing). The schema supports it; the surface does not yet expose it.
- Auto-promotion pipelines (tag → tier → tier with approval gates). (v0.5+.)
- Webhooks / external notifications. (v0.5+.)
- Replacing the existing scenario verbs. They survive and migrate behind the control-plane shim.

---

## 2. Operating model context

This system implements the **release operating model** captured in operator memory `feedback_release_operating_model.md` (2026-05-10):

- **Local loop**: build + tests + 4-lens audits as the inner loop, in the product repo.
- **Test surface (disposable)**: Win11_test VM + test Docker stack. Smoke, torture, E2E. Checkpoint/revert/disrupt freely.
- **Demo surface (clean)**: Win11_demo VM + future standalone demo Docker stack. Only deployed at minor-version tag boundaries, only after the full release's tests pass. Each minor-version tag = one demo deploy.
- **Rollback**: every tag must be rapidly revertible. Signalman builds, tests, deploys, rolls back from any tag.

The meta build system is what *operates* this model — the gates, the catalog, the deploy/rollback execution, the health verification.

---

## 3. Architecture

### 3.1 Layers

```
+---------------------------------------------------------------+
|  Operator surface                                             |
|  - signalman CLI (existing) + new release/health verbs        |
|  - Web dashboard (v0.4+)                                      |
|  - LLM skills                                                 |
+---------------------------------+-----------------------------+
                                  | HTTP (bearer token)
+---------------------------------v-----------------------------+
|  Control plane (TypeScript web service, new)                  |
|  - REST API                                                   |
|  - Release catalog, deployment ledger, scenario index,        |
|    artifact metadata, audit log, tenant/auth                  |
|  - StorageDriver (SQLite | Postgres), BlobDriver (FS | S3)    |
+---------------------------------+-----------------------------+
                                  | HTTP (job poll / report)
+---------------------------------v-----------------------------+
|  Runner (TypeScript, evolved from host/, stateless)           |
|  - Executes scenarios, builds, deploys, health probes         |
|  - Reports envelope events back to control plane              |
+----------------+--------------------------+-------------------+
                 | gRPC/mTLS                | scenario engine
+----------------v---------+   +------------v----------------+
| Host service             |   | Guest agent (existing)      |
| (Rust, service/, exists) |   | (Rust, guest/, exists)      |
| Privileged Hyper-V ops   |   | In-VM exec / file ops       |
+--------------------------+   +-----------------------------+
```

### 3.2 Three deployment shapes

| Shape | Control plane | Runner | Storage | Auth | Tenancy |
| --- | --- | --- | --- | --- | --- |
| **Local** | in-process inside CLI, or `signalman serve` on localhost | same host | SQLite + local FS blobs under `~/.signalman/` | none (loopback only) | default org pinned |
| **Self-hosted** | standalone deploy (Docker, MSI, or `signalman serve`) | one or many, registered | SQLite or Postgres + FS or S3 | bearer token | default org or operator-managed orgs |
| **Hosted (v0.4+)** | Anthropic-operated | customer-registered or hosted | Postgres + S3 | bearer token (v0.4) → OAuth (v0.4+) | full multi-tenant, free + paid tiers |

**Local mode is the laptop dev loop** — same binary, runs everything in-process, zero config. This is the path the Example operator uses today.

### 3.3 Boundaries

- **Control plane is the source of truth** for catalog and ledger state. Runners are stateless caches at most.
- **Runners are the only thing that touches the host service**, the guest agent, or the product repo working tree. The control plane never shells out to Hyper-V or git.
- **The host service ([service/](../../service/)) is unchanged.** It already brokers privileged Hyper-V ops via mTLS gRPC. Runners call it as before.
- **Artifact blobs live behind a BlobDriver.** Control plane stores metadata (sha256, size, content-type, location URI); runners and the future dashboard pull blobs through signed URLs the control plane mints.

---

## 4. Data model

All entities carry `org_id` and `created_at` / `updated_at`. IDs are ULID strings. Soft delete via `deleted_at`.

### 4.1 Core entities

| Entity | Purpose | Key fields |
| --- | --- | --- |
| `org` | Tenant boundary. Default org (`org_default`) auto-created on first boot. | `id`, `name`, `tier` (free/paid) |
| `api_key` | Bearer token. Scoped to org. | `id`, `org_id`, `prefix`, `hash`, `name`, `expires_at` |
| `product` | A product signalman can build. (Initially: Example.) | `id`, `org_id`, `name`, `repo_url`, `build_yaml_path` |
| `release` | A built, immutable artifact set for a product at a revision. | `id`, `org_id`, `product_id`, `tag`, `commit_sha`, `manifest_sha256`, `signed_by`, `built_at`, `built_by_runner_id`, `status` (`building`/`ready`/`failed`) |
| `artifact` | A single blob produced by a release build (MSI, dashboard tarball, backend image ref, NMH binary, extension zip). | `id`, `release_id`, `component`, `kind` (`blob`/`image_ref`), `sha256`, `size_bytes`, `blob_uri`, `image_ref` |
| `target` | A deployable surface (a VM, a Docker stack). | `id`, `org_id`, `name`, `kind` (`vm_test`/`vm_demo`/`docker_test`/`docker_demo`), `connection` (JSON: backend, vm_name, host) |
| `deployment` | An attempt (or success) to put a `release` on a `target`. | `id`, `org_id`, `release_id`, `target_id`, `status` (`pending`/`deploying`/`active`/`failed`/`superseded`/`rolled_back`), `started_at`, `completed_at`, `previous_deployment_id`, `health_summary` |
| `health_check` | A probe result. | `id`, `deployment_id`, `probe_name`, `status`, `latency_ms`, `detail`, `checked_at` |
| `scenario` | Indexed scenario metadata. Body stays on disk in local mode; persisted in DB for hosted. | `id`, `org_id`, `path`, `scenario_hash`, `name`, `tags`, `source` (`disk`/`db`/`gitops`) |
| `run` | A scenario execution. (Existing concept; promoted into the catalog.) | `id`, `org_id`, `scenario_id`, `target_id`, `triggered_by` (`cli`/`api`/`deployment`/`schedule`), `envelope_blob_uri`, `result`, `started_at`, `completed_at` |
| `audit_log` | Append-only operator action log. | `id`, `org_id`, `actor`, `action`, `entity_type`, `entity_id`, `detail`, `at` |

### 4.2 Release ↔ deployment lifecycle

```
build → release(status=ready, manifest signed)
                   |
                   v
deploy → deployment(status=deploying) → health checks → deployment(status=active)
                                                              |
                                       new deployment to same target → previous becomes superseded
                                                              |
                                       rollback verb → re-deploy previous-active release → deployment(status=active),
                                                                                            old becomes rolled_back
```

A `target` has at most one `deployment.status='active'` at a time. Atomicity is enforced by the control plane via a unique partial index `(target_id) WHERE status='active'`. Rollback finds the most recent `superseded` deployment for the target and creates a new deployment from its `release_id`.

---

## 5. Storage

### 5.1 Drivers

```ts
interface StorageDriver {
  // Relational
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: StorageDriver) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
}

interface BlobDriver {
  put(key: string, body: Buffer | NodeJS.ReadableStream): Promise<{uri: string; sha256: string; size: number}>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
```

Implementations:

- **SQLite** (built-in `node:sqlite`, stable as of Node 22.5) — default for local and self-hosted-small. Migrations are hand-written, Postgres-portable SQL files in `host/src/control-plane/storage/migrations/` applied by a small in-tree runner (Drizzle/Prisma were considered but the ORM cost wasn't worth it at v0.2 schema size). `package.json` engines pin Node ≥22.5.
- **Postgres** (`pg`, same migration files ported where SQLite/PG diverge) — self-hosted-large and hosted. v0.3.
- **Local FS blob** — files under `${SIGNALMAN_DATA_DIR}/blobs/${org_id}/${sha256[0:2]}/${sha256}`.
- **S3-compatible blob** — bucket per environment, keyed `${org_id}/${sha256[0:2]}/${sha256}`.

Selected at boot from `signalman.config.yaml`:

```yaml
storage:
  relational:
    driver: sqlite       # or: postgres
    url: ~/.signalman/signalman.db
  blobs:
    driver: local        # or: s3
    root: ~/.signalman/blobs
```

### 5.2 Multi-tenant scoping

Every query on the control plane carries an `org_id` derived from the bearer token (or the default org in local mode). The data layer enforces the scope; no API endpoint takes `org_id` as a request parameter. This is the standard "tenant in the auth context, not the request" pattern; cheap to ship correctly from day one, expensive to retrofit.

### 5.3 Three release-form configurations

These are the tiers from question 2 in the design conversation. Each maps onto a storage configuration; all three are supported simultaneously, selected per-product or per-org via config.

| Tier | When | Manifest | Artifacts | Configuration |
| --- | --- | --- | --- | --- |
| **Local cache** | laptop dev | DB row only | local FS blobs | `signing.required: false`, `blobs.driver: local` |
| **Signed manifest** | CI / staging | DB row + signed manifest blob | local FS or S3 | `signing.required: true`, `signing.key: <path>` |
| **Per-tag artifact directory** | production CD | DB row + signed manifest + per-tag prefix in blob store | S3 with structured prefix | additionally exports a `releases/<product>/<tag>/` directory tree on demand for offline rollback |

---

## 6. Build orchestration

### 6.1 The product-repo build contract

The Example repo declares its build to signalman via a checked-in file (path declared on the `product` row, default `signalman.build.yaml`). Signalman never inspects product source beyond this file.

```yaml
# Example repo: signalman.build.yaml
schema_version: 1
components:
  - name: agent_service
    build:
      cwd: agent
      command: cargo
      args: [build, --release]
    artifacts:
      - kind: blob
        path: agent/target/release/example-agent.exe
  - name: driver_msi
    build:
      cwd: installer
      command: pwsh
      args: [-File, Build-Msi.ps1]
    artifacts:
      - kind: blob
        path: installer/dist/example-driver.msi
  - name: dashboard
    build:
      cwd: dashboard
      command: npm
      args: [run, build]
    artifacts:
      - kind: blob
        path: dashboard/dist.tar.gz
        produce: tar -czf dashboard/dist.tar.gz -C dashboard dist
  - name: backend
    build:
      cwd: backend
      command: docker
      args: [build, -t, "example-backend:${TAG}", .]
    artifacts:
      - kind: image_ref
        ref: "example-backend:${TAG}"
  # …nmh, extension, etc.
verification:
  smoke:    [example-v2-network-egress, example-agent-service]
  torture:  [example-v2-network-torture]
  e2e:      [example-v2-registry-deny, silo-validation]
```

The schema is intentionally narrow: a list of components, each with a build invocation and the artifacts it produces. Signalman validates that every declared artifact exists post-build (the explicit fix for the "forgot the dashboard" failure class). Components run in declaration order; parallelism comes later.

The `verification` block names scenarios (existing) that signalman will run at each tier.

### 6.2 Build execution

```
signalman release build --product example --tag v1.4.0
  ↓
control plane: insert release(status=building, tag=v1.4.0)
  ↓
runner: clone product repo at tag → temp dir
  ↓
runner: parse signalman.build.yaml
  ↓
runner: for each component → execute build → verify artifact exists → upload blob → record artifact row
  ↓
runner: assemble manifest → optionally sign → upload → control plane: release(status=ready, manifest_sha256=…)
```

Build is idempotent on `(product_id, commit_sha, manifest_canonical)`: rebuilding the same revision produces a release that compares equal modulo `built_at`. We do **not** require byte-identical reproducibility (toolchain non-determinism would block us); we require **manifest equivalence**: same component list, same artifact sha256 set. If a rebuild produces different sha256s, that's a real change and gets a new release row.

---

## 7. Verification, deploy, rollback

### 7.1 Tiered verification

```
build → tier:test_vm → tier:test_docker → tier:tagged → deploy:demo
        smoke+torture   E2E                gate           manual or scheduled
```

Each tier is a set of scenario IDs from the build manifest's `verification` block. A tier passes when every scenario produces a `pass` envelope. Tier failures block promotion; the operator sees the first failing scenario and its envelope.

`signalman release verify --release <id> --tier {smoke|torture|e2e|all}` runs a tier against the test VM (smoke, torture) or test Docker stack (e2e). Health probes (§8) run as a final gate.

### 7.2 Deploy

```
signalman release deploy --release <id> --target win11_demo
  ↓
control plane: validate release.status=ready, target.kind matches
  ↓
control plane: insert deployment(status=deploying, previous_deployment_id=<current active>)
  ↓
runner: pull artifacts → push to target VM via host service + guest agent →
        install MSI → load driver → start backend container → load dashboard →
        register NMH → install extension
  ↓
runner: run health probes (§8)
  ↓
control plane: deployment(status=active); previous → superseded
```

Atomicity model: the deploy is staged on the target before becoming `active`. A staging slot (e.g., a checkpoint, or a parallel install location) is created; on health-pass it's promoted; on health-fail it's discarded and the previous deployment remains active. Exact staging mechanism is per-target-kind (Hyper-V checkpoints for VM targets are the obvious lever).

### 7.3 Rollback

```
signalman release rollback --target win11_demo
  ↓
control plane: find target's most recent superseded deployment
  ↓
runner: re-execute deploy of that release on the target
  ↓
control plane: new deployment(status=active); current active → rolled_back
```

Rollback is "deploy the previous release," not "undo the deploy." This keeps the model uniform — every state the system can reach is reachable via a deploy. A `--release <id>` flag allows rolling back to an arbitrary prior release, not just the immediate predecessor.

---

## 8. Health probes

A probe is a named, callable function that returns `{status: pass|fail|degraded, latency_ms, detail}`. Probes live in the runner (they need to talk to the host service / guest / target VM) and are registered by name in a probe registry.

Initial probes (one per known component):

| Probe | What it checks |
| --- | --- |
| `agent_service` | Service is running, responsive on its named pipe |
| `driver_minifilter` | `fltmc filters` lists the Example minifilter |
| `backend_health` | HTTP GET `/health` returns 200 |
| `dashboard_load` | SPA bundle loads, returns expected app shell |
| `nmh_pipe` | NMH host responds on its pipe |
| `browser_extension` | Extension manifest present, version matches |

Verbs:

- `signalman health check --target <id> [--probe NAME]...` — run probes, default all.
- `signalman health history --target <id> [--since DURATION]` — query past results.

Probe results are written to `health_check` rows linked to the active deployment.

---

## 9. CLI / MCP surface additions

Existing verbs (`list`, `describe`, `plan`, `run`, `record`, `status`, `init`, `vm`) are unchanged in shape; their execution path migrates to "call the control plane, which executes via runner." In local mode this is in-process and the change is invisible.

### 9.1 New verbs

```
signalman release build      --product P --tag T
signalman release list       [--product P] [--status S]
signalman release show       <release_id>
signalman release verify     --release R --tier {smoke|torture|e2e|all}
signalman release deploy     --release R --target T
signalman release rollback   --target T [--release R]
signalman release promote    --release R   # mark as ready-for-demo (gate flag)

signalman health check       --target T [--probe N]...
signalman health history     --target T [--since D]

signalman target list
signalman target add         --name N --kind K --connection FILE
signalman target remove      --name N

signalman product list
signalman product add        --name N --repo URL [--build-yaml PATH]

signalman serve              [--port P]   # start the control plane (used by self-hosted)
signalman runner register    --control-plane URL --token TOKEN   # register this host as a runner
```

### 9.2 MCP additions

Each new verb gets an MCP tool (`signalman_release_build`, etc.), following the existing convention from [docs/design/p0-mcp-surface.md](p0-mcp-surface.md). Bulk verbs (`release list`, `target list`) go under `signalman.advanced.*` to match the existing surface-inversion principle.

### 9.3 Run modes

The two run modes are config:

```yaml
run_mode: local   # CLI executes locally, reports to control plane (laptop)
# or:
run_mode: submit  # CLI submits a job; a runner picks it up (CI, hosted)
```

In `local` mode, the CLI doubles as a runner. In `submit` mode, the CLI is a thin client and a separately-deployed runner does the work.

---

## 10. Auth (MVP)

- API keys are created via `signalman api-key create --name N`. Display once, hash stored.
- Bearer token in `Authorization: Bearer sk_…` header; loopback in local mode bypasses auth.
- One key = one org scope. Scopes (read-only, full) deferred.
- OAuth, sessions, and the dashboard land in v0.4+.

---

## 11. LLM skills

Each major flow ships with a skill in `~/.claude/skills/` (or the equivalent for Codex):

- `signalman-build-from-tag` — invoke `release build`, surface failures, summarize.
- `signalman-deploy-to-test` — pick a release, run smoke + torture, deploy to test VM, report.
- `signalman-deploy-to-demo` — gate-check, deploy to demo VM, run health probes, report.
- `signalman-rollback` — find prior deployment, redeploy, verify health.
- `signalman-health-check` — run probes, summarize failures.

Each skill is short — it tells the LLM the verb, the expected envelope shape, and the failure modes worth surfacing.

---

## 12. Phasing

### v0.2.0 — MVP (local mode)

Scope: single binary on a laptop, in-process control plane, SQLite, local FS blobs, default org. Enough to replace the current LLM-driven build/deploy of Example.

- Control plane skeleton (in-process), Drizzle schema, SQLite migrations
- `BlobDriver` interface + local FS impl
- `signalman.build.yaml` parser + validator
- `release build` with artifact verification
- `release list`, `release show`
- `target add`, `target list`
- `release deploy` for VM targets (Hyper-V via existing host service)
- `release rollback`
- Health probe registry + initial six probes
- `health check`, `health history`
- LLM skills for build / deploy / rollback / health
- Migration of existing scenario verbs to control-plane shim (in-process)

### v0.3.0 — self-hosted

Scope: control plane separable as a deployable service; runners register over HTTP; bearer-token auth; Postgres tested; S3 blob driver.

- `signalman serve` standalone
- HTTP API surface + bearer-token auth
- `signalman runner register` + runner job-poll loop
- Postgres `StorageDriver` (same migrations)
- S3 `BlobDriver`
- Multi-runner job dispatch
- Audit log surface
- Manifest signing (sigstore or minisign)

### v0.4.0 — hosted commercial

Scope: SaaS instance, free + paid tiers, dashboard, OAuth.

- Multi-tenant operations (org switching, RBAC)
- Web dashboard (Next.js or similar)
- OAuth + session auth
- Billing hooks
- Tier enforcement (free vs paid quotas)

### v0.5.0+ — auto-promote, webhooks, scheduling

- Auto-promotion pipelines (build → tier → tier with approval)
- Approval workflows
- Webhooks / Slack / email notifications
- Scheduled health checks
- Cross-product release coordination

---

## 13. Open questions

1. **Where does the release catalog live in the *Example* operator's mental model?** Specifically: should annotated git tags in the Example repo carry the manifest sha256 (so the tag itself is auditable), or is the catalog purely signalman-side? Defaulting to signalman-side for now; tag annotation is a v0.3 feature.
2. **Staging mechanism per target kind.** For Hyper-V VM targets, checkpoints are the obvious lever for atomic deploy. For future Docker/k8s targets the answer is different. v0.2 only needs Hyper-V.
3. **Manifest signing key management.** Who holds the key? For hosted, we hold it. For self-hosted, the operator. v0.2 ships unsigned; v0.3 adds signing.
4. **Build caching and parallelism.** The schema doesn't prevent parallel builds, but v0.2 runs components serially. Component-level cache keys (sha256 of inputs) are deferred.
5. **Per-org product limits.** Free tier almost certainly has a cap on products / releases / runners. Schema supports it; enforcement deferred to v0.4.
6. **Migration of existing in-disk scenario state.** Today's `.signalman/recordings/<id>/last-run.json` etc. need to either move into the DB or be indexed by it. Tactical migration plan deferred to v0.2 implementation.
7. **GitOps sync for scenarios.** Scenario library option (b) — sync from a tenant's source repo — has UX implications (which branch? which path? webhook?). Defer to v0.4.

---

## 14. Glossary

- **Product** — an external codebase signalman builds, tests, and deploys (initially Example).
- **Release** — an immutable artifact set built from a product at a specific revision, identified by tag.
- **Target** — a deployable surface (a VM, a Docker stack).
- **Deployment** — an instance of a release on a target, with status and health.
- **Tier** — a verification level (smoke, torture, e2e). Tiers gate promotion.
- **Probe** — a named, callable health check on a single component.
- **Runner** — the executor process. Stateless. Talks to control plane and host service.
- **Control plane** — the stateful TypeScript web service. Owns the catalog and ledger.
- **Manifest** — the signed declaration of a release's contents (component list, artifact sha256s).
