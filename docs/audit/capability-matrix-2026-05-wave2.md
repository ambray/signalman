# Capability matrix — 2026-05 Wave 2

**Scope**: every capability shipped to `main` at HEAD `9f418b8` — the consolidated state after Wave A (WS1 + WS2 + WS3 + WS6) and Wave B (WS4 + WS5) merged. This refresh follows the Wave-1 matrix at `docs/audit/capability-matrix-2026-05.md` (anchored at `558e0ed`).

**Diff since Wave 1 (558e0ed → 9f418b8)**: 50 net commits, 6 workstreams consolidated.

## Top-line counts (Wave 1 → Wave 2)

| | Wave 1 (558e0ed) | Wave 2 (9f418b8) |
|---|---|---|
| MCP tools registered (`server.tool(...)`) | 39 | **69** |
| CLI top-level verbs | 17 | **23+** (cloud, stack, k8s, schedule, webhook, promotion, registry serve added) |
| Skill files (`skills/<name>/SKILL.md`) | 10 | **39** |
| Migrations (`storage/migrations/`) | 4 | **12** (0001–0005 baseline + WS6; 0040–0041 WS1; 0050 WS2; 0060/0065/0070 WS3) |
| `host/src/__tests__/*.test.ts` files | 91 | **134** |
| Tests passing | 1899 | **2587** + 3 skipped |
| Lines coverage | 86.59% | **84.29%** (still > 80% gate) |
| Branches coverage | 81.65% | **82.28%** |
| Functions coverage | 91.15% | **88.19%** |

## Wave-A + Wave-B contributions by workstream

### WS1 — Cloud completion (v0.3.0-5 sub-tasks 5/6/8)

- TTL reaper (`signalman_reaper_run_once` / `_status`)
- Per-org budgets (`signalman_budget_get` / `_set` / `_usage`)
- Per-org credentials (`signalman_creds_set` / `_get` / `_remove`)
- Cloud connection descriptor (`signalman_cloud_connection_descriptor`)
- Stack pre-flight cost estimate (`signalman_stack_plan_cost`)
- CLI parity: `signalman cloud` + `signalman stack` subcommand families
- 5 skills: signalman-build-cloud-connection, signalman-estimate-stack-cost, signalman-manage-cloud-budget, signalman-manage-cloud-credentials, signalman-reap-cloud-instances
- Migrations: 0040 (cloud_budgets), 0041 (cloud_credentials)
- New module: `host/src/cloud/{budget,connection,cost,credentials,per-org-backend,reaper}.ts`

### WS2 — Kubernetes (v0.3.0-6)

- KubectlDriver + HelmDriver (`host/src/k8s/`)
- K8s deploy executor + release-deploy wiring
- 3 MCP tools: `signalman_k8s_deploy` / `_rollback` / `_status`
- CLI: `signalman k8s deploy|rollback|status` + `signalman runner deploy-k8s`
- 3 skills: signalman-deploy-k8s, signalman-rollback-k8s, signalman-k8s-status
- Migration: 0050 (target_kind_k8s, dialect-split into .pg.sql + .sqlite.sql)
- Target-kind enum extended: `k8s_test`, `k8s_demo`

### WS3 — Release operations (v0.4.0 Epics 1–3)

- Scheduled health checks (Epic 3): scheduler + 6 MCP tools (`signalman_schedule_list|add|disable|enable|remove|run_once`) + CLI parity
- Outbound webhooks (Epic 2): dispatcher + HMAC + Slack/email drivers + 4 MCP tools (`signalman_webhook_list|add|remove|test`)
- Promotion policies (Epic 1): policy table + listener + 7 MCP tools (`signalman_promotion_list|add|remove|approve|reject|approvals|tick`) + tier-to-tier approver allow-list
- 3 skills: signalman-schedule-health, signalman-add-webhook, signalman-promote-release
- Migrations: 0060 (health_schedule), 0065 (webhook_subscription), 0070 (promotion_policy)
- New modules: `host/src/control-plane/{events,promotion,scheduler}/`
- New host dep: `nodemailer` + `@types/nodemailer`

### WS4 — Cross-platform (v0.4.0-4)

- Guest-agent platform split (`guest/src/platform/{windows,linux,macos,other}.rs`)
- libvirt host hypervisor backend (`host/src/hypervisors/libvirt.ts`)
- vmrun host hypervisor backend for VMware Fusion (`host/src/hypervisors/vmrun.ts`)
- Linux SYSTEM-elevation via passwordless `sudo -n`
- apt/dnf/yum/brew package-manager routing
- Backend fixtures + tests (libvirt-argv, libvirt-backend, vmrun-argv, vmrun-backend)
- ROADMAP + CHANGELOG updates
- No new MCP tools or skills (chunk-1 backends are exposed via existing `signalman_advanced_vm_*` tool family)

