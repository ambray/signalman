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
- **Hyper-V** (Windows) — primary backend since 2026-04; required for Example
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

The Example V2 scenarios in `examples/example-v2-*` are the reference set that
exercise the full stack end-to-end (ETW + WFP + kernel-debug tooling).

## Quick Start

### Loom-fronted (default agent path; v0.1.0 target)

> **Status: in progress** — the plugin lives at `plugins/signalman-loom-plugin/`
> and is the P5 deliverable on the v0.1.0 critical path. Until that lands, use
> the standalone path below.

The plugin is a Rust crate that registers with Loom through the trusted-plugin
inventory at build time (Loom links it in via `inventory::submit!`). Once P5.1
lands, the workflow is:

```bash
# 1. Build Signalman + the Loom plugin in this repo
cd host && npm install && npm run build && cd ..
cargo build --release -p signalman-loom-plugin

# 2. Build Loom with the Signalman plugin enabled (in the loom repo)
cargo build --release -p loom --features signalman

# 3. Run Loom MCP; agents see loom.signalman.* tools
loom mcp serve
```

In Claude Code or Codex, the agent invokes `loom.signalman.list`, then
`loom.signalman.run <scenario>`. Loom holds the run handle (via its
`TaskOwnership` state) and streams envelope events through its `EventBus`.

### Standalone (CI / direct MCP / debugging)

```bash
# Install the host MCP server
cd host && npm install && npm run build

# Add to Claude Code as a direct MCP server (no Loom in the loop)
claude mcp add signalman node host/dist/server.js

# Or invoke via CLI for CI:
node host/dist/cli.js run cursor-restrict
echo $?   # standard exit codes; envelope JSON on stdout
```

## Scenario Format

Each scenario is a directory with three files:

```
scenarios/cursor-restrict/
├── setup.yaml       # VM config, software installation, policy setup
├── workflow.md       # Natural language narrative for LLM drivers
└── assertions.yaml   # Expected outcomes and verification steps
```

### Setup DSL (`setup.yaml`)
```yaml
name: "Cursor under Restrict policy"
vms:
  - name: endpoint-1
    template: windows-11-clean
    checkpoint: agent-installed

setup:
  - vm_install: { name: endpoint-1, package: Cursor.Cursor }
  - vm_copy_file: { src: ./policies/restrict-ai.rego, dest: C:\Example\policies\ }
  - vm_run_command: { cmd: "Restart-Service ExampleAgent" }
```

### Workflow Narrative (`workflow.md`)
Natural language instructions that an LLM driver reads and translates into tool calls:

```markdown
# Cursor Under Restrict Policy

## Context
You are testing the agent's Restrict enforcement on Cursor IDE.

## Workflow
1. **Launch Cursor** — Open Cursor from the desktop shortcut.
2. **Create a project** — Create a new folder and open it.
3. **Write code** — Create hello.py with a print statement.
4. **Test AI features** — Attempt Ctrl+Space completion. It should fail.
5. **Verify** — Cursor still runs, AI blocked, agent logged the event.
```

### Assertions (`assertions.yaml`)
```yaml
assertions:
  - type: process_running
    process: cursor.exe
  - type: restriction_active
    process: cursor.exe
    mode: AppContainer
  - type: network_blocked
    host: api.openai.com
    port: 443
  - type: agent_event
    event_type: enforcement
    action: restrict
```

## License

MIT
