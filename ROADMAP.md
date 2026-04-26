# Signalman Development Roadmap

**Last Updated**: 2026-04-26
**Current Version**: Pre-release (v0.0.x)
**Target**: v0.1.0 (first public release as agent-first DevOps runner)
**Test Count**: 151 Rust (guest/service) + 769 TypeScript (host) = 920 tests
**Repo**: https://github.com/ambray/signalman.git

**2026-04-26 Mac virtualization decision**: macOS VM support starts with a
Tart-backed host backend (`host/src/hypervisors/tart.ts`) rather than a
first-party Swift daemon. Rationale: Apple's Virtualization.framework requires a
signed/entitled caller, Tart already packages that surface and provides clone,
run, stop, IP lookup, image registry, and `tart exec` command execution. This
unblocks v0.1.x Mac runner experiments while preserving a v0.2+ path to a
service-like Swift helper if Signalman needs its own mTLS identity, code-signing
story, or deeper VM-state control. See `docs/mac-virtualization.md`.

**2026-04-25 audit pass**: Four-lens audit (QA / Architecture / PM / Security)
distributed into existing phases. P0 and P1 confirmed merged. P3, P4, P7 re-scoped
with concrete deliverables. New P8 added for a one-shot proto v1 freeze before
v0.1.0 publishes. Hub component (`hub/`) — 122 LOC of TODOs — slated for
extraction to a sibling repo. UI/Browser/Verify guest RPCs remain proto
placeholders returning `unimplemented`. `template:` field is decorative until
v0.2.0-2 ephemeral VM provisioning lands; documented as known. Two Critical
security findings (mTLS authenticates the channel not the caller; cert
bundle written with default ACLs) folded into P4 with explicit sub-items.

**2026-04-25 architecture decision (Loom-fronted agent surface)**: Loom has
shipped its plugin contract (`PluginCapability::RegisterMcpTools`,
`McpToolRegistration`, `EventBus`, `TaskOwnership` persistence, descriptor-
backed TUI command forms, `loom-workflows` task lifecycle). Signalman now
adopts a **Loom-fronted topology**: agents (Claude Code / Codex) talk MCP
to **Loom**, which is the state holder and the operator console; Loom drives
**Signalman** as a runner for scenario execution. Implications:

- The agent's primary MCP surface is `loom.*` tools (registered by the
  Signalman Loom plugin). The native `signalman.*` MCP server (`host/`)
  remains shipping for direct CLI/CI use, but is no longer the default
  agent surface in v0.1.0 docs and quickstart.
- **P5 is promoted to v0.1.0 critical path**, expanded into sub-phases.
  Was 2-4d "later"; now 4-7d defining the agent UX.
- **P3 trims** several deliverables that Loom now provides as substrate
  (live event streaming → Loom `EventBus`; run-handle persistence →
  Loom `TaskOwnership` shape; trace-id → Loom `TelemetryEvent.labels`;
  structured errors → Loom `LoomError`/sync-state pattern).
- **v0.2.0-4 Explicit Orchestrator** is largely subsumed by Loom workflows
  + `loom tui`. Signalman-side scope drops from 5-7d to ~2-3d "expose
  scenario state via Loom workflow primitives."
- **Hub** continues as a sibling-repo extraction (Loom is effectively the
  hub for the v0.1.0 timeframe).

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
  - Tart (`hypervisors/tart.ts`) — macOS-on-Apple-Silicon runner backend: clone-based creation, headless start/stop, IP lookup, `tart exec` command execution, suspend/resume, and clone-emulated checkpoints. Scenario file copy uses the Signalman guest agent when available; backend-level Tart copy remains a future shared-directory/SSH/SCP/Tart-copy concern.
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
- **macOS guest bootstrap** (`scripts/macos/install-guest-agent.sh`) — LaunchDaemon installer for root command/file control inside Tart macOS guests.
- **Verification** (`verification.rs`) — Restriction verification logic
- **CLI** (`main.rs`) — `--bind`, `--token`, `--allow-insecure` flags via clap. Refuses to start without auth unless explicitly insecure.

### Test Infrastructure
- 29 host test files (769 tests)
- 151 Rust tests across guest and service crates
- TypeScript compilation clean; ESLint clean with existing unused-disable warnings

---

## v0.1.0 Roadmap (Path to First Public Release)

**Estimated total**: ~22-32 days
**Critical path**: P0 → P1 → P3 (P2/P4/P5/P6/P7 parallelize)

### P0: MCP Surface Inversion — ✅ MERGED 2026-04
**Estimated Duration**: 4-5 days
**Status**: Merged. Six verbs registered ([host/src/server.ts:251-320](host/src/server.ts:251)),
advanced namespace gated with deprecation aliases, scenario hash + envelope
shipping, CLI parity in place. `signalman.record` ships as the documented stub.
**Why first** (historical): Surface design constrains every other phase's API.

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

