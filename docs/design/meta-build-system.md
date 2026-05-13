# Meta Build System — Design

**Status**: v0.2.0 + v0.3.0 implemented (PRs 1–10e on branch
`intelligent-carson-a92b80`); v0.4.0+ scope (auto-promotion,
webhooks, scheduling) is design-only.
**Target**: v0.2.0 (MVP, local mode, **shipped**); v0.3.0 (self-hosted,
**shipped**); v0.4.0+ (post-self-hosted iteration, **future**).
**Author**: 2026-05-10 design pass; v0.2/v0.3 implementation 2026-05-11.

**Locks down**: Architecture, storage interface, release-catalog shape, CLI/MCP
surface additions, phasing.

> **Implementation note (2026-05-11):** what was design-only in the original
> draft is now code. v0.2.0 ships the local in-process control plane
> (`host/src/control-plane/`), the release-catalog schema with SQLite
> storage and local-FS blobs, and the `release build / list / show / deploy
> / rollback / health` verbs. v0.3.0 ships the HTTP control plane
> (`signalman serve`, `host/src/http/`), Bearer-token API keys
> (`host/src/http/auth.ts`), the job queue + remote runners
> (`host/src/runner/`, `host/src/control-plane/storage/migrations/0003_jobs.sql`),
> the Postgres storage driver (`host/src/control-plane/storage/postgres.ts`,
> `docs/postgres-driver.md`), Ed25519 manifest signing
> (`host/src/control-plane/build/signing.ts`), and the S3 blob driver
> (`host/src/control-plane/blobs/s3.ts`). Sections below should be read as
> the design intent; consult the code for the implemented contract.

## TL;DR

Signalman is being expanded from a scenario runner into a full release-lifecycle platform for an externally-developed product. It will deterministically **build** the product from a tag, **verify** through a tiered pipeline (test VM → test Docker → tagged release → demo deploy), **deploy** to test or demo surfaces, **roll back** atomically, and **health-check** every component, with the LLM removed from the load-bearing path.

Architecturally, signalman becomes a **control plane + runner** product, modeled on GitHub Actions (control plane ↔ runner). The control plane owns the release catalog, deployment ledger, scenario library, artifact metadata, audit log, and tenant model, behind a REST API. Runners are stateless executors that talk HTTP to the control plane and gRPC/mTLS to the existing privileged host service ([service/](../../service/)). All storage is pluggable (SQLite | Postgres for relational, local FS | S3 for blobs); multi-tenant is baked in from day one (every entity carries `org_id`); single-tenant deployments pin to a default org. Two deployment shapes are supported: **local** (single binary, in-process control plane, on-laptop dev loop) and **self-hosted** (separately-deployed control plane, registered runners).

The `signalman.build.yaml` contract checked into the *product* repo declares how to build each component; signalman clones the product repo at a tag, executes the declared steps, captures artifacts into the catalog, and records a signed manifest. From then on, deploys, rollbacks, and health checks operate on catalog entries, not on a working tree.

---

## 1. Goals and non-goals

### Goals (v0.2 MVP)

1. **Deterministic whole-stack build** for a given product revision. Catches the "forgot to build the dashboard" / "shipped stale driver" failure class by making artifact production declarative and verified.
2. **Tiered verification** with explicit gates: local 4-lens (in product repo) → test VM smoke + torture → test Docker E2E → tag → demo deploy.
3. **Atomic deploy and rollback** of an entire release onto a target VM (test or demo).
4. **Per-component health probes** with a uniform interface (agent service, driver minifilter, backend `/health`, dashboard SPA load, NMH pipe, browser extension).
5. **LLM skills** so future Claude/Codex sessions invoke the above without re-reading the CLI surface.
6. **Storage that scales from a local laptop to a multi-tenant self-hosted fleet** without a rewrite.

### Non-goals (v0.2 MVP)

- Auto-promotion pipelines (tag → tier → tier with approval gates). (v0.4+.)
- Webhooks / external notifications. (v0.4+.)
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

### 3.2 Two deployment shapes

