# Capability matrix — 2026-05 Wave 3 (post-WS6-closeout)

**Scope**: every capability shipped to `main` at HEAD `82506a1` — the consolidated state after WS6 closed M5 (audit log surface), M6 (P0 micro-skills), M7 (WS3↔WS2 health-gate), M8 (cloud_vm + cloud_stack target kinds), and M9 (runner deploy multi-transport).

**Relationship to prior audits**:
- **Wave 1** (`docs/audit/capability-matrix-2026-05.md`, anchored at `558e0ed`) — the original WS6 milestone-0 audit. Preserved as historical record.
- **Wave 2** (`docs/audit/capability-matrix-2026-05-wave2.md`, anchored at `9f418b8`) — written between Wave A/B merges and the M5-M9 work. Preserved as historical record. The "What's left for the next round" section there is superseded by this doc's deferral list.
- **Wave 3 (this doc)** is the canonical post-WS6 state and the single source of truth for "what's left."

## Top-line counts (Wave 2 → Wave 3)

| | Wave 2 (`9f418b8`) | Wave 3 (`82506a1`) |
|---|---|---|
| MCP tools registered | 69 | **72** (+`signalman_audit_query/_append/_runner_deploy`) |
| CLI top-level verbs | 23+ | **24+** (+`signalman audit`) |
| Skill files | 39 | **42** (+`signalman-query-audit-log` / `signalman-deploy-to-cloud` / `signalman-deploy-runner`) |
| TargetKind enum values | 6 | **8** (+`cloud_vm`, `cloud_stack`) |
| Migrations | 12 | **14** (+`0071_promotion_health_gate`, `0072_target_kind_cloud.{sqlite,pg}.sql`) |
| `host/src/__tests__/*.test.ts` files | 134 | **139** |
| Host tests passing | 2587 + 3 skipped | **2716 + 3 skipped** |
| Lines coverage | 84.29% | **84.55%** |
| Branches coverage | 82.28% | **82.62%** |
| Functions coverage | 88.19% | **88.32%** |
| Registry tests passing | (separate config) | **107 / 107** |

All four host gates above 80 / 70 / 80 / 80 threshold.

## WS6 milestone close-out (M5 → M9)

| M# | Title | Commit | Closes |
|---|---|---|---|
| M5 | Audit log CLI + MCP surface | `a8da0db` | Wave-2 P2 gap "HTTP audit log query/post operator-only" |
| M6 | P0 micro-skills wiring (promotion_approvals + schedule_run_once) | `f51d9a5` | Wave-2 P0 gaps |
| M7 | WS3 promotion auto-approver health-gate | `a7c3b84` | Wave-2 cross-workstream #6 |
| M8 | cloud_vm + cloud_stack target kinds | `1b2da08` | Wave-2 cloud-deploy gap #4 |
| M9 | Runner deploy multi-transport (script/ssh/winrm/docker/cloud) | `82506a1` | Wave-2 runner-deploy gap #3 (M3.5 deferral) |

## Gap-list re-tier (post-M5-M9)

**P0 — shipped + functional + MCP + CLI + skill**: closed. Both prior P0 micro-gaps are wired via the existing `signalman-promote-release` and `signalman-schedule-health` skills (M6).

**P1 — shipped + CLI but not MCP**: 0 remaining (closed at Wave 2).

**P1' — shipped + MCP but not CLI**: 0 remaining (closed at Wave 2).

**P2 — shipped but neither MCP nor skill (operator-only)**: 2 remaining (down from 3).
- HTTP audit log: **CLOSED** by M5.
- Jobs queue HTTP-only: intentionally not surfaced (runner-internal protocol; surfacing would invite misuse).
- `/v1/releases/:id/artifacts`: partially mitigated by `signalman_release_show` returning artifact metadata. Could add a thin verb in a future round if operator demand surfaces.

**P3 — shipped + silent regression risk**: 2 remaining (unchanged from Wave 2).
- `signalman_advanced_vm_screenshot` test pin (`vm-screenshot.test.ts`) — placeholder stub.
- WS1 `cloud-aws.test.ts` / `cloud-azure.test.ts` cold-import cost — documented; under timeouts.

## Carve-outs and next steps (recommended sequence)

