# Signalman Development Roadmap

**Last Updated**: 2026-05-13
**Current Version**: v0.2.1 (tagged 2026-05-13; capability-surface scrub — see CHANGELOG.md)
**Target**: v0.3.0 (hermetic-replayable-unattended trio + ephemeral VM provisioning + cloud provider support + Kubernetes)
**Test Count**: 1428 host (vitest) + 130 guest (cargo) tests on main
**Repo**: https://github.com/ambray/signalman.git

**2026-05-12 v0.2.0 cut**: First formally versioned release bundled
the local in-process meta build system + the networked control plane
(HTTP serve, runners, Ed25519 signing, Postgres, S3) into one tag.
The ROADMAP sections previously labeled "v0.2.0" describe work that
did NOT ship in v0.2.0 — those items moved to the v0.3.0 milestone
below and were renamed accordingly. Similarly, "v0.3.0+ (Speculative)"
became "v0.4.0+ (Speculative)".

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
v0.1.0 publishes. Hub component (`hub/`) was 122 LOC of TODO stubs;
removed on 2026-05-12 (dormant, not relied on by any other component).
UI/Browser/Verify guest RPCs remain proto
placeholders returning `unimplemented`. `template:` field is decorative until
v0.3.0-2 ephemeral VM provisioning lands; documented as known. Two Critical
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
- **v0.3.0-4 Explicit Orchestrator** is largely subsumed by Loom workflows
  + `loom tui`. Signalman-side scope drops from 5-7d to ~2-3d "expose
  scenario state via Loom workflow primitives."
- **Hub** has been removed from the tree (the stub was not relied on
  by any other component). Loom remains the effective orchestrator
  for the v0.1.0 timeframe.

**2026-04-24 strategic shift**: Signalman is being repositioned from being
a single product's test harness into a first-class agent-first DevOps
platform — orchestrator + runner for security, compliance, and CI/CD
workflows that agents can author and that humans/CI can run unattended.
The differentiator is **hermetic** (cacheable runner outputs),
**replayable** (agent ad-hoc work captured as reusable scenarios), and
**unattended** (orchestrator decoupled from any agent in the loop).
Product-specific scenarios live in their respective consuming products'
repos and no longer gate Signalman releases.

**2026-04-24 change**: kernel-debug supporting infra landed ahead of
schedule — kd.exe session, driver_load/unload/ioctl, BreakLog,
kernel_expect_bugcheck, `kernel_etw_start/stop` MCP tools,
event-driven VM orchestration with warm checkpoint, Zod schema
validation for setup.yaml/assertions.yaml, and an ESLint flat config.
The product-specific scenarios that exercise this infra live in the
consuming product's repo.

**2026-04-17 change**: Hyper-V is now the primary hypervisor backend (was VMware).
VMware Workstation remains a working fallback but is no longer the default in
`buildBackendList` or `signalman.yaml`. This aligns with production deployment
targets that need agent-side SYSTEM privileges, which Hyper-V integration
services expose cleanly.

---

## Product Direction

### Vision
Agents author hermetic, replayable security/compliance/CI workflows. Humans
and CI run them unattended. Local-first.

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
  - `compose-builder.ts` — Fluent API with `backendStack()` factory for product E2E stacks
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
Windows SCM lifecycle. **Audit closure (A2)**: closed in `3354ded`. Scenario runs
and CLI VM verbs now use the same service-first backend selector, so installed
services are preferred before the direct Hyper-V fallback.
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
`Wait-Job` against CIM events). The avoidable heartbeat polling gap is closed
in `3354ded`; orphan handling remains.

- Replace `waitForHeartbeat()` polling with `Register-CimIndicationEvent`
  on `Msvm_HeartbeatComponent` - closed in `3354ded` for the service path,
  matching the direct Hyper-V backend semantics.
- Make warm-checkpoint the default (already proven: 189s vs. 954s smoke).
- VM cache TTL (30s) + `invalidate(name)` from `vm_delete` (Phase 3.4
  carry-over).
- **Audit C7**: cleanup/orphan reaper. The scenario teardown guard is closed
  by the cleanup follow-up: once VMs are resolved, declared teardown now runs
  from `finally` after guest-readiness, setup, workflow, assertion, or runtime
  errors. The provisioning orphan reaper is also closed in this branch: VM
  creation now writes a Signalman manifest, and the dry-run-first
  `vm_cleanup_orphans` tool only targets manifest-owned VMs that lack the
  target checkpoint. The process-exit kd cleanup hook is also closed in this
  branch: active `signalman run` orchestrators register a one-shot exit hook
  that synchronously terminates spawned kd sessions if the host exits before
  normal teardown. The recordings GC is closed here as well: completed runs
  prune stale metadata-only `last-run.json` directories for deleted scenarios
  while preserving richer v0.2 recording captures.
- **Audit F1**: parallelize `waitForGuestAgents` per VM — closed in this
  branch. Each VM keeps its own retry/deadline loop, while the outer wait
  runs all VM readiness checks concurrently.
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
**Status**: mTLS and ECDSA P-256 landed. Capability enforcement,
environment-backed secret resolution, cert rotation, and the
`protoc-bin-vendored` supply-chain note are closed in `3354ded`; remaining
Critical/High audit hardening is tracked below.

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
- ✅ **B2 / Sec F1 (CLOSED 2026-04-28) — Client-cert SHA-256 pin.**
  New `--client-cert-sha256 <hex>` (env `SIGNALMAN_CLIENT_CERT_SHA256`,
  comma-separated for rotation). On startup the guest agent parses the
  flag into a `cert_pin::PinSet`; refuses to start if pins are
  configured without full mTLS (`--tls-cert + --tls-key + --tls-ca`).
  At request time, the `AuthInterceptor` extracts the leaf client cert
  from `tonic::transport::server::TlsConnectInfo::peer_certs`, SHA-256s
  the DER, and compares constant-time against every configured pin.
  Closes the "any cert from this CA grants SYSTEM" gap. Tests: 13
  unit (`cert_pin::tests`) + 2 integration (`cert_pin_matching_*`,
  `cert_pin_mismatched_*`) — the integration tests issue two leaves
  from the same CA and prove pin enforcement rejects a chain-valid but
  identity-wrong cert with `Status::unauthenticated`.
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
- ✅ **B9 / Sec F9 (CLOSED 2026-04-28)** — `is_denied_command` now
  case-insensitive (`format C:` and `RM -RF /` both match), patterns
  expanded (`cipher /w`, `rd /s /q`, target-bound `format c:`/`format /q`
  rather than bare `format` to avoid colliding with cargo/rustfmt), and
  the `DENIED_COMMANDS` doc-comment makes the **tripwire-not-boundary**
  scope explicit: this list catches blatant agent hallucinations cheaply
  but the actual security boundary is mTLS + named-pipe ACL + (B2-pending)
  cert pin. A positive allowlist was rejected with rationale: generic VM
  scenario execution legitimately needs arbitrary `winget`/`choco`/`pwsh`
  invocations; per-scenario allowlists deferred to v0.2.0 manifest work.
  See `guest/src/service.rs:35-90` for the full doc-comment.
- **B10 / Sec F10** — `file_ops.rs` path checks: case-insensitive,
  prefix-canonical (today: case-sensitive prefix string match,
  [guest/src/file_ops.rs:21-160](guest/src/file_ops.rs:21)).
- **B11 / Sec F11** — Strip credentials from `AUDIT: run_command` logs;
  redact known sensitive arg patterns
  ([guest/src/service.rs:441-446](guest/src/service.rs:441)).

**P4.3 — Capability and secrets ENFORCEMENT (originally listed, were stubs):**
- **C3 — Capability declaration enforcement.** Closed in `3354ded`.
  Scenario `capabilities:` now gates declared VMs, networks, and host
  file read/write paths before execution.