### WS5 — Artifact registry (v0.4.0+ OSS scaffolding)

- New standalone package `@signalman/registry` (`registry/`)
- Generic blob + manifest types
- `LocalFsBlobStore` (content-addressed)
- SQLite manifest catalog index
- Ed25519 manifest signing port from `host/src/control-plane/build/signing.ts`
- HTTP API (push/pull blob, push/pull manifest, list versions, delete) + RBAC stub
- Registry CLI (`registry serve`, `registry verify`, `registry keygen`)
- `signalman-registry` BlobDriver in `@signalman/host` — proves federation
- Registry package gates: 88.56% lines / 80.83% branches / 95.94% functions

### WS6 — Audit + skills (this branch's contributions)

- Capability matrix at `docs/audit/capability-matrix-2026-05.md`
- Merge plan at `docs/audit/merge-plan-2026-05.md`
- Frontmatter validator (`host/src/__tests__/skills-frontmatter.test.ts`) — caught 4 latent YAML colon-pitfall bugs during consolidation
- P1 MCP wrappers (9 tools): `signalman_release_verify`, `_key_generate`, `_key_fingerprint`, `_api_key_create/_list/_revoke`, `_runner_build_config/_persist_config`, `_release_build_remote`
- `signalman_target_edit` MCP + CLI (operator-authorised P3 closure)
- `signalman_runner_list` + `_deregister` MCP + CLI
- Runner registration: runners table (migration 0005) + heartbeat infrastructure + worker heartbeat loop
- 25 SKILL.md files covering P0 + follow-on gaps
- `signalman_release_build_remote` MCP tool
- `host/src/server-helpers.ts` (resolvePemInput path-xor-pem helper)

## Consolidated MCP tool index (69 tools)

| Family | Tools | Workstream |
|---|---|---|
| Scenarios (v0.1.x) | `signalman_list`, `signalman_describe`, `signalman_plan`, `signalman_run`, `signalman_status`, `signalman_record`, `signalman_record_finalize` | Pre-Wave1 |
| Product CRUD | `signalman_product_add/_list/_remove` | Pre-Wave1 |
| Release | `signalman_release_build`, `_list`, `_show`, `_deploy`, `_rollback` | Pre-Wave1 |
| Target | `signalman_target_add/_list/_remove`, **`_edit`** | Pre-Wave1 + **WS6** |
| Health | `signalman_health_check`, `_history` | Pre-Wave1 |
| Cloud (v0.3.0-5) | `signalman_cloud_provision/_terminate/_status/_list/_backends/_connection_descriptor` | Pre-Wave1 + **WS1** |
| Stack | `signalman_stack_apply`, `_destroy`, **`_plan_cost`** | Pre-Wave1 + **WS1** |
| Reaper | `signalman_reaper_run_once`, `_status` | **WS1** |
| Budget | `signalman_budget_get/_set/_usage` | **WS1** |
| Credentials | `signalman_creds_set/_get/_remove` | **WS1** |
| Kubernetes | `signalman_k8s_deploy`, `_rollback`, `_status` | **WS2** |
| Schedule | `signalman_schedule_list/_add/_disable/_enable/_remove/_run_once` | **WS3** |
| Webhook | `signalman_webhook_list/_add/_remove/_test` | **WS3** |
| Promotion | `signalman_promotion_list/_add/_remove/_approve/_reject/_approvals/_tick` | **WS3** |
| Release verify (P1) | `signalman_release_verify` | **WS6** |
| Key (P1) | `signalman_key_generate`, `_fingerprint` | **WS6** |
| API keys (P1) | `signalman_api_key_create/_list/_revoke` | **WS6** |
| Runner (P1+M3) | `signalman_runner_build_config/_persist_config/_list/_deregister` | **WS6** |
| Release build remote (P1) | `signalman_release_build_remote` | **WS6** |

Plus `signalman_advanced_*` (~25 VM/Docker/UI/Browser tools, pre-Wave1, unchanged).

## Consolidated skill index (39 skills)

Pre-Wave1 (10): signalman-apply-cloud-stack, signalman-build-from-tag, signalman-deploy-to-demo, signalman-deploy-to-test, signalman-destroy-cloud-stack, signalman-health-check, signalman-list-cloud-instances, signalman-provision-cloud-vm, signalman-rollback, signalman-terminate-cloud-vm.

WS1 follow-ons (5): signalman-build-cloud-connection, signalman-estimate-stack-cost, signalman-manage-cloud-budget, signalman-manage-cloud-credentials, signalman-reap-cloud-instances.

WS2 (3): signalman-deploy-k8s, signalman-k8s-status, signalman-rollback-k8s.

WS3 (3): signalman-schedule-health, signalman-add-webhook, signalman-promote-release.

