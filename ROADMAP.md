# Signalman Development Roadmap

**Last Updated**: 2026-04-17
**Current Version**: Pre-release (v0.0.x)
**Target**: v0.1.0 (first public release)
**Test Count**: 59 Rust (guest) + 257 TypeScript (host, 8 files) = 316 tests
**Repo**: https://github.com/ambray/signalman.git

**2026-04-17 change**: Hyper-V is now the primary hypervisor backend (was VMware).
VMware Workstation remains a working fallback but is no longer the default in
`buildBackendList` or `signalman.yaml`. This aligns with the Example correlator's
production deployment target, which assumes Hyper-V integration services.

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

### Test Scenarios
- `silo-validation/` — Win11 silo kernel API validation (8 steps, 4 assertions)
- `silo-validation-server2022/` — Server 2022 variant
- `sandbox-enforcement/` — Full E2E: install Cursor, deploy sandbox policy, validate silo + network restrictions (11 assertions)
- `cursor-restrict/` — Cursor restriction scenario
- `codex-sandbox/` — Codex sandbox scenario

### Test Infrastructure
- 8 host test files (257 tests): sanitize, assertions, config, docker, orchestrator, reporter, scenarios, client
- 59 guest Rust tests
- TypeScript compilation clean, Clippy clean

---

## What Remains

### Phase 1: Pre-v0.1.0 Blockers

**Estimated Duration**: 5-7 days
**Status**: ~70% complete

#### 1.1 Fix Pre-existing Test Failures — ✅ DONE (commit 9f44072, 2026-04-12)
- **`client.test.ts`** — 8 failing tests fixed; full host suite is green (257 tests).
- **Effort**: S (< 1 day) — completed.

#### 1.2 CI Pipeline
- GitHub Actions workflow for:
  - `npx tsc --noEmit` (TypeScript)
  - `npx vitest run` (host tests)
  - `cargo test` (guest tests)
  - `cargo clippy -- -D warnings` (guest lint)
  - `cargo fmt --check` (guest format)
- Coverage reporting with 80% threshold
- **Effort**: S

#### 1.3 E2E Test Migration from Correlator
- Migrate the Hyper-V VM E2E test suite (currently 87 Pester tests + 4 orchestrator scripts) to use Signalman's scenario engine
- Wire `ScenarioOrchestrator` → `AssertionEvaluator` → `JUnitReporter` into a single `signalman test` CLI command
- Validate against the existing Win11 VM (DESKTOP-FAF4PL7, 172.30.0.10) — now Hyper-V-only
- **Effort**: L (3-5 days)
- **Blocked by**: 1.1 (client tests must pass first)

#### 1.4 Correlator Silo PoC Validation — NEW 2026-04-17
Scenario harness for the silo-research PoC (correlator `docs/silo-research/kernel-deep-dive/poc-usermode/`).

- New scenario: `scenarios/example-silo-poc/`
  - VM: `endpoint-1` (Win11 24H2, Containers feature **disabled**)
  - Setup: copy `silo_poc.exe` into the VM, launch via `psexec -s` as SYSTEM
  - Assertions:
    - All 5 silo-build steps return `STATUS_SUCCESS`
    - Helper process's `Global\ExampleSiloPocMutex_<pid>` is invisible from outside the silo
    - Exit code = 0
- New scenario: `scenarios/example-silo-poc-containers-on/`
  - Same VM template but with Containers feature **enabled** (control)
  - Confirms behaviour is identical → feature-gate hypothesis falsified
- **Effort**: M (1-2 days)
- **Blocked by**: 1.3 (reuses the Hyper-V VM infrastructure)
- **References**: correlator `docs/silo-research/kernel-deep-dive/07-summary-report.md`,
  `docs/silo-research/kernel-deep-dive/poc-usermode/README.md`

#### 1.4 Wire Dead Modules — ✅ DONE (commit 9f44072, 2026-04-12)
- `parseNarrative` is invoked by the scenario runner (`runner.ts:177`) and the orchestrator (`orchestrator.ts:167`).
- `writeJunitReport` is invoked by the orchestrator (`orchestrator.ts:277`) and the runner (`runner.ts:537`).
- **Effort**: S — completed.

---

### Phase 2: Docker Integration for Correlator E2E

**Estimated Duration**: 3-4 days
**Status**: Infrastructure built, integration remaining