### P1: Hyper-V Control-Plane Service — ✅ MERGED 2026-04 (with audit closure)
**Estimated Duration**: 5-8 days
**Status**: Merged. Rust crate, named-pipe + TCP transports, mTLS, MSI scaffold,
Windows SCM lifecycle. **Audit closure (A2)**: `default-executor.ts` does not
use the service-backend selection that exists in `server.ts`, so
`signalman.run` silently bypasses the service. ~0.5d to wire and verify.
**Why critical** (historical): Per-call gsudo prompts make the system unusable
for agent-driven workflows. gsudo's daemon path is unreliable from detached
Node children, so every PowerShell call re-elevates via Direct COM.

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

### P2: Orchestrator Polish (Surgical) — REVISED 2026-04-25
**Estimated Duration**: 3-4 days (was 2-3d; +1d for audit-driven cleanup)
**Why constrained**: The 2026-04-24 audit found `f1c1f93` already did the
heavy lifting (10/10 smoke, 189s vs. 954s, state mutations now block on
`Wait-Job` against CIM events). Polling gaps and orphan handling remain.

- Replace `waitForHeartbeat()` polling with `Register-CimIndicationEvent`
  on `Msvm_HeartbeatComponent` — closes the only avoidable polling site
  ([hyperv.ts:610](host/src/hypervisors/hyperv.ts:610)).
- Make warm-checkpoint the default (already proven: 189s vs. 954s smoke).
- VM cache TTL (30s) + `invalidate(name)` from `vm_delete` (Phase 3.4
  carry-over).
- **Audit C7**: cleanup/orphan reaper. Failed scenarios leave VMs `Running`;
  `executeSetup` failures don't trigger teardown; no orphan reaper for VMs
  spawned by failed `vm_create`; no GC on `.signalman/recordings/`; no
  `kd.exe` reaper if the host process dies before
  `teardownKernelDebugSessions`. Add a try/finally revert-to-pre-run guard
  and a process-exit cleanup hook.
- **Audit F1**: parallelize `waitForGuestAgents` per VM
  ([orchestrator.ts:1291-1334](host/src/scenarios/orchestrator.ts:1291)) —
  currently sequential `for (const def of vmDefs)`.
- **Not addressed**: `waitForGuestAgents` server-push readiness — gRPC has
  no push primitive; deferred until guest exposes a readiness stream (proto
  change, see P8).
- **Effort**: S–M

### P3: Agent UX Baseline — RE-SCOPED 2026-04-25 (twice)
**Estimated Duration**: 3-5 days (audit had pushed to 6-9d; the Loom-fronted
architecture decision moves C1/C2/C10 to P5 where they close via Loom
substrate, so P3 returns to roughly its original budget)
**Status**: ~50%. Surface, envelope, and streaming-via-Loom shipped through
P5; in-Signalman residual deliverables are smaller.

**Originally listed, confirmed shipped:**
- Result envelope (`scenario_hash`, `agent_version`, `network_class`,
  `events[]`, `duration`) emitted from CLI and MCP run paths.
- Tool descriptions tightened for in-context cost.

**Moved to P5 (closed via Loom substrate, not Signalman-native):**
- ~~C1 Run-handle persistence~~ → **closes via P5.2** (Loom task ownership
  holds the run handle; Signalman writes its own state file but is no longer
  the system of record for "is this run alive").
- ~~C2 Live event streaming~~ → **closes via P5.3** (Signalman emits into
  Loom `EventBus`; agents subscribe via Loom MCP). Signalman still needs
  the orchestrator-side hook (the `(event) => void` callback into
  `runScenario`, deleting the retrospective replay in
  [default-executor.ts:53-80](host/src/verbs/default-executor.ts:53)) —
  that ~1d of Signalman work stays in P3 but the consumer is Loom.
- ~~C10 Trace-id propagation~~ → **closes via P5.3** (label on
  Loom `TelemetryEvent`). Signalman still injects the `signalman-trace-id`
  gRPC header for in-process correlation between host/service/guest;
  ~0.5d. Loom collates across producers.

**Still in P3 (Signalman-native deliverables):**
- **C2-residual — Orchestrator event-emission hook.** Wire
  `(event) => void` into `runScenario`; push events from inside
  `executeSetup`/`executeToolBlock`/assertion eval; delete the replay
  loop. The Loom plugin is the consumer; this is just the producer side.
  ~1d.