- **C4 — Secret primitive resolution.** Closed in `3354ded` for the v0.1.x
  env-backed model: `${secret:NAME}` resolves from
  `SIGNALMAN_SECRET_NAME` or `NAME` and fails closed when missing.

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

**P5.3 — Live event streaming via Loom EventBus: ✅ closed**
- Signalman emits envelope events (step start/finish, assertion
  pass/fail, error, run finished) into Loom's `EventBus` with a
  `signalman.run.<phase>` event kind taxonomy. **This is how P3-C2
  closes** — agents subscribe via `EventBus.subscribe(filter)` instead
  of Signalman building a streaming event protocol of its own.
- Trace-id flows as a `TelemetryEvent.labels["signalman-trace-id"]`
  entry; one event-bus `repo_id` correlates all phases of a run.
  **This is how P3-C10 closes.**
- **Delivered**: `plugins/signalman-loom-plugin/src/events.rs` defines
  the `EventEmitter` / `EventSink` abstraction, the `RunEventKind`
  taxonomy (`signalman.run.{started,streaming,step_started,
  step_completed,step_failed,assertion_passed,assertion_failed,
  finished,lost}`), and the per-envelope-event promotion helper that
  the `loom.signalman.run` and `loom.signalman.status` handlers call
  on every poll. State-machine transitions in `state.rs`
  (`record_*_with_emitter` variants) emit lifecycle events exactly
  once per transition. The trait-based abstraction is the cheap
  insurance: until `loom_plugin_api::PluginContext` exposes an
  `EventBus` accessor, `handlers::emitter_for` returns a no-op sink;
  when Loom's API stabilises, that single function is the only call
  site that needs updating. Test coverage uses an in-memory
  `MockEventSink` so assertions on emission order, label propagation,
  and once-per-transition semantics all run without depending on a
  Loom build.

**P5.4 — Descriptor-backed scenario forms in `loom tui`: ✅ closed**
- Each Signalman scenario exposes a Loom form descriptor (analogous to
  `form.task.start`) so the operator console renders scenarios as guided
  forms. Required parameters (scenario id), optional parameters
  (overrides, `${secret:NAME}` resolution), and validated fields drop in
  with no TUI changes.
- Status indicators (running / passed / failed / lost) feed the active-
  work dashboard via Loom task attention state.
- **Delivered**: `plugins/signalman-loom-plugin/src/forms.rs` defines
  `ScenarioFormDescriptor` / `FormField` / `FieldKind` / `FieldValidator`
  with text / select / number / boolean / secret variants and
  min-length / pattern / range / trace-id validators. The new
  `loom.signalman.form_descriptor` MCP tool (`handlers.rs`) shells out
  to `signalman describe`, parses the response via
  `descriptor_from_describe_response`, and emits the descriptor JSON
  for the TUI. Secret fields default to `${secret:NAME}` so saved form
  state never carries plaintext credentials. `status_indicator_for_status`
  yields a `StatusBadge` (label + display + colour key + glyph + terminal
  flag) for every `RunStatus` variant; `failed_finished_badge()` covers
  the envelope-failed case so the dashboard distinguishes pass-vs-fail
  without re-walking the state machine. The wire format is
  forward-compatible (tagged `kind` discriminator on `FieldKind`,
  `additionalProperties: true` on the output schema), so a future
  `PluginHandles.forms` field on `loom-plugin-api` can absorb the same
  descriptor without re-shaping JSON.

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

### P6: Packaging + Docs — SCAFFOLDING LANDED 2026-04-28
**Estimated Duration**: 5-7 days (was 3-4d; +2d for README scrub and
test-strategy doc)

**P6 SCAFFOLDING (LANDED 2026-04-28):** The release pipeline is wired
end-to-end and tested via local dry-run. Tag-triggered build + sign
+ publish:
- ✅ `.github/workflows/release.yaml` — tag (`v*.*.*`) or
  `workflow_dispatch` trigger. Three independent jobs (service-msi,
  host-npm, guest-crate) feed a `github-release` aggregator that
  attaches every artifact to a GitHub Release. Each job verifies the
  manifest version matches the tag before building.
- ✅ MSI signing via `signtool` gated on `WINDOWS_CERT_BASE64` +
  `WINDOWS_CERT_PASSWORD` secrets (cert decoded into RUNNER_TEMP,
  shredded after sign, never written under workspace).
- ✅ npm publish via `NPM_TOKEN` (Automation type), with
  `npm pack` artifact uploaded for manual fallback when secret unset.
- ✅ `cargo publish --dry-run` always runs as a release gate; real
  publish gated on `CARGO_REGISTRY_TOKEN`.
- ✅ `scripts/release-dry-run.ps1` — local pre-flight that
  reproduces every build + packaging step except the publish ones.
  Run before tagging to catch version skew / WiX template / packaging
  errors without a CI round-trip.
- ✅ README quickstart updated: removes "in progress" P5 caveat,
  adds MSI install path, adds Release process section pointing at the
  workflow + dry-run script.

**Operator setup remaining (release day):** configure the four repo
secrets (`WINDOWS_CERT_BASE64` + password, `NPM_TOKEN`,
`CARGO_REGISTRY_TOKEN`), then `git tag v0.1.0 && git push origin
v0.1.0`. The workflow handles the rest.

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
  kernel-driver / ETW / WFP CI for security products** — the niche
  the kernel-debug + ETW tooling actually serves.
- **A5 — Hide or complete `.signalman/scenarios/codex-sandbox/`** (ships
  `setup.yaml` only; no workflow.md, no assertions.yaml; `signalman.list`
  surfaces it as a discoverable broken entry).
- **A6 — Move/repath absolute `E:\source\repos\correlator\...` references
  in `examples/` to portable paths or document them as in-tree fixtures.**
- **D5 — `docs/testing.md` test-strategy doc.** How to add tests at each
  level (unit / integration / system / smoke / E2E), how to run the gated
  E2E lane, what mock vs. real means in this repo. Closes the missing
  test-strategy artifact.
- Document `template:` field as decorative until v0.3.0-2 ships
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
- ✅ **Workflow API surface tests (LANDED 2026-04-28).**
  `host/src/__tests__/workflow-api.test.ts` (20 tests) pins the
  scenario-action → backend/guest-client routing for the four
  user-facing verbs: `vm_checkpoint`, `vm_restore`, `vm_copy_file`
  (host_to_guest + guest_to_host), `vm_install`. Per-action tests cover
  argv shape, error propagation as failed StepResults, and missing-VM
  edge cases; an end-to-end chain test (`restore → copy → install →
  checkpoint`) verifies dispatch order. Each test carries a "What this
  catches" comment naming the regression it guards against.
