# Signalman v0.3.0 / v0.4.0 — Six-Workstream Parallel Plan

**Generated**: 2026-05-14
**Main HEAD when plan was created**: `558e0ed` (`test(v0.3.0-5): bump cloud-discoverability test timeout for coverage`)
**Plan owner**: operator (you) — agents in each session execute against this doc

## Context

Signalman is an agent-first DevOps platform with two cooperating layers:
- a Windows host (`host/`, TypeScript) that talks to test VMs and manages release lifecycle
- a Rust guest agent (`guest/`) that runs inside test VMs and exposes gRPC RPCs to the host

**Shipped through `main` at `558e0ed`:**
- v0.1.x — provisioning, ephemeral VMs, Hyper-V backend, scenario runner, hermetic envelope foundation
- v0.2.0 — release pipeline, meta-build system, HTTP control plane, Postgres + S3, audit log, Ed25519 manifest signing
- v0.3.0-1 → v0.3.0-4 — Record/Replay, ephemeral VMs (full), hermetic-triple envelope, Loom-fronted orchestrator
- v0.3.0-5 sub-tasks 1-4 — cloud-backend abstraction, AWS EC2 + Azure VM SDK backends, OpenTofu driver, MCP cloud + stack tools, 5 cloud SKILL.md skills

**Now in flight — 6 parallel workstreams off `main`:**
Each lives in its own worktree under `~/source/repos/`. Each is owned by one Claude Code session.

| # | Stream | Worktree | Branch | First milestone |
|---|---|---|---|---|
| 1 | Cloud completion | `signalman-cloud-finish` | `feat/v0.3.0-5-cloud-finish` | sub-task 5: cost-guardrails reaper |
| 2 | Kubernetes | `signalman-kubernetes` | `feat/v0.3.0-6-kubernetes` | k8s deploy target (KubectlDriver + HelmDriver) |
| 3 | Release ops | `signalman-release-ops` | `feat/v0.4.0-release-ops` | scheduled health checks (smallest of 3 epics, ship first) |
| 4 | Cross-platform | `signalman-cross-platform` | `feat/v0.4.0-cross-platform` | guest platform-trait split + Linux/macOS Health + RunCommand |
| 5 | Artifact registry | `signalman-registry` | `feat/v0.4.0-registry` | package skeleton + generic blob format + signing port |
| 6 | Audit + skills | `signalman-audit-skills` | `chore/audit-and-skills` | capability matrix doc + Phase B skills for P0 gaps |

Workstream 1 (cloud completion) is being driven in the same session as this plan.
Workstreams 2-6 each need their own Claude Code session — use the prompts in `prompts/`.

---

## Per-workstream scope summary

### WS1: Cloud completion (v0.3.0-5 sub-tasks 5-8)

Closes out v0.3.0-5 cloud-provider support.

