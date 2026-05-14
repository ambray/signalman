# WS2 starting prompt — Kubernetes (v0.3.0-6)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman-kubernetes`.

---

You are working on Signalman, an agent-first DevOps platform. Host is TypeScript (`host/`); guest agent is Rust (`guest/`). v0.2.0 shipped 2026-05-12 (release pipeline, meta-build, HTTP control plane, Postgres, S3 blobs, audit log, manifest signing). v0.3.0-5 sub-task 4 just landed (cloud abstraction in `host/src/cloud/` with AWS/Azure SDK backends + OpenTofu driver + MCP `signalman_cloud_*` / `signalman_stack_*` tools + 5 cloud SKILL.md skills). Main is at `558e0ed`.

**Your worktree**: `C:\Users\ucale\source\repos\signalman-kubernetes` — branch `feat/v0.3.0-6-kubernetes`. `cd` there. All git ops from inside that worktree. **Do NOT push to origin.**

## Orientation reading (in order, before any code)

1. `docs/workstreams/PLAN.md` in your worktree (if present) — overall plan and cross-stream coordination rules
2. `CLAUDE.md` at repo root — Loom protocol
3. `host/src/cloud/types.ts` — abstraction shape; you'll write something analogous for K8s
4. `host/src/cloud/tofu.ts` — subprocess-driver pattern (init/apply/destroy + JSON parsing) you'll mirror for `kubectl`/`helm`
5. `host/src/control-plane/deploy/executor.ts` — how existing deploy drivers plug in
6. `host/src/control-plane/schema.ts` — `Target.kind` enum; you'll add `k8s_test` and `k8s_demo`
7. `host/src/__tests__/server-cloud-tools.test.ts` — MCP envelope contract test pattern; you'll mirror for K8s tools
8. `docs/design/meta-build-system.md` §14 — full K8s design

## Your milestone — v0.3.0-6 (both sub-tasks)

**Sub-task 1: K8s as deploy target.**
- Extend `Target.kind` with `k8s_test`, `k8s_demo` (append-only)
- New driver module `host/src/k8s/` with `KubectlDriver` and `HelmDriver` classes:
  - `apply(bundleUri, namespace, context?)` — runs `kubectl apply -k <bundle>` or `helm upgrade --install` based on `Chart.yaml` presence
  - `rollback(releaseId, namespace)` — `kubectl rollout undo` or `helm rollback`
  - `status(namespace)` — parses `kubectl get -o json` into the same `Deployment.status` shape the docker-compose driver uses
  - `health(namespace, timeout)` — `kubectl wait --for=condition=ready`
- Inject `exec` for testability (mirror `host/src/cloud/tofu.ts`'s `defaultExec` pattern)
- New error class `K8sDriverError` with stable codes: `kubectl_failed`, `kubectl_not_found`, `helm_failed`, `helm_not_found`, `bundle_path_missing`, `cluster_auth_failed`, `namespace_missing`
- Wire into the deploy executor in `host/src/control-plane/deploy/executor.ts` alongside the docker-compose / cloud_stack paths
- Three new MCP tools in `host/src/server.ts` (envelope shape `{ ok: true, value }` / `{ ok: false, error: { code, message } }`):
  - `signalman_k8s_deploy`
  - `signalman_k8s_rollback`
  - `signalman_k8s_status`
- 3 SKILL.md skills under `skills/`: `signalman-deploy-k8s`, `signalman-rollback-k8s`, `signalman-k8s-status` (frontmatter pattern from `skills/signalman-apply-cloud-stack/SKILL.md`)

**Sub-task 2: K8s as runner substrate.**
- `examples/k8s-runner/` directory with Job and Deployment manifest examples + README
- Document prerequisites: ServiceAccount, Secret holding runner Bearer token, per-tenant namespace
- New CLI verb `signalman runner deploy-k8s --manifest <path>` that wraps `kubectl apply -f` and waits for runner registration via the existing control plane

## Reserved blocks (don't collide with other workstreams)

- Migration block: **0050-0059** (only if K8s-specific schema needed)
- `Target.kind` enum slots: `k8s_test`, `k8s_demo`

## Test taxonomy — write all three layers

- **Unit**: `K8sDriverError` code dispatch; bundle-kind detection (chart vs manifest); kubectl/helm argv composition; status-JSON parser fixture; namespace + context flag injection
- **Integration**: `KubectlDriver` + injected `exec` stub returning canned JSON; `HelmDriver` same; deploy-executor dispatch from a synthetic `Target` row
- **System**: MCP tool envelope contract tests (style of `server-cloud-tools.test.ts`); full apply → status → rollback flow via injected exec

Tests in `host/src/__tests__/`: `k8s-driver.test.ts`, `k8s-kubectl.test.ts`, `k8s-helm.test.ts`, `k8s-executor-integration.test.ts`, `server-k8s-tools.test.ts`, etc.

## Definition of Done (must pass before each milestone completes)

1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd host && npm run coverage -- --testTimeout=30000` — ≥80% lines / ≥70% branches / ≥80% functions / ≥80% statements
4. **4-lens audit completed** — write a `## 4-lens audit` section in `.workstream-status.md` with QA / Architecture / Product / Security subsections, each ending **PASS** or **specific concern flagged**. **Required** before declaring the milestone done.
5. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>) but **NOT pushed**.

Apply this to **each delivery milestone** — at minimum once at sub-task 1 completion and again at sub-task 2 completion. If you find yourself finishing one but not the other, that's still a delivery milestone — audit it.

## Commit pattern

- Sub-task 1: ~5 commits (types + error class + enum, KubectlDriver + tests, HelmDriver + tests, executor wiring, MCP tools + skills)
- Sub-task 2: ~2 commits (examples + README, CLI verb + tests)
- Subject format: `feat(v0.3.0-6): <what> (k8s commit N)`
- If a bash heredoc commit message hits quoting issues, write to `.commit-msg-temp.txt` and `git commit -F` it

## Status report (when complete)

Write `.workstream-status.md` at the worktree root with sections:
- `## Commits` — `git log --oneline` of yours
- `## Tests added` — paths + counts per layer
- `## Coverage` — numbers + delta
- `## 4-lens audit` — full audit per definition above
- `## Deferred` — anything you consciously postponed
- `## Operator review needed` — anything that needs eyes before consolidation

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment
- No emojis
- Read CLAUDE.md; use Loom MCP tools if available, else raw git
- Cross-stream rule: only touch `server.ts` / `cli.ts` / `schema.ts` in your own additions; do not refactor those files

Start by `cd C:\Users\ucale\source\repos\signalman-kubernetes`, read orientation files, then plan, then implement.