This is the operator's working list. Items are ordered by **recommended sequence**: what unblocks the most downstream work first, then tooling-readiness, then size.

> Symbol legend:
> 🚧 **Blocking** — has a precondition that must be met before the work can even start.
> ⚡ **Quick win** — small scope, no external deps, can be picked off in a single session.
> 🔄 **In-place follow-up** — extends an existing surface; risk surface is well-understood.
> 🆕 **New surface** — adds capability that doesn't exist today; design surface is wider.

### 1. M8 cloud_vm install-bundle integration ⚡ 🔄

**What's there now**: M8 ships cloud_vm deploy as reachability-probe + Deployment row. The VM is verified-reachable but Signalman doesn't actually install the release artifact onto it; operators wire that themselves via cloud-init / userdata / post-deploy hooks.

**What's missing**: Wire `host/src/provisioning/install-bundle.ts` into `runCloudVmReleaseDeploy` so after reachability passes, the executor pulls the release artifact, builds a `GuestAgentClient` over the cloud IP, and runs the install-bundle DAG (same code path as `vm_test`/`vm_demo`).

**Entry points**:
- `host/src/verbs/control-plane.ts` → `runCloudVmReleaseDeploy` (line ~1670, after the reachability probe)
- `host/src/provisioning/install-bundle.ts` (the bundle DAG executor)
- `host/src/guest/client.ts` → `GuestAgentClient` constructor

**Size**: ~150-250 LOC + a few tests. Closest existing analogue: how the VM-backed `runDeploy` calls install steps via the hypervisor backend.

**Why first**: smallest new code; closes the "what does cloud_vm deploy actually DO" question that the M8 deferral message points at. No external tooling deps.

### 2. M8 cloud rollback (cloud_vm + cloud_stack) ⚡ 🔄

**What's there now**: M8 deploy adapter is fully wired; rollback is explicitly refused with an operator-facing pointer ("redeploy the prior release with `signalman release deploy --release <prior-id>`").

**What's missing**: Symmetric rollback paths. For `cloud_stack`, this is mostly "re-apply with the prior release's vars" (functionally identical to `release deploy --release <prior>`, but operators expect `release rollback` to work). For `cloud_vm`, depends on item #1 above — rollback = redeploy the prior release artifact onto the same instance.

**Entry points**:
- `host/src/verbs/control-plane.ts` → `runReleaseRollback` (line ~921, the `isCloudTargetKind` refusal)
- The existing `runK8sReleaseRollback` is the model (mirror its shape for cloud variants).

**Size**: small per kind. Ship `cloud_stack` rollback first (simpler — just re-apply with prior vars); `cloud_vm` rollback depends on #1.

**Why second**: small, in-place, and once #1 lands, this is "copy the deploy path with reversed release lookup."

### 3. M9 transports — live integration tests 🚧 🔄

**What's there now**: M9's five transports (script / ssh / winrm / docker / cloud) ship with 45 unit tests that pin every command shape, but no live integration tests against real SSH/WinRM/Docker/cloud targets.

**What's missing**: An integration-test lane that runs:
- The script transport's emitted bash against a Linux container.
- The ssh transport against a sshd container.
- The winrm transport against a WSL-hosted or container'd Windows target.
- The docker transport against a local daemon.
- The cloud transport against AWS / Azure (gated on credentials).

**Entry points**: `host/src/__tests__/runner-deploy.test.ts` (unit tests live here; a new `host/src/__tests__/runner-deploy.integration.test.ts` would mirror the pattern). The CI lane would need a `.github/workflows/runner-deploy-integration.yml` or similar.

**Size**: setup-heavy, code-light. The transports are operator-driven today, so this is a CI/operational confidence pass, not a code change.

**Why third**: locks in M9's contract before any downstream consumer (auto-provisioning operator workflows) takes a hard dependency on the surface.

🚧 **Precondition**: a CI lane with credentials for AWS + Azure for the cloud-transport tests. Each non-cloud transport tests against a container so its precondition is just Docker-in-CI.

### 4. WS1 sub-task 7 — Packer golden images 🚧 🆕

**What's there now**: WS1 shipped sub-tasks 5/6/8 (cost-guardrails, networking, credentials, CLI parity). Sub-task 7 (Packer-built golden images — VHDX + AMI + Azure managed image in lockstep) is the remaining WS1 deliverable.

