# Capability matrix — 2026-05 Wave 3 (post-WS6-closeout)

**Scope**: every capability shipped to `main`. **Updated to HEAD `678a44b`** after the wave-3 carve-out batch (#1 + #2 + #5) closed three of the nine items in the recommended-sequence list.

Prior HEAD reference: `82506a1` (post-M9). The wave-3 carve-out batch ships:
- **`678a44b`** — cloud_vm install-bundle + cloud rollback + SSM/Bastion dialers (closes #1, #2, #5)

**Relationship to prior audits**:
- **Wave 1** (`docs/audit/capability-matrix-2026-05.md`, anchored at `558e0ed`) — the original WS6 milestone-0 audit. Preserved as historical record.
- **Wave 2** (`docs/audit/capability-matrix-2026-05-wave2.md`, anchored at `9f418b8`) — written between Wave A/B merges and the M5-M9 work. Preserved as historical record. The "What's left for the next round" section there is superseded by this doc's deferral list.
- **Wave 3 (this doc)** is the canonical post-WS6 state and the single source of truth for "what's left."

## Top-line counts (Wave 2 → Wave 3 → carve-out batch)

| | Wave 2 (`9f418b8`) | Wave 3 (`82506a1`) | + carve-out (`678a44b`) |
|---|---|---|---|
| MCP tools registered | 69 | 72 | **72** |
| CLI top-level verbs | 23+ | 24+ | **24+** |
| Skill files | 39 | 42 | **42** |
| TargetKind enum values | 6 | 8 | **8** |
| Migrations | 12 | 14 | **14** |
| `host/src/__tests__/*.test.ts` files | 134 | 139 | **140** (+ `cloud-dialers`) |
| Host tests passing | 2587 + 3 skipped | 2716 + 3 skipped | **2751 + 3 skipped** |
| Lines coverage | 84.29% | 84.55% | **~84.7%** |
| Branches coverage | 82.28% | 82.62% | **~82.7%** |
| Functions coverage | 88.19% | 88.32% | **~88.4%** |
| Registry tests passing | (separate config) | 107 / 107 | **107 / 107** |
| Cloud dialer module | — | — | **5 files / 23 tests** |

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

**Closure tracker (`678a44b`)**: ✅ #1 (M8 cloud_vm install-bundle), ✅ #2 (M8 cloud rollback), ✅ #5 (SSM/Bastion tunneling dialers) all shipped in the wave-3 carve-out batch. Remaining: #3, #4, #6, #7, #8, #9.

> Symbol legend:
> ✅ **Done** — shipped to main.
> 🚧 **Blocking** — has a precondition that must be met before the work can even start.
> ⚡ **Quick win** — small scope, no external deps, can be picked off in a single session.
> 🔄 **In-place follow-up** — extends an existing surface; risk surface is well-understood.
> 🆕 **New surface** — adds capability that doesn't exist today; design surface is wider.

### 1. ✅ M8 cloud_vm install-bundle integration — **CLOSED in `678a44b`**

Shipped: targets gain an optional `install_bundle_path` connection field. When set, the executor parses the YAML, builds a `GuestAgentClient` over the dial address, and runs `installBundle` after reachability passes. Per-package health checks (`install:<pkg>`) surface in `signalman_health_history`; install failures mark the deployment failed with the underlying error.

Injectable `installBundleInvoker` for tests; production wires through `installBundle` from `host/src/provisioning/install-bundle.ts`.

4 new tests in `host/src/__tests__/cloud-deploy.test.ts` cover: happy path with per-package checks; failure marks deployment failed; absent path = today's behaviour; malformed YAML throws.

**Operator surface**: add `install_bundle_path: "/abs/path/to/bundle.yaml"` to a `cloud_vm` target's connection JSON. The path is resolved on the operator's host (NOT the cloud VM); bundle source fields (e.g. `direct` artifacts) are still fetched by the guest agent on the remote.

### 2. ✅ M8 cloud rollback (cloud_vm + cloud_stack) — **CLOSED in `678a44b`**

Shipped: new `runCloudReleaseRollback` resolves the prior-active deployment for the target and re-runs the deploy path against that older release. Works identically for both kinds because both dispatch through `runCloudReleaseDeploy`.

Audit-log marker: `release.rollback.started` / `_completed` / `_failed` entries WRAP the inner `release.deploy.*` entries so operators can distinguish "I asked for rollback" from "I asked for deploy of release N (which happens to be older)."

Edge cases tested: no active deployment refuses; one-deploy-only refuses; explicit `toReleaseId` pins; rollback failures emit `release.rollback.failed`. 6 new tests.

**Operator surface**: `signalman release rollback --target <cloud-target>` now works without falling back to the manual "redeploy the prior release" pattern. The old pattern still works for explicit version pinning (via `--release`).

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

### 5. ✅ WS1 SSM / Bastion tunneling dialers — **CLOSED in `678a44b`**

Shipped: new module `host/src/cloud/dialers/` with `Dialer` interface + `DialerError` (stable codes: `auth_failed` / `cli_not_found` / `tunnel_failed` / `unsupported_descriptor`) + injectable `DialerExec` + two concrete dialers:
- `AwsSsmDialer`: shells out to `aws ssm start-session --document-name AWS-StartPortForwardingSession`; ready-on-output detection; SIGTERM→SIGKILL close.
- `AzureBastionDialer`: shells out to `az network bastion tunnel`; same pattern.

`defaultDialerFor(descriptor)` dispatches by `kind`; `public_mtls` correctly throws `unsupported_descriptor` (no dialer needed).

**Upstream changes**: `CloudConnectionDescriptor` in `host/src/cloud/types.ts` extended:
- `aws_ssm` gained optional `profile?: string`
- `azure_bastion` gained required `bastion_name: string` (a resource group can host multiple Bastions; `az network bastion tunnel --name` needs it)

`getConnectionDescriptor` takes `bastionName` + `awsProfile` opts; CLI gains `--bastion-name` + `--aws-profile`.

**M8 integration**: `runCloudVmReleaseDeploy` no longer refuses `aws_ssm` / `azure_bastion`. Targets carry `tunnel_options: { aws_profile?, azure_bastion_name?, azure_subscription_id?, azure_resource_group? }`. Deploy resolves descriptor → opens tunnel → dials `127.0.0.1:<localPort>` instead of the cloud IP. Tunnel closes on both success and error paths.

Tests: 23 in `cloud-dialers.test.ts` + 2 new dialed-tunnel integration tests in `cloud-deploy.test.ts`.

**Shell-out only**: no new npm deps. Operator must have `aws` / `az` CLIs on PATH with the Session Manager plugin / `bastion` extension installed respectively. The `DialerError('cli_not_found')` code surfaces missing-CLI cases.

**Operator surface**: set `network_mode: "aws_ssm"` (or `azure_bastion` + tunnel_options) on a `cloud_vm` target's connection JSON, then `signalman release deploy` just works.

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