The Docker client and `ComposeBuilder.exampleBackendStack()` factory are built. What remains:

#### 2.1 Compose Stack Validation
- Test `exampleBackendStack()` against the real correlator backend Docker image
- Validate health checks, gRPC connectivity, database initialization
- **Effort**: M

#### 2.2 Hybrid VM + Docker Scenarios
- Scenario type that spins up Docker compose (backend) + VM (agent) together
- Orchestrator needs a "compose" setup step type alongside existing VM steps
- Add `docker_compose_up` as a first-class setup action in `orchestrator.ts`
- **Effort**: M

#### 2.3 Agent Install + Backend Connect E2E
- Full scenario: Docker backend starts → VM agent installs → agent registers with backend → policy pushes → enforcement validates
- This is the critical path for correlator's silo validation testing
- **Effort**: M
- **Blocked by**: 2.1, 2.2

---

### Phase 3: Production Hardening

**Estimated Duration**: 4-5 days
**Status**: Partially addressed by audit fixes

#### 3.1 mTLS for Guest Agent
- Currently: bearer token auth (just shipped)
- Target: full mTLS with certificate validation
- Guest checks client certificate against trusted CA
- Certificate generation tooling already exists in `certs/`
- **Effort**: M

#### 3.2 MCP Server Authentication
- Document MCP security model: stdio = trusted, network = requires auth
- Add VM allow-list so MCP tools can only target approved VMs
- **Effort**: S

#### 3.3 Certificate Improvements
- Upgrade from RSA 2048 to ECDSA P-256
- Make SAN IPs configurable (currently hardcoded `172.30.0.x`)
- Certificate expiry warnings at startup
- `signalman certs renew` CLI command
- **Effort**: M

#### 3.4 VM Cache Improvements (Deferred from audit S-17)
- TTL-based cache expiry (30 seconds)
- `invalidate(name)` method called from `vm_delete`
- Prevent stale handle usage
- **Effort**: S

#### 3.5 Error Handling Polish
- `psJson()` includes original stdout in JSON parse errors
- Default 30-second deadline on all unary gRPC calls
- Structured error codes in gRPC responses
- **Effort**: S

---

### Phase 4: Protocol and API Improvements

**Estimated Duration**: 2-3 days
**Status**: Not started

#### 4.1 Proto Enhancements
- Split `ProcessStartResponse` into fire-and-forget vs wait response types
- Add `RunCommandStream` server-streaming RPC for long-running commands
- Structured error response types
- **Effort**: M

#### 4.2 Async Client Factory
- `GuestClient.connect(address, { timeout })` async factory replacing constructor
- Connection retry configuration
- **Effort**: S

#### 4.3 Scenario Matrix Support
- Single scenario definition, multiple VM targets (replace duplicate `silo-validation/` + `silo-validation-server2022/`)
- Matrix syntax in `setup.yaml`: `targets: [win11-base, windows-server-2022]`
- **Effort**: M

---

### Phase 6: Example Correlator V1-V3 Isolation Scenarios — NEW 2026-04-17

**Estimated Duration**: 6-9 days across correlator sprints
**Status**: Not started, scoped

**Network prerequisite** (captured 2026-04-17 during Win11x64 setup): the
initial silo-promotion and agent-service validation scenarios run on
`RevnTestSwitch` (isolated, static `172.30.0.10`) because the agent under
test does not need external connectivity. **Tool-detection and sandbox /
restrict scenarios from Phase 6.1 onward require internet access** —
winget for tool installation, real AI endpoint reachability for DNS + TLS
fingerprint capture, real policy enforcement against live endpoints.

Options when we reach those scenarios:
- **(b)** Move the VM to `Default Switch` (NAT, DHCP) and update affected
  scenarios' `switch:` + `static_ip:` to DHCP
- **(c)** Give the VM a second NIC: `RevnTestSwitch` for agent↔host
  telemetry + `Default Switch` for outbound internet

Option (c) is preferred because it preserves the existing host↔guest
static-IP contract for Signalman gRPC while allowing the guest outbound
traffic for tool installs. Sprint 60.7+ assumes (c) is in place.

Support scenarios for the correlator's independent isolation engine (design
doc: `correlator/docs/silo-research/kernel-deep-dive/09-isolation-architecture-design.md`).
Each V-level maps to a set of Signalman scenarios that validate the agent's
behaviour on a real Hyper-V endpoint.