- **C5 — Scenario-level retry policy** in `setup.yaml`
  (`retry: { count, backoff }`). Not Loom-substrate-replaceable; lives
  inside the orchestrator. ~1d.
- **C6 — Structured gRPC error envelope** (codes + machine-readable
  detail) replacing stringly-typed errors. The Loom plugin will surface
  these as Loom `LoomError` shapes, but the structured emit is
  Signalman's job. ~1-2d.
- **C10-residual — `signalman-trace-id` gRPC header propagation**
  host→service→guest with `tracing` span echoes on the Rust side. ~0.5d.

- **Effort**: S–M (3-5 days)
- **v0.1.0 boundary**: full hermetic triple (`vm_lineage_hash`) still
  deferred to v0.2.0; VM state remains a soft input until ephemeral VMs land.

### P4: Security Baseline for Product — RE-SCOPED 2026-04-25
**Estimated Duration**: 9-11 days (was 3-5d; +6d for audit Critical/High
findings + capability/secrets enforcement that were stubs)
**Status**: ~30%. mTLS landed; ECDSA P-256 landed; capability + secrets
parse but don't enforce; two Critical findings open from audit.

**Originally listed, confirmed shipped:**
- mTLS for guest agent (P4 partial merge).
- ECDSA P-256 cert upgrade + configurable SAN IPs.

