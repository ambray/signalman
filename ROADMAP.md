# Signalman Development Roadmap

**Last Updated**: 2026-04-24
**Current Version**: Pre-release (v0.0.x)
**Target**: v0.1.0 (first public release as agent-first DevOps runner)
**Test Count**: 59 Rust (guest) + 257 TypeScript (host, 8 files) = 316 tests
**Repo**: https://github.com/ambray/signalman.git

**2026-04-24 strategic shift**: Signalman is being repositioned from "Example
test harness" to a first-class agent-first DevOps platform — orchestrator +
runner for security, compliance, and CI/CD workflows that agents can author
and that humans/CI can run unattended. The differentiator is **hermetic**
(cacheable runner outputs), **replayable** (agent ad-hoc work captured as
reusable scenarios), and **unattended** (orchestrator decoupled from any
agent in the loop). Example V1–V3 scenarios move to `examples/` and no longer
gate Signalman releases.

**2026-04-24 change**: Phase 6.2 V2 "Gated Silo" scenarios have landed ahead of
schedule. `example-v2-registry-deny` ships with ETW assertions, and
`example-v2-network-egress` ships with WFP-live assertions against the ExampleNet
classify callback. A bonus `example-v2-network-torture` scenario was added for
WFP stress coverage. Supporting infra also landed: kernel-debug tooling
(kd.exe session, driver_load/unload/ioctl, BreakLog, kernel_expect_bugcheck),
`kernel_etw_start/stop` MCP tools, event-driven VM orchestration with warm
checkpoint, Zod schema validation for setup.yaml/assertions.yaml, and an
ESLint flat config.

**2026-04-17 change**: Hyper-V is now the primary hypervisor backend (was VMware).
VMware Workstation remains a working fallback but is no longer the default in
`buildBackendList` or `signalman.yaml`. This aligns with the Example correlator's
production deployment target, which assumes Hyper-V integration services.

---

## Product Direction

### Vision
Agents author hermetic, replayable security/compliance/CI workflows. Humans
and CI run them unattended. Local-first; hosted orchestration is explicitly
out of scope until v0.3.0+.

### Orchestrator / Runner duality

- **Runner** (Signalman is mostly here today): given `(scenario, VM lineage,
  agent version)`, produces the same result. Hermetic, sandboxed, reportable.
- **Orchestrator**: schedules runners, holds DAG state, gates on results,
  caches at the scenario level. Today the *agent in Claude Code* plays this
  role implicitly — fine for v0.1.0 but blocks unattended CI use, so an
  explicit orchestrator graduates in v0.2.0.

### MCP surface principle (from 2026-04-24 design discussion)
The unit of agent action is a **scenario**, not a raw VM/Docker call. Six
high-level verbs (`list`, `describe`, `plan`, `run`, `record`, `status`)
collapse the permission surface from "approve 25 tools" to "approve a
scenarios directory once." Raw VM/Docker ops survive behind an
`advanced.*` capability that requires explicit opt-in and never appears in
the default agent loop.

### CLI parity
Every MCP verb has a matching CLI command. CI invokes the CLI; agents invoke
the MCP. Same execution path, same result envelope, same exit codes. Locked
in from day one (v0.1.0).

### Hermetic envelope (staged)
- **v0.1.0**: result envelope is `(scenario_hash, agent_version,
  network_class, result, events[], duration)`. VM state is documented as a
  soft input.
- **v0.2.0**: full triple `(scenario_hash, vm_lineage_hash, agent_version)`
  once ephemeral VM provisioning lands. Optional cache: same triple + pass
  → return cached result.

---

## What's Been Built (Completed Work)

### Host MCP Server (TypeScript)
- **MCP Protocol Server** (`host/src/server.ts`) — Full MCP server with tool registration, Zod schema validation, JSON schema-to-Zod bridge
- **Hypervisor Backends**:
  - Hyper-V (`hypervisors/hyperv.ts`) — Full VM lifecycle, checkpoints, file transfer, command execution, IP address resolution, heartbeat wait, memory/CPU configuration. All PowerShell commands use sanitized parameter passing.
  - VMware (`hypervisors/vmware.ts`) — Full vmrun backend with checkpoint, file transfer, command execution. Credential redaction in error messages.
  - Backend interface (`hypervisors/interface.ts`) — Shared types for VM handle, checkpoint, command result, progress callback