| Shape | Control plane | Runner | Storage | Auth | Tenancy |
| --- | --- | --- | --- | --- | --- |
| **Local** | in-process inside CLI, or `signalman serve` on localhost | same host | SQLite + local FS blobs under `~/.signalman/` | none (loopback only) | default org pinned |
| **Self-hosted** | standalone deploy (Docker, MSI, or `signalman serve`) | one or many, registered | SQLite or Postgres + FS or S3 | bearer token | default org or operator-managed orgs |

**Local mode is the laptop dev loop** — same binary, runs everything in-process, zero config. This is the path operators use today.

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
| `product` | A product signalman can build. | `id`, `org_id`, `name`, `repo_url`, `build_yaml_path` |
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

The product repo declares its build to signalman via a checked-in file (path declared on the `product` row, default `signalman.build.yaml`). Signalman never inspects product source beyond this file.

```yaml
# Product repo: signalman.build.yaml
schema_version: 1
components:
  - name: agent_service
    build:
      cwd: agent
      command: cargo
      args: [build, --release]
    artifacts:
      - kind: blob
        path: agent/target/release/myagent.exe
  - name: driver_msi
    build:
      cwd: installer
      command: pwsh
      args: [-File, Build-Msi.ps1]
    artifacts:
      - kind: blob
        path: installer/dist/driver.msi
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
      args: [build, -t, "myapp-backend:${TAG}", .]
    artifacts:
      - kind: image_ref
        ref: "myapp-backend:${TAG}"
  # …nmh, extension, etc.
verification:
  smoke:    [example-v2-network-egress, example-agent-service]
  torture:  [example-v2-network-torture]
  e2e:      [example-v2-registry-deny, example-e2e-full-stack]
```

The schema is intentionally narrow: a list of components, each with a build invocation and the artifacts it produces. Signalman validates that every declared artifact exists post-build (the explicit fix for the "forgot the dashboard" failure class). Components run in declaration order; parallelism comes later.

The `verification` block names scenarios (existing) that signalman will run at each tier.

### 6.2 Build execution

