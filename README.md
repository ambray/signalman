# Signalman

**Agent-first DevOps platform: VM scenario runner + tag-driven release-lifecycle control plane.**

Signalman is two complementary halves that share storage, auth, and CLI:

1. **Scenario runner (v0.1.x)** — executes hermetic VM-backed test scenarios
   (Hyper-V primary; Tart/VMware fallback) for security, compliance, and CI
   workflows. LLM agents drive it through [Loom](https://github.com/ambray/loom);
   CI pipelines drive it through the native CLI.
2. **Meta build system (v0.2.x — v0.3.x)** — a tag-driven release pipeline for
   an externally-developed product. Builds a deterministic release from a git
   tag, signs the manifest with Ed25519, stages artifacts into a
   content-addressed blob store, deploys atomically to a target VM, and
   rolls back on demand. The control plane runs in-process for local mode or
   as a networked HTTP service for self-hosted / shared-runner deployments.

Both halves multiplex through one MCP server, one CLI, and one storage layer
(pluggable SQLite | Postgres, pluggable local-FS | S3 blobs). Single-tenant by
default; multi-tenant scoping (`org_id` on every row, Bearer-token API keys)
is wired through but not surfaced operationally until v0.4.0.

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
+---------------------------------------------+
| Signalman host (TypeScript, one process)    |
|                                             |
|  Verb surface (CLI + MCP, single contract)  |
|  - Scenarios: list/describe/plan/run/       |
|    record/status                            |
|  - Meta build: product/release/target/      |
|    deployment/health + key/api-key/runner   |
|                                             |
|  Control plane (in-process or `serve`d)     |
|  - Release catalog, deployment ledger,      |
|    scenario index, artifact metadata,       |
|    audit log, tenant model                  |
|  - HTTP API on node:http, bearer-token auth |
|  - StorageDriver (SQLite | Postgres)        |
|  - BlobDriver (local FS | S3)               |
|  - Ed25519 manifest signing                 |
|  - Job queue → release.build jobs           |
|                                             |
|  Runner workers (in-process or remote)      |
|  - Poll the control plane, claim jobs       |
|  - Clone product repo at tag, run the       |
|    declared build steps, upload artifacts   |
|  - Stateless; many workers per control plane|
+---------------------+-----------------------+
                      | mTLS gRPC
            +---------+-----------+
            |                     |
+-----------v---------+ +---------v-----------+
| Hyper-V service     | | Hypervisor backends |
| (Rust, MSI-install) | | Tart (mac) /        |
| Privileged Hyper-V  | | VMware (legacy)     |
| cmdlets over mTLS   | +----------+----------+
+----------+----------+            |
           |                       |
   +-------v-------+       +-------v-------+
   | Guest Agent   |  ...  | Guest Agent   |
   | (per VM)      |       | (per VM)      |
   | proc / cmd /  |       | proc / cmd /  |
   | file / verify |       | file / verify |
   +---------------+       +---------------+
```

**Three deployment shapes** for the meta build system (see
[docs/design/meta-build-system.md](docs/design/meta-build-system.md)):

- **Local** — single binary, in-process control plane. The default; nothing
  to deploy, no network surface, all state in `.signalman/`.
- **Self-hosted** — `signalman serve` on a long-lived host; remote runners
  register via `signalman runner register` and poll via HTTP. SQLite is fine
  for small fleets; Postgres + S3 for larger ones (see
  [docs/postgres-driver.md](docs/postgres-driver.md)).
- **Hosted commercial** (v0.4.0+) — multi-tenant SaaS atop the same control
  plane. The schema is already org-scoped; the surface isn't exposed yet.

The Loom-fronted topology is the default agent surface in v0.1.x for the
scenario half; the meta build verbs (`signalman release build`, `release
deploy`, `release rollback`, `release verify`, etc.) are CLI/HTTP-first and
don't depend on Loom.

## Components

### Loom Plugin (`plugins/signalman-loom-plugin/`) — v0.1.0 (in progress)
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
  pipes through a less-privileged service account)
- **Tart** (macOS on Apple Silicon) — first Mac runner backend for macOS VM
  lifecycle and command execution through Apple's Virtualization.framework;
  see [docs/mac-virtualization.md](docs/mac-virtualization.md). macOS guests run
  the normal Signalman guest agent; `scripts/macos/install-guest-agent.sh`
  installs it as a LaunchDaemon for unattended file and command operations.
- **VMware Workstation** (Windows/Linux) — fallback, deprioritized; receives
  no new feature work
- Cross-platform daemons (libvirt on Linux, first-party Swift helper on macOS)
  — v0.3.0+

### Hyper-V Control-Plane Service (`service/`)
Rust crate that brokers privileged Hyper-V cmdlets via mTLS gRPC, eliminating
per-call gsudo prompts in agent-driven workflows. MSI-installable; runs under
a dedicated service account with minimum Hyper-V Admin privileges. Named-pipe
+ localhost TCP transports.

### Guest Agent (`guest/`)
Rust agent that runs inside each VM and exposes process control, command
execution, file operations, and network/filesystem verification primitives over
gRPC with bearer-token authentication and optional mTLS.
Scenario file transfer uses this agent in chunks, so Mac/Tart runs do not depend
on hypervisor-specific shared folders.

UI automation, browser automation, and `VerifyRestriction` RPCs ship as proto
placeholders returning `unimplemented` in v0.1.0. They will graduate when a
real consumer needs them; until then, scenarios should rely on
command-output assertions, ETW captures, and network/file-access tests.

### Scenarios (`.signalman/scenarios/`, `examples/`)
Test definitions using a two-layer approach:
- **YAML DSL** — VM configuration, setup steps, assertions
- **Markdown narratives** — natural-language workflow for LLM drivers

Scenarios that exercise the full kernel-side stack (ETW + WFP + kernel-debug
tooling) typically live in the consuming product's repo's `.signalman/scenarios/`
directory rather than here — they're product-specific by nature.

### Meta build control plane (`host/src/control-plane/`) — v0.2.0–v0.3.0
TypeScript implementation of the release-lifecycle service. Ships
in-process for local mode and as an HTTP service (`signalman serve`) for
self-hosted/shared-runner deployments.

- **Schema** — products, releases, artifacts, targets, deployments,
  health checks, audit log, organisations, API keys, jobs. ULID PKs,
  ISO-8601 timestamps, partial unique indexes for soft-deletion. Same
  migration files run verbatim against SQLite and Postgres
  (`host/src/control-plane/storage/migrations/`).
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

### Runner workers (`host/src/runner/`) — v0.3.0a
Stateless workers that poll the control plane for `release.build` jobs,
claim them atomically, clone the product repo at the release's tag, run
the build executor against an `HttpControlPlane` shim, and upload the
resulting artifacts. Started via `signalman runner start --name
<worker>`; many workers can share one control plane.

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

### Standalone (CI / direct MCP / debugging)

```bash
# From npm (once v0.1.0 is published — see Release section below)
npm install -g @signalman/host

# Or from source
cd host && npm install && npm run build

# Add to Claude Code as a direct MCP server (no Loom in the loop)
claude mcp add signalman node host/dist/server.js

# Or invoke via CLI for CI (any scenario in .signalman/scenarios/):
node host/dist/cli.js run sandbox-enforcement
echo $?   # standard exit codes; envelope JSON on stdout
```

### Meta build system (release lifecycle for an external product)

Once installed, register a product, build a release, and deploy it. All
verbs work against the local (in-process) control plane by default;
point at `signalman serve` with `SIGNALMAN_API_URL` for remote mode.

```bash
# 1. Register your product (the repo whose tags you'll be building).
signalman product add --name myapp \
  --repo-url https://github.com/myorg/myapp.git

# 2. Check in a signalman.build.yaml at the root of the product repo:
#    components: each names a build command, a working directory, and
#    the artifacts the build produces (path globs or image refs). See
#    docs/design/meta-build-system.md §4.2 for the full schema.

# 3. Build a release from a tag. Clones the repo, runs each component's
#    build command, captures artifacts into the blob store, computes
#    + signs the manifest, writes a release row.
signalman release build --product myapp --tag v1.0.0 \
  --sign --signing-key ~/.signalman/keys/release.pem

# 4. Register a deploy target (a VM, a Docker host, etc.) and deploy.
signalman target add --name win11-demo --kind vm_test \
  --connection '{"vmName":"Win11_demo"}'
signalman release deploy --target win11-demo --release <id>

# 5. Run per-component health probes; deploy is gated on them.
signalman health check --deployment <id>

# 6. Roll back atomically if something's off.
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
export SIGNALMAN_API_URL=http://control-plane.example.com:8765
export SIGNALMAN_API_TOKEN=sk_...
signalman runner register --name builder-1
signalman runner start --name builder-1

# `release build --remote` queues a release.build job for any available
# runner instead of running it in-process:
signalman release build --product myapp --tag v1.0.0 --remote
```

Ed25519 signing keys are generated and inspected with `signalman key`:

```bash
signalman key generate --out ~/.signalman/keys/release.pem
signalman key fingerprint --key ~/.signalman/keys/release.pub.pem
# → matches the `signed_by` field on each release row this key signs

signalman release verify --release <id> \
  --public-key ~/.signalman/keys/release.pub.pem
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

> Older `cursor-restrict` / `restrict-ai.rego` examples in earlier docs
> referenced a product-specific policy bundle and a `vm_screenshot` RPC
> that ships as a proto stub in v0.1.0. Use the smoke example above as
> the starting template instead.

## License

Apache License 2.0. See [LICENSE](LICENSE) for the full text.
