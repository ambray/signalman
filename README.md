# Signalman

**Agent-first DevOps platform: VM scenario runner + tag-driven release-lifecycle control plane + standalone artifact registry.**

Signalman is three complementary halves that share storage, auth, and CLI:

1. **Scenario runner (v0.1.x)** — executes hermetic VM-backed test scenarios
   (Hyper-V primary on Windows; Tart on macOS; libvirt + vmrun on
   Linux/cross-platform; VMware as legacy fallback) for security, compliance,
   and CI workflows. LLM agents drive it through
   [Loom](https://github.com/ambray/loom); CI pipelines drive it through the
   native CLI. Guest agent is cross-platform — Windows / Linux / macOS — via
   a `Platform` trait dispatched at compile time.
2. **Meta build system (v0.2.x — v0.4.x)** — a tag-driven release pipeline
   for an externally-developed product. Builds a deterministic release from
   a git tag, signs the manifest with Ed25519, stages artifacts into a
   content-addressed blob store, deploys atomically to a target (VM, cloud
   VM, Kubernetes cluster, or Docker stack), and rolls back on demand. The
   control plane runs in-process for local mode or as a networked HTTP
   service for self-hosted / shared-runner deployments. Layered operator
   features include cloud-provider integration (AWS + Azure, ephemeral
   instances + OpenTofu stacks), Kubernetes deploy via `kubectl` / Helm,
   auto-promotion with approval gates, outbound webhooks (generic / Slack /
   email), and scheduled health checks.
3. **Artifact registry (`@signalman/registry`, v0.1.x)** — standalone OSS
   product spun out of the meta-build blob catalog. Speaks cargo
   sparse-index and npm protocols today (OCI / Maven / pip / Helm queued).
   Each manifest carries provenance metadata (`source: upload | proxy_cache
   | manifest_create`). Virtual upstreams pull-through public registries
   with Ed25519 re-signing on cache write. Forensic + provenance HTTP API
   answers "what's in my registry and where did it come from" and an
   immutable audit log answers "who did what when".

All three multiplex through one MCP server, one CLI surface (per binary),
and one storage layer (pluggable SQLite | Postgres, pluggable local-FS | S3
blobs). Single-tenant by default; per-org scoping (`org_id` on every row,
Bearer-token API keys, per-org credentials at rest, per-org cost guardrails)
is wired through the schema and surfaced via the operator CLI.

Website: [signalman.dev](https://signalman.dev)

## Architecture

```
+---------------------+      +----------------------+
| Claude Code / Codex |      | Direct CLI / CI      |
|   (via MCP)         |      |  (exit codes + JSON  |
|                     |      |   envelope contract) |
+----------+----------+      +-----------+----------+
           |                              |
           v                              |
+----------+----------+                   |
|   Loom MCP Server   |                   |
|   - tasks / state   |                   |
|   - EventBus        |                   |
|   - operator TUI    |                   |
+----------+----------+                   |
           | loom plugin                  |
           |  (shells to CLI / MCP)       |
           +-------------+----------------+
                         v
+--------------------------------------------------+   +--------------------------------+
| Signalman host (TypeScript, one process)         |   | @signalman/registry            |
|                                                  |   |   (separate binary)            |
|  Verb surface (CLI + MCP, single contract)       |   |                                |
|  - Scenarios:   list/describe/plan/run/          |   |  Verb surface                  |
|    record/status                                 |   |  - serve, audit, forensic,     |
|  - Meta build:  product/release/target/          |   |    virtual, keygen, verify     |
|    deployment/health + key/api-key/runner        |   |                                |
|  - Cloud:       cloud {provision/terminate/      |   |  HTTP                          |
|    status/list/creds/budget/usage/reaper/        |   |  - /v1/blobs/:sha256           |
|    connection-descriptor},                       |   |  - /v1/manifests/...           |
|    stack {apply/destroy/plan-cost}               |   |  - /v1/audit/{query,append}    |
|  - Kubernetes: k8s {deploy/rollback/status},     |   |  - /v1/forensic/{manifest,...} |
|    runner deploy-k8s                             |   |  - /cargo/<org>/...            |
|  - Operations: promotion {add/approve/reject/    |   |  - /npm/<org>/...              |
|    tick}, webhook {add/list/test},               |   |                                |
|    schedule {add/run-once/start}                 |   |  Storage                       |
|                                                  |   |  - ManifestIndex (SQLite)      |
|  Control plane (in-process or `serve`d)          |   |  - RegistryBlobs (local-FS|S3) |
|  - Release catalog, deployment ledger,           |   |  - Virtual-upstream cache      |
|    scenario index, artifact metadata,            |   |  - Audit log + Provenance      |
|    audit log, tenant model                       |   |                                |
|  - Promotion policies + approval ledger          |   |  Acts as a BlobDriver behind   |
|  - Webhook subscriptions + event dispatcher      |   |  @signalman/host (registry-    |
|  - Scheduled health probes                       |   |  blob-driver) — same artifact  |
|  - Cloud cost guardrails + per-org credentials   |   |  pipeline, externalized store. |
|  - HTTP API on node:http, bearer-token auth      |   +--------------------------------+
|  - StorageDriver (SQLite | Postgres)             |
|  - BlobDriver (local-FS | S3 | signalman-registry)
|  - Ed25519 manifest signing                      |
|  - Job queue → release.build jobs                |
|                                                  |
|  Runner workers (in-process or remote)           |
|  - Poll the control plane, claim jobs            |
|  - Clone product repo at tag, run declared       |
|    build steps, upload artifacts                 |
|  - Stateless; many workers per control plane     |
|  - Multi-transport deploy: script / ssh / winrm  |
|    / docker / cloud (SSM | Bastion tunneling)    |
+----------+--------------------+---------+--------+
           |                    |         |
   mTLS gRPC      cloud SDK / kubectl     | OpenTofu (HCL stacks)
           |                    |         |
+----------v----------+ +-------v---------v---+ +----------------------+
| Hyper-V service     | | Hypervisor backends | | Cloud + k8s backends |
| (Rust, MSI-install) | | Hyper-V (Win)       | | AWS / Azure SDK      |
| Privileged Hyper-V  | | Tart (macOS)        | | (cloud_vm_test)      |
| cmdlets over mTLS   | | libvirt (Linux)     | | OpenTofu             |
+----------+----------+ | vmrun (cross-plat)  | | (cloud_stack_test)   |
           |            | VMware (legacy)     | | kubectl + Helm       |
           |            +----------+----------+ | (k8s_test)           |
           |                       |            +-----------+----------+
           |                       |                        |
   +-------v-------+       +-------v-------+       +--------v---------+
   | Guest Agent   |  ...  | Guest Agent   |  ...  | Pods / Cloud VMs |
   | (per VM)      |       | (per VM)      |       | (deploy targets) |
   | Platform trait:       | Platform trait:       +------------------+
   |  Windows full UI/     |  Linux: SYSTEM via
   |  browser surface;     |  passwordless sudo;
   |  Linux/macOS proc /   |  macOS: brew + AX
   |  cmd / file / net.    |  driver (planned)
   +---------------+       +---------------+
```

**Two deployment shapes** for the meta build system (see
[docs/design/meta-build-system.md](docs/design/meta-build-system.md)):

- **Local** — single binary, in-process control plane. The default; nothing
  to deploy, no network surface, all state in `.signalman/`.
- **Self-hosted** — `signalman serve` on a long-lived host; remote runners
  register via `signalman runner register` and poll via HTTP. SQLite is fine
  for small fleets; Postgres + S3 for larger ones (see
  [docs/postgres-driver.md](docs/postgres-driver.md)).

The registry is a **third runtime** that can co-exist with either shape:
operators run `signalman-registry serve` as a separate process (or behind a
fronting proxy), and `@signalman/host`'s `signalman-registry` BlobDriver
points artifact storage at it. The registry can also serve cargo/npm
clients directly, so a single Signalman deployment can be the registry of
record for the org's CI/CD pipeline. See `registry/README.md` for the
standalone scope and `docs/supply-chain.md` for the bootstrap-from-signalman
story.

The Loom-fronted topology is the default agent surface in v0.1.x for the
scenario half; the meta build, cloud, k8s, registry, promotion, webhook,
and scheduled-health verbs are CLI/HTTP-first and don't depend on Loom.

## Components

### Loom Plugin (`plugins/signalman-loom-plugin/`) — v0.2.0
Rust crate registering `loom.signalman.list/describe/plan/run/record/status`
MCP tools through Loom's `RegisterMcpTools` capability. Stores run handles via
Loom's `TaskOwnership` shape (no Signalman-side persistence layer); emits
envelope events into Loom's `EventBus`; exposes scenarios as descriptor-backed
forms in `loom tui`. Shells out to the Signalman CLI/MCP — Signalman is not
embedded as a Rust dependency of Loom.

### Host MCP Server (`host/`)
TypeScript MCP server providing the `signalman.*` verb surface plus the
`signalman.advanced.*` namespace for fine-grained VM/Docker tools. Used directly
by CI pipelines, custom MCP clients, and the Loom plugin's subprocess path.
Includes pluggable hypervisor backends.

**Supported Hypervisors:**
- **Hyper-V** (Windows) — primary backend since 2026-04; required when
  the guest agent needs to run as SYSTEM with `SeTcbPrivilege` (Hyper-V
  integration services expose this cleanly, where VMware's tooling
  pipes through a less-privileged service account).
- **Tart** (macOS on Apple Silicon) — first Mac runner backend for macOS VM
  lifecycle and command execution through Apple's Virtualization.framework;
  see [docs/mac-virtualization.md](docs/mac-virtualization.md). macOS guests
  run the normal Signalman guest agent under the new `Platform` trait;
  `scripts/macos/install-guest-agent.sh` installs it as a LaunchDaemon for
  unattended file and command operations.
- **libvirt** (Linux) — `virsh`-wrapping backend in
  `host/src/hypervisors/libvirt.ts`. Drives qemu/KVM through the standard
  libvirt API. Shipped in v0.4.0-4; primary backend on Linux developer hosts
  and Linux CI runners.
- **vmrun** (cross-platform; Windows / Linux / macOS) — parallel-track
  VMware Workstation/Fusion driver in `host/src/hypervisors/vmrun.ts`.
  Shipped in v0.4.0-4 as an injectable-exec, stable-error-code alternative
  to the legacy `vmware.ts`. The two converge in a future release (see
  the carve-out list in `docs/audit/capability-matrix-2026-05-wave3.md`).
- **VMware Workstation** (Windows/Linux, legacy) — kept working but
  deprioritized; converges with vmrun.ts above when a production scenario
  exercises the parallel-track driver end-to-end.
- **Cloud VMs** (AWS + Azure) — not hypervisors per se but registered as
  deploy targets via `cloud_vm_test` / `cloud_stack_test` target kinds
  with SDK-backed lifecycle (provision, terminate, status, cost-reaper).
  See the Quick Start §"Cloud providers" below.

### Hyper-V Control-Plane Service (`service/`)
Rust crate that brokers privileged Hyper-V cmdlets via mTLS gRPC, eliminating
per-call gsudo prompts in agent-driven workflows. MSI-installable; runs under
a dedicated service account with minimum Hyper-V Admin privileges. Named-pipe
+ localhost TCP transports.

### Guest Agent (`guest/`)
Rust agent that runs inside each VM and exposes process control, command
execution, file operations, and network/filesystem verification primitives
over gRPC with bearer-token authentication and optional mTLS. Scenario file
transfer uses this agent in chunks, so Mac/Tart and Linux/libvirt runs do
not depend on hypervisor-specific shared folders.

**Cross-platform via the `Platform` trait** (v0.4.0-4): per-OS modules under
`guest/src/platform/{windows,linux,macos,other}.rs` implement
platform-specific behaviour behind a common trait the service layer
dispatches through. Per-platform status:

- **Windows** — full surface: proc / cmd / file / net / **UI automation +
  browser automation** via the in-VM UIA sidecar (`guest/src/ui_sidecar.rs`).
  SYSTEM-elevation via Hyper-V integration services + `SeTcbPrivilege`.
- **Linux** — proc / cmd / file / net implemented; SYSTEM-elevation via
  passwordless `sudo -n` (operator configures sudoers on the guest);
  package install routes through `apt` / `dnf` / `yum` (auto-detected).
  UI / browser RPCs return `Status::unimplemented` (no portable AX
  equivalent).
- **macOS** — proc / cmd / file / net implemented; package install routes
  through `brew`. UI / browser RPCs return `Status::unimplemented` until
  the AppleScript + Accessibility API driver lands (planned —
  `MacosPlatform::supports_ui_automation()` is the capability flip).
- **Other / fallback** — unconditional `Status::unimplemented` with a
  canonical message; the trait contract keeps the proto v1 surface stable
  across new OSes joining later.

### Scenarios (`.signalman/scenarios/`, `examples/`)
Test definitions using a two-layer approach:
- **YAML DSL** — VM configuration, setup steps, assertions
- **Markdown narratives** — natural-language workflow for LLM drivers

Product-specific scenarios live in the consuming product's repo under
its own `.signalman/scenarios/` directory; this repo only ships a
handful of minimal smoke scenarios as runnable examples.

### Meta build control plane (`host/src/control-plane/`) — v0.2.0–v0.3.0
TypeScript implementation of the release-lifecycle service. Ships
in-process for local mode and as an HTTP service (`signalman serve`) for
self-hosted/shared-runner deployments.

- **Schema** — products, releases, artifacts, targets, deployments,
  health checks, audit log, organisations, API keys, jobs, runners,
  **promotion policies + approvals** (v0.4.0-1), **webhook subscriptions**
  (v0.4.0-2), **scheduled health probes** (v0.4.0-3), **cloud
  org-budgets + usage + credentials** (v0.3.0-5). ULID PKs, ISO-8601
  timestamps, partial unique indexes for soft-deletion. Same migration
  files run verbatim against SQLite and Postgres
  (`host/src/control-plane/storage/migrations/`); a `.pg.sql` /
  `.sqlite.sql` suffix carries dialect-specific variants where
  CHECK-constraint rewrites diverge.
- **Storage drivers** — `SqliteStorageDriver` (node:sqlite, default) and
  `PostgresStorageDriver` (`pg`, opt-in via config). Identical repository
  interface; the verb code never knows which is underneath. See
  [docs/postgres-driver.md](docs/postgres-driver.md).
- **Blob drivers** — `LocalFsBlobDriver` (content-addressed,
  `<root>/<org_id>/<sha[0:2]>/<sha>`) and `S3BlobDriver`
  (`@aws-sdk/client-s3`, presigned downloads). Both reject path traversal
  and option-injection at the input boundary.
- **Build executor** — clones the product repo at a tag, runs the
  `signalman.build.yaml` declared by the *product*, captures artifacts
  into the blob store, computes a canonical manifest, signs it with
  Ed25519, and writes the release row. The same executor runs in-process
  for local builds and over HTTP for remote runners.
- **Job queue** — atomic claim via `BEGIN IMMEDIATE` + UPDATE-WHERE on
  SQLite and `SELECT FOR UPDATE SKIP LOCKED` on Postgres. Powers the
  `release.build` job kind used by remote runners.
- **Manifest signing** — Ed25519 over the canonical manifest JSON. Uses
  Node's built-in `crypto` (no third-party crypto dep). Verification is
  exposed as `signalman release verify` and as the `verifyManifest`
  helper.

### Runner workers (`host/src/runner/`) — v0.3.0a + WS6 wave-3
Stateless workers that poll the control plane for `release.build` jobs,
claim them atomically, clone the product repo at the release's tag, run
the build executor against an `HttpControlPlane` shim, and upload the
resulting artifacts. Started via `signalman runner start --name
<worker>`; many workers can share one control plane.

**Multi-transport deploy** (`signalman runner deploy ...`): runners can
be brought up over `script` (operator-provided bash), `ssh` (SSH-key auth),
`winrm` (PowerShell-over-HTTPS), `docker` (container runtime on a remote
host), or `cloud` (provision an instance and dial it via SSM / Bastion).
Each transport carries a uniform `RunnerDeployResult` envelope so CI
pipelines drive any of them through the same verb. See the operator
walkthrough in `docs/bootstrap.md` and the integration-test scaffolding
in `host/src/__tests__/runner-deploy.integration.test.ts` (gated on
`SIGNALMAN_INTEGRATION_TESTS=1`).

### Artifact registry (`registry/`) — v0.1.x
Standalone OSS product (`@signalman/registry`) that the meta-build
catalog talks to via a stable HTTP contract. Ships its own binary
(`signalman-registry serve`) and its own CLI verbs (`audit`, `forensic`,
`virtual`, `keygen`, `verify`).

- **Manifest store** — content-addressed blobs + a separate manifest
  table keyed by `(org, kind, name, version)`. `kind` is the
  discriminator: `generic` (v0.4.0), `cargo` (M10.2+), `npm` (v0.1.1)
  today; `oci` / `maven` / `pip` / `helm` queued (`registry/ROADMAP.md`).
- **Cargo facade** — sparse-index protocol at `/cargo/<org>/...`.
  `cargo publish` + `cargo install` work against per-org sparse
  indexes; virtual upstreams transparently mirror crates.io with
  optional Ed25519 re-signing on cache write.
- **npm facade** — `/npm/<org>/<package>` packuments + tarballs;
  scoped + unscoped names; virtual-upstream pull-through against
  npmjs.com with re-signing. `@signalman/host` becomes
  `npm install`-able from a self-hosted registry.
- **Provenance + forensic API** — every manifest carries
  `provenance: {source, upstream_url?, signed_by?, ...}`. The
  `/v1/forensic/manifest/<name>/<version>` HTTP API answers "where did
  this artifact come from" in one call; `/v1/audit/query` returns the
  audit-log trail filtered by action / org / actor.
- **As a host BlobDriver** — `@signalman/host` ships a
  `signalman-registry` BlobDriver; pointing the host's blob config at
  a registry URL routes every artifact write through the registry's
  storage layer (with provenance + signing for free).

See `registry/README.md` for the package scope and
`docs/supply-chain.md` for the bootstrap-from-signalman vision.

## Quick Start

> New operators: see [docs/bootstrap.md](docs/bootstrap.md) for the
> end-to-end "fresh Hyper-V host → first `signalman run`" walkthrough
> (prerequisites, dev certs, template fetch, VM provision, bundle
> install, troubleshooting).

### Loom-fronted (default agent path; v0.1.0)

The Loom plugin lives at `plugins/signalman-loom-plugin/`. It registers with
Loom through the trusted-plugin inventory at build time (Loom links it in via
`inventory::submit!`), exposes `loom.signalman.*` MCP tools, persists run
state in Loom-managed task storage, streams `signalman.run.*` events on
Loom's EventBus, and ships a directive provider that drops Signalman guidance
into every agent target's `CLAUDE.md` / `AGENTS.md` / `.cursor/rules`.

```bash
# 1. Build Signalman + the Loom plugin in this repo
cd host && npm install && npm run build && cd ..
cargo build --release -p signalman-loom-plugin \
  --manifest-path plugins/signalman-loom-plugin/Cargo.toml

# 2. Build Loom with the Signalman plugin enabled (in the loom repo)
cargo build --release -p loom --features signalman

# 3. Run Loom MCP; agents see loom.signalman.* tools automatically
loom mcp serve
```

In Claude Code or Codex, the agent invokes `loom.signalman.list`, then
`loom.signalman.run <scenario>`. Loom holds the run handle (via its
`TaskOwnership` state) and streams envelope events through its `EventBus`.

#### Hermetic identity for workflow caching (v0.3.0-4)

When a Loom workflow node invokes `loom.signalman.run` (or polls via
`loom.signalman.status`) the plugin promotes the run envelope's
identity subset to a top-level `hermetic_identity` object on the
response:

```json
{
  "run_id": "abc",
  "status": "passed",
  "envelope": { /* full ScenarioResult */ },
  "hermetic_identity": {
    "scenario_hash":   "0a1b2c...",
    "vm_lineage_hash": "f4e5d6...",
    "agent_version":   "0.2.1",
    "network_class":   "default-switch"
  }
}
```

Workflow nodes gate on `hermetic_identity` for cache-keying without
descending into envelope JSON: identical
`(scenario_hash, vm_lineage_hash, agent_version)` tuples are
guaranteed to produce the same `ScenarioResult` under hermetic
execution, so Loom's cache layer can short-circuit identical inputs.

The field is absent (rather than `null`) when the envelope is
pre-v0.3.0-3 or the run failed before populating any identity field
— callers can use presence to detect cache-eligible runs.

### Standalone (CI / direct MCP / debugging)

```bash
# From npm (once v0.1.0 is published — see Release section below)
npm install -g @signalman/host

# Or from source
cd host && npm install && npm run build

# Add to Claude Code as a direct MCP server (no Loom in the loop)
claude mcp add signalman node host/dist/server.js

# Or invoke via CLI for CI (any scenario in .signalman/scenarios/):
node host/dist/cli.js run service-backend-smoke
echo $?   # standard exit codes; envelope JSON on stdout
```

#### Choosing between Loom-fronted and direct CLI

Both paths produce the same `ScenarioResult` envelope (v0.3.0-3 +
hermetic identity fields), so the choice is about orchestration
ownership:

| Concern | Loom-fronted | Direct CLI / CI |
|---|---|---|
| Run state persistence | Loom-managed, survives host restart | Caller manages (e.g. GH Actions artifact) |
| Live event streaming | `signalman.run.*` events on Loom's EventBus | None — wait for envelope on stdout |
| Retry / scheduling | Loom workflows or directives | Caller's CI scheduler |
| Cache lookup | `hermetic_identity` on plugin response | Parse envelope `scenario_hash` + `vm_lineage_hash` |
| Best for | Agent-driven DevOps, multi-step compositions | Single-shot CI gates, third-party schedulers |

The CLI's exit codes and envelope JSON are the stable contract for
direct callers — adding Loom in front of them never changes the
underlying run shape.

### Meta build system (release lifecycle for an external product)

Once installed, register a product, build a release, and deploy it. All
verbs work against the local (in-process) control plane by default;
point at `signalman serve` with `SIGNALMAN_API_URL` for remote mode.

```bash
# 1. Register your product (the repo whose tags you'll be building).
signalman product add --name myapp \
  --repo https://github.com/myorg/myapp.git

# 2. Check in a signalman.build.yaml at the root of the product repo:
#    components: each names a build command, a working directory, and
#    the artifacts the build produces (path globs or image refs). See
#    docs/design/meta-build-system.md §4.2 for the full schema.

# 3. Generate an Ed25519 signing keypair (one-time, per operator).
#    Default output is ~/.signalman/keys/signing.{pub,key}; --name
#    overrides the filename stem if you want multiple keys.
signalman key generate

# 4. Build a release from a tag. Clones the repo, runs each component's
#    build command, captures artifacts into the blob store, computes
#    + signs the manifest, writes a release row.
signalman release build --product myapp --tag v1.0.0 \
  --sign --key ~/.signalman/keys/signing.key

# 5. Register a deploy target (a VM, a Docker host, etc.) and deploy.
signalman target add --name win11-demo --kind vm_test \
  --connection '{"vmName":"Win11_demo"}'
signalman release deploy --target win11-demo --release <id>

# 6. Run per-component health probes against the active deployment
#    on a target. (Deploy already gates on these; this verb re-runs
#    them on demand.)
signalman health check --target win11-demo

# 7. Roll back atomically if something's off.
signalman release rollback --target win11-demo
```

For **remote operation** (control plane on one host, runners on
others):

```bash
# On the control-plane host — pick a port and (recommended for any
# non-loopback bind) require Bearer tokens from every client:
signalman serve --host 0.0.0.0 --port 8765 --disable-loopback-bypass

# Mint a key for each runner / CI consumer (token shown once):
signalman api-key create --name my-runner
# → sk_XXXXXXXX_YYYYYYYYYYYYYYYYYYYYYYYYYY

# On a runner host — register + start a worker against the control plane:
signalman runner register \
  --control-plane http://control-plane.example.com:8765 \
  --token sk_XXXXXXXX_YYYYYYYYYYYYYYYYYYYYYYYYYY \
  --worker-name builder-1
signalman runner start

# `release build --remote` queues a release.build job for any available
# runner instead of running it in-process:
signalman release build --product myapp --tag v1.0.0 --remote
```

Inspecting and verifying signing keys:

```bash
# Print the fingerprint of an existing public key. The fingerprint
# (first 16 hex chars of sha256(DER pubkey)) matches the `signed_by`
# column on every release this key signs.
signalman key fingerprint ~/.signalman/keys/signing.pub

# Verify a release's manifest against a public key. Exits non-zero
# if the fingerprint or signature don't match.
signalman release verify <release-id> \
  --public-key ~/.signalman/keys/signing.pub
```

### Cloud providers (AWS + Azure)

Provision ephemeral cloud VMs as scenario hosts or deploy targets, and
apply OpenTofu stacks for multi-resource cloud infrastructure. See
`docs/design/v0.3.0-5-cloud-providers.md` for the full design.

```bash
# 1. Configure per-org credentials at rest (AES-256-GCM, key from
#    SIGNALMAN_CRED_KEY env var). Plaintext NEVER appears on argv.
export SIGNALMAN_CRED_KEY=$(openssl rand -base64 32)
signalman cloud creds set --provider aws \
  --plaintext-json '{"access_key_id":"AKIA...","secret_access_key":"..."}'

# 2. Set a monthly budget guardrail (per-org, in cents). The reaper
#    auto-terminates instances when projected spend exceeds the limit.
signalman cloud budget set --monthly-cents-limit 5000 --soft-warn-pct 80

# 3. Provision an ephemeral cloud VM. TTL enforced by the reaper.
signalman cloud provision --provider aws \
  --region us-east-1 --instance-type t3.micro \
  --image-ref ami-0c55b159cbfafe1f0 \
  --name ci-runner-1 --ttl-minutes 60

# 4. Apply a multi-resource stack via OpenTofu.
signalman stack apply \
  --stack-name prod-net --module-path ./infra/network \
  --var environment=prod

# 5. Use cloud VMs as deploy targets — register with cloud_vm_test kind
#    and a connection descriptor that names the dial transport (public
#    mTLS for direct access, aws_ssm or azure_bastion for tunneled).
signalman cloud connection-descriptor \
  --provider aws --network-mode aws_ssm \
  --instance-id i-0123abc > target.json
signalman target add --name prod-host --kind cloud_vm_test \
  --connection "$(cat target.json)"

# 6. Inspect cost + usage at any time.
signalman cloud usage --org-id <id>
signalman cloud reaper status
```

### Kubernetes (deploy target + runner substrate)

Deploy releases to Kubernetes clusters via `kubectl` or Helm, and run
remote runners as in-cluster pods. See
`docs/design/meta-build-system.md` §14 (v0.3.0-6).

```bash
# Apply a release's k8s manifest to a namespace. Driver is auto-detected
# from the bundle (Helm chart vs raw manifest) or explicit via --driver.
signalman k8s deploy \
  --bundle-uri ./manifests/myapp/  --namespace prod \
  --cluster-context prod-cluster --release-name myapp

# Roll back to a prior Helm revision.
signalman k8s rollback \
  --release-id <id> --namespace prod --to-revision 3 --driver helm

# Probe the live state of a release in a namespace.
signalman k8s status --namespace prod --release-name myapp

# Deploy a runner pod into a cluster.
signalman runner deploy-k8s \
  --manifest ./runner.yaml --namespace runners \
  --selector app.kubernetes.io/name=signalman-runner \
  --wait-timeout-ms 120000
```

The k8s deploy path is deliberately separate from `signalman release
deploy` — k8s manifests don't fit the per-target Deployment-row model
the VM-deploy path uses. Both paths emit `release-deployed` webhook
events on success (see §"Webhooks + notifications" below).

### Auto-promotion + approval gates

Tag → tier → tier release flow with configurable approval semantics.
A `promotion_policy` says "when a release of product P lands at source
target S, promote it onto dest target D using gate G." See
`docs/design/meta-build-system.md` §12 (v0.4.0-1) and the
`signalman-promote-release` skill.

```bash
# 1. Define a policy. Three gate kinds:
#      auto       — fire deploy immediately on release-built / -deployed
#      manual     — create a pending approval row; operator must approve
#      time_delay — pending until auto_approve_at elapses; tick advances
signalman promotion add \
  --product myapp --dest demo --gate auto

signalman promotion add \
  --product myapp --source demo --dest prod --gate manual \
  --gate-config '{"approvers":["alice@example","bob@example"]}'

# 2. Inspect pending approvals.
signalman promotion approvals --status pending --format json

# 3. Approve / reject a pending approval. The verb fires the deploy on
#    approve, records the decision on the approval row + audit log,
#    and emits a promotion-approved (or -rejected) webhook event.
signalman promotion approve <approval-id> \
  --decided-by alice --reason "smoke tests green"
signalman promotion reject <approval-id> --reason "rollback in progress"

# 4. Process due time-delay approvals (cron-friendly).
signalman promotion tick
```

The approver allow-list (`gate_config.approvers`) is **honour-system**:
`--decided-by` is caller-supplied, not authenticated. Deployments that
need real RBAC are expected to front the OSS control plane with an
external identity / policy layer
(`signalman-cloud:docs/contracts/promotion-approvers.md`).

### Webhooks + notifications

Outbound HTTP / Slack / email notifications on release / deployment /
health / promotion state changes. See
`docs/design/meta-build-system.md` §13 (v0.4.0-2).

```bash
# 1. Register a generic webhook (POST JSON body, optional HMAC-SHA256
#    signature header X-Signalman-Signature).
signalman webhook add --kind generic \
  --url https://hooks.example.com/signalman \
  --secret <hmac-key> --events release-built,deployment-rolled-back

# 2. Slack incoming webhook (URL-authenticated; HMAC field ignored).
signalman webhook add --kind slack \
  --url https://hooks.slack.com/services/T.../B.../X... \
  --events health-failed,promotion-rejected

# 3. Email (mailto: URL; SMTP transport from SIGNALMAN_SMTP_URL env;
#    absent = silent skip).
signalman webhook add --kind email \
  --url mailto:oncall@example.com \
  --events release-built,deployment-rolled-back

# 4. Test a subscription with a synthetic event before relying on it.
signalman webhook test <id>

# 5. List + remove.
signalman webhook list --format json
signalman webhook remove <id>
```

Event kinds: `release-built`, `release-deployed`,
`deployment-rolled-back`, `health-failed`, `promotion-approved`,
`promotion-rejected`. Empty `--events` = subscribe to all. Failed
deliveries are audit-logged but never block the upstream pipeline.

### Scheduled health checks

Periodic re-runs of the existing `health check` verb against each
target's active deployment, without an operator pulling the trigger.
See `docs/design/meta-build-system.md` §12 and the
`signalman-schedule-health` skill.

```bash
# 1. Add a schedule. Interval floor is 60s.
signalman schedule add \
  --target prod-host --interval-seconds 300 --probes smoke,latency

# 2. List schedules.
signalman schedule list --format json

# 3. Run a single tick on demand (CI-friendly; doesn't start a daemon).
signalman schedule run-once

# 4. Run the scheduler daemon (Ctrl-C to stop).
signalman schedule start --tick-ms 60000

# 5. Disable / re-enable / remove.
signalman schedule disable <id>
signalman schedule enable <id>
signalman schedule remove <id>
```

Each tick lands a row in the existing `health_check` table — scheduled
runs and operator-triggered runs share the same history. A failed
probe also fires the `health-failed` webhook event.

### Artifact registry (`signalman-registry`)

The standalone registry binary is a separate component (see
`registry/README.md`). Quickstart for an operator running it
alongside the host:

```bash
# 1. Start the registry process. Defaults to SQLite + local-FS
#    blobs under <data-dir>/registry/.
signalman-registry serve --host 0.0.0.0 --port 9876 \
  --data-dir ~/.signalman/registry

# 2. Configure a virtual upstream (e.g., crates.io passthrough).
signalman-registry virtual add \
  --kind cargo --upstream-url https://index.crates.io/ \
  --org myorg --re-sign

# 3. Point cargo at the per-org sparse index.
cat > .cargo/config.toml <<EOF
[registries.myorg]
index = "sparse+http://localhost:9876/cargo/myorg/"
EOF

# 4. Publish + install through the registry. `cargo publish` and
#    `cargo install` work transparently.
cargo publish --registry myorg
cargo install --registry myorg my-crate

# 5. Inspect provenance + audit log of an artifact.
signalman-registry forensic manifest --name my-crate --version 1.0.0
signalman-registry audit query --action upload --since 24h
```

Point `@signalman/host` at the registry by setting its blob driver:

```yaml
# .signalman/config.yaml
controlPlane:
  blobs:
    driver: signalman-registry
    baseUrl: http://localhost:9876
    bearerToken: sk_XXXXXXXX_YYYYYYYYYYYYYYYYYYYYYYYYYY
```

### Hyper-V control-plane service (Windows host)

The privileged Hyper-V daemon ships as a signed MSI on Windows. Install
once per host:

```powershell
# Download signalman-service.msi from the GitHub Releases page (or
# build locally — see scripts/release-dry-run.ps1).
msiexec /i signalman-service.msi /qn

# The installer registers the SCM service, generates dev certs under
# %ProgramData%\Signalman\certs, and starts the service.
```

The service exposes a gRPC control plane over a Windows named pipe
(`\\.\pipe\signalman-service`) with a hardened SDDL ACL (LocalSystem +
BUILTIN\Administrators + BUILTIN\Hyper-V Administrators) and over
loopback TCP `127.0.0.1:17777` with mTLS.

### Release process

Tag-triggered. See `.github/workflows/release.yaml`:

```bash
# Dry-run locally before tagging (catches version skew, packaging
# issues, and template errors without round-tripping through CI).
pwsh scripts/release-dry-run.ps1

# Bump host/package.json + guest/Cargo.toml + Cargo.toml versions to
# the same string, commit, then tag.
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds + signs the MSI (via `signtool`), publishes
`@signalman/host` to npm, publishes `signalman-guest` to crates.io,
and creates a GitHub Release with all artifacts attached. The
`WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD` / `NPM_TOKEN` /
`CARGO_REGISTRY_TOKEN` repo secrets gate the publish steps —
unsigned/unpublished artifacts are still produced when secrets are
missing, so dry-runs and pre-cert builds remain useful.

## Scenario Format

Each scenario is a directory with three files:

```
scenarios/<name>/
├── setup.yaml       # VM config, software installation, policy setup
├── workflow.md      # Natural language narrative for LLM drivers
└── assertions.yaml  # Expected outcomes and verification steps
```

### Setup DSL (`setup.yaml`)

Minimal, illustrative example — runs a process listing in a Hyper-V VM
that already has the guest agent installed. The four scenarios shipped
with this repo (`.signalman/scenarios/live-*` and `service-backend-smoke`)
are short smoke tests; product-specific scenarios live in the product's
own repo's `.signalman/scenarios/` directory.

```yaml
name: "smoke: hyperv basic"
version: "1.0"

vms:
  - name: endpoint-1
    template: win11-base
    checkpoint_restore: agent-installed
    guest_agent_port: 50051

setup:
  - action: vm_run_command
    vm: endpoint-1
    command: powershell.exe
    args: ["-Command", "Get-Process | Select-Object -First 5"]
```

#### Ephemeral VMs (v0.3.0+)

Scenarios that want a fresh VM per run — no shared state between
scenarios, no hand-pinned hostname — set `ephemeral: true`. The
orchestrator branches a [differencing
disk](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/manage-virtual-hard-disks)
off the resolved template's base VHDX, creates the VM, runs the
scenario, then stops + deletes the VM and unlinks the child VHDX at
teardown:

```yaml
name: "smoke: ephemeral hyperv"
version: "1.0"

vms:
  - name: fresh-vm
    template: win11-base    # template MUST be pre-baked (agent installed)
    ephemeral: true         # per-scenario disposable VM
    guest_agent_port: 50051

setup:
  - action: vm_run_command
    vm: fresh-vm
    command: powershell.exe
    args: ["-Command", "hostname"]
```

Constraints:

- **Hyper-V backend only** in v0.3.0; Tart / VMware support arrives
  when those backends grow a differencing-disk equivalent.
- **Pre-baked template required** — the base VHDX must already have
  the guest agent installed. v0.3.0-5 ships the Packer pipeline that
  builds baked templates from scratch; until then, operators build
  the baked VHDX manually and point `base_image_path` at it.
- **Mutually exclusive with `provision_if_missing`** — the latter is
  the long-lived "create VM + install agent + take checkpoint" path
  (P9.4); ephemeral is per-scenario. Declaring both is a
  schema-load-time error.
- `checkpoint_restore` is silently ignored on ephemeral VMs (no
  checkpoint exists yet — they start fresh from the base).

A stable `vm_lineage_hash` is computed at provision time from
`{template_name, template_version, os, installed[]}` and recorded
on the scenario-run record. v0.3.0-3 graduates this through the
public result envelope so caching layers (Loom workflow evidence)
can short-circuit identical inputs.

### Workflow Narrative (`workflow.md`)
Natural language instructions that an LLM driver reads and translates into tool calls:

```markdown
# Hyper-V Basic Smoke

## Context
You are verifying the host can reach the guest agent and run a command
inside the VM.

## Workflow
1. **Restore the checkpoint** — bring `endpoint-1` to a known good state.
2. **Run a process listing** — execute `Get-Process` over the guest agent.
3. **Verify** — assertions check the agent responded and the command's
   exit code was zero.
```

### Assertions (`assertions.yaml`)
```yaml
assertions:
  - type: command_succeeded
    vm: endpoint-1
    step: 0
  - type: stdout_matches
    vm: endpoint-1
    step: 0
    pattern: "ProcessName"
```

### Record / Replay (v0.3.0+)

The agent-first differentiator: turn an ad-hoc agent investigation
into a reusable, hermetic scenario without hand-writing YAML.

Four-step workflow, runnable through the Loom-fronted MCP surface
or the direct CLI:

```bash
# 1. Start a recording session. Captures every subsequent MCP tool
#    call into .signalman/recordings/<safe_name>/<recording_id>/calls.jsonl
#    until the session expires (default 10 min) or is finalised.
loom.signalman.record { "name": "my-flow" }
#    or via CLI:
#    signalman record my-flow

# 2. Do agent-style work. Every loom.signalman.* (or signalman_* MCP)
#    invocation is wrapped in withRecording() and appended to calls.jsonl.
#    Sensitive params (tokens, passwords, API keys) are redacted on
#    capture; max array / object / string sizes are bounded.

# 3. Promote the recording into a candidate scenario. Reads calls.jsonl,
#    synthesises setup.yaml + workflow.md + assertions.yaml under
#    .signalman/scenarios/<scenario_id>/, returns the promoted paths.
loom.signalman.record_finalize { "recording_id": "rec_..." }
#    or via CLI:
#    signalman record finalize rec_<id> [--scenario-id smoke/my-flow] [--force]

# 4. Operator reviews the synthesised scenario. The current synthesiser
#    emits placeholders for VM template, network class, and assertions —
#    review the promoted files before committing:
#      - vms[]:    template / network / pre_started flags
#      - workflow: selectors, waits, expected outputs
#      - assertions: pass/fail criteria from observed behaviour
```

The synthesised scenario is marked `tags: [recorded, candidate]` so
it's discoverable but obviously promotion-pending. Once reviewed +
committed, it joins the normal scenario library and re-runs through
`signalman run <id>` like any other scenario.

Locked design (see `docs/design/v0.3.0-1-record-replay.md`):

- Append-only `calls.jsonl` capture — recording never changes tool
  semantics; a broken disk or stale path costs capture fidelity, not
  scenario execution.
- Param/result redaction at capture time — sensitive keys
  (`token`, `password`, `secret`, `auth`, `api_key`, `bearer`,
  `private_key`) replaced before persistence.
- Recording-id format: `rec_<iso-ts>_<hex>` so concurrent recordings
  can't collide on disk.

### Result Envelope (v0.3.0+)

Every `signalman run` produces a `ScenarioResult` envelope on stdout
(or via the MCP `signalman.run` response). Beyond the usual
`status` / `duration_ms` / `setup_results[]` / `assertion_results[]`
fields, v0.3.0 ships four identity fields that pin the run's
content-addressed shape:

| Field              | Type     | Description |
|--------------------|----------|-------------|
| `scenario_hash`    | hex(64)  | SHA-256 over the canonical form of `setup.yaml` + `assertions.yaml` + `workflow.md`. Stable across whitespace / comment changes; perturbed by any semantic change. Two runs of the same scenario carry the same hash. |
| `vm_lineage_hash`  | hex(64)  | Aggregate of per-VM lineage identities for ephemeral runs. Same template + same OS + same installed[] → same hash. Undefined when no ephemeral VMs were provisioned. |
| `agent_version`    | string   | Guest-agent version(s) observed during the run. `"0.2.1"` for a single agent; `"0.1.5,0.2.1"` for a mixed-version multi-VM scenario. |
| `network_class`    | string   | Network class label. `"pre-started"` when operator-managed, `<sanitised switch name>` when network is declared, `"default"` otherwise. Multi-VM scenarios get the sorted-comma-joined unique set. |

These fields are the input to scenario-run caching: a downstream
consumer (Loom workflow evidence, CI dashboard) can safely cache
`(scenario_hash, vm_lineage_hash, agent_version) → result` because
identical inputs are guaranteed to produce identical results under
hermetic execution. The cache layer itself ships in a v0.3.0
follow-up; the envelope graduation here is the contract it needs.

## License

Apache License 2.0. See [LICENSE](LICENSE) for the full text.