- **Tool System** (`tools/`) — Modular MCP tool architecture:
  - `vm-lifecycle.ts` — vm_create, vm_start, vm_stop, vm_delete, vm_list, vm_status
  - `vm-operations.ts` — vm_run_command, vm_copy_file, vm_install, vm_wait_agent
  - `vm-checkpoint.ts` — vm_checkpoint, vm_restore, vm_list_checkpoints (sanitized)
  - `docker-tools.ts` — docker_compose_up/down, docker_status, docker_logs, docker_exec, docker_wait_healthy (path-validated)
- **Input Sanitization** (`sanitize.ts`) — 7 validators: VM names, labels, paths (blocks `"`), commands, PowerShell args, URLs, timeouts
- **VM Cache** (`vm-cache.ts`) — Shared singleton cache eliminating 4 duplicate instances
- **Docker Integration** (`docker/`):
  - `client.ts` — Full Docker client: container lifecycle, compose, health, network, images. Health check command sanitization, protected env keys.
  - `compose-builder.ts` — Fluent API with `exampleBackendStack()` factory for correlator E2E
- **Scenario Engine** (`scenarios/`):
  - `assertions.ts` — 10 assertion types, JSON path resolution, 7 comparison operators, ReDoS-guarded regex
  - `orchestrator.ts` — Full lifecycle: resolve VMs → wait agents → setup → assertions → teardown
  - `runner.ts` — YAML-based scenario loading with case-insensitive path traversal protection
  - `templates.ts` — VM templates with built-in defaults (win11-base, win10-base, win11-dev)
  - `narrative.ts` — Markdown workflow parser
- **Config** (`config.ts`) — YAML config with env overrides, `maxAliasCount: 100` YAML bomb protection
- **Reporter** (`output/reporter.ts`) — JUnit XML output
- **gRPC Client** (`guest/client.ts`) — `withRetry()`, connection state tracking, per-RPC timeouts, keepalive
- **Kernel-Debug Tooling** (`kernel-debug/`) — `KdSession` (kd.exe spawn + parser), pluggable `ToolRegistry` factory, `driver_load/unload/ioctl` handlers, `BreakLog`, `kernel_expect_bugcheck`, `kernel_break_on`, auto-wired from `setup.yaml`. ESLint flat config landed.
- **ETW MCP Tools** — `kernel_etw_start` / `kernel_etw_stop` for in-scenario ETW capture; consumed by V2 registry-deny and network-egress assertions.
- **Event-Driven VM Orchestration** — warm-checkpoint flow, slow-cold-boot tolerance, surfaced `driver_last_resolved_path`; 10/10 green VM smoke.
- **Schema Validation** — Zod-validated `setup.yaml` and `assertions.yaml` loaders.

### Guest Agent (Rust)
- **gRPC Service** (`service.rs`) — 8 fully implemented RPCs:
  - Health, Register, ProcessStart/Stop/List, RunCommand, TestNetwork, TestFileAccess
  - Bearer token authentication interceptor (CLI `--token` or `SIGNALMAN_AUTH_TOKEN` env)
  - Command denylist + shell metacharacter rejection + audit logging
  - Async `tokio::process::Command` with timeout enforcement
  - Package ID validation for install_software
- **Process Management** (`process.rs`) — Process registry, SafeHandle RAII for Win32, `os_kill` with honest force=false behavior, handle-leak-free `CreateToolhelp32Snapshot`
- **File Operations** (`file_ops.rs`) — Read (100MB cap, chunked), write (path jail via `SIGNALMAN_WORKSPACE`), list directory. System directory write blocking.
- **Verification** (`verification.rs`) — Restriction verification logic
- **CLI** (`main.rs`) — `--bind`, `--token`, `--allow-insecure` flags via clap. Refuses to start without auth unless explicitly insecure.

### Test Infrastructure
- 8 host test files (257 tests): sanitize, assertions, config, docker, orchestrator, reporter, scenarios, client
- 59 guest Rust tests
- TypeScript compilation clean, Clippy clean

---

## v0.1.0 Roadmap (Path to First Public Release)

**Estimated total**: ~22-32 days
**Critical path**: P0 → P1 → P3 (P2/P4/P5/P6/P7 parallelize)