- ✅ **D2 — Host↔service mTLS handshake test (CLOSED 2026-04-28).**
  `service/tests/mtls_smoke.rs` ships three windows-only `#[tokio::test]`
  cases: `mtls_valid_client_succeeds`, `mtls_wrong_ca_rejected`,
  `mtls_no_client_cert_rejected`. Each spins up the actual
  `signalman_service::transport::serve` with a fresh tempdir cert bundle
  generated via `tls::generate_certs` (skipping `ensure_certs`'s
  `icacls` step to stay CI-runnable), dials the TCP listener with a
  tonic client built from the same bundle, calls `Health`, asserts.
  Negative cases use a foreign-CA-signed client identity / no client
  cert at all and verify the handshake or first RPC fails. Companion
  to `named_pipe_smoke.rs` — together they exercise both transports.
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
- ✅ **D4 — Gated E2E lane (LANDED 2026-04-28).** New
  `.github/workflows/e2e.yaml` runs only on `workflow_dispatch` or PRs
  labeled `e2e`. Job builds host (npm) + guest (cargo) + service (cargo)
  in release mode, then invokes `scripts/e2e-smoke.ps1`. The smoke
  script is a placeholder (no Hyper-V on standard runners) that verifies
  the toolchain — host CLI `--help`, guest `--version`, service binary
  present — and exits non-zero on any failure. When a self-hosted
  Hyper-V runner is wired up, the smoke script gets replaced by a real
  scenario run (restore checkpoint → install agent → `signalman run
  smoke` → assert pass). The lane scaffolding stays exercised in the
  meantime so the wiring doesn't bit-rot.

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
  and `integrity_level` as first-class fields. Move these into:
  ```proto
  oneof platform_details {
    WindowsProcessDetails win = 100;
    LinuxProcessDetails   lin = 101;   // reserved
    MacOsProcessDetails   mac = 102;   // reserved
  }
  ```
  Linux/macOS guest agents do not have to ship to claim the slot;
  reserving it now is the breaking change to avoid later. Keeps
  `TestNetwork`/`TestFileAccess`/`Health`/`Register`/`RunCommand`
  portable as today.
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

## v0.1.1 Roadmap (Provisioning + Bootstrap) — NEW 2026-04-28

**Why a separate minor**: v0.1.0 ships the secure scenario runner +
Loom-fronted MCP surface; that's a coherent "you can use this if you
already have a guest-installed VM checkpoint" product. v0.1.1 closes
the onboarding gap — fresh Windows host → first scenario run without
hand-rolled cert generation, manual VM creation, or copy-pasted guest
install steps. Treating this as v0.1.1 (a) keeps v0.1.0 shippable
NOW and (b) lets P9 land iteratively against real operator feedback.

### Audit cadence (locked 2026-04-28)
Every P9.x deliverable runs a **6-lens audit** at delivery milestone
(not per-commit) before the merge commit lands:
- **PM** — roadmap fit, scope creep check, "is this minimum shippable"
- **QA** — test coverage, edge cases, regression risk
- **Arch** — design consistency, contract stability, future flexibility
- **Sec** — threat model, attack surface, secret handling
- **DX** — contributor onboarding, code clarity, doc-as-code
- **Ops** — CLI ergonomics for HUMANS *and* MCP-schema clarity for
  LLM agents (deterministic outputs, recoverable errors,
  no-foot-gun defaults)

### P9: Provisioning + Bootstrap

**Symmetry rule** (locked): every new provisioning capability lands as
**both** a CLI verb and an MCP tool with identical input shape. Agents
and CI invoke the same surface.

**Versioning rule** (locked): provisioning verbs are *destructive* but
ship in the *default* MCP namespace (not `signalman.advanced.*`). Tool
descriptions explicitly say "creates / destroys VM state" so LLM
clients can apply their own confirmation gates.