**What's missing**: A Packer-based image build pipeline that produces:
- A Hyper-V VHDX image for the local backend.
- An AWS AMI per region for the AwsBackend.
- An Azure managed image per region for the AzureBackend.

All three in lockstep so the same scenario can pin a single Signalman image-ref and have it resolve correctly on any backend.

**Entry points**:
- Existing: `.workstream-status.md` §"Sub-task 7" + `docs/workstreams/PLAN.md` (the original sub-task plan).
- Greenfield: `infra/packer/` or similar (no existing tree).

**Size**: multi-day. Includes Packer templates, post-build artifact upload to AWS + Azure, image-id tagging for cross-backend lookup, and a CI lane that runs the build periodically (or on demand).

**Why fourth**: 🚧 **Precondition**: Packer binary + AWS + Azure credentials in a CI lane. Until those are available, this can't start.

### 5. WS1 SSM / Bastion tunneling drivers 🚧 🔄

**What's there now**: WS1 sub-task 6 shipped the connection-descriptor contract — `signalman_cloud_connection_descriptor` returns the addressing parameters a caller needs for `public_mtls` / `aws_ssm` / `azure_bastion`. The actual SSM Session Manager / Azure Bastion dialers were explicitly deferred.

**What's missing**: Two concrete dialer drivers:
- AWS SSM: open an SSM session, port-forward the descriptor's `port` to the local socket, expose the local end as a dial target.
- Azure Bastion: equivalent using Bastion's native-client port-forwarding API.

**Entry points**:
- `host/src/cloud/connection.ts` — descriptor types.
- M8 cloud_vm deploy refuses `aws_ssm` / `azure_bastion` modes with a clear error pointing at this work (`host/src/verbs/control-plane.ts` → `runCloudVmReleaseDeploy`).

**Size**: medium per driver. Each is an SDK integration + a local-socket forwarder.

**Why fifth**: 🚧 **Precondition**: AWS SDK SSM client + Azure SDK Bastion client integration + a target VM provisioned in the relevant mode. Unblocks the M8 cloud_vm refusal path.

### 6. WS1 Loom plugin handlers (Rust) 🚧 🆕

**What's there now**: The Loom plugin skeleton crate exists at `plugins/signalman-loom-plugin/` with handlers.rs / events.rs / forms.rs / etc. — but no `cloud_*` / `reaper_*` / `budget_*` / `stack_*` handlers wired through.

**What's missing**: Loom plugin handlers for the v0.3.0-5 sub-task 4/5/6/8 surface:
- `loom.signalman.cloud_provision` / `_terminate` / `_status` / `_list`
- `loom.signalman.reaper_run_once` / `_status`
- `loom.signalman.budget_get` / `_set` / `_usage`
- `loom.signalman.stack_apply` / `_destroy` / `_plan_cost`
- `loom.signalman.creds_set` / `_get` / `_remove`

Each handler shells out to (or reimplements) the host's equivalent MCP tool over the Signalman host's HTTP control plane.