WS6 — primary agent surface (7): signalman-discover-scenarios, signalman-plan-scenario, signalman-run-scenario, signalman-record-scenario, signalman-register-product, signalman-register-target, signalman-inspect-release.

WS6 — follow-ons (4): signalman-cloud-status, signalman-cloud-backends, signalman-health-history, signalman-verify-release.

WS6 — M2 P1 wrappers (4): signalman-key-management, signalman-mint-api-key, signalman-register-runner, signalman-build-release-remote.

WS6 — M3 (3): signalman-edit-target, signalman-list-runners, signalman-deregister-runner.

## Gap-list re-tier (post-consolidation)

**P0 — shipped + functional + MCP + CLI but no skill**: largely closed. Remaining gaps:

- `signalman_promotion_approvals` (listing pending approvals) — no skill yet; could be folded into `signalman-promote-release`.
- `signalman_schedule_run_once` — no skill (sub-feature of `signalman-schedule-health`).

**P1 — shipped + CLI but not MCP**: 0 remaining. WS6 closed `release verify`, `key gen/fp`, `api-key`, `runner register/build/persist`, `release build --remote`. `serve` / `runner start` / `init` / `ephemeral reap` stay CLI-only by design.

**P1' — shipped + MCP but not CLI (inverse)**: 0 remaining. WS1 sub-task 8 closed the cloud + stack CLI verbs.

**P2 — shipped but neither MCP nor skill (operator-only)**: 3 remaining.

- HTTP audit log query/post (`/v1/audit`) — still operator-only; no `signalman audit query` CLI or `signalman_audit_*` MCP. Wave-2 follow-up.
- Jobs queue (HTTP-only) — appropriate for runner-internal protocol; intentionally not surfaced.
- Artifact listing for a release (`/v1/releases/:id/artifacts`) — partially mitigated by `signalman_release_show` returning artifact metadata.

**P3 — shipped + silent regression risk**: 2 remaining.

- `signalman_advanced_vm_screenshot` test pin lives in WS6 (`vm-screenshot.test.ts`) — kept for the placeholder stub. When the real implementation lands, the test directs the developer to update it.
- WS1 `cloud-aws.test.ts` / `cloud-azure.test.ts` cold-import cost (the v0.3.0-5 `558e0ed` baseline already documented). WS1's recent additions (cost estimate, budget, credentials) take ~3s under coverage instrumentation; current per-test timeouts (30s) handle it.

## Coverage notes

The headline lines coverage dipped from 86.59% (Wave 1 baseline) to 84.29% (Wave 2 consolidated). All four metrics still above the 80/70/80/80 gates. The dip is real-code coverage: each workstream added new code with healthy unit coverage but bringing down the headline percentage:

- WS1 cloud modules (reaper, budget, cost, credentials) — well-covered at the unit level but pull headline down because of the volume.
- WS2 k8s modules — exec spawner intentionally excluded from coverage per its commit message.
- WS3 events/promotion/scheduler — new modules with sub-90% function coverage on first ship.
- WS5 registry package (separate vitest config; 88.56% lines on its own scope).

No regression in any pre-Wave-1 surface. The new code is healthy; the headline number just averages over more code.

## What's left for the next round (Wave 3)

1. **P2 audit-log surface**: ship `signalman audit query` CLI + `signalman_audit_query` MCP tool + `signalman-audit-query` skill. WS6 milestone-5 plan covers this.
2. **`runner deploy`** (WS6 M3.5 deferral): multi-transport (SSH/WinRM/Hyper-V) remote bootstrap. Design-doc-first; multi-milestone effort. WS2 covers k8s; this would cover the non-k8s transports.
3. **`cloud_vm` / `cloud_stack` target kinds** (WS6 M4 deferral): full cloud-deploy story. Operator-authorised; queued.
4. **Registry hardening**: OCI distribution spec, mutable tags, RBAC, virtual registries (per WS5's `registry/ROADMAP.md`). Multi-PR effort.
5. **WS3 promotion auto-approver ↔ WS2 k8s deploy integration**: WS3's tier-to-tier listener may want to gate on k8s deployment evidence. Cross-workstream follow-up.

## Wave-1 audit doc relationship

This Wave-2 matrix supersedes Wave 1 for surface enumeration purposes, but keeps the Wave-1 matrix as the **historical record** of what the WS6 audit found at `558e0ed`. The Wave-1 doc's gap list is preserved verbatim; the resolution notes here describe how each tier was closed (or queued).

The Wave-1 frontmatter validator test (`host/src/__tests__/skills-frontmatter.test.ts`) is the **enforcement mechanism** going forward — every new skill must pass it before merge. It caught 4 latent YAML colon-pitfall bugs during this consolidation (apply-cloud-stack, destroy-cloud-stack, list-cloud-instances, provision-cloud-vm, terminate-cloud-vm) — all fixed in-place during the squash merge.
