# Signalman

**VM scenario runner for agent-driven security, compliance, and CI workflows on Windows.**

Signalman is the runner half of an agent-first DevOps stack. LLM agents (Claude
Code, Codex) talk MCP to **Loom** — the operator surface that holds task state,
events, and orchestration — and Loom drives **Signalman** to execute scenario
runs against real Hyper-V VMs. Scenarios produce a hermetic result envelope
(scenario hash, agent version, events, duration) that Loom records as task
evidence. CI pipelines and direct CLI consumers can also drive Signalman
without Loom in the loop.

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
+---------------------------------------+
|  Signalman Runner                     |
|  - Six verbs (list/describe/plan/run/ |
|    record/status) and CLI parity      |
|  - Hyper-V control-plane (Rust svc,   |
|    mTLS, MSI-installable)             |
|  - Hypervisor plugins (Hyper-V        |
|    primary; VMware fallback)          |
|  - Scenario engine + result envelope  |
+------------------+--------------------+
                   | gRPC (mTLS)
          +--------+--------+
          |                 |
  +-------v-------+ +-------v-------+
  | Guest Agent   | | Guest Agent   |
  | (Windows 11)  | | (Windows 11)  |
  | - Process     | | - Process     |
  | - Cmd exec    | | - Cmd exec    |
  | - File ops    | | - File ops    |
  | - Verify net/ | | - Verify net/ |
  |   filesystem  | |   filesystem  |
  +---------------+ +---------------+
```

The Loom-fronted topology is the default agent surface in v0.1.0; the standalone
`signalman.*` MCP server in `host/` keeps shipping for direct CLI/CI consumers
and as the substrate the Loom plugin shells to.

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
- **Hyper-V** (Windows) — primary backend since 2026-04; required for Ospiri
  correlator silo validation (agent runs as SYSTEM with `SeTcbPrivilege`,
  which Hyper-V integration services expose cleanly)
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

The Ospiri V2 scenarios in `examples/ospiri-v2-*` are the reference set that
exercise the full stack end-to-end (ETW + WFP + kernel-debug tooling).

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
that already has the guest agent installed. Real scenarios live in
`examples/ospiri/` (full driver + WFP stack) and `.signalman/scenarios/`
(short-form smoke tests):

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

> Older cursor-restrict / `restrict-ai.rego` examples in earlier docs
> referenced an Ospiri policy bundle and a `vm_screenshot` RPC that
> ships as a proto stub in v0.1.0. Use the smoke example above as the
> starting template instead.

## License

MIT