### P0: MCP Surface Inversion — NEW 2026-04-24
**Estimated Duration**: 4-5 days
**Why first**: Surface design constrains every other phase's API. Doing this
after P1 (Service) means redesigning the service interface.

- `.signalman/` project layout (mirror of `.github/workflows/`):
  - `config.yaml`, `scenarios/`, `templates/`, `recordings/` (recordings dir
    reserved for v0.2.0 record/replay)
- Six MCP verbs:
  - `signalman.list` — enumerate scenarios with hash + last-run cache
  - `signalman.describe` — return scenario YAML + workflow.md (no execution)
  - `signalman.plan` — dry-run; return step plan + affected resources
  - `signalman.run` — execute scenario; stream events; return envelope
  - `signalman.record` — **v0.1.0 ships a stub**; full impl in v0.2.0
  - `signalman.status` — environment health (service, VMs, recent runs)
- Existing fine-grained tools (`vm_*`, `docker_*`) move behind
  `signalman.advanced.*` namespace; default agent loop never sees them.
- CLI commands mirror MCP verbs: `signalman list`, `signalman run <scenario>`,
  `signalman plan <scenario>`, `signalman status`. Same execution path,
  same envelope, same exit codes.
- Scenario hash (SHA-256 over canonicalized YAML + workflow.md) recorded
  in result envelope.
- **Effort**: M

### P1: Hyper-V Control-Plane Service — NEW 2026-04-24
**Estimated Duration**: 5-8 days
**Why critical**: Per-call gsudo prompts make the system unusable for
agent-driven workflows. Confirmed by 2026-04-24 elevation audit:
gsudo's daemon path is unreliable from detached Node children, so every
PowerShell call re-elevates via Direct COM. Single highest-leverage move.

- Windows service (Rust preferred; parity with guest agent toolchain):
  - Named-pipe + localhost gRPC endpoints, both with mTLS
  - One-time install grant replaces N per-call UAC prompts
  - Service validates inputs (VM names, paths, args) — sanitization moves
    here, host stays a thin client
- MSI installer with signed binary; service runs under dedicated account
  with minimum Hyper-V Admin privileges (SID `S-1-5-32-578`).
- Host MCP becomes a thin client; backend interface gains a `service`
  transport alongside the existing `direct` PowerShell path.
- VMware backend unchanged (no elevation needed; remains thin-client only).
- Cross-platform daemon design (libvirt on Linux, vmrun on macOS) deferred
  to v0.3.0+; the protocol is designed to admit them.
- **Effort**: L

### P2: Orchestrator Polish (Surgical) — REVISED 2026-04-24
**Estimated Duration**: 2-3 days
**Why constrained**: The 2026-04-24 audit found `f1c1f93` already did the
heavy lifting (10/10 smoke, 189s vs. 954s, state mutations now block on
`Wait-Job` against CIM events). Two real polling gaps remain; everything
else is stable.

- Replace `waitForHeartbeat()` polling with `Register-CimIndicationEvent`
  on `Msvm_HeartbeatComponent` — closes the only avoidable polling site
  ([hyperv.ts:610](host/src/hypervisors/hyperv.ts:610)).
- Make warm-checkpoint the default (already proven: 189s vs. 954s smoke).
- VM cache TTL (30s) + `invalidate(name)` from `vm_delete` (Phase 3.4
  carry-over).
- **Not addressed**: `waitForGuestAgents()` polling
  ([orchestrator.ts:1309](host/src/scenarios/orchestrator.ts:1309)) — gRPC
  has no server-push primitive; deferred until guest exposes a readiness
  stream (proto change, post-v0.1.0).
- **Effort**: S

### P3: Agent UX Baseline — NEW 2026-04-24
**Estimated Duration**: 3-5 days

- Structured gRPC error envelope (codes + machine-readable detail)
  replacing today's stringly-typed errors.
- Scenario-level retry policy in `setup.yaml` (`retry: { count, backoff }`).
- Result envelope `{scenario_hash, agent_version, network_class, result,
  events[], duration}` — emitted from CLI and MCP run paths. **v0.1.0 ships
  scenario-hash + agent-version only**; full hermetic triple lands in
  v0.2.0 with ephemeral VMs. VM state is documented as a soft input until
  then.