```
signalman release build --product myapp --tag v1.4.0
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
| `driver_minifilter` | `fltmc filters` lists the product's minifilter |
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

### v0.2.0 — local + self-hosted meta build system **[SHIPPED 2026-05-12]**

First formally versioned release. Bundles the originally-scoped
v0.2.0 (local in-process) and v0.3.0 (networked control plane)
into one tag since they were developed in lockstep on the same
branch.

Local in-process meta build system:

- Control plane skeleton (in-process), schema, SQLite migrations
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

Networked control plane:

- ✅ `signalman serve` standalone (`host/src/http/index.ts`, `cli.ts cmdServe`)
- ✅ HTTP API surface + bearer-token auth (`host/src/http/app.ts`, `auth.ts`)
- ✅ `signalman runner register` + runner job-poll loop (`host/src/runner/`)
- ✅ Postgres `StorageDriver` (same migrations) (`host/src/control-plane/storage/postgres.ts`)
- ✅ S3 `BlobDriver` (`host/src/control-plane/blobs/s3.ts`)
- ✅ Multi-runner job dispatch (atomic claim via `SELECT FOR UPDATE SKIP LOCKED` on PG; `BEGIN IMMEDIATE` + `UPDATE … WHERE … LIMIT 1` on SQLite)
- ✅ Audit log surface (`POST /v1/audit`, `GET /v1/audit`)
- ✅ Manifest signing — Ed25519 via Node's built-in `crypto` (`host/src/control-plane/build/signing.ts`); `signalman key generate/fingerprint` + `release verify`

### v0.3.0 — cloud provider support + Kubernetes + image pipeline

Scope: expand the substrate. Ship cloud-provider hypervisor
backends, deploy-target drivers (OpenTofu + Kubernetes manifests),
cloud runners, pipeline-built golden images, and cost guardrails.
Also lands the four originally-scoped v0.3.0 epics
(Record/Replay, Ephemeral VMs, Hermetic Envelope, Explicit
Orchestrator) — see `ROADMAP.md`.

Cloud provider work is the substantive new design surface;
see §13 (Cloud provider support) for the full design.
Kubernetes work is §14. Artifact registry as a separate OSS
product line lands in v0.4.0+ — see §15.

### v0.4.0+ — auto-promote, webhooks, scheduling, artifact registry

- Auto-promotion pipelines (build → tier → tier with approval)
- Approval workflows
- Webhooks / Slack / email notifications
- Scheduled health checks
- Cross-product release coordination
- Artifact registry as a separate OSS product (§15)

---

## 13. Cloud provider support (v0.3.0)

Expand the platform's substrate so scenarios run, deploys land,
and runners execute against major cloud providers — not just local
hypervisors. v0.3.0 ships **AWS** and **Azure**; both **Windows
and Linux** are first-class.

### 13.1 The workload split

Cloud provider support is three distinct workloads with very
different optimal tooling. The single biggest architectural
decision is to acknowledge that split rather than force them
through a single abstraction.

| Workload | Lifetime | Tool | Why |
|---|---|---|---|
| **Ephemeral test VM** (hypervisor backend) | minutes to hours; one job per VM, destroy after | Direct SDK (`@aws-sdk/client-ec2`, `@azure/arm-compute`) | Speed and minimal overhead matter; no need for declarative state on a single ephemeral resource |
| **Cloud runner** (registered worker) | days to weeks; warm pool, reused | Direct SDK | Persistent but simple lifecycle; SDK call to provision/destroy + the runner registers via standard registration |
| **Cloud deploy target** (staging / demo / prod environment) | indefinite; evolves over time | OpenTofu via subprocess | Declarative model, state file, drift detection, dependency ordering between resources (VPC → subnet → EC2 → ALB → cert → DNS) |

The ephemeral and runner paths share one set of code (`host/src/hypervisors/{aws-ec2,azure-vm}.ts`); the deploy-target
path is a new pluggable driver layer alongside the existing
docker-compose driver.

### 13.2 New target kinds

The `Target.kind` enum gains:

- `cloud_vm_test` / `cloud_vm_demo` — single VM, direct SDK provisioning. Uses the hypervisor abstraction; suitable for smoke tests on a real cloud VM.
- `cloud_stack_test` / `cloud_stack_demo` — OpenTofu-managed environment of arbitrary complexity. Target row carries `bundle_uri` pointing at the HCL bundle.
- `k8s_test` / `k8s_demo` — Kubernetes-managed deploy (see §14).

The existing `vm_test`/`vm_demo`/`docker_test`/`docker_demo` kinds
continue to work unchanged.

### 13.3 OpenTofu as the deploy-target driver

OpenTofu (MPL-2.0, Linux Foundation governance, fork of Terraform
1.5.x) is the IaC subprocess we ship behind. Reasons:

- The provider ecosystem (AWS, Azure, k8s, …) is already MPL-2.0 and shared with OpenTofu out of the box.
- Subprocess-only integration: no Go-library imports, no source bundling. Pure "use" of MPL-2.0 software — zero copyleft trigger. (Compare with Terraform 1.6+, which is BSL and would block SaaS embedding.)
- The HCL we generate and the bundles we ship are our work; we license them under Apache-2.0 to match the rest of `host/`.
- Pulumi remains a viable alternate driver; we make the driver layer pluggable so a `pulumi` driver can land later if customer demand emerges.

#### State management

For self-hosted, OpenTofu state lives in **S3 + DynamoDB lock**:
- State URI: `s3://<configured-bucket>/<org_id>/<target_id>/terraform.tfstate`
- Lock table: a DynamoDB table the operator pre-provisions, or one we create on first use.
- This mirrors the blob-driver pattern (S3 already required for self-hosted).

For local-mode, OpenTofu state lives in `~/.signalman/tf-state/<target-id>/`. Single-operator, single-machine — no need for remote state coordination.

Signalman does **not** proxy or wrap OpenTofu state; OpenTofu owns its own state-storage protocol and we let it.

#### HCL starter library

In-tree directory `host/src/control-plane/deploy/tofu-bundles/`
ships vetted bundles for common cases:

