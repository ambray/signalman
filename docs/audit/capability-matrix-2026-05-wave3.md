# Capability matrix — 2026-05 Wave 3 (post-WS6-closeout)

**Scope**: every capability shipped to `main`. **Updated through batch 2** of the wave-3 carve-out closure work. Six of nine items now closed; the remaining three are blocked on external environments.

HEAD progression:
- `82506a1` — post-M9 (WS6 complete; wave-3 doc baseline)
- `678a44b` — wave-3 carve-out batch 1: cloud_vm install-bundle + cloud rollback + SSM/Bastion dialers (#1, #2, #5)
- Batch 2 (this round): M9 integration scaffolding + Packer golden-image scaffolding + Loom plugin cloud handlers (#3, #4, #6) — about to land in a single batch commit.

**Relationship to prior audits**:
- **Wave 1** (`docs/audit/capability-matrix-2026-05.md`, anchored at `558e0ed`) — the original WS6 milestone-0 audit. Preserved as historical record.
- **Wave 2** (`docs/audit/capability-matrix-2026-05-wave2.md`, anchored at `9f418b8`) — written between Wave A/B merges and the M5-M9 work. Preserved as historical record. The "What's left for the next round" section there is superseded by this doc's deferral list.
- **Wave 3 (this doc)** is the canonical post-WS6 state and the single source of truth for "what's left."

## Top-line counts (Wave 2 → Wave 3 → carve-out batch 1 → carve-out batch 2)

| | Wave 2 (`9f418b8`) | Wave 3 (`82506a1`) | Batch 1 (`678a44b`) | Batch 2 (this round) |
|---|---|---|---|---|
| MCP tools registered (host) | 69 | 72 | 72 | **72** |
| Loom plugin handlers | 5 | 5 | 5 | **25** (+17 cloud) |
| CLI top-level verbs | 23+ | 24+ | 24+ | **24+** |
| Skill files | 39 | 42 | 42 | **42** |
| TargetKind enum values | 6 | 8 | 8 | **8** |
| Migrations | 12 | 14 | 14 | **14** |
| `host/src/__tests__/*.test.ts` files | 134 | 139 | 140 | **142** (+ integration + packer-templates) |
| Host tests passing | 2587 + 3 skipped | 2716 + 3 skipped | 2751 + 3 skipped | **2761 + 8 skipped** |
| Plugin (Rust) tests passing | n/a | n/a | n/a | **201** (was 168 — +33 cloud handler unit tests) |
| Lines coverage | 84.29% | 84.55% | ~84.7% | **~84.7%** |
| Branches coverage | 82.28% | 82.62% | ~82.7% | **~82.7%** |
| Functions coverage | 88.19% | 88.32% | ~88.4% | **~88.4%** |
| Registry tests passing | (separate config) | 107 / 107 | 107 / 107 | **107 / 107** |
| Cloud dialer module | — | — | 5 files / 23 tests | **5 files / 23 tests** |
| Packer templates | — | — | — | **4 HCL files + 1 workflow + 1 sanity test (9 tests)** |
| M9 integration scaffolding | — | — | — | **1 test file + compose + 1 workflow** |

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

**Closure tracker**:
- Batch 1 (`678a44b`): ✅ #1 (M8 cloud_vm install-bundle), ✅ #2 (M8 cloud rollback), ✅ #5 (SSM/Bastion tunneling dialers).
- Batch 2 (parallel-agent batch): ✅ #3 (M9 integration test scaffolding), ✅ #4 (Packer golden-image scaffolding), ✅ #6 (Loom plugin Rust handlers).
- **Batch 3 — M10 wave** (`8b8f8c9` → `59bdfd9` + M10.6): ✅ #9 (WS5 registry hardening — re-scoped to cargo facade + virtual registry + forensic API as the bootstrap-enabling subset).
- **Remaining: #7, #8 only.** Both blocked on external environments (real Mac dev host / live scenario run on vmrun.ts).

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

### 3. ✅ M9 transports — live integration test scaffolding — **CLOSED (scaffolding shipped)**

Shipped scaffolding (an operator with a CI lane + cloud creds runs the tests; they're skipped by default):

- `host/src/__tests__/runner-deploy.integration.test.ts` — 6 tests gated on `SIGNALMAN_INTEGRATION_TESTS=1`. Default `npx vitest run` skips them; activating the env var runs the script/ssh/docker/cloud legs. WinRM is documentation-only (operator-driven against a real Windows host).
- `host/test-fixtures/runner-deploy/docker-compose.yml` — sshd fixture (linuxserver/openssh-server on 127.0.0.1:2222). Throwaway keys live under `fixtures/` (gitignored).
- `host/test-fixtures/runner-deploy/README.md` — operator-side env-var checklist for each transport leg.
- `.github/workflows/runner-deploy-integration.yaml` — runs on workflow_dispatch + weekly schedule + PRs touching the runner-deploy surface. Cloud leg gated on `vars.SIGNALMAN_HAS_CLOUD_CREDS == 'true'` + secrets being present.

**Live testing remains operator-driven**: this commit ships the harness; the operator activates it by adding GitHub secrets + setting the env vars. The cloud-transport leg is double-gated (creds + `SIGNALMAN_INTEGRATION_CLOUD_OPT_IN=1`) because it provisions real VMs that cost real money.

🚧 **Remaining precondition for actual execution**: AWS / Azure secrets + a runner with Docker for the sshd container. Until then the workflow exists, validates syntactically, but the cloud leg self-skips.

### 4. ✅ WS1 sub-task 7 — Packer golden-image scaffolding — **CLOSED (scaffolding shipped)**

Shipped scaffolding (an operator with cloud creds runs the workflow; HCL is hand-validated against Packer 1.10+ syntax):

- `infra/packer/aws/ami.pkr.hcl` — `amazon-ebs` builder; per-region AMI build (Ubuntu 22.04); guest-agent baked in as a systemd unit; manifest post-processor emits AMI ids.
- `infra/packer/azure/managed-image.pkr.hcl` — `azure-arm` builder; per-region managed image; same provisioner shape.
- `infra/packer/hyperv/vhdx.pkr.hcl` — Windows Server 2022 base; operator-driven (no nested-virt on GitHub-hosted runners; documented).
- `infra/packer/common/build.pkrvars.hcl` — shared variables (`agent_version`, `image_tag`, etc.) with sensible defaults.
- `infra/packer/README.md` — operator setup: required toolchain, secret list, manifest-id consumption flow back into `signalman cloud provision --image-ref`.
- `.github/workflows/golden-images.yml` — runs on workflow_dispatch + monthly schedule; AWS + Azure lanes gated on creds being present; Hyper-V is doc-only.
- `host/src/__tests__/packer-templates.test.ts` — 9 sanity tests asserting the HCL files reference the expected sources, that the workflow references the expected secrets, and that the Hyper-V build is correctly excluded from CI.

**Live builds remain operator-driven**: this commit ships the templates + workflow. The operator activates by adding `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or the Azure equivalents) + optionally `MTLS_ROOT_CA` to repo secrets, then triggers `workflow_dispatch`.

🚧 **Remaining precondition for actual execution**: Packer-capable runner + cloud secrets + a per-region build matrix decision (currently sequential list-var, not cross-region copy). All flagged in the README's "Known limitations".

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

### 6. ✅ WS1 Loom plugin handlers (Rust) — **CLOSED**

Shipped: 17 new Loom-namespaced MCP handlers in `plugins/signalman-loom-plugin/src/handlers.rs`. Each follows the existing `register_X` / `build_X_args` / `handle_X` pattern and shells out via `run_signalman` (already on the subprocess allowlist; no new Cargo deps).

Surface:
- `loom.signalman.cloud_provision` / `_terminate` / `_status` / `_list` / `_backends` / `_connection_descriptor` (6)
- `loom.signalman.reaper_run_once` / `_status` (2)
- `loom.signalman.budget_get` / `_set` / `_usage` (3)
- `loom.signalman.stack_apply` / `_destroy` / `_plan_cost` (3)
- `loom.signalman.creds_set` / `_get` / `_remove` (3)

Total handler count: 5 existing (list/describe/plan/run/status) + 8 mid-WS6 additions + **17 new** = **25 handlers** registered. `tests/inventory.rs` + the registration test in `lib.rs` both updated.

Tests: 33 new unit tests in `mod tests` of `handlers.rs` (target was ~20; agent shipped overcoverage including 4 reject-malformed-input cases for the trickier creds / budget / stack verbs). All 201 plugin tests pass (`cargo test`); `cargo check` + `cargo clippy --all-targets --no-deps` clean.

Plus an incidental `cargo fmt --all` cleanup pass over the plugin tree — the plugin had pre-existing fmt drift (events.rs, forms.rs, etc.) that wasn't enforced by CI. Bundled with this commit; +254 lines of pure formatting are NOT new logic.

**Operator surface**: Loom workflows now drive every operator-facing cloud verb through the plugin's namespaced MCP tool. The architecture diagram showing Signalman exposing cloud capability through Loom is now true end-to-end.

**Deliberate JSON ↔ argv translations** (documented in commit + handler doc comments):
- `org_id` (JSON) → `--org` (CLI) for budget + creds
- `monthly_cap_cents` (JSON) → `--monthly-cents` (CLI) — validated `> 0` at the plugin layer
- `plaintext_json` object (JSON) → split per-backend argv flags (`--access-key-id` etc.) — plaintext NEVER appears on argv in stable form
- `stack_destroy --module-path`: required in JSON for symmetry, silently dropped from argv (CLI keys destroy on stack-name only)

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

### 9. ✅ WS5 registry hardening — **CLOSED in M10 wave (2026-05-15)**

Re-scoped from "registry hardening" to **bootstrap-enabling subset of the WS5 roadmap**. The cargo facade + virtual registry + forensic API are now operator-ready; the remaining WS5 roadmap items (npm/OCI/maven facades, mutable tags, RBAC, vulnerability scanning) are queued in `registry/ROADMAP.md` v0.1.x and beyond as their own milestones.

**Shipped in M10** (commits `8b8f8c9`, `6731445`, `6a155af`, `ac15dda`, `59bdfd9`, M10.6):

| Phase | Title | Commit |
|---|---|---|
| M10.1 | Manifest `kind` discriminator + Provenance + audit log + migration | `8b8f8c9` |
| M10.2 | Cargo sparse-index read path + per-org namespacing | `6731445` |
| M10.3 | Cargo publish + yank + audit-log on writes | `6a155af` |
| M10.4 | Cargo virtual-registry pull-through + re-signing | `ac15dda` |
| M10.5 | Forensic + provenance HTTP API | `59bdfd9` |
| M10.6 | Operator surface (CLI verbs + skill) + ROADMAP refresh | (this batch) |

**Operator surface now reachable**:
- `cargo publish` / `cargo install` against per-org sparse indexes
- Virtual upstreams transparently mirror crates.io with optional re-signing
- Every artifact carries provenance (`source: upload | proxy_cache | manifest_create`) — answers "what's in my registry and where did it come from"
- Immutable audit log with filtered query API — answers "who did what when"

**Coverage**: registry package at 87% lines / 80% branches / 96% functions across 220+ tests (post-M10.6). All above 80/70/80/80 thresholds.

**What's queued for v0.1.x** (per `registry/ROADMAP.md` refresh):
- **v0.1.1**: npm protocol facade — `@signalman/host` becomes `npm install`-able
- **v0.1.2**: OCI distribution spec — `docker pull` against a Signalman registry
- **v0.1.3**: Security integration — OSV + Veracode / Sonatype firewall passthroughs
- **v0.1.4**: Mutable tags + retention/GC

These together close the **"bootstrap signalman from signalman"** loop end-to-end (the operator's CI publishes; their CD pulls; supply-chain provenance is a single HTTP call away). See `registry/ROADMAP.md` §"What 'bootstrap signalman from signalman' looks like end-state" for the day-0-to-day-3 walkthrough.

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