- Streaming events during run (not just final exit code) so the agent can
  react step-by-step.
- Tool descriptions tightened for in-context cost (every turn pays).
- **Effort**: M

### P4: Security Baseline for Product
**Estimated Duration**: 3-5 days
**Status**: Partially addressed by audit fixes; first-class-product gaps
identified 2026-04-24.

- mTLS for guest agent (carry-over from old Phase 3.1).
- MCP transport auth model: stdio = trusted (current), network = mTLS +
  VM allow-list. Documented and enforced.
- Scenario YAML capability declaration: a scenario declares which
  hosts/VMs/networks it touches; runner refuses to execute outside its
  declared scope. Closes the "scenarios are unsigned and fully privileged"
  gap.
- Secret primitive: `${secret:NAME}` reference in scenario YAML, resolved
  at run time from a host-side keychain or env, never persisted in logs
  or recordings.
- ECDSA P-256 cert upgrade + configurable SAN IPs (carry-over from old
  Phase 3.3).
- **Effort**: M

### P5: Loom Plugin — NEW 2026-04-24
**Estimated Duration**: 2-4 days
**Why later**: Loom (`E:\source\repos\loom`) is pre-initial-commit. Don't
co-couple lifecycles. Integration is over a stable contract.

- Loom plugin (Rust crate + Deno shim) registers `signalman.*` MCP tools
  via Loom's `McpToolRegistration` capability.
- Loom directives surface a "use Signalman for VM-based validation"
  default for Claude Code / Codex.
- Loom event bus (`loom-events`) emits Signalman lifecycle events
  (`signalman.run.started/finished`) for `task_start` / `follow_through`
  consumption.
- Integration is **sibling-MCP**, not embedded. Signalman remains its own
  crate / npm package.
- **Effort**: S–M

### P6: Packaging + Docs
**Estimated Duration**: 3-4 days

- Signed MSI for the service (P1 dep).
- npm package `@signalman/host` (or just `signalman`).
- crates.io `signalman-guest`.
- README quickstart, scenario-authoring guide, MCP setup guide for Claude
  Code (`.claude/settings.json` example, permission model).
- **Effort**: M

### P7: CI Pipeline (carry-over from old Phase 1.2)
**Estimated Duration**: 1-2 days

- GitHub Actions: `tsc --noEmit`, `vitest run`, `cargo test`,
  `cargo clippy -- -D warnings`, `cargo fmt --check`.
- Coverage reporting with 80% threshold.
- **Effort**: S

---

## v0.2.0 Roadmap

These are the primitives that make "agent-first DevOps" actually new.
Deferred from v0.1.0 per 2026-04-24 decision to keep first release
shippable.

### v0.2.0-1: Record / Replay
**Estimated Duration**: 5-7 days

- `signalman.record` captures next N MCP calls into `.signalman/recordings/`
  as a candidate scenario YAML + workflow.md.
- Promotion flow: human reviews recording → moves to `scenarios/`.
- This is the primitive that makes "agent-first DevOps" a real
  differentiator: ad-hoc agent work becomes reusable, hermetic infra.
- **Effort**: L

### v0.2.0-2: Ephemeral VM Provisioning
**Estimated Duration**: 5-8 days

- Differencing-disk pipeline (Hyper-V `New-VHD -ParentPath`).
- Base-image catalog (`templates/` directory, content-addressed).
- Per-scenario disposable guests; VM lineage hash recorded in result
  envelope.
- Removes hand-pinned `DESKTOP-FAF4PL7` dependency (acceptable for v0.1.0
  per 2026-04-24 decision; required for true repeatability).
- **Effort**: L

### v0.2.0-3: Hermetic Envelope (full triple)
**Estimated Duration**: 1-2 days (depends on v0.2.0-2)

- Result envelope graduates to `(scenario_hash, vm_lineage_hash,
  agent_version, network_class, result, events[], duration)`.
- Optional cache: same triple + pass → return cached result.
- **Effort**: S

### v0.2.0-4: Explicit Orchestrator
**Estimated Duration**: 5-7 days

- Workflow YAML defining a DAG of scenario invocations + gates.
- Scheduler runs without an agent in the loop (cron / Actions / Loom).
- State management for in-flight runs.
- Up-to-control-plane reporting (JSON / OpenTelemetry).
- This is where "agent-first" extends to "unattended-capable."
- **Effort**: L

