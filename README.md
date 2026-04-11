# Signalman

**VM Test Orchestration Framework for AI-Driven Workflow Testing**

Signalman enables LLM agents (Claude, etc.) and CI pipelines to launch, configure, checkpoint, and drive real-world workflow tests on virtual machines with full process and UI control.

Website: [signalman.dev](https://signalman.dev)

## Architecture

```
Claude Code / CI Runner
    |
    v
+------------------------------------------+
|  Signalman Host MCP Server               |
|  - VM lifecycle (create/start/stop/snap) |
|  - Artifact deployment                   |
|  - Software management (winget/choco)    |
|  - Multi-VM orchestration                |
|  - Hypervisor plugins                    |
+------------------+-----------------------+
                   | gRPC (mTLS)
          +--------+--------+
          |                 |
  +-------v------+  +------v-------+
  | Guest Agent  |  | Guest Agent  |
  | (Windows 11) |  | (Ubuntu)     |
  | - Process    |  | - Process    |
  | - UI Auto    |  | - UI Auto    |
  | - Browser    |  | - Browser    |
  | - Verify     |  | - Verify     |
  +--------------+  +--------------+
          |                 |
          +--------+--------+
                   | (optional)
          +--------v--------+
          | Signalman Hub   |
          | - Registry      |
          | - Web Dashboard |
          | - Fleet Mgmt    |
          +-----------------+
```

## Components

### Host MCP Server (`host/`)
TypeScript MCP server that provides VM management tools to Claude Code and other MCP-compatible clients. Includes pluggable hypervisor backends.

**Supported Hypervisors:**
- Hyper-V (Windows)
- VMware Workstation (Windows/Linux)
- Azure VMs (planned)
- AWS EC2 (planned)

### Guest Agent (`guest/`)
Rust agent that runs inside each VM, providing process control, UI automation, browser automation, and restriction verification capabilities via gRPC.

### Hub (`hub/`) — Optional
Commercial registry and dashboard for fleet-wide test orchestration. Guest agents register with the hub for discovery in complex environments.

### Scenarios (`scenarios/`)
Test definitions using a two-layer approach:
- **YAML DSL** — Machine configuration, setup steps, and assertions
- **Markdown narratives** — Natural language workflow descriptions for LLM drivers

## Quick Start

```bash
# Install the host MCP server
cd host && npm install && npm run build

# Add to Claude Code
claude mcp add signalman node host/dist/server.js

# Use in Claude Code
# "Start the test VM and install Cursor"
# "Run the cursor-restrict test scenario"
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