- `aws-simple-vm` — single EC2 instance + security group + key pair
- `aws-three-tier` — VPC + ALB + EC2 + RDS + IAM role
- `aws-eks-cluster` — managed Kubernetes (EKS) with worker node group
- `azure-windows-vm` — Windows VM with Bastion + WinRM
- `azure-linux-vm` — Linux VM with public IP + SSH
- `azure-aks-cluster` — managed Kubernetes (AKS)

Operators can also bring their own HCL directory; `Target.bundle_uri` points at either an in-tree starter or an operator-authored bundle (local path, S3 URI, or `git+https://...`).

Bundles ship under **Apache-2.0**, same as the rest of the host
package. License compatibility with OpenTofu's MPL-2.0 runtime is
unaffected — we license the data we produce, OpenTofu licenses its
runtime, no overlap.

### 13.4 Cloud hypervisor backends

`host/src/hypervisors/aws-ec2.ts` and `host/src/hypervisors/azure-vm.ts`
implement the existing `Hypervisor` interface. Operations:

- `provision(template, options)` — `RunInstances` (AWS) / VM
  creation (Azure) with the template's image ID, instance type,
  network config. Tags include `signalman.org_id`, `signalman.run_id`, `signalman.ttl_expires_at`.
- `start(handle)` / `stop(handle)` — `StartInstances` /
  `StopInstances` (cloud-equivalents).
- `destroy(handle)` — `TerminateInstances` / VM delete.
- `get_address(handle)` — returns the public or private IP plus
  the auth material the guest agent needs (see §13.7).

Cloud-specific knobs that hang off `Target.connection`:

- `region`
- `vpc_id` / `subnet_id` (AWS) or `virtual_network_id` /
  `subnet_id` (Azure)
- `instance_type` / `vm_size`
- `image_id` — AMI (AWS) or managed-image ID (Azure)
- `iam_role` / `managed_identity` — what the VM runs as

### 13.5 Cost guardrails (must-have)

The first cloud-provider bug-report on a public repo will be "I
forgot to clean up and got a $400 bill" unless we ship guardrails
in v0.3.0. Three controls, all must-have:

1. **Wall-clock TTL on ephemeral VMs.** Default 1h, configurable
   per-scenario via `setup.yaml` (`ttl_seconds: <int>`). A
   background reaper job (runs every 5 minutes) destroys any
   tagged VM whose `ttl_expires_at` is in the past.
2. **Per-org cloud-spend budget.** Soft warning at 80%, hard
   refusal-to-spawn at 100%. Budget configured per-org; usage
   tracked in `cloud.org_cloud_usage` (Postgres rows, joinable
   with audit log). Counter increments on `provision` from cost
   estimates derived from instance type + region + duration.
3. **Pre-flight cost estimate on `release deploy`.** When the
   target is `cloud_stack_*`, `signalman release deploy` runs
   `tofu plan` first, extracts the cost-affecting resource
   diffs, and surfaces "Deploying this target costs ~$84/month
   at AWS list prices. Continue? [y/N]" (or `--no-confirm` to
   bypass for CI).

Quota counters live in Postgres (existing `@signalman/host`
schema). Redis is unnecessary at v0.3.0 scale.

### 13.6 Networking — guest-agent reachability

How does the control plane reach the guest agent running on a
cloud VM?

v0.3.0 default: **public IP + mTLS**. Cloud VM gets a public IP
(or NAT-fronted equivalent); security group restricts inbound to
the gRPC port from the control-plane host's IP; the guest agent
authenticates the caller via mutual TLS using the operator's
cert bundle.

v0.3.x followups for stricter security:
- **AWS SSM Session Manager** — zero public surface; gRPC tunneled through SSM. Requires SSM agent in the AMI.
- **Azure Bastion** — equivalent for Azure VMs.

The choice is per-target via `Target.connection.network_mode`:
`"public_mtls"` (default), `"aws_ssm"`, `"azure_bastion"`.

### 13.7 Credentials — layered model

Cloud credentials follow a layered model:

1. **Per-org defaults**, stored encrypted in the control-plane
   DB. Encrypted with an org-scoped key derived from the
   operator's KMS root (operator chooses KMS provider:
   `aws-kms`, `azure-key-vault`, `age-encrypted-file`).