#### 6.1 V1 "Observable Silo" Scenarios
- `scenarios/example-v1-silo-isolation/` — agent launches a monitored AI tool,
  promotes it to a silo, validates `\BaseNamedObjects` isolation + ETW visibility
- `scenarios/example-v1-appcontainer-compose/` — confirms silo composes with
  existing AppContainer token restriction without breaking renderer sandboxes
- **Assertions**: silo ID queryable; mutex isolation verified; telemetry batch
  delivered to backend; enforcement record shows `Silo` mode
- **Effort**: M (2-3 days)

#### 6.2 V2 "Gated Silo" Scenarios
- `scenarios/example-v2-registry-deny/` — validates ExampleReg driver denies
  writes to `HKLM\...\Run`, `...\Services`, IFEO, Scheduled Tasks
- `scenarios/example-v2-network-egress/` — validates ExampleNet WFP callout
  enforces per-silo egress allow-list + JA4 fingerprint capture
- **Assertions**: blocked writes emit audit events; allow-listed endpoint
  reachable; non-allowed endpoint TCP-RST; JA4 hash present in telemetry
- **Effort**: M (2-3 days)
- **Blocked by**: 6.1 (V1 must land first)

#### 6.3 V3 "Sandboxed Silo" Scenarios
- `scenarios/example-v3-fs-isolation/` — ExampleFs minifilter denies read of
  secret paths (`%LOCALAPPDATA%\Microsoft\Vault`, browser credential caches)
- `scenarios/example-v3-handle-filter/` — ExampleObj denies cross-silo handle opens
- `scenarios/example-v3-complex-app/` — contained Claude Cowork scenario:
  Electron main + child processes + WebView2 + terminal + MCP server spawns
  all stay within the silo; policy violations fire expected denials
- **Assertions**: secret path reads return ENOENT; child processes inherit silo;
  breakaway attempts denied; observability coverage >= 95%
- **Effort**: L (3-4 days)
- **Blocked by**: 6.2

---

### Phase 5: Ecosystem and Docs

**Estimated Duration**: 2-3 days
**Status**: Not started

#### 5.1 Documentation
- README with quickstart, architecture diagram, scenario authoring guide
- Contributing guide
- API reference for MCP tools
- **Effort**: M

#### 5.2 npm/crates.io Publishing
- Package host as `@signalman/host` npm package
- Package guest as `signalman-guest` crate
- CLI binary distribution via GitHub releases
- **Effort**: M

---

## Timeline Summary

| Phase | Duration | Status | Gate |
|-------|----------|--------|------|
| Phase 1: Pre-v0.1.0 Blockers (incl. Silo PoC) | 6-9 days | ~70% done | Must complete for v0.1.0 |
| Phase 2: Docker E2E Integration | 3-4 days | Infra built | Needed for correlator silo testing |
| Phase 3: Production Hardening | 4-5 days | ~30% done | Target v0.2.0 |
| Phase 4: Protocol Improvements | 2-3 days | Not started | Target v0.3.0 |
| Phase 5: Ecosystem and Docs | 2-3 days | Not started | Target v0.3.0 |
| Phase 6: Correlator V1-V3 Scenarios | 6-9 days | Scoped 2026-04-17 | Runs parallel to correlator V1-V3 sprints |

**Remaining effort**: ~22-31 days total (was 16-22 before Phase 6)
**Critical path**: Phase 1.3 → Phase 1.4 (Silo PoC) → Phase 2.3 → Phase 6.1 (V1 scenarios)

---

## Completed Audit Findings

All findings from the original 33-item audit + the Sprint 60 steelman audit have been addressed:

### Original Audit (33 findings)
| Status | Count | Details |
|--------|-------|---------|
| FIXED | 27 | Phases 1-3 security + functional fixes across 5 development phases |
| RESOLVED | 4 | S-23 (vmCache dedup), S-24 (tool registration), S-17 (process registry), S-18 (SafeHandle) |
| DEFERRED | 2 | S-31 (proto split), S-32 (streaming RPC) → Phase 4 |

### Sprint 60 Steelman Audit (20 findings)
| Status | Count | Details |
|--------|-------|---------|
| FIXED | 19 | S-01 through S-20 (all CRITICAL/HIGH/MEDIUM) |
| DEFERRED | 1 | S-17 (VM cache race) → Phase 3.4 |

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