**P9.1 — Windows guest-agent MSI + `signalman vm provision`**
- New `guest/wix/product.wxs` builds `signalman-guest.msi`. The MSI:
  - Drops `signalman-guest.exe` into `%ProgramFiles%\Signalman\guest\`.
  - Registers a Windows service (auto-start, runs as LocalSystem).
  - Opens an inbound firewall rule for port 50051 (loopback by default;
    operator-overridable via MSI property).
  - Reads CA + server cert from `%ProgramData%\Signalman\certs\` (host
    is responsible for landing them inside the VM before the MSI runs).
- New CLI verb: `signalman vm provision <name> [--template T]
  [--guest-msi PATH] [--checkpoint LABEL] [--force]`. Pipeline:
  1. Resolve template (P9.5 may have downloaded the VHDX).
  2. Create VM (idempotent: skip if exists with matching template).
  3. Boot, wait for IP.
  4. Generate dev certs into a tempdir, copy into VM via Hyper-V
     `Copy-VMFile`.
  5. Discover guest MSI: `--guest-msi` arg → `dist/guest/*.msi` in the
     installed host package → fetch from GitHub Releases matching
     `signalman --version`. Hard-fail on miss with explicit
     remediation.
  6. Copy MSI into VM, run silent install, wait for service health.
  7. Take a checkpoint (default label `agent-installed`).
- New MCP tool `vm_provision` — same input shape as the CLI.
- **Cert model (locked, Q2(c))**: one-CA-many-VMs for v0.1.x. All
  provisioned guests get the same server cert. v0.2.0 promotes to
  per-VM identity certs (consumes the B2 pin registry).
- **Failure recovery**: leave the VM around on failure (operator
  inspects), explicit `signalman vm cleanup <name>` to remove. No
  silent rollback. `--cleanup-on-failure` opt-in flag.
- **Idempotency**: re-running with no changes is a 2-second no-op.
  `--force` rebuilds from scratch (cleanup + provision).

**P9.2 — Software bundle manifest + `signalman vm install-bundle`**
- New schema: `bundle.yaml` with declarative `packages:` list.
- New CLI verb: `signalman vm install-bundle <vm> <bundle.yaml>`.
- New MCP tool `vm_install_bundle`.
- New scenario YAML key: `software:` references a bundle filename so
  scenarios can compose package sets.

**Tier 1 sources (v0.1.1, must-have):**
| source | shape | notes |
|---|---|---|
| `winget` | `{ id, source: winget, version?, verify? }` | already exists |
| `choco` | `{ id, source: choco, version?, verify? }` | already exists |
| `msstore` | `{ id, source: msstore, version?, verify? }` | one-line addition (winget --source msstore) |
| `direct` | `{ id, source: direct, url, sha256, args, verify }` | **most security-sensitive** |
| `docker` | `{ id, source: docker, image, image_sha256, ports, env, restart_policy, verify }` | requires Docker on the VM (operator orders the prereq) |

**Tier 2 sources — ✅ landed 2026-04-29 (v0.1.1):** `scoop`,
`github_release`, `git_repo` (with `ref:` for branch/tag/SHA, optional
`submodules:` / `sparse:`), `powershell` (`Install-Module`), `npm`,
`pip`, `cargo`, `custom_script`. Routing summary:
- `scoop` → guest-side `installSoftware` RPC with new Rust handler arm.
- `github_release` → host-side fetch of
  `api.github.com/repos/<owner>/<repo>/releases/latest`, asset glob
  match, then existing `installDirect` RPC.
- `git_repo` → 1–3 `runCommand("git", [...])` calls (clone, optional
  sparse-checkout init/set, optional submodules update).
- `powershell` / `npm` / `pip` / `cargo` → `runCommand` shell-out with
  language-specific argv. No new RPCs.
- `custom_script` → single `runCommand("powershell", [..., script-block])`
  that performs `Invoke-WebRequest` + `Get-FileHash` + `& <interpreter>`.
  pwsh-only on Windows for v0.1.1; bash on Linux/macOS guests deferred
  to v0.1.2 once a first-class download-verify-spawn RPC ships.

**Tier 3 (later, multi-platform):** `brew`, `mas`, `apt`, `dnf`,
`flatpak`, `snap`.

**`direct` security gates (locked)**:
- SHA-256 REQUIRED — refuse to download without it.
- HTTPS-only.
- Allowlist installer extensions: `.msi`, `.exe`, `.msix`, `.appx`.
  Operators wanting `.bat`/`.ps1` use Tier-2 `custom_script` with its
  own threat model.

**`docker` security gates (locked)**:
- `image_sha256` REQUIRED (image digest pin, not the tag).
- Image pulls go through the VM's docker daemon (not the host's).
- Container `restart_policy` defaults to `unless-stopped`.

**Ordering (locked, Q10(a))**: bundle author orders manually,
`source: docker` entries must come AFTER the Docker install entry
(typically `Docker.DockerDesktop` from winget). Future `requires:`
DAG resolver: see P9.7.

**Optional `parallel:` group flag** for known-independent installs:
```yaml
packages:
  - { id: Git.Git, source: winget }      # serial — others may depend
  - parallel:
    - { id: Microsoft.VisualStudioCode, source: winget }
    - { id: 7zip.7zip, source: winget }
    - { id: Mailhog, source: docker, image: "mailhog/mailhog@sha256:..." }
```

**Idempotency**: rely on the underlying package manager. `winget
install` returns "already installed" cleanly; `docker run` errors
"container already exists" which the orchestrator catches and treats
as success. No host-side install ledger (avoids drift).

**P9.3 — `signalman init` + `signalman vm create`**
- `signalman init` (locked, Q5(c)): minimal scaffold. Creates
  `.signalman/{config.yaml,scenarios/,templates/}` plus an empty
  sample scenario. Runs in <1 second.
- `signalman init --bootstrap` (opt-in): full interactive flow —
  generate dev certs, prompt for template, download base image
  (P9.5), provision a VM. May take 30+ minutes; deliberately
  separated so re-running `init` is always safe.
- `signalman vm create <name> [--template T]`: explicit VM creation
  outside the provisioning pipeline (no agent install, no checkpoint).
  For users who want the create step but their own bootstrap.

**P9.4 — Idempotent "ensure provisioned" semantics — ✅ closed 2026-04-28**
- Cross-cutting test suite landed at `host/src/__tests__/
  provisioning-idempotency.test.ts` (9 cases across 8 describe
  blocks). Each provisioning verb (init, fetch-template, provision,
  cleanup, install-bundle) gets a × 3 invocation case asserting the
  second + third runs no-op. End-to-end test chains all five verbs
  twice and asserts the second pass is uniformly fast.
- Per-assertion regression-class messages (e.g. "fetch was
  re-invoked despite warm cache", "scaffold restored after force
  overwrite") so a failed assertion immediately names which verb's
  idempotency contract broke.
- ✅ **`provision_if_missing: true` scenario YAML — landed 2026-04-29.**
  New `vmConfigSchema.provision_if_missing` field (default `false`).
  When set, `ScenarioOrchestrator.resolveVms` calls `provisionVM`
  before the scenario starts when the named VM is absent on the host.
  Idempotent (matches the rest of P9 — provisionVM no-ops in <100ms
  when the VM + checkpoint already exist). Hard-fails with a
  remediation hint pointing at the flag when a missing VM is seen
  without `provision_if_missing` set.

**P9.5 — Template registry + base-image fetch**
- New template fields:
  ```yaml
  base_image_path: "D:/images/win11.vhdx"  # BYO
  # OR
  base_image_url: "https://aka.ms/.../win11-eval.vhdx"
  base_image_sha256: "REQUIRED for URL form"
  ```
- New CLI verb: `signalman vm fetch-template <name>` — downloads to
  `%LOCALAPPDATA%\Signalman\templates\<name>\<sha>.vhdx`, verifies
  SHA-256, atomic rename on success.
- HTTPS-only for `base_image_url`.
- v0.1.1 ships **with** a curated default-templates section pointing
  at Microsoft Eval VHDX URLs (90-day eval license, legally
  distributable). Custom templates use the BYO path.
- **Out of scope for v0.1.1**: ISO-to-VHDX conversion. Operators
  provide pre-built VHDX (downloaded or `Convert-WindowsImage.ps1`).
  v0.2.0 may add an ISO build step.
- ✅ **Disk-fill cap — landed 2026-04-29** (Sec follow-up flagged in
  P9.5 audit). `fetchTemplateImage` accepts `maxBytes?` (default
  `DEFAULT_MAX_BYTES = 50 GiB`). Pre-flight rejects when
  `Content-Length` already exceeds the cap; mid-stream check shreds
  the partial `.tmp` file when running total exceeds the cap (defends
  against Content-Length spoofing). 3 new tests in
  `template-fetch.test.ts`. Defends operators paste-pointing at a
  multi-TB URL and hostile servers serving an unbounded body under a
  hash that happens to match.
- ✅ **`vm_install_bundle` MCP-server wiring — landed 2026-04-29.**
  New `host/src/provisioning/guest-client-factory.ts` exports
  `makeGuestClientResolver(getBackend)` — builds a per-VM
  `GuestAgentClient` on demand from (backend, vmName) with no caching
  (bundle installs are infrequent; stale clients across reboots would
  be a worse footgun than the per-call IP-resolution cost). Wired
  into `createAllTools` so `vm_install_bundle` is now registered in
  the default MCP namespace alongside `vm_provision` /
  `vm_fetch_template` / `vm_cleanup`.

**P9.6 — Bootstrap docs — ✅ closed 2026-04-28**
- `docs/bootstrap.md` landed with the full end-to-end walkthrough:
  prerequisites (Hyper-V, Node 20+, pwsh, openssl, `Default Switch`,
  pre-built VHDX), one-time setup (npm install host, generate dev
  certs, `signalman init`, `signalman vm fetch-template`), first VM
  provision (7-step pipeline trace pinned to
  `host/src/provisioning/provision.ts`), first scenario run (envelope
  shape pinned to `host/src/output/envelope.ts`), `vm install-bundle`
  against `examples/bundles/dev-tools.bundle.yaml`, iteration loop
  (`--force` rebuild + `vm cleanup`), troubleshooting (guest MSI
  discovery, SHA mismatch, boot hang, `direct`-source feature
  detection), explicit out-of-scope list (Linux/macOS provisioning,
  per-VM identity certs, ISO-to-VHDX, interactive
  `init --bootstrap`), and source-of-truth cross-references. README
  Quick Start now points at the doc on the first line. The
  `docs/testing.md` gated-E2E-lane wiring is referenced from the
  cross-reference list; the lane itself plugs the bootstrap path in
  once self-hosted Hyper-V runners come online (P7 D4 follow-up,
  not blocked by this entry).

**P9.8 — Resume context (`docs/STATUS.md`) — ✅ landed 2026-04-29.**
Living document at `docs/STATUS.md` (~550 lines) captures the
"where are we" snapshot for future sessions / other-machine resumes:
versions, recent commits, audit closure table, test coverage map,
roadmap status by milestone, outstanding TODOs in code, release
process, architecture invariants (the 19 locked Q-decisions), and
literal copy-pasteable prompts for both fresh-clone contributor
onboarding and Claude-session continuation. The doc is the single
read that future work should start with — it cross-references every
other file but stands on its own. Trigger rules for keeping it
current live in the doc's "Document maintenance" section.

**P9.7 — DAG-resolved bundle dependencies — closed in `3354ded`**
- Bundles can declare a `requires:` field with topological sorting:
  ```yaml
  - id: Mailhog
    source: docker
    image: mailhog/mailhog@sha256:...
    requires: ["Docker.DockerDesktop"]
  ```
- Unknown dependencies, duplicate IDs, self-dependencies, and cycles fail
  before guest RPCs. Independent dependency chains continue when an unrelated
  chain fails.

**Effort estimate**: 5-8 days for P9.1–P9.6.
**Parallelizable**: P9.1, P9.2, P9.5 are disjoint after P9.5's
`templates.ts` API contract is locked. P9.3 + P9.6 are main-session
material.

---

## v0.3.0 Roadmap

These are the primitives that make "agent-first DevOps" actually new.
Deferred from v0.1.0 per 2026-04-24 decision to keep the first release
shippable; renamed from "v0.2.0 Roadmap" on 2026-05-12 when v0.2.0
shipped without them.

### v0.3.0-1: Record / Replay
**Estimated Duration**: 5-7 days

- `signalman.record` captures next N MCP calls into `.signalman/recordings/`
  as a candidate scenario YAML + workflow.md.
- Promotion flow: human reviews recording → moves to `scenarios/`.
- This is the primitive that makes "agent-first DevOps" a real
  differentiator: ad-hoc agent work becomes reusable, hermetic infra.
- **Effort**: L

### v0.3.0-2: Ephemeral VM Provisioning
**Estimated Duration**: 5-8 days

- Differencing-disk pipeline (Hyper-V `New-VHD -ParentPath`).
- Base-image catalog (`templates/` directory, content-addressed).
- Per-scenario disposable guests; VM lineage hash recorded in result
  envelope.
- Removes hand-pinned `DESKTOP-FAF4PL7` dependency (acceptable for v0.1.0
  per 2026-04-24 decision; required for true repeatability).
- **C9 — Wire `template:` field for real.** Today the orchestrator never
  calls `resolveTemplate`; the field is decorative and v0.1.0 documents
  it as such. v0.3.0-2 makes it actually provision from
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

### v0.3.0-3: Hermetic Envelope (full triple)
**Estimated Duration**: 1-2 days (depends on v0.3.0-2)

- Result envelope graduates to `(scenario_hash, vm_lineage_hash,
  agent_version, network_class, result, events[], duration)`.
- Optional cache: same triple + pass → return cached result.
- **Effort**: S

### v0.3.0-4: Explicit Orchestrator (Loom-fronted) — REVISED 2026-04-25
**Estimated Duration**: 2-3 days (was 5-7d; Loom workflows + `loom tui`
provide the DAG, scheduler, state management, and operator console; the
remaining Signalman-side scope is the contract surface Loom invokes)

The unattended orchestrator is **Loom**. Loom workflows already provide
task lifecycle, ownership reconciliation, follow-through, attention
routing, and TUI command palette. Scheduling lives in cron / GitHub
Actions / Loom directives, not in Signalman. Signalman's v0.3.0-4 work
is the contract that lets Loom workflows compose Signalman scenarios:

- **Scenario composition primitive** in the Loom plugin: a Loom
  workflow node invokes `loom.signalman.run` and gates on its
  envelope result. Pass scenario hash + lineage hash + capability
  declarations through the Loom task brief.
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

### v0.3.0-5: Cloud provider support (AWS + Azure)
**Estimated Duration**: 10-15 days

Full design in [`docs/design/meta-build-system.md` §13](docs/design/meta-build-system.md).
Three workload classes split across two driver paths:

- **Ephemeral test VMs** (`cloud_vm_test` target kind) use the vendor
  SDK directly (boto3 / Azure SDK). Lifecycle is wall-clock-TTL'd and
  budget-gated; created per scenario, destroyed at teardown.
- **Cloud runners** use the vendor SDK directly. Two auth modes shipping:
  (a) bearer token derived from IAM role on the runner host
  (the default, simplest), and (b) native vendor identity
  (IAM role-on-EC2 / managed identity-on-Azure-VM) for enterprise
  consumers who require it.
- **Deploy targets** (`cloud_stack_test` target kind) compose via
  OpenTofu HCL (MPL-2.0; subprocess-safe for both Apache-2.0 OSS and
  commercial-fork use). Out-of-the-box starter library:
  `aws-simple-vm`, `aws-three-tier`, `aws-eks-cluster`,
  `azure-windows-vm`, `azure-linux-vm`, `azure-aks-cluster`.

Cross-cutting concerns:

- **Cost guardrails**: per-org budget, per-target wall-clock TTL,
  pre-flight `tofu plan` cost estimate surfaced in CI envelope.
- **Networking default**: public IP + mTLS, with the auth material
  the guest agent needs delivered through the same per-org credential
  layer (per-org default → per-target override → per-runtime override).
- **Pipeline-built golden images**: Packer-based build in-tree, signed
  with the release-signing key, manifest recorded in the artifact
  catalog. `vm_lineage_hash` (added in v0.3.0-3) abstracts over
  cloud-specific image IDs (AMI vs Azure managed image) via
  `{template_name, version, os, installed[]}`.
- **OpenTofu state backend**: S3 + DynamoDB lock for self-hosted;
  local disk for local-mode.

Depends on v0.3.0-2 (ephemeral VM provisioning patterns, especially
`vm_lineage_hash`) and v0.3.0-3 (hermetic envelope). Parallelizable
with v0.3.0-1 and v0.3.0-4.

- **Effort**: XL

### v0.3.0-6: Kubernetes (deploy target + runner substrate)
**Estimated Duration**: 6-10 days

Full design in [`docs/design/meta-build-system.md` §14](docs/design/meta-build-system.md).

- **`k8s_test` target kind**: manifests-first deploy target driver.
  Apply scenario-declared manifests to a configured cluster context,
  wait for ready, expose pod IPs to the scenario's assertion layer.
- **Runner substrate via K8s Jobs**: an alternative to the docker-
  compose substrate. A Job spawns one runner pod per scenario run;
  the runner reports status back to the control plane the same way
  the local/docker-compose runner does.
- **Cluster auth**: kubeconfig path + context, with optional service-
  account-token override for in-cluster workloads.
- **Cross-cloud matrix**: the same `k8s_test` driver works against
  AKS, EKS, and self-managed clusters; differences live in the
  starter-library HCL stanzas (aws-eks-cluster, azure-aks-cluster).
- **Operator pattern**: custom-operator path for tighter scenario ↔
  Kubernetes integration is deferred to v0.3.x once the manifests-
  first contract is proven.

Depends on v0.3.0-5 cloud-credential plumbing for cloud-managed
clusters; works standalone against locally-configured clusters.

- **Effort**: L

---

## v0.4.0+ (Speculative)

### Auto-promotion pipelines + webhooks + scheduling

These were tracked as v0.4+ non-goals in
`docs/design/meta-build-system.md` but never had ROADMAP entries.
They cover the next tier of operational features layered on top of
the v0.2.0 release pipeline.

- **Auto-promotion** (tag → tier → tier with approval gates). A tag
  on the product repo triggers `release.build`; on green tests the
  release promotes to the next-tier deploy target; configurable
  approval gates between tiers. The release pipeline foundation
  shipped in v0.2.0; the promotion ladder + approvals layer on top.
- **Webhooks / external notifications.** Outbound HTTP hooks on
  release / deployment / health-check state changes. Slack / email
  / generic-webhook drivers. Pairs with auto-promotion (approval
  notifications) and with audit-log exports.
- **Scheduled health checks.** A periodic job that re-runs
  `health check` against every active deployment without an
  operator triggering it. Pairs with audit-log retention so flapping
  health is queryable historically.

### Artifact registry as standalone OSS product

Full design in [`docs/design/meta-build-system.md` §15](docs/design/meta-build-system.md).

Promote the v0.3.0 in-tree artifact catalog (which already stores
content-addressed blobs + the cloud-image manifests landed in
v0.3.0-5) into a standalone OSS product. Competitive wedge vs.
JFrog Artifactory and Sonatype Nexus, which are commercial-only in
this niche (signed-manifest CI artifact storage with deterministic
replay).

- **Standalone deploy**: ships as a separate binary + service, with
  the existing `@signalman/host` consuming it over a stable HTTP
  contract (the same contract the in-tree catalog currently
  implements internally).
- **OCI distribution spec compliance**: speak the OCI v2 manifest
  + blob protocol so `docker pull` / `crane copy` / `oras` interop
  works out of the box.
- **Scope**: signed manifests, content-addressed blob store, blob
  pruning / GC, retention policies, per-org access control. Out of
  scope: P2P distribution, geographic replication (revisit if real
  consumer demand surfaces).

Interim v0.3.0 home: cloud-image manifests live in the existing
artifact catalog (no schema change, just additional content kinds).
The standalone-product promotion lands when the OSS surface is
stable enough to commit to a wire contract.

- **Effort**: XL

### Platform + protocol expansion

- **Cross-platform daemon** (libvirt on Linux, vmrun wrapper on
  macOS). Depends on P8 (proto v1 freeze with `oneof platform_details`
  and hypervisor-contract decision) — done in v0.1.0.
  **Shipped in v0.4.0-4** (WS4): `host/src/hypervisors/libvirt.ts`
  wraps `virsh` (Linux); `host/src/hypervisors/vmrun.ts` is the new
  parallel-track Workstation/Fusion driver. Both register through
  the existing `buildBackendList` selector, so existing MCP / CLI
  surfaces auto-discover them. See *Backend convergence (vmrun.ts +
  vmware.ts)* in [Cuts and Deferrals](#2026-05-14-v040-4-cross-platform-followups)
  for the lone outstanding consolidation item.
- **E3 — Linux/macOS guest agent.** Audit found the guest crate
  compiles on Linux but `ProcessInspect` is Win32-only
  ([guest/src/service.rs](guest/src/service.rs)). Implement
  the proto-portable RPCs (Health/Register/RunCommand/TestNetwork/
  TestFileAccess) per OS; leave Windows-only RPCs `unimplemented`
  per platform. **Largely shipped in v0.4.0-4** (WS4):
  `guest/src/platform/{windows,linux,macos,other}.rs` houses a
  `Platform` trait the service layer dispatches through. Linux now
  has SYSTEM-elevation via passwordless `sudo -n` plus
  `install_software` routing through `apt`/`dnf`/`yum`; macOS routes
  through `brew`. UI / browser RPCs return `Status::unimplemented`
  on non-Windows with a canonical message. **Remaining**: macOS UI
  automation parity with the Win32 UIA sidecar — see
  *macOS UI automation* in [Cuts and Deferrals](#2026-05-14-v040-4-cross-platform-followups).
  Mobile (iOS/Android emulators, real devices via USB/network) is
  a further extension that needs a different UI proto shape than
  Windows UIA.
- **E4 — Mobile UI proto shape.** Today's UI RPCs presuppose Windows UIA
  selectors (`automation_id`, `class_name`); accommodating ADB / idb /
  Appium needs a different message shape. Defer until a real consumer
  asks for it.
- **Per-user identity certs and per-method capability tokens.** Replaces
  the v0.1.0 cert-pin (P4.1 B2) with a real authorization layer; the
  guest authenticates *who* is calling, not just whether mTLS terminated.
- Scenario matrix support (carry-over from old Phase 4.3 — defer until
  duplicate-scenario pain is real).
- Proto enhancements: split `ProcessStartResponse`, `RunCommandStream`
  (carry-over from old Phase 4.1).

### CLI + OSS-hygiene followups

- **`signalman --version` verb.** Referenced in `SECURITY.md`,
  `CONTRIBUTING.md`, and the bug-report issue template; currently
  the CLI returns "unknown verb" for `--version`. Should print
  `host/package.json` version + commit SHA. Trivial implementation;
  unblocks the doc-references that point at it.
- **`CODE_OF_CONDUCT.md`.** Intentionally deferred during the v0.2.0
  OSS-hygiene pass per operator decision. GitHub's community-profile
  checklist surfaces this as a missing item; lands when ready to
  paste the Contributor Covenant text (or whichever variant is chosen).

---

## v0.5+ — Claude Code plugin + next-10 epics (NEW 2026-05-15)

Forward roadmap items kicked off after v0.4.0 + Wave-3 consolidation.
These run in parallel — pick whichever has owner bandwidth.

### Claude Code plugin (WS7) — v0.5

Package the existing 44-skill / 27-CLI-verb / MCP-exposed surface into
a one-click-install Claude Code plugin, with a clean open-core boundary
(OSS plugin in this repo; proprietary sibling plugin in
`signalman-cloud`).

- Full roadmap: [`plugin/ROADMAP.md`](plugin/ROADMAP.md)
- Workstream prompt:
  [`docs/workstreams/prompts/ws7-claude-plugin.md`](docs/workstreams/prompts/ws7-claude-plugin.md)
- MVP scope: plugin scaffold + MCP registration + 6 skills +
  `/signalman-status` slash command + permission preset
- v0.2.0 scope: full 44-skill coverage, incident-responder subagent,
  destructive-command hooks, cloud-aware skill loading
- v1.0.0 scope: split into `signalman` (OSS) + `signalman-cloud`
  (proprietary) plugins

### Per-user identity certs (WS8) — v0.5

Extend the one-CA-many-VMs model from v0.1.x into named-identity
mTLS with per-identity revocation, replacing the v0.1.x cert-pin
stopgap (`guest/src/cert_pin.rs`). Three identity kinds
(user / machine / service); SPIFFE-compatible URI SAN convention;
signed serial-denylist for revocation; opt-in → default-on → sole
migration over v0.2.0 → v0.2.1 → v0.3.0.

- Design doc: [`docs/design/per-user-identity-certs.md`](docs/design/per-user-identity-certs.md)
- Workstream prompt: [`docs/workstreams/prompts/ws8-per-user-identity-certs.md`](docs/workstreams/prompts/ws8-per-user-identity-certs.md)
- Status: awaiting session launch (2026-05-16)

### Next cohort (WS9–WS12) — 4-parallel wave, kicked off 2026-05-16

The 4-parallel pattern proven by the WS1–WS6 wave (2026-05-14)
applies again here: four workstreams off `main`, each on its own
feature branch, each owned by one Claude Code session. Coordination
rules are reduced because WS9–WS12 have minimal file overlap, but
the same Definition of Done + 4-lens audit + "no push to origin"
rules apply.

| # | Stream | Branch | First milestone | Status |
|---|---|---|---|---|
| 9 | Signing service provider + infrastructure | `feat/v0.5-signing-service` | Design doc (gated) → `LocalDiskProvider` interface + lift | Awaiting session launch (2026-05-16) |
| 10 | Registry OCI distribution spec v1.1 | `feat/v0.5-registry-oci` | Design doc (gated) → manifest schema + types | Awaiting session launch (2026-05-16) |
| 11 | vmrun ↔ VMware backend convergence | `feat/v0.5-vmware-convergence` | Design doc (gated) → parity test suite (before merge) | Awaiting session launch (2026-05-16) |
| 12 | OSS release-readiness | `feat/v0.5-oss-release-readiness` | `signalman --version` verb | Awaiting session launch (2026-05-16) |

Prompts: [`ws9-signing-service.md`](docs/workstreams/prompts/ws9-signing-service.md),
[`ws10-registry-oci.md`](docs/workstreams/prompts/ws10-registry-oci.md),
[`ws11-vmrun-vmware-convergence.md`](docs/workstreams/prompts/ws11-vmrun-vmware-convergence.md),
[`ws12-oss-release-readiness.md`](docs/workstreams/prompts/ws12-oss-release-readiness.md).

#### Cohort scope summary

- **WS9 (Signing service)** — **SHIPPED v0.5.0 (M0–M4 + M6 closure,
  2026-05-17).** `SigningProvider` abstraction over key custody;
  `LocalDiskProvider` (classical Ed25519 + ECDSA P-256 + ML-DSA-65 +
  **hybrid Ed25519+ML-DSA-65 as the default for new keys, NIST FIPS
  204 post-quantum-ready**) and `AwsKmsProvider` (classical ECDSA
  P-256) both ship. Migrations 0090 (`signing_provider_key`) + 0091
  (`signing_nonce`); audit-log `signing.*` action codes; replay-dedup
  runtime via signing_nonce PK uniqueness; full `signalman signing`
  CLI (`providers list`, `keys list|add|revoke|rotate`, `verify`,
  `nonce-sweep`) + matching MCP tools. **M5 (route
  `service/src/tls.rs` through provider) deferred to v0.5.1** —
  gated on WS8 merge. **v0.6+ deferrals**: detached-operator signing
  (Q3), Azure KV / GCP KMS providers, HSM / TPM providers, hybrid
  via AWS KMS, auto-rotation scheduler. See
  [`docs/design/signing-service.md`](docs/design/signing-service.md)
  §Deviations from §Locked design for the as-shipped vs as-locked
  diff.
- **WS10 (Registry OCI distribution spec v1.1)** — close
  [`registry/ROADMAP.md`](registry/ROADMAP.md) §v0.1.2: add `/v2/*`
  route surface alongside `/v1/*`, OCI manifest + image-index media
  types, shared blob store (digests are `sha256:<hex>` so the
  existing `BlobRef` shape maps 1:1), virtual upstream pull-through
  against Docker Hub with Ed25519 re-signing, cosign-style signing
  using the existing keypair, and the upstream
  `opencontainers/distribution-spec/conformance` harness wired into
  CI. GHCR + ECR upstreams scoped to v0.6. Design-gated. **Note:**
  the original WS10 (macOS UI automation parity) was reassigned on
  2026-05-16 because the operator does not currently have an Apple
  Silicon dev-host; the scoped prompt is preserved at
  [`docs/workstreams/prompts/ws-future-macos-ui-parity.md`](docs/workstreams/prompts/ws-future-macos-ui-parity.md)
  for pickup when Mac hardware becomes available.
- **WS11 (vmrun ↔ VMware convergence)** — merge the parallel-track
  `vmrun.ts` + legacy `vmware.ts` backends into a single converged
  module per the operator commitment baked into the `vmrun.ts`
  §"Locked design" header comment. Behavior parity is enforced
  by a new parity test suite landed *before* the merge.
  Design-gated. No new features; refactor-with-guarantee.
- **WS12 (OSS release-readiness)** — close the five "Open" items in
  [`docs/STATUS.md`](docs/STATUS.md) §Public-release status plus
  one quiet CI gap: `signalman --version` verb, `CODE_OF_CONDUCT.md`
  (Contributor Covenant), coordinated v0.4.0 tag prep, public-release
  operator runbook (secrets + visibility flip), CI coverage gate
  enforcement, and GitHub community-profile checklist closure.
  Small items by design; bundled to amortize the operator-review
  cost.

#### Cross-stream coordination (WS9–WS12)

Minimal overlap by design; the coordination matrix is short.

| Resource | WS9 | WS10 | WS11 | WS12 |
|---|---|---|---|---|
| Host migration numbers | 0090–0099 | (none) | (none) | (none) |
| Registry migration numbers | (none) | `0004` (oci_metadata) | (none) | (none) |
| New error-code namespaces | `signing.*` audit codes; `SigningProviderError` | OCI spec `errors[]` shape (canonical codes `BLOB_UNKNOWN`, `MANIFEST_UNKNOWN`, etc.) | converged `VmwareBackendError` (supersedes `VmrunBackendError`) | (none) |
| New CLI verbs | `signalman signing *` | `signalman-registry oci sign|verify` (if Q3 lands "include cosign") | (none — selector alias only) | `signalman --version` flag |
| New MCP tools | `signalman_signing_keys_list`, `signalman_signing_verify` | (none — OCI tooling is standard CLI) | (none) | (none) |
| New HTTP route namespace | (none) | `/v2/*` on the registry app | (none) | (none) |
| `host/src/cli.ts` edits | yes (new `signing` verb) | none | none | yes (new `--version` flag) |
| `host/src/mcp/server.ts` edits | new tool block | none | none | none |
| `host/src/hypervisors/` edits | none | none | yes (full convergence) | none |
| `registry/src/` edits | minor (`signing.ts` refactor through provider) | major (new `oci/` module, `http/app.ts` mount, schema delta) | none | none |
| `guest/src/` edits | none | none | none | none |
| `service/src/tls.rs` edits | yes (Milestone 4 only; coordinate with WS8 merge) | none | none | none |
| Design doc | `docs/design/signing-service.md` (new) | `docs/design/registry-oci.md` (new) | `docs/design/vmware-backend-convergence.md` (new) | (none; runbook only) |

**WS9 ↔ WS8 coupling.** WS9 Milestone 4 routes the WS8 CA-key signing
through the new provider interface. If WS8 hasn't merged when WS9
reaches that milestone, the WS9 session stops and surfaces to the
operator. All other WS9 milestones are independent.

**WS9 ↔ WS10 coupling.** WS10 Milestone 6 (cosign signing on OCI
manifests) uses the existing `registry/src/signing.ts` Ed25519
surface directly. If WS9 has merged when WS10 reaches that
milestone, the cosign path routes through the new `SigningProvider`
interface instead of the legacy surface; the WS10 session
coordinates with the operator before that milestone. Otherwise
WS10 ships against the v0.4.x signing surface and a follow-up PR
migrates it after WS9 lands.

**WS11 scope discipline.** WS11 is a refactor with a parity
guarantee — not a venue for new VMware features. Adjacent ideas
(VM creation via vmrun, expanded snapshot semantics, vSphere
extras) get filed as v0.6+ ROADMAP entries.

**WS10 ↔ WS12 coupling.** The registry's `package.json` is at
`0.0.1` despite `registry/ROADMAP.md` claiming v0.1.1 shipped. WS12
Milestone 3 will discover this drift during the version-bump pass;
WS10 Milestone 7 surfaces it explicitly. Resolve in whichever
session reaches the bump first; do not double-write.

**Design-gated workstreams (WS9, WS10, WS11).** Milestone 0 is the
design doc; the operator approves it before any production code
lands. WS12 has no design gate — its scope is concrete enough that
the operator-question round at session start is sufficient.

**No push to origin from any session.** Same as the WS1–WS6 wave:
operator consolidates by fast-forward into `main` after reviewing
each session's `.workstream-status.md`.

---

## Product-specific scenarios

Scenarios that exercise a specific product's behavior (kernel-driver
test suites, registry/network policy validation, agent-service smoke
tests, etc.) live in the consuming product's own repo's
`.signalman/scenarios/` directory, not here. They consume Signalman as
a public dependency; their delivery cadence is decoupled from Signalman
semvers and they don't gate Signalman releases.

Signalman ships only a handful of generic in-tree scenarios under
`.signalman/scenarios/` (`live-*`, `service-backend-smoke`) that
exercise the platform itself, not any one product.

### Network topology note (captured 2026-04-17)

Setting product-specific scenarios aside: scenarios that need internet
access (winget for tool installation, live endpoint reachability for
DNS + TLS fingerprint capture, real-policy enforcement against live
endpoints) should give the VM either a NAT-style switch (e.g.
`Default Switch`) or a second NIC alongside an isolated control switch.
A second-NIC layout is preferred for scenarios that also need a stable
host↔guest gRPC contract on the isolated side.

---

## Timeline Summary

| Phase | Duration | Status | Gate |
|-------|----------|--------|------|
| P0: MCP Surface Inversion | 4-5d | ✅ Merged 2026-04 | (closed) |
| P1: Hyper-V Service | 5-8d | ✅ Merged 2026-04 | Closure bug A2 → P3 |
| P2: Orchestrator Polish | 3-4d | ✅ Closed (f1c1f93 + cleanup reaper + parallel-agents wait F1) | — |
| P3: Agent UX Baseline | 3-5d | Re-trimmed 2026-04-25 | Orchestrator event hook + retry + structured errors + trace-id |
| P4: Security Baseline | 9-11d | ✅ Closed in v0.2.0 security pass (F1–F5) | — |
| P5: Loom Plugin | 4-7d | ✅ Closed (P5.1–P5.5 all merged) | — |
| P6: Packaging + Docs | 5-7d | ✅ Closed (release workflow + MSI + npm + crate; OSS hygiene in v0.2.0) | — |
| P7: CI Pipeline + Test Pyramid | 6-12d | ✅ Closed (service CI re-enable + proto contract + mTLS handshake + gated E2E lane) | — |
| P8: Proto v1 Freeze | 2-3d | ✅ Closed (E1, E2 — proto v1 frozen) | — |
| P9: Provisioning + Bootstrap | — | ✅ Closed (v0.1.1 stack) | — |
| **v0.2.0 (shipped 2026-05-12)** | **bundle of local meta-build + networked control plane** | **✅ Tagged** | **See CHANGELOG.md** |
| **v0.2.1 (shipped 2026-05-13)** | **capability-surface scrub — wire-breaking patch** | **✅ Tagged** | **See CHANGELOG.md §0.2.1** |
| v0.3.0-1: Record/Replay | 5-7d | Next milestone | The agent-first differentiator |
| v0.3.0-2: Ephemeral VMs | 5-8d | Next milestone (in progress) | True repeatability + `template:` wiring (C9) + streamed copy (C8) |
| v0.3.0-3: Hermetic Envelope | 1-2d | Next milestone | Depends on Ephemeral VMs |
| v0.3.0-4: Explicit Orchestrator | 2-3d | Next milestone | Loom workflows + `loom tui` are the orchestrator; Signalman exposes the contract |
| v0.3.0-5: Cloud provider support | 10-15d | Next milestone | AWS + Azure: ephemeral test VMs + cloud runners (direct SDK), deploy targets (OpenTofu). Depends on -2 + -3 |
| v0.3.0-6: Kubernetes | 6-10d | Next milestone | `k8s_test` deploy target + Job-based runner substrate. Depends on -5 cloud-credential plumbing |
| v0.4.0+ | tracked above under "Speculative" | — | Auto-promotion / webhooks / scheduling, **artifact registry as standalone OSS product**, platform expansion, CLI/OSS-hygiene followups |

**v0.3.0 effort**: ~29-45 days. Critical path: Ephemeral VMs →
Hermetic Envelope → Cloud provider support → Kubernetes;
Record/Replay and the Loom-fronted orchestrator contract parallelize
with the cloud track.

---

## Cuts and Deferrals

Removed from main roadmap; revisit only with concrete evidence of need.

### 2026-05-14 (v0.4.0-4 cross-platform followups)

Two items from the WS4 cross-platform milestone were intentionally
deferred at the close of the workstream. Both have explicit
preconditions; do not re-open without them.

- **macOS UI automation parity with the Win32 UIA sidecar.** WS4
  landed the `Platform` trait, the Linux/macOS guest agent split,
  package-manager routing (`brew` on macOS), and a clean
  `Status::unimplemented` response for `ui_click` / `ui_type` /
  `ui_key` / `ui_find` / `ui_screenshot` / `browser_*` on non-
  Windows. The remaining work is a macOS-native UI driver
  (AppleScript + the Accessibility API), parallel to
  `guest/src/ui_sidecar.rs`. Scope estimate is multi-session and
  the selector/control-type grammar will be different from UIA's
  (`automation_id`, `class_name` don't translate cleanly to AX).

  **Precondition for restart**: the work must run on a real macOS
  development host. The current build environment is Windows; we
  cannot iterate on the Accessibility API surface or driving real
  desktop apps from here. **Next session must be on a Mac** — open
  a fresh worktree there off `feat/v0.4.0-cross-platform` (or the
  appropriate descendant), then implement
  `guest/src/ui_sidecar_macos.rs` behind
  `#[cfg(target_os = "macos")]` and flip
  `MacosPlatform::supports_ui_automation()` to true. The trait
  contract and unimplemented-message tests already in
  `guest/src/platform/macos.rs` lock the surface so the flip is
  a one-line capability change once the implementation lands.

  No proto change required — UI RPCs are already on the proto v1
  surface and the macOS side reuses them.

- **Backend convergence (vmrun.ts + vmware.ts).** WS4 deliberately
  shipped `host/src/hypervisors/vmrun.ts` as a parallel-track
  file rather than refactoring the existing `vmware.ts` (operator
  decision in the WS4 kickoff). The two drivers wrap the same
  `vmrun` CLI but differ on injection-shape and error-code
  surface; `vmware.ts` additionally has the `govc` fallback for
  vSphere.

  **Precondition for restart**: vmrun.ts must have seen at least
  one production scenario run end-to-end. Today (2026-05-14) it
  has only the unit + integration test fixtures from WS4 Chunk 3
  — merging now would lock in an unproven shape. Once a real
  scenario lands on it, audit which features each driver carries
  uniquely and converge onto one file. The govc-vSphere path
  belongs in the converged file; injectable exec + stable error
  codes (the vmrun.ts contribution) belong in the converged file.

  Operators currently choose between the two via
  `hypervisor.backend = "vmware"` vs `"vmrun"`; the convergence
  PR is expected to keep both keys working for one release with
  a deprecation note, then drop the older one.

### 2026-04-25 (audit-driven)

- **Hub component (`hub/`)** — was 122 LOC of TODO stubs. **Done
  2026-05-12**: removed from the tree; no other component relied
  on it.
- **Aspirational README claims** — Azure VMs, AWS EC2, scenario
  marketplace, UI automation, browser automation, cross-platform guest
  agents, fleet management. Removed from README in P6 (A3); reintroduce
  only when implemented. Sharpens v0.1.0 positioning to **Windows
  kernel-driver / ETW / WFP CI for security products** — the niche
  the kernel-debug + ETW tooling actually serves today.
- **Browser guest RPCs** ([proto/guest.proto](proto/guest.proto)
  — `BrowserNavigate`, `BrowserClick`, `BrowserScreenshot`)
  stay deferred until a real consumer needs them. Windows UIA RPCs have graduated from
  placeholders: `UIClick`, `UIType`, `UIKey`, `UIFind`, and `UIScreenshot`
  proxy to the interactive user-session sidecar and are covered by the
  `live-ui-sidecar-smoke` scenario. The remaining UI follow-up is
  implementation quality: replacing per-action PowerShell startup with a
  native long-lived helper.
- **`template:` field is decorative for v0.1.0.** Orchestrator never
  calls `resolveTemplate`; scenarios silently rely on a hand-built VM
  matching `vms[].name` literally and a hand-named checkpoint. Documented
  as known in P6; wired for real in v0.3.0-2 (C9). Acceptable for v0.1.0
  because the existing product scenarios already work this way.
- **Cross-platform claims** in README — removed until P8 (proto
  split) + E3 (Linux/macOS guest implementation) ship. P8 closed
  in v0.1.0; E3 largely shipped in v0.4.0-4 (WS4) — the guest
  crate now has a `Platform` trait, Linux SYSTEM-elevation via
  `sudo -n`, and `apt`/`dnf`/`yum`/`brew` package-manager
  routing. **Re-introduce README cross-platform claims** carefully
  scoped to what's actually supported today: Linux fully (guest
  agent + libvirt hypervisor); macOS partially (guest agent +
  Tart/vmrun hypervisors, but no UI automation — see
  *macOS UI automation* in the 2026-05-14 deferrals). Do NOT
  claim macOS UI driving until that work lands.

### 2026-04-24 (original)

- **Old Phase 1.3 (E2E test migration from a consuming product)**: now
  tracked by the consuming product's team, not by Signalman.
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