2. **Per-target overrides** — a `Target` row can carry its own
   credential reference, overriding the org default.
3. **Per-runtime overrides** — `signalman release deploy
   --aws-profile staging` or `--azure-credentials path/to/sp.json`
   overrides both, for one operation.

The control plane never logs credentials and never returns them
on read endpoints. They flow into OpenTofu runs as env vars and
into SDK clients as the AWS/Azure SDK's default credential chain.

### 13.8 Pipeline-built golden images

Test VMs need *images*, not just VMs. Cloud equivalents of the
existing VHDX templates need to be built, stamped with a version,
and registered as known artifacts.

Approach: **build all template flavors (VHDX + AMI + Azure
managed image) in lockstep** from a single Packer manifest. Each
build run produces:

- A VHDX for Hyper-V testing
- An AMI in each AWS region we support
- An Azure managed image in each Azure region
- A manifest record describing all three, signed with the
  release-signing key, stored in the configured artifact catalog
  location (S3 for self-hosted, local FS for local-mode)

The build pipeline lives **in-tree** under `golden-images/`,
runs in CI (with credentials for AWS + Azure release accounts),
and emits the manifest into the same blob store as release
artifacts. Images are versioned (e.g. `win11-test@2026.04.0`)
and addressable by version + cloud + region.

`Target.connection.image_id` accepts either a raw cloud-vendor
ID (AMI / Azure managed image ID) or a versioned reference
(`win11-test@2026.04.0` — control plane resolves to the right
cloud-vendor ID at deploy time).

### 13.9 The `vm_lineage_hash` (hermetic envelope)

The hermetic envelope (v0.3.0 — see ROADMAP) needs a
content-addressed identity for the VM lineage that the scenario
ran against. Cloud-vendor image IDs (AMIs, managed images) are
*not* directly comparable to VHDX content hashes. The lineage
needs to abstract over the cloud.

`vm_lineage_hash` is the sha256 of a canonical JSON object:

```json
{
  "template_name": "win11-test",
  "template_version": "2026.04.0",
  "os": "windows-11-22h2",
  "installed": [
    "signalman-guest@0.2.0",
    "powershell@7.4.0",
    "dev-toolchain@2026.04"
  ]
}
```