**Entry points**:
- `plugins/signalman-loom-plugin/src/handlers.rs` — extend.
- `plugins/signalman-loom-plugin/Cargo.toml` — likely needs AWS/Azure SDK Rust deps (or reqwest if delegating to the host's HTTP layer).

**Size**: large. Rust + multi-vendor + plugin SDK + tests.

**Why sixth**: 🚧 **Precondition**: a Rust-focused session (current environment is TypeScript-primary). Surfaces a separate operator path (Loom workflows) but doesn't unblock TypeScript-side work.

### 7. WS4 macOS UI automation parity 🚧 🆕

**What's there now**: WS4 landed the `Platform` trait + Linux/macOS guest agent split + `brew`/`apt`/`dnf` package routing + clean `Status::unimplemented` responses for `ui_*` / `browser_*` RPCs on non-Windows. See `ROADMAP.md` §"2026-05-14 (v0.4.0-4 cross-platform followups)".

**What's missing**: A macOS-native UI driver using AppleScript + the Accessibility API, parallel to `guest/src/ui_sidecar.rs`. The selector/control-type grammar is different from UIA's; this isn't a copy-paste.

**Entry points**:
- `guest/src/platform/macos.rs` — flip `MacosPlatform::supports_ui_automation()` to true once the impl lands.
- `guest/src/ui_sidecar_macos.rs` (new file, behind `#[cfg(target_os = "macos")]`).

**Size**: multi-session.

**Why seventh**: 🚧 **Precondition**: a real macOS development host. The current Windows build environment can't iterate on AX. **Next session must be on a Mac.** The trait contract is already locked so the flip is a one-line capability change once implementation lands.

### 8. WS4 vmrun ↔ vmware.ts convergence 🔄

**What's there now**: WS4 deliberately shipped `host/src/hypervisors/vmrun.ts` as a parallel-track file rather than refactoring the existing `host/src/hypervisors/vmware.ts` (operator decision in the WS4 kickoff). Both wrap the `vmrun` CLI but differ on injection-shape and error-code surface.

**What's missing**: A converged single file that carries:
- vmrun.ts's contributions: injectable exec + stable error codes.
- vmware.ts's contributions: `govc` fallback for vSphere.

Plus a one-release deprecation window where both `hypervisor.backend = "vmware"` and `"vmrun"` keep working.

**Entry points**:
- `host/src/hypervisors/vmware.ts` (existing, primary).
- `host/src/hypervisors/vmrun.ts` (parallel-track, to be merged in).

**Size**: small-medium — mostly refactor + a deprecation note. Tests exist for both.

**Why eighth**: 🚧 **Precondition** (per ROADMAP): vmrun.ts must have seen at least one production scenario run end-to-end. Today (2026-05-15) it has only the unit + integration fixtures. **Don't merge until proven in a real scenario.**

### 9. WS5 registry hardening 🆕

**What's there now**: WS5 shipped the OSS scaffolding for `@signalman/registry`: generic blob + manifest types, `LocalFsBlobStore`, SQLite manifest catalog, Ed25519 signing, HTTP API, CLI (`registry serve|verify|keygen`), and the `signalman-registry` BlobDriver in `@signalman/host` that proves federation.

**What's missing** (per `registry/ROADMAP.md`):
- **v0.4.1**: OCI distribution spec v1.1 compliance.
- **v0.4.2**: Mutable tags + retention/GC.
- **v0.4.3**: Operational hardening.
- **v0.4.4**: RBAC + cloud federation.
- **v0.4.x**: Protocol facades, virtual registries, vulnerability scanning.

**Entry point**: `registry/ROADMAP.md` is the canonical roadmap.

**Size**: multi-PR. Each `v0.4.x` line is its own milestone with its own design surface.

**Why last**: ✋ **Explicit scope boundary**: this is WS5's roadmap, not WS6's. Reopening WS5 requires its own kickoff and capacity planning. Tracked here for completeness, not for immediate action.

### Out-of-scope (won't fix unless operator explicitly requests)

- **`/v1/releases/:id/artifacts` MCP/CLI surface** — partially mitigated by `signalman_release_show` returning artifact metadata. No operator demand has surfaced; promoting to a follow-up only when it does.
- **Jobs queue HTTP surface promotion** — intentionally runner-internal; surfacing would invite misuse.
- **`signalman_advanced_vm_screenshot`** — P3 placeholder test stub. Will be addressed naturally when the real screenshot RPC lands.

## Coverage notes (Wave 3)

Coverage moved UP slightly from Wave 2:

| Metric | Wave 2 | Wave 3 | Delta |
|---|---|---|---|
| Lines | 84.29% | 84.55% | +0.26 |
| Branches | 82.28% | 82.62% | +0.34 |
| Functions | 88.19% | 88.32% | +0.13 |

The M5-M9 additions were tested at unit + integration layers proportional to the new surface, so the headline percentage held above the gate even as the codebase grew.

## What the operator should read first when picking up next work

1. This document (`wave3`) for the **what's left** list above.
2. `.workstream-status.md` for the per-milestone close-out narrative + 4-lens audits.
3. `ROADMAP.md` (main) for WS4 deferrals + cross-component dependencies.
4. `registry/ROADMAP.md` for WS5's own follow-up plan.
5. `docs/workstreams/PLAN.md` for the original six-workstream plan + reserved migration blocks.

If the operator's next gesture is "pick up item #N from the carve-outs list", they should grep this doc for that item's section, then jump to the named entry points.