- **Sub-task 5 (this session's milestone)**: cost-guardrails reaper. Three controls from design §13.5:
  1. Wall-clock TTL reaper polling every 5 min; terminates past-TTL instances via idempotent `terminateInstance`.
  2. Per-org spend budget in Postgres (`cloud_org_budgets` + `cloud_org_usage` tables); soft warn at 80%, hard refuse with `budget_exceeded` at 100%.
  3. Pre-flight cost estimate on `signalman_stack_apply`: parse `tofu plan -json`, sum against a static instance-type × region cost table, surface "~$X/month" prompt.
- **Sub-task 6** (followup session): networking (`public_mtls` / `aws_ssm` / `azure_bastion`) + layered credential model.
- **Sub-task 7** (followup session): pipeline-built golden images (Packer manifest → VHDX + AMI + Azure managed image in lockstep).
- **Sub-task 8** (followup session): CLI verbs (`signalman cloud *` / `signalman stack *`) + Loom plugin handlers (`loom.signalman.cloud_*`).

**Reserved migration block**: 0040-0049 (cloud-budget tables; subsequent sub-tasks pick from here).

### WS2: Kubernetes (v0.3.0-6)

Two sub-tasks, intended to ship together but separable.

- **Sub-task 1**: K8s as deploy target. `k8s_test` / `k8s_demo` target kinds; `kubectl apply -k` and `helm upgrade --install` drivers; rollback via `kubectl rollout undo` / `helm rollback`; health via `kubectl wait`. Three new MCP tools (`signalman_k8s_deploy`, `signalman_k8s_rollback`, `signalman_k8s_status`).
- **Sub-task 2**: K8s as runner substrate. Operator-authored manifest pattern (`Job` for one-shot, `Deployment` for warm-pool); examples under `examples/k8s-runner/`; CLI verb `signalman runner deploy-k8s`.

**Reserved migration block**: 0050-0059 (if K8s-specific target metadata needs schema).
**Reserved target-kind enum slots**: `k8s_test`, `k8s_demo`.

### WS3: Release operations (v0.4.0 epics 1-3)

Three PR-sized epics. Ship-order: scheduled-health (smallest) → webhooks → auto-promotion (largest).

- **Epic 1 (scheduled health)**: `health_schedule` table; scheduler waking every minute; hook into audit log + event dispatcher; CLI `signalman schedule list/add/disable`; MCP `signalman_schedule_list/add`.
- **Epic 2 (webhooks)**: event dispatcher + `webhook_subscription` table; generic-webhook driver with HMAC; Slack driver; Email driver (gated by `SIGNALMAN_SMTP_URL` env); fired on release-built/deployed/rolled-back/health-failed/promotion-approved events; CLI `signalman webhook list/add/test`.
- **Epic 3 (auto-promotion)**: `promotion_policy` table; listener on build-completed event; gate kinds (`auto`/`manual`/`time_delay`); CLI `signalman promotion list/add/approve/reject`; MCP `signalman_promotion_*`.

**Reserved migration block**: 0060-0079 (broad block since 3 epics). Use 0060-0064 for scheduled-health, 0065-0069 for webhooks, 0070-0074 for promotion.

### WS4: Cross-platform (v0.4.0-4)

Three chunks; ship in order (skip if scope runs over).

- **Chunk 1**: guest-agent platform split. Reorganise `guest/src/` so platform-conditional code lives in `platform/{windows,linux,macos}.rs`. Implement Linux + macOS versions of portable RPCs (Health, Register, RunCommand, TestNetwork, TestFileAccess). Windows-only RPCs (ProcessInspect with UIA, UI element selectors, kernel-debug attaches) return `Status::unimplemented` on non-Windows.
- **Chunk 2**: libvirt host hypervisor backend. Subprocess-driven via `virsh` (no native deps). Same shape as Hyper-V backend.
- **Chunk 3**: vmrun host hypervisor backend for VMware Fusion. **NB**: tree has existing `host/src/hypervisors/vmware.ts` — clarify with operator whether vmrun is a parallel-track backend or rename/replacement.

**Mind these tree drifts** vs the original brief: `tart.ts` (not `tart-backend.ts`), `vmware.ts` already exists.

### WS5: Artifact registry (v0.4.0+ OSS product)

New standalone package `@signalman/registry` at `registry/` in the repo root. This milestone is **scaffolding + generic blob format + signing port + minimal HTTP API**. OCI distribution spec, mutable tags, retention, npm/maven/crates protocols, vuln scanning are **all deferred** to v0.4.x followups.

**This session's deliverable**:
1. Package skeleton (`registry/package.json`, `tsconfig.json`, `vitest.config.ts`)
2. Types (`Blob`, `Manifest`, `BlobRef`, `RegistryStorage`)
3. `LocalFsStorage` impl + SQLite manifest index
4. Ed25519 signing port from `host/src/control-plane/build/signing.ts`
5. HTTP API (push/pull blob, push/pull manifest, list versions, delete manifest with RBAC stub)
6. CLI (`registry serve`, `registry verify`)
7. `signalman-registry` BlobDriver in `@signalman/host` — proves federation works

### WS6: Capability audit + skills

Two phases. Phase A on the **shipped-as-of-main** surface (not the in-flight workstream output — that comes in Wave 2 after WS1-5 land).

- **Phase A**: produce `docs/audit/capability-matrix-2026-05.md` — every shipped capability × {functional? MCP-exposed? CLI-exposed? skill-covered?}. Walk the source tree to enumerate; don't trust prior docs alone. Output a gap list prioritised P0-P3.
- **Phase B**: write SKILL.md files for the highest-impact P0 gaps (estimate 5-8 skills). Match the frontmatter pattern in `skills/signalman-build-from-tag/SKILL.md` and `skills/signalman-provision-cloud-vm/SKILL.md`. Add a `host/src/__tests__/skills-frontmatter.test.ts` validator.

---

## Cross-stream coordination rules

These prevent merge conflicts when consolidating.

| Resource | WS1 | WS2 | WS3 | WS4 | WS5 | WS6 |
|---|---|---|---|---|---|---|
| Migration numbers | 0040-0049 | 0050-0059 | 0060-0079 | (none) | (own schema) | (none) |
| `Target.kind` enum | (none) | `k8s_test`, `k8s_demo` | (none) | (none) | (none) | (none) |
| New error-code unions | `CloudBackendErrorCode` (`budget_exceeded`) | new `K8sDriverError` | n/a | new `LibvirtBackendError`, `VmrunBackendError` | new `RegistryError` | n/a |
| New MCP tool names | (cost-estimate flag on existing tools) | `signalman_k8s_*` | `signalman_schedule_*`, `signalman_webhook_*`, `signalman_promotion_*` | (none) | (registry has its own HTTP API, not MCP) | (skill files only) |
| `host/src/server.ts` edits | minimal | new tool block | new tool block | none | none | none |
| `host/src/cli.ts` edits | yes (cloud + stack verbs in sub-task 8) | yes (deploy-k8s) | yes (schedule/webhook/promotion) | none | none | none |

**Each workstream edits `server.ts` only in its own tool-registration block.** Order doesn't matter — additions are append-only and the cloud-tool section pattern is the template.

**Each workstream's first commit should NOT touch shared files** (server.ts, cli.ts, schema.ts) — keep those for later commits when the new module is ready to wire in. This makes merge conflicts unlikely.

**ROADMAP.md updates**: each workstream updates only its own section at the end of its work. WS6 may add a meta section but does not touch other workstreams' sections.

**Do NOT push to origin from any workstream session.** Operator consolidates by fast-forward into `main` after reviewing `.workstream-status.md` and the commit list.

---

## Definition of Done — applies to every workstream, every milestone

A milestone (one sub-task / epic / chunk — whatever the workstream's unit is) is **not done** until ALL of the following pass:

1. **Tests pass**: `cd host && npm test` (full suite green; new tests added at the unit / integration / system layers as the work warrants).
2. **TypeScript clean**: `cd host && npx tsc --noEmit` zero errors.
3. **Coverage holds**: `cd host && npm run coverage -- --testTimeout=30000` shows ≥80% lines / ≥70% branches / ≥80% functions / ≥80% statements (the existing `vitest.config.ts` thresholds).
4. **Rust gate (WS4 only)**: `cd guest && cargo build --all-features && cargo test --all-features && cargo clippy --all-features -- -D warnings` zero warnings.
5. **4-lens audit completed** — this is non-negotiable. Write a section in `.workstream-status.md` titled `## 4-lens audit` with subsections:
   - **QA**: test counts by layer, coverage numbers, any flaky-test concerns
   - **Architecture**: design choices made, abstractions added, contracts changed
   - **Product**: operator-visible surface (CLI/MCP/skills), trigger phrases, guardrails baked into docs
   - **Security**: input validation, auth/authn, secrets handling, log-leakage risks, sandbox/permissions impact
   - Each subsection ends with **PASS** or **specific concerns flagged for operator review**
6. **Commits ready**: per-logical-step commits; each commit's diff has tests + impl + doc updates that fit together; `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` footer; **no push to origin** — operator consolidates.

If a milestone can't hit (1)-(4), it is not complete — flag it in `.workstream-status.md` under `## Operator review needed` and stop. Don't ship a half-baked milestone.

---

## Test taxonomy expectation

Each workstream writes tests at **all three layers** where the layering exists in its scope. Don't write only unit tests for cross-module wiring; don't write integration tests for pure function logic.

| Layer | When to use | Example fixtures |
|---|---|---|
| **Unit** | Pure function logic; time math; validation; classifiers; argv composition | Cost-table lookup with known keys; reaper TTL-comparison; HMAC signature; stack-name regex |
| **Integration** | Multi-module wiring through real interfaces with one boundary stubbed | Reaper + stub cloud backend; KubectlDriver with injected `exec`; promotion listener + stubbed deploy executor |
| **System** | Full-stack flow with everything real except external I/O (cloud APIs, real cluster) | End-to-end provision → reap cycle; HTTP push/pull/verify on the registry; webhook delivery against in-memory `http.Server` |

Vitest config + existing patterns are in `host/src/__tests__/` — match the naming convention (`<module>.test.ts`, `<module>-integration.test.ts`, `<feature>-e2e.test.ts`).

---

## Operator consolidation flow (when a workstream completes)

The operator (you) does this for each completed workstream:

```bash
# In the main signalman repo (not a worktree)
cd ~/source/repos/signalman
git fetch origin
git checkout main
git pull --ff-only origin main
git merge --ff-only feat/<workstream-branch>   # only if FF possible; otherwise review for rebase
git push origin main

# Clean up worktree (only after merging)
git worktree remove ../signalman-<workstream-name>
git branch -d feat/<workstream-branch>
```

If `git merge --ff-only` fails because another workstream landed first, rebase the slower workstream onto the new main and re-run audit + coverage before merging.

---

## What I (the WS1 agent in this session) will do next

1. Commit this `docs/workstreams/` planning artifact to the WS1 branch (`feat/v0.3.0-5-cloud-finish`) so it's under version control.
2. Start WS1 sub-task 5 (cost-guardrails reaper): three commits (TTL reaper / spend budget / pre-flight cost estimate) with tests at all three layers each.
3. Run quality gates + 4-lens audit before declaring sub-task 5 complete.
4. Write `.workstream-status.md` at the worktree root.

The other 5 prompts under `prompts/` are ready to paste into new Claude Code sessions running from each respective worktree.