---

## v0.3.0+ (Speculative)

- Cross-platform daemon (libvirt on Linux, vmrun wrapper on macOS).
- Scenario matrix support (carry-over from old Phase 4.3 — defer until
  duplicate-scenario pain is real).
- Proto enhancements: split `ProcessStartResponse`, `RunCommandStream`
  (carry-over from old Phase 4.1).
- Hosted orchestration / control plane (explicit non-goal until
  local-first loop is undeniable).

---

## Examples (no longer gate releases)

These live in `examples/` and consume Signalman as a public dependency.
Their delivery cadence is decoupled from Signalman semvers — Example team
owns the schedule.

### Network prerequisite (captured 2026-04-17)
The initial silo-promotion and agent-service validation scenarios run on
`RevnTestSwitch` (isolated, static `172.30.0.10`) because the agent under
test does not need external connectivity. **Tool-detection and sandbox /
restrict scenarios require internet access** — winget for tool installation,
real AI endpoint reachability for DNS + TLS fingerprint capture, real
policy enforcement against live endpoints.

Options when reaching those scenarios:
- **(b)** Move the VM to `Default Switch` (NAT, DHCP) and update affected
  scenarios' `switch:` + `static_ip:` to DHCP.
- **(c)** Give the VM a second NIC: `RevnTestSwitch` for agent↔host
  telemetry + `Default Switch` for outbound internet.

Option (c) is preferred because it preserves the existing host↔guest
static-IP contract for Signalman gRPC while allowing the guest outbound
traffic for tool installs.

### Example Correlator V1–V3 Isolation Scenarios

Reference: `correlator/docs/silo-research/kernel-deep-dive/09-isolation-architecture-design.md`.
Each V-level maps to a set of Signalman scenarios that validate the
correlator agent's behaviour on a real Hyper-V endpoint.

#### V1 "Observable Silo" (not started)
- `examples/example-v1-silo-isolation/` — agent launches a monitored AI
  tool, promotes it to a silo, validates `\BaseNamedObjects` isolation +
  ETW visibility.
- `examples/example-v1-appcontainer-compose/` — confirms silo composes with
  existing AppContainer token restriction without breaking renderer
  sandboxes.
- **Assertions**: silo ID queryable; mutex isolation verified; telemetry
  batch delivered to backend; enforcement record shows `Silo` mode.

#### V2 "Gated Silo" — ✅ DONE (2026-04-22 → 2026-04-24)
- `examples/example-v2-registry-deny/` — landed with real ETW assertions
  (commits `1c57ff5`, `7073372`); driver-last-path-captured assertion
  retired in `72debe6` after Sprint 60.11 DIAG removal.
- `examples/example-v2-network-egress/` — landed pre-WFP (`8df8736`), then
  upgraded to WFP-live classify-callback assertions (`9308530`), renamed
  to reflect post-dispatcher-fix state (`277b046`), audit-cleaned
  (`2600333`).
- `examples/example-v2-network-torture/` — bonus scenario added in
  `9308530` for WFP stress coverage.
- **Outstanding**: JA4 fingerprint capture (carved out of network-egress;
  awaits correlator JA4 hashing path).
- **Note**: scenarios currently live under `scenarios/` and will be moved
  to `examples/` as part of P0 surface inversion.

#### V3 "Sandboxed Silo" (not started)
- `examples/example-v3-fs-isolation/` — ExampleFs minifilter denies read of
  secret paths (`%LOCALAPPDATA%\Microsoft\Vault`, browser credential caches).
- `examples/example-v3-handle-filter/` — ExampleObj denies cross-silo handle
  opens.
- `examples/example-v3-complex-app/` — contained Claude Cowork scenario:
  Electron main + child processes + WebView2 + terminal + MCP server
  spawns all stay within the silo; policy violations fire expected denials.
- **Assertions**: secret path reads return ENOENT; child processes inherit
  silo; breakaway attempts denied; observability coverage ≥ 95%.

### Correlator Silo PoC (not started)
- `examples/example-silo-poc/` — VM `endpoint-1` (Win11 24H2, Containers
  feature **disabled**); copy `silo_poc.exe`, launch via `psexec -s` as
  SYSTEM. All 5 silo-build steps return `STATUS_SUCCESS`; helper process's
  `Global\ExampleSiloPocMutex_<pid>` invisible from outside the silo;
  exit code = 0.