**P4.1 — Critical/High audit hardening (close before v0.1.0 publishes):**
- **B1 / Sec F2 (Critical) — Cert ACL hardening.** `tls::ensure_certs`
  ([service/src/tls.rs:83-91](service/src/tls.rs:83)) writes `ca.key`,
  `server.key`, `client.key` with default ACLs into `%ProgramData%\Signalman\certs\`
  — `Authenticated Users:R` by inheritance. Any local user can copy the
  bundle and drive the elevated daemon. Add `SetSecurityInfo` (or
  `icacls /inheritance:r /grant SYSTEM:F /grant Administrators:F /grant
  <ServiceAcct>:R`) at install time. Single highest-value security fix.
- **B2 / Sec F1 (Critical mitigation) — Pin client-cert SHA-256 (or DN
  allowlist) on the guest.** Today mTLS authenticates the *channel*, not
  the *caller*; any cert chained to the configured CA grants full SYSTEM
  RCE. Pinning turns "any cert from this CA" into "this exact cert";
  rotation becomes "update the pinned hash." Per-user identity certs ship
  in v0.2.0+.
- **B3 / Sec F3 (High) — `--allow-insecure` loopback enforcement.** Doc
  comment ([guest/src/main.rs:46-49](guest/src/main.rs:46)) claims
  loopback-only; parser accepts `0.0.0.0`. Add
  `if cli.allow_insecure && !addr.ip().is_loopback() { error!(...); exit(1); }`
  before listener bind.
- **B4 / Sec F4 (High) — `process_start` denylist + metachar parity.**
  `run_command` enforces both ([guest/src/service.rs:457-468](guest/src/service.rs:457));
  `process_start` does not, and `process_start(run_as="system")` is the
  more dangerous primitive. Mirror the checks before the SYSTEM branch.
- **B5 / Sec F5 (High) — Drop `cmd.exe /C` SYSTEM path.** `run_command`
  with `run_as=system` shells through `cmd.exe /C`
  ([guest/src/service.rs:471-499](guest/src/service.rs:471)), restoring
  metacharacter interpretation (`>`, `<`, `(`, `)`, `^`, `%VAR%`) the
  denylist doesn't cover. Pass `args` as true argv via
  `CreateProcessAsUserW` without `cmd.exe`.
- **B6 / Sec F6 (High) — Named-pipe `SECURITY_DESCRIPTOR`.**
  [service/src/transport.rs:166-188](service/src/transport.rs:166) creates
  the pipe with bare `ServerOptions::new()` — no `SECURITY_ATTRIBUTES`.
  Build an SD allowing only the service account + Hyper-V Admins; log
  connecting PID via `GetNamedPipeClientProcessId`.

**P4.2 — Medium-severity defense in depth:**
- **B7 / Sec F7** — Constant-time bearer-token compare
  ([guest/src/main.rs:108-114](guest/src/main.rs:108)).
- **B8 / Sec F8** — Pin TLS min-version (TLS 1.3) explicitly in tonic config.
- **B9 / Sec F9** — Replace substring denylist with positive allowlist (or
  remove). Naive case-sensitive `contains` is bypassed by `format C:`,
  `cipher /w`, encoded PowerShell, etc. False confidence > no list.
- **B10 / Sec F10** — `file_ops.rs` path checks: case-insensitive,
  prefix-canonical (today: case-sensitive prefix string match,
  [guest/src/file_ops.rs:21-160](guest/src/file_ops.rs:21)).
- **B11 / Sec F11** — Strip credentials from `AUDIT: run_command` logs;
  redact known sensitive arg patterns
  ([guest/src/service.rs:441-446](guest/src/service.rs:441)).

**P4.3 — Capability and secrets ENFORCEMENT (originally listed, were stubs):**
- **C3 — Capability declaration enforcement.** Scenario YAML
  `capabilities:` block parses ([host/src/verbs/plan.ts](host/src/verbs/plan.ts))
  but the runner does not refuse to execute outside declared scope. Wire
  the gate.
- **C4 — Secret primitive resolution.** `${secret:NAME}` parses but does
  not resolve from a host-side keychain or env. Implement and ensure
  zero log/recording leakage.

**P4.4 — Supply chain and lifecycle:**
- **B12 / Sec F15** — Pin GitHub Actions by SHA, not tag (e.g.
  `arduino/setup-protoc@v3` → SHA pin). Touches CI; coordinate with P7.
- **B13 / Sec F14** — Document `protoc-bin-vendored` supply-chain stance
  or replace with pinned-checksum source.
- **F3 — Cert rotation story** (lifecycle, not just initial gen).

**P4.5 — Originally listed, confirmed in scope:**
- MCP transport auth model: stdio = trusted (current), network = mTLS +
  VM allow-list. Documented and enforced.
- **Effort**: L

### P5: Loom Plugin (Agent-Front Surface) — PROMOTED 2026-04-25
**Estimated Duration**: 4-7 days (was 2-4d "later"; now v0.1.0 critical
path because Loom is the agent's MCP surface and Signalman is the runner
Loom invokes)
**Why now**: Loom origin/main has shipped a stable plugin contract
(`PluginCapability::RegisterMcpTools`, `McpToolRegistration`, `EventBus`,
`TaskOwnership`, descriptor-backed TUI forms). The "pre-initial-commit
Loom" caveat from 2026-04-24 is obsolete. The integration model is now:
agent → Loom MCP → Loom plugin → Signalman CLI/MCP → VM.

**P5.1 — Plugin manifest + MCP tool registration:**
- Implement `TrustedPlugin` for Signalman in a new `signalman-loom-plugin`
  crate. Manifest declares
  `PluginCapability::RegisterMcpTools` and
  `PluginCapability::RunSubprocess { allowlist: ["signalman", "node"] }`.
- Register `loom.signalman.list/describe/plan/run/record/status` via
  `McpToolRegistration` (mirroring Signalman's six native verbs but
  scoped to Loom's tool namespace). Input/output schemas reuse Signalman's
  Zod-derived JSON schemas; handler shells out to the Signalman CLI.
- Mark stability `Experimental` for v0.1.0; `Stable` once contract bakes.

**P5.2 — Scenario ↔ Loom Task mapping:**
- A `signalman.run` invocation creates a Loom task (or attaches to an
  existing one). Loom owns the run handle via `TaskOwnership`-shaped
  state instead of Signalman's in-memory `Map`. **This is how P3-C1
  closes** — Signalman doesn't build its own persistence; the Loom plugin
  records run state into `.loom/`-managed task state with the
  `TaskOwnershipStatus` reconciliation shape (Claimed / Current /
  Collision / Unknown adapted to "Started / Streaming / Finished /
  Lost / Stale").
- Loom task-resume continuity (`TaskResumeRequest`/`TaskResumeResult`)
  surfaces in-flight runs after host restart; Signalman just needs to
  redrive the run from its persisted state file.

**P5.3 — Live event streaming via Loom EventBus:**
- Signalman emits envelope events (step start/finish, assertion
  pass/fail, error, run finished) into Loom's `EventBus` with a
  `signalman.run.<phase>` event kind taxonomy. **This is how P3-C2
  closes** — agents subscribe via `EventBus.subscribe(filter)` instead
  of Signalman building a streaming event protocol of its own.
- Trace-id flows as a `TelemetryEvent.labels["signalman-trace-id"]`
  entry; one event-bus `repo_id` correlates all phases of a run.
  **This is how P3-C10 closes.**

**P5.4 — Descriptor-backed scenario forms in `loom tui`:**
- Each Signalman scenario exposes a Loom form descriptor (analogous to
  `form.task.start`) so the operator console renders scenarios as guided
  forms. Required parameters (scenario id), optional parameters
  (overrides, `${secret:NAME}` resolution), and validated fields drop in
  with no TUI changes.
- Status indicators (running / passed / failed / lost) feed the active-
  work dashboard via Loom task attention state.

**P5.5 — Directives + agent guidance:**
- A Loom directive (e.g. `validate-on-vm`) surfaces "use Signalman for
  VM-based validation" defaults for Claude Code / Codex through Loom's
  existing directive mechanism. Replaces the current
  "approve a scenarios directory once" capability prompt with a
  Loom-native "approve the Signalman plugin once."

**Topology and boundaries:**
- Integration remains **process-isolated**: the plugin shells out to the
  Signalman CLI binary (or speaks to its MCP stdio transport). Signalman
  is not embedded as a Rust dependency of Loom; lifecycles stay
  independent.
- Native `signalman.*` MCP server (`host/`) keeps shipping for CI and
  direct-CLI/MCP consumers. README quickstart leads with Loom; an
  "advanced / standalone" section keeps the direct path documented.
- The `signalman.advanced.*` tools are NOT re-exposed through Loom —
  they remain behind the standalone MCP server's advanced namespace and
  are off the default agent loop.

- **Effort**: M (4-7 days)

### P6: Packaging + Docs — RE-SCOPED 2026-04-25
**Estimated Duration**: 5-7 days (was 3-4d; +2d for README scrub and
test-strategy doc)

**Originally listed:**
- Signed MSI for the service (P1 dep).
- npm package `@signalman/host` (or just `signalman`).
- crates.io `signalman-guest`.
- README quickstart, scenario-authoring guide, MCP setup guide for Claude
  Code (`.claude/settings.json` example, permission model).

**New from 2026-04-25 audit ("make the README true"):**
- **A3 — README scrub.** Remove claims of Azure VMs, AWS EC2, Hub fleet
  management, scenario marketplace, UI automation, browser automation,
  Linux/macOS guest agents. They are not built and they distort
  positioning. Reframe as Windows-first; move aspirational items to a
  "v0.3.0+ non-promise" section. Sharpen positioning to **Windows
  kernel-driver / ETW / WFP / silo CI for security products** — the niche
  the kernel-debug + ETW tooling actually serves.
- **A4 — Replace cursor-restrict as the lead README scenario.** Today's
  lead is broken: missing `restrict-ai.rego`, missing `test-config.yaml`,
  uses `vm_screenshot` 5× (the RPC is a stub), and `screenshot_check`
  assertions are no-ops. Replace with `silo-validation` or a pared
  `example-v2-network-egress`. Or ship the missing files plus real
  screenshot capture, but only if UI/browser placeholders graduate.
- **A5 — Hide or complete `.signalman/scenarios/codex-sandbox/`** (ships
  `setup.yaml` only; no workflow.md, no assertions.yaml; `signalman.list`
  surfaces it as a discoverable broken entry).
- **A6 — Move/repath absolute `E:\source\repos\correlator\...` references
  in `examples/` to portable paths or document them as in-tree fixtures.**
- **D5 — `docs/testing.md` test-strategy doc.** How to add tests at each
  level (unit / integration / system / smoke / E2E), how to run the gated
  E2E lane, what mock vs. real means in this repo. Closes the missing
  test-strategy artifact.
- Document `template:` field as decorative until v0.2.0-2 ships
  ephemeral-VM provisioning. Today the orchestrator never calls
  `resolveTemplate` ([host/src/scenarios/templates.ts:36-74](host/src/scenarios/templates.ts:36));
  scenarios silently rely on a hand-built VM matching `vms[].name`.

- **Effort**: M

### P7: CI Pipeline + Test Pyramid — RE-SCOPED 2026-04-25
**Estimated Duration**: 6-12 days (was 1-2d; the original scope was
existing-tests CI, audit found the test pyramid is inverted-T —
3 real integration tests in the entire repo, zero system/smoke/E2E)

**Originally listed:**
- GitHub Actions: `tsc --noEmit`, `vitest run`, `cargo test`,
  `cargo clippy -- -D warnings`, `cargo fmt --check`.
- Coverage reporting with 80% threshold.

**P7.1 — Re-enable existing CI (audit closure, near-zero effort):**
- **A1 — Uncomment the `service-windows` job
  ([.github/workflows/ci.yaml:97-122](.github/workflows/ci.yaml:97))**.
  Block already exists; comment was never removed when the worktree
  merged. Uncovers ~50 service-crate unit tests + the named-pipe smoke
  that are currently developer-machine-only.
- **B12 — Pin GitHub Actions by SHA**, not tag (carry-over from P4.4).

**P7.2 — Real integration tests (close the inverted-T):**
- **D1 — Proto contract test (Rust↔TS).** Spin up `signalman-service`
  (or a tonic server backed by `MockBackend`) on a TCP port in CI; have
  the host's `ServiceBackend` connect through the real `@grpc/grpc-js`
  client (no mocks). Pass each across Health, VmList,
  VmRunCommand-streaming, VmCopyFile-streaming. Catches proto-drift bugs
  current tests cannot detect.
- **D2 — Host↔service mTLS handshake test.** Mirror the guest-agent
  mTLS pattern at [guest/src/main.rs:363](guest/src/main.rs:363) but on
  the service side with a TS client. Three cases: valid mTLS, wrong CA,
  cert missing. Use `rcgen` server-side, `tls.createSecureContext`
  client-side. Closes the only post-P4 mTLS gap.
- **D3 — Scenario-validation smoke.** One test that walks
  `.signalman/scenarios/`, calls `parseSetup` + `parseAssertions`, and
  fails on schema errors. Cheap fence against rotted example scenarios.
- **D6 — VMware backend tests.** [host/src/hypervisors/vmware.ts](host/src/hypervisors/vmware.ts)
  ships, is selectable by config, and has zero test coverage today.
- **D7 — Reduce flakiness fuel.** Replace 50ms sleep at
  [guest/src/main.rs:348](guest/src/main.rs:348) and 100ms at
  [service/tests/named_pipe_smoke.rs:296](service/tests/named_pipe_smoke.rs:296)
  with deterministic synchronization where feasible.
- **D8 — Drop `node:fs` mock from
  [host/src/__tests__/service-backend.test.ts:111](host/src/__tests__/service-backend.test.ts:111)**
  once D2 lands (it exists only because no real TLS test exists).

**P7.3 — Gated E2E lane (the missing top of the pyramid):**
- **D4 — Single E2E gated by `SIGNALMAN_E2E=1`.** Restore a known
  checkpoint, run `signalman.run` against `silo-validation` (or a
  purpose-built `smoke` scenario), assert pass. Run nightly on a
  self-hosted Windows runner, not on PR. Solves the "no test ever boots
  a VM" gap without making PR CI flaky.

- **Effort**: M–L

### P8: Proto v1 Freeze + Platform-Detail Split — NEW 2026-04-25
**Estimated Duration**: 2-3 days
**Why before v0.1.0 publishes**: Once `signalman.guest.v1` and
`signalman.service.v1.ControlPlane` are tagged in a public release, splitting
Windows-isms behind a `oneof` or renaming the package is a breaking change.
One-shot opportunity. Parallelizes with P3/P4/P6/P7.

- **E1 — Split Windows-only fields into `oneof platform_details`.**
  [proto/guest.proto:111-149](proto/guest.proto:111) bakes
  `is_appcontainer`, `appcontainer_sid`, `is_low_integrity`, `is_in_job`,
  `integrity_level`, and `restriction_mode: "AppContainer"` as first-class
  fields. Move these into:
  ```proto
  oneof platform_details {
    WindowsProcessDetails win = 100;
    LinuxProcessDetails   lin = 101;   // reserved
    MacOsProcessDetails   mac = 102;   // reserved
  }
  ```
  Same treatment for restriction-mode taxonomy. Linux/macOS guest agents
  do not have to ship to claim the slot; reserving it now is the breaking
  change to avoid later. Keeps `TestNetwork`/`TestFileAccess`/`Health`/
  `Register`/`RunCommand` portable as today.
- **E2 — Decide hypervisor contract truth.** [service/src/backend.rs:181-237](service/src/backend.rs:181)
  is named `Backend` but every method assumes Hyper-V semantics
  (`Copy-VMFile`, `Msvm_ComputerSystem`, two-step Off+Apply on
  restoreCheckpoint). Either:
  (a) extend `VmConfig` with an opaque `hypervisor_specific: bytes` blob
  and document that `Backend`s own image lifecycle, or
  (b) admit Hyper-V is the contract: rename `signalman.service.ControlPlane`
  → `signalman.service.v1.HyperV`. Pick one before publishing. (a) keeps
  the door open for libvirt/vmrun in v0.3.0+ without a proto break;
  (b) sets correct expectations and defers the abstraction question to
  when libvirt arrives. Either is defensible — pick one.
- Add a future-readiness slot in `proto/guest.proto` for a server-push
  readiness stream so the deferred `waitForGuestAgents` polling
  ([orchestrator.ts:1291](host/src/scenarios/orchestrator.ts:1291)) can
  swap to push without another proto bump.

- **Effort**: M

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
- **C9 — Wire `template:` field for real.** Today the orchestrator never
  calls `resolveTemplate`; the field is decorative and v0.1.0 documents
  it as such. v0.2.0-2 makes it actually provision from
  [host/src/scenarios/templates.ts](host/src/scenarios/templates.ts) +
  the differencing-disk pipeline.
- **C8 — Streamed `vm_copy_file` progress.** Today
  [hyperv.ts:501-514](host/src/hypervisors/hyperv.ts:501) wraps
  `Copy-VMFile` in a single PowerShell call with no progress; multi-GB
  transfers appear hung. Decision: either (a) chunked guest-side write
  via the agent (the `stream VmCopyFileEvent` proto already exists at
  [service/proto/signalman_service.proto:41-42](service/proto/signalman_service.proto:41)
  on the service side), or (b) document a per-file size limit and emit
  a heartbeat event every N seconds. Differencing disks reduce the need
  but don't eliminate it (large artifact deploys still happen).
- **Effort**: L

### v0.2.0-3: Hermetic Envelope (full triple)
**Estimated Duration**: 1-2 days (depends on v0.2.0-2)

- Result envelope graduates to `(scenario_hash, vm_lineage_hash,
  agent_version, network_class, result, events[], duration)`.
- Optional cache: same triple + pass → return cached result.
- **Effort**: S

### v0.2.0-4: Explicit Orchestrator (Loom-fronted) — REVISED 2026-04-25
**Estimated Duration**: 2-3 days (was 5-7d; Loom workflows + `loom tui`
provide the DAG, scheduler, state management, and operator console; the
remaining Signalman-side scope is the contract surface Loom invokes)

The unattended orchestrator is **Loom**. Loom workflows already provide
task lifecycle, ownership reconciliation, follow-through, attention
routing, and TUI command palette. Scheduling lives in cron / GitHub
Actions / Loom directives, not in Signalman. Signalman's v0.2.0-4 work
is the contract that lets Loom workflows compose Signalman scenarios:

- **Scenario composition primitive** in Loom plugin: a Loom workflow node
  invokes `loom.signalman.run` and gates on its envelope result. Pass
  scenario hash + lineage hash + capability declarations through the
  Loom task brief.
- **Result envelope → Loom task evidence.** The hermetic triple
  (`scenario_hash`, `vm_lineage_hash`, `agent_version`) becomes part of
  the Loom task evidence record so Loom's caching layer can short-circuit
  identical inputs.
- **Direct CLI/CI orchestration path documented.** For consumers who
  don't want Loom in the loop (raw GitHub Actions, third-party CI), the
  CLI exit codes + envelope JSON remain the contract. README documents
  both paths: Loom-fronted (default) and direct-CLI (advanced).
- **Cut from this phase**: bespoke DAG YAML, bespoke scheduler, bespoke
  control-plane reporting. Loom owns those.
- **Effort**: S

---

## v0.3.0+ (Speculative)

- **Cross-platform daemon** (libvirt on Linux, vmrun wrapper on macOS).
  Depends on P8 (proto v1 freeze with `oneof platform_details` and
  hypervisor-contract decision) being done in v0.1.0.
- **E3 — Linux/macOS guest agent.** Audit found the guest crate
  compiles on Linux but `ProcessInspect`/`VerifyRestriction` are Win32-only
  ([guest/src/service.rs:632-642](guest/src/service.rs:632)). Implement
  the proto-portable RPCs (Health/Register/RunCommand/TestNetwork/
  TestFileAccess) per OS; leave Windows-only RPCs `unimplemented` per
  platform. Mobile (iOS/Android emulators, real devices via USB/network)
  is a further v0.3.0+ extension that needs a different UI proto shape
  than Windows UIA.
- **E4 — Mobile UI proto shape.** Today's UI RPCs presuppose Windows UIA
  selectors (`automation_id`, `class_name`); accommodating ADB / idb /
  Appium needs a different message shape. Defer until a real consumer
  asks for it.
- **Per-user identity certs and per-method capability tokens.** Replaces
  the v0.1.0 cert-pin (P4.1 B2) with a real authorization layer; the
  guest authenticates *who* is calling, not just whether mTLS terminated.
- **Hub component (resurrected).** Today's `hub/` directory is moving to
  a sibling repo (see Cuts & Deferrals); a real registry / dashboard /
  fleet-management surface comes back here when v0.2.0-4 explicit
  orchestrator graduates to multi-host.
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
| P0: MCP Surface Inversion | 4-5d | ✅ Merged 2026-04 | (closed) |
| P1: Hyper-V Service | 5-8d | ✅ Merged 2026-04 | Closure bug A2 → P3 |
| P2: Orchestrator Polish | 3-4d | Surgical + audit | f1c1f93 + cleanup reaper (C7) + parallel agents wait (F1) |
| P3: Agent UX Baseline | 3-5d | ~50% / re-trimmed 2026-04-25 | Orchestrator event hook (C2-residual) + retry (C5) + structured errors (C6) + trace-id header (C10-residual). C1/C2/C10 substrate moved to P5. |
| P4: Security Baseline | 9-11d | ~30% / re-scoped 2026-04-25 | 2 Critical (B1, B2) + 4 High (B3-B6) + capability/secrets enforcement (C3, C4) |
| **P5: Loom Plugin (Agent-Front Surface)** | **4-7d** | **PROMOTED 2026-04-25** | **v0.1.0 critical path. Plugin manifest (P5.1) + scenario↔task mapping (P5.2) + EventBus streaming (P5.3) + TUI forms (P5.4) + directives (P5.5).** |
| P6: Packaging + Docs | 5-7d | Not started + audit | MSI, npm, crate, quickstart (Loom-fronted), README scrub (A3-A6), `docs/testing.md` (D5) |
| P7: CI Pipeline + Test Pyramid | 6-12d | Re-scoped 2026-04-25 | Service CI re-enable (A1), proto contract test (D1), mTLS handshake (D2), gated E2E (D4) |
| P8: Proto v1 Freeze | 2-3d | NEW 2026-04-25 | One-shot before v0.1.0 publishes (E1, E2) |
| v0.2.0: Record/Replay | 5-7d | Deferred | The agent-first differentiator |
| v0.2.0: Ephemeral VMs | 5-8d | Deferred | True repeatability + `template:` wiring (C9) + streamed copy (C8) |
| v0.2.0: Hermetic Envelope | 1-2d | Deferred | Depends on Ephemeral VMs |
| v0.2.0: Explicit Orchestrator | 2-3d | Loom-fronted (was 5-7d) | Loom workflows + `loom tui` are the orchestrator; Signalman exposes the contract |

**v0.1.0 remaining effort**: ~32-50 days (P3 trimmed by ~3-4d, P5 expanded
by ~2-3d, net roughly even; v0.2.0-4 dropped by ~3-4d)
**v0.1.0 critical path**: **P5 (Loom plugin) → P3 (orchestrator hook +
errors + retry) → P8 (proto freeze) → P4 (Critical/High security) → P7
(test pyramid) → P6 (release).** P5.3 (EventBus streaming) depends on
P3's orchestrator event-emission hook, but the rest of P5 can start
immediately. P2 parallelizes anywhere.
**v0.2.0 effort**: ~13-20 days (was ~16-24d; v0.2.0-4 drops by ~3-4d
because Loom workflows + `loom tui` largely is the orchestrator)
**v0.2.0 critical path**: Ephemeral VMs → Hermetic Envelope; Record/Replay
and the Loom-fronted orchestrator contract parallelize.

---

## Cuts and Deferrals

Removed from main roadmap; revisit only with concrete evidence of need.

### 2026-04-25 (audit-driven)

- **Hub component (`hub/`)** — currently 122 LOC of TODOs, returns
  placeholder stubs from every method. **Action**: extract to a sibling
  repo (`signalman-hub`) and remove from this tree. README architecture
  diagram updated to reflect that the hub is out-of-tree until v0.3.0+.
  Avoids treating a stub as a peer component during v0.1.0 release.
- **Aspirational README claims** — Azure VMs, AWS EC2, scenario
  marketplace, UI automation, browser automation, cross-platform guest
  agents, fleet management. Removed from README in P6 (A3); reintroduce
  only when implemented. Sharpens v0.1.0 positioning to **Windows
  kernel-driver / ETW / WFP / silo CI for security products** — the niche
  the kernel-debug + ETW tooling actually serves today.
- **UI / Browser / Verify guest RPCs** ([proto/guest.proto:25-39](proto/guest.proto:25)
  — `UIClick`, `UIType`, `UIScreenshot`, `UIFind`, `BrowserNavigate`,
  `BrowserClick`, `BrowserScreenshot`, `VerifyRestriction`) **stay as
  proto placeholders** returning `Status::unimplemented`
  ([guest/src/service.rs:565-641](guest/src/service.rs:565)). v0.1.0
  documents them as not-yet-built; scenarios should not depend on them.
  Implementation deferred until a real consumer needs them; keeping the
  proto slot reserved avoids a breaking proto change later.
- **`template:` field is decorative for v0.1.0.** Orchestrator never
  calls `resolveTemplate`; scenarios silently rely on a hand-built VM
  matching `vms[].name` literally and a hand-named checkpoint. Documented
  as known in P6; wired for real in v0.2.0-2 (C9). Acceptable for v0.1.0
  because Example V2 scenarios already work this way.
- **Cross-platform claims** in README — removed until P8 (proto split)
  + E3 (Linux/macOS guest implementation) ship. Today the guest crate
  compiles on Linux but Win32-only RPCs return `unimplemented`.

### 2026-04-24 (original)

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