Two scenarios running on the same `template_name@template_version`
on AWS vs. Azure get the **same** `vm_lineage_hash` (because
they're functionally the same test environment), even though
their cloud-vendor image IDs differ. The `installed` array
captures what the manifest says ships in the image, not what's
sitting on top.

The Packer pipeline emits this manifest as the source of truth;
the hermetic-envelope code reads from it.

### 13.10 Cloud runners

Runners that live in the cloud and pick up jobs from the control
plane. Two flavors:

- **BYOR (bring-your-own-runner) on a cloud VM** — operator
  manually provisions a cloud VM, runs `signalman runner
  register`, and the runner registers with the existing
  Bearer-token flow. Already works today; cloud is just one more
  place a runner can live.
- **Cloud-native runner pool** — control plane provisions
  worker VMs via the hypervisor backend, runners auto-register
  using cloud-vendor instance identity rather than a
  pre-provisioned Bearer token.

For the cloud-native pool, **two auth flows are supported**:

1. **Bearer-derived-from-IAM** (ships first). Operator pre-provisions
   a Bearer token, attaches it to the IAM role / managed identity
   the worker VM assumes, runner fetches at boot via instance
   metadata service. Control plane sees a normal Bearer
   registration. Simpler to implement; reuses the v0.2.0 auth path.
2. **Native vendor identity** (ships second). Runner presents a
   vendor-signed token (AWS sigv4-signed request, Azure
   managed-identity JWT). Control plane verifies with the vendor
   and creates a session bound to the role. No bearer tokens to
   manage on the operator side. **Hard requirement for
   enterprise adoption** — many large-org security teams won't
   permit static Bearer tokens.

Both auth flows feed the same downstream `runner_id` —
control plane doesn't care how the runner authenticated, only
that it did. Audit log records the auth method per registration.

### 13.11 Open questions specific to cloud-provider work

- **Pulumi as alternate driver** — do we ship one in v0.3.x, or
  only on customer demand? Default: only on demand.
- **Spot / preemptible instances** for ephemeral test VMs — big
  cost savings but adds interruption-handling complexity. Defer
  to v0.3.x.
- **Multi-region deploys** — `Target.connection.region` is a
  single value today; multi-region setups need multi-region
  HCL bundles. Defer until a real consumer asks.
- **Air-gapped operation** — some customers can't reach AWS/Azure
  public endpoints. AWS GovCloud and Azure Government endpoints
  are configurable via SDK, but air-gapped (private cloud only)
  is a separate design pass. Out of scope for v0.3.0.

---

## 14. Kubernetes (v0.3.0)

Kubernetes lands as **two surfaces** in v0.3.0, both driven by
operator-authored manifests (rather than custom CRDs / operator
pattern, which lands in v0.3.x).

### 14.1 Kubernetes as a deploy target

New target kinds `k8s_test` / `k8s_demo`. The deploy driver is
`kubectl apply` (or `helm install` / `helm upgrade` if the bundle
is a Helm chart) against a manifest bundle attached to the
target.

- `Target.connection.cluster_context` — kubectl context name or
  kubeconfig path; defaults to the operator's `KUBECONFIG`.
- `Target.bundle_uri` — points at a directory of YAML manifests
  or a Helm chart (local path, S3 URI, or `git+https://...`).
- Deploy lifecycle:
  - `release deploy` → `kubectl apply -k <bundle>` (or `helm
    upgrade --install`) with `--namespace=<target.namespace>`.
  - `release rollback` → `kubectl rollout undo` / `helm rollback`.
  - Health probes already work via `kubectl get pods` /
    `kubectl wait --for=condition=ready`.

Status surface: `kubectl get -o json` parsed into the
`Deployment.status` field. Same flow as docker-compose targets.

### 14.2 Kubernetes as a runner substrate

Alternative to docker-compose for hosting scenario runners. Each
runner is a Kubernetes `Job` (one-shot) or part of a `Deployment`
(warm-pool). Operator authors the manifests; signalman documents
the contract.

Manifest pattern (operator copies + customizes):

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  generateName: signalman-runner-
spec:
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: signalman-runner
      containers:
        - name: runner
          image: ghcr.io/.../signalman-runner:0.3.0
          env:
            - name: SIGNALMAN_CONTROL_PLANE_URL
              value: https://control-plane.example.com
            - name: SIGNALMAN_RUNNER_TOKEN
              valueFrom:
                secretKeyRef: { name: signalman-runner, key: token }
            - name: SIGNALMAN_TENANT_ID
              valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
```

Cluster prerequisites:
- A `ServiceAccount` with permissions to spawn worker pods (for
  the deploy-target flow).
- A `Secret` holding the runner Bearer token.
- A namespace per tenant if multi-tenant on a shared cluster.

### 14.3 Kubernetes as a runner substrate — operator pattern (v0.3.x)

Followup work that lands after v0.3.0 manifest-driven runners
have user signal:

- Custom resources `SignalmanRunner`, `SignalmanRunnerPool`,
  `SignalmanScenarioRun`.
- Operator deployed via Helm chart.
- Operator reconciles `SignalmanRunnerPool` against current
  pending-job count from the control plane; scales pods up/down
  via standard k8s autoscaling primitives.

Deferred until we see what operators actually struggle with on
the manifest-driven path.

### 14.4 Cluster auth

K8s clusters expect either kubeconfig credentials (long-lived
client certs / OIDC tokens) or in-cluster service account
tokens. Layered model from §13.7 applies: per-org default
kubeconfig → per-target override → per-runtime override.

Inside the cluster (runner pods, deploy-target pods), service
account tokens flow naturally via the standard `automountServiceAccountToken: true` mechanism. No additional auth
plumbing needed.

### 14.5 Cross-cloud + cross-platform matrix

Scenario matrix support (a v0.4.0+ epic per `ROADMAP.md`) needs
cloud and platform as matrix dimensions, not just OS. Example:

```yaml
# scenario.matrix
matrix:
  - { cloud: aws,   region: us-east-1, os: windows-11 }
  - { cloud: aws,   region: us-west-2, os: linux-22.04 }
  - { cloud: azure, region: eastus,    os: windows-11 }
  - { cloud: azure, region: westeu,    os: linux-22.04 }
```

Each matrix entry runs as a separate scenario invocation; results
aggregate into a single matrix-level envelope. The matrix
dimensions feed the target-selection logic — entry 1 might use
`Target name=aws-win-east`, entry 2 `aws-linux-west`, etc.

This composes cleanly with cloud-provider hypervisor backends:
the `cloud` and `region` matrix dimensions resolve to a
`Target.kind=cloud_vm_test` with the right `connection.region`,
runtime-provisioned per entry.

---

## 15. Artifact registry (v0.4.0+, OSS product)

The meta-build system's content-addressed blob store (S3 +
local-FS) is the seed of a larger artifact registry product. v0.4.0+
lifts it to a **standalone OSS product** competing in the same
space as JFrog Artifactory / GitHub Packages / Sonatype Nexus.

### 15.1 Why standalone, why OSS

**Standalone (not embedded in `@signalman/host`)** because:
- It's a different scaling axis — registries handle blob reads from
  every CI run in an org, not just signalman-issued reads.
- It's a different protocol surface — OCI distribution spec,
  npm registry protocol, maven, crates.io-compatible, Helm chart
  spec. Each is a sustained engineering investment.
- It's a different deploy story — registries are typically
  fronted by CDNs, sit behind authn proxies, integrate with
  vulnerability scanners, support replication.

**Open-source** because:
- It's a **competitive wedge against the commercial-only
  registries** (JFrog, Sonatype). A free Apache-2.0 registry that
  plays well with the signalman release pipeline is a
  better-funded customer's first reason to look at signalman.
- It composes with signalman's existing OSS positioning. A
  proprietary registry would create a confusing product story
  ("the meta build system is open source, but the artifacts it
  stores are not").

### 15.2 Relationship with `@signalman/host`

Two boundaries, one direction:

- The host package's `BlobDriver` interface stays as-is. v0.2.0's
  local-FS + S3 drivers continue to work for the
  release-pipeline use case.
- A **new driver** (`signalman-registry` driver) lets
  `@signalman/host` use the registry product as a blob backend.
  Drop-in for S3.
- The registry product itself is a **separate npm package /
  binary** (`@signalman/registry`), with its own release
  pipeline, deploy story, and config surface.

This means signalman-the-meta-build-system can use any backing
store (FS / S3 / signalman-registry / other-vendor-registry), and
the registry product can be deployed standalone for users who
don't use the meta build system at all.

### 15.3 v0.3.0 interim home for cloud images

Cloud-image artifacts (AMIs, Azure managed images, VHDX) need
somewhere to live in v0.3.0 — before the artifact registry
product ships. Approach: **per-org S3 / Azure-blob folders,
indexed by signalman's existing artifact catalog**. Specifically:
- AMIs live in their cloud-vendor catalog (AWS account's owned
  AMIs); a manifest record in `@signalman/host`'s artifact table
  references the AMI ID.
- Azure managed images same pattern.
- VHDX templates live in the configured blob store.

When the artifact registry product lands, the migration path is
"import from cloud catalog + blob store into the registry."
Manifest records carry forward; only the storage backend
changes. No throwaway work.

### 15.4 Scope and phasing (v0.4.0+)

Initial scope (v0.4.0 if ambitious, v0.4.x more likely):

- Generic blob format (sha256-addressable, signed manifests) —
  port the existing format.
- OCI distribution spec compliance — push/pull container images
  via `docker push` / `oras push`. Most common ask.
- Mutable tags — `latest`, `staging`, `production` pointing at
  immutable content addresses.
- Retention + GC — auto-expire by age, count, or tag policy.
- Discovery API — search by name + version + tag.
- RBAC — read / write / admin per repository, mapping cleanly to
  the existing org / API-key model.

Followups (v0.4.x — v0.5.x):

- npm registry protocol — publish + install with `npm`.
- crates.io-compatible — publish + install with `cargo`.
- maven / pip / Helm repos — same pattern, separate workstreams.
- Vulnerability scanning — Trivy / Grype integration.
- Mirroring + caching — sit between consumers and upstream
  public registries.

### 15.5 Architecture sketch

- **Storage** — same `BlobDriver` interface as `@signalman/host`.
  Default: local FS or S3.
- **Index** — Postgres (small deployments) or a real search
  index (OpenSearch / Tantivy) for larger.
- **API** — separate HTTP service, deployable independently.
  Auth federates with `@signalman/host` API keys (same
  `sk_<prefix>_<secret>` token shape).
- **Garbage collection** — reference-counted from manifests;
  unreferenced blobs collected after configurable grace period.
- **Mirror behavior** — falls back to upstream public registries
  when a name+version isn't local; caches the result.

### 15.6 Open questions specific to artifact registry

- **First protocol** — OCI is the most-asked but also the
  largest scope. Should v0.4.0 ship OCI alone, or the generic
  blob format alone (with OCI as v0.4.x)?
- **Compatibility scope for OCI** — distribution-spec v1.1 baseline,
  but the OCI ecosystem has fragmented around referrers,
  artifacts, and signing extensions (cosign, notation). Pick one
  signing path; my lean is cosign because the Ed25519
  release-signing infrastructure we already have aligns more
  cleanly with cosign's keypair model than with notation's PKI.
- **Multi-tenant isolation model** — same `org_id` scoping as
  `@signalman/host`? Or registry-scoped namespaces (closer to
  Docker Hub's `<user>/<image>` model)? Probably both, with the
  namespace acting as a registry-side concept on top of org.

---

## 16. Open questions

1. **Where does the release catalog live in the operator's mental model?** Specifically: should annotated git tags in the product repo carry the manifest sha256 (so the tag itself is auditable), or is the catalog purely signalman-side? Defaulting to signalman-side for now; tag annotation is a v0.3 feature.
2. **Staging mechanism per target kind.** For Hyper-V VM targets, checkpoints are the obvious lever for atomic deploy. For future Docker/k8s targets the answer is different. v0.2 only needs Hyper-V.
3. **Manifest signing key management.** ~~Who holds the key? For hosted, we hold it. For self-hosted, the operator. v0.2 ships unsigned; v0.3 adds signing.~~ **Resolved in v0.3.0d**: signing is Ed25519 via Node's built-in `crypto`; keys are PEM (SPKI public / PKCS#8 private) on disk; the *operator* holds the private key in self-hosted mode. The CLI never persists keys beyond `signalman key generate --out`. The fingerprint (`signed_by` on the release row, first 16 hex chars of sha256(DER pubkey)) lets operators verify which key signed a release without storing the key in the catalog.
4. **Build caching and parallelism.** The schema doesn't prevent parallel builds, but v0.2 runs components serially. Component-level cache keys (sha256 of inputs) are deferred.
5. **Per-org product limits.** The schema reserves columns for
   tracking usage counters, but no policy layer reads or enforces
   them yet.
6. **Migration of existing in-disk scenario state.** Today's `.signalman/recordings/<id>/last-run.json` etc. need to either move into the DB or be indexed by it. Tactical migration plan deferred to v0.2 implementation.
7. **GitOps sync for scenarios.** Scenario library option (b) — sync from a tenant's source repo — has UX implications (which branch? which path? webhook?). Deferred.

---

## 17. Glossary

- **Product** — an external codebase signalman builds, tests, and deploys.
- **Release** — an immutable artifact set built from a product at a specific revision, identified by tag.
- **Target** — a deployable surface (a VM, a Docker stack).
- **Deployment** — an instance of a release on a target, with status and health.
- **Tier** — a verification level (smoke, torture, e2e). Tiers gate promotion.
- **Probe** — a named, callable health check on a single component.
- **Runner** — the executor process. Stateless. Talks to control plane and host service.
- **Control plane** — the stateful TypeScript web service. Owns the catalog and ledger.
- **Manifest** — the signed declaration of a release's contents (component list, artifact sha256s).