- `examples/example-silo-poc-containers-on/` — same template with
  Containers feature **enabled** (control). Confirms behaviour is
  identical → feature-gate hypothesis falsified.
- References: correlator `docs/silo-research/kernel-deep-dive/07-summary-report.md`,
  `docs/silo-research/kernel-deep-dive/poc-usermode/README.md`.

---

## Timeline Summary

| Phase | Duration | Status | Gate |
|-------|----------|--------|------|
| P0: MCP Surface Inversion | 4-5d | New | Constrains all other v0.1.0 APIs |
| P1: Hyper-V Service | 5-8d | New | Kills gsudo; required for agent UX |
| P2: Orchestrator Polish | 2-3d | Surgical | f1c1f93 already did the heavy lift |
| P3: Agent UX Baseline | 3-5d | New | Result envelope (scenario-hash + agent-version) |
| P4: Security Baseline | 3-5d | ~30% done | Capability decl + secrets primitive |
| P5: Loom Plugin | 2-4d | New | Sibling MCP, decoupled lifecycle |
| P6: Packaging + Docs | 3-4d | Not started | MSI, npm, crate, quickstart |
| P7: CI Pipeline | 1-2d | Not started | Carry-over from old 1.2 |
| v0.2.0: Record/Replay | 5-7d | Deferred | The agent-first differentiator |
| v0.2.0: Ephemeral VMs | 5-8d | Deferred | True repeatability |
| v0.2.0: Hermetic Envelope | 1-2d | Deferred | Depends on Ephemeral VMs |
| v0.2.0: Explicit Orchestrator | 5-7d | Deferred | Unattended CI use case |

**v0.1.0 effort**: ~22-32 days
**v0.1.0 critical path**: P0 → P1 → P3 (everything else parallelizes)
**v0.2.0 effort**: ~16-24 days
**v0.2.0 critical path**: Ephemeral VMs → Hermetic Envelope; Record/Replay
and Explicit Orchestrator parallelize.

---

## Cuts and Deferrals (2026-04-24)

Removed from main roadmap; revisit only with concrete evidence of need.

- **Old Phase 1.3 (E2E test migration from correlator)**: now an
  `examples/` task tracked by the Example team, not by Signalman.
- **Old Phase 1.5 (Silo PoC)**: same — moved to `examples/`.
- **Old Phase 2.1–2.3 (Docker E2E)**: absorbed into P0/P3 — Docker becomes
  a scenario primitive alongside VMs. No standalone phase.
- **Old Phase 4.1 (proto split, RunCommandStream)**: deferred to v0.3.0+
  — current proto is fine; revisit when streaming RPCs are needed by a
  real consumer.
- **Old Phase 4.3 (matrix support)**: deferred until duplicate scenarios
  become an actual pain point.
- **Old Phase 5 (npm/crates publishing)**: rolled into P6.

---

## Completed Audit Findings

All findings from the original 33-item audit + the Sprint 60 steelman audit have been addressed:

### Original Audit (33 findings)
| Status | Count | Details |
|--------|-------|---------|
| FIXED | 27 | Phases 1-3 security + functional fixes across 5 development phases |
| RESOLVED | 4 | S-23 (vmCache dedup), S-24 (tool registration), S-17 (process registry), S-18 (SafeHandle) |
| DEFERRED | 2 | S-31 (proto split), S-32 (streaming RPC) → v0.3.0+ |

### Sprint 60 Steelman Audit (20 findings)
| Status | Count | Details |
|--------|-------|---------|
| FIXED | 19 | S-01 through S-20 (all CRITICAL/HIGH/MEDIUM) |
| DEFERRED | 1 | S-17 (VM cache race) → P2 |

### Security Posture
- Bearer token authentication on guest agent
- Command denylist + metacharacter rejection
- Async command execution with enforced timeouts
- Path jail for file writes
- 100MB read cap
- SafeHandle for all Win32 handles
- Input sanitization at tool handler + backend layers
- YAML bomb protection
- ReDoS guards on user-supplied patterns
- Docker compose path traversal prevention
- Protected environment variables
