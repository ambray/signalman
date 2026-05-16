# Workstreams — v0.3.0 / v0.4.0 parallel plan

This directory is the planning artifact for the six parallel workstreams kicked off 2026-05-14 to drive v0.3.0-5 to completion and start v0.3.0-6 + v0.4.0.

## Files

- **[PLAN.md](./PLAN.md)** — master plan covering all 6 workstreams: scope, branches, reserved enum/migration blocks, cross-stream coordination rules, Definition of Done (including the 4-lens audit requirement).
- **[prompts/](./prompts/)** — paste-ready starting prompts for every parallel session.
  - *WS1–WS6 cohort (May 2026, merged):* `ws2-kubernetes.md`, `ws3-release-ops.md`, `ws4-cross-platform.md`, `ws5-registry.md`, `ws6-audit-skills.md` (WS1 was driven in the session that generated this artifact).
  - *WS7–WS8 cohort (awaiting launch, scoped 2026-05-15/16):* `ws7-claude-plugin.md`, `ws8-per-user-identity-certs.md`.
  - *WS9–WS12 cohort (awaiting launch, scoped 2026-05-16):* `ws9-signing-service.md`, `ws10-registry-oci.md`, `ws11-vmrun-vmware-convergence.md`, `ws12-oss-release-readiness.md`.
  - *Deferred (pending hardware):* `ws-future-macos-ui-parity.md` — was the original WS10; reassigned on 2026-05-16 because the operator does not currently have an Apple Silicon dev-host. Pickup when a Mac is available and renumber to the next free slot.

## How to use this

1. Pick a workstream you want to drive. Open a new Claude Code session.
2. Make sure that session has shell + write access to the corresponding worktree under `C:\Users\ucale\source\repos\signalman-<workstream>`.
3. Copy the entire prompt from `prompts/<workstream>.md` (everything below the "Paste the block below" line, but excluding that intro line itself) into the new session.
4. The session will orient itself, plan, and execute. When done, look for `.workstream-status.md` at the worktree root for the audit + commit list.
5. Consolidate to main when satisfied (instructions at the bottom of `PLAN.md`).

## Standing rules (applied to every workstream)

- **Definition of Done at every delivery milestone**: tests pass, TS clean, coverage holds, 4-lens audit completed, commits ready but **not pushed**. See `PLAN.md` for the full checklist.
- **4-lens audit** at every milestone is non-negotiable. Each workstream's prompt enforces it explicitly. Audit subsections: QA / Architecture / Product / Security; each ends with **PASS** or **specific concern flagged for operator review**.
- **Test taxonomy**: unit + integration + system layers where the layering exists. Don't write integration tests for pure-function logic; don't write only unit tests for cross-module wiring.
- **No push to origin** from any workstream. Operator consolidates via fast-forward into `main`.
- **Reserved blocks** (migration numbers, enum slots, error-code unions) per `PLAN.md` — prevents merge conflicts when consolidating.

## Workstream status

| # | Stream | Branch | First milestone | Status |
|---|---|---|---|---|
| 1 | Cloud completion | `feat/v0.3.0-5-cloud-finish` | Sub-task 5: cost-guardrails reaper | Merged into main (2026-05) |
| 2 | Kubernetes | `feat/v0.3.0-6-kubernetes` | k8s deploy target + runners | Merged into main (2026-05) |
| 3 | Release ops | `feat/v0.4.0-release-ops` | Scheduled health (first of 3 epics) | Merged into main (2026-05) |
| 4 | Cross-platform | `feat/v0.4.0-cross-platform` | Guest platform-trait split | Merged into main (2026-05) |
| 5 | Artifact registry | `feat/v0.4.0-registry` | Package skeleton + blob format + signing port | Merged into main (2026-05) |
| 6 | Audit + skills | `chore/audit-and-skills` | Capability matrix + top P0 skill gaps | Merged into main (2026-05) |
| 7 | Claude Code plugin | `feat/v0.5-claude-plugin` | v0.1.0 MVP per [`plugin/ROADMAP.md`](../../plugin/ROADMAP.md) | Awaiting session launch (2026-05-15) |
| 8 | Per-user identity certs | `feat/v0.5-identity-certs` | Schema + repo per [`docs/design/per-user-identity-certs.md`](../design/per-user-identity-certs.md) | Awaiting session launch (2026-05-16) |
| 9 | Signing service provider + infrastructure | `feat/v0.5-signing-service` | Design doc (gated) → `LocalDiskProvider` interface + lift. Per [`prompts/ws9-signing-service.md`](prompts/ws9-signing-service.md). | Awaiting session launch (2026-05-16) |
| 10 | Registry OCI distribution spec v1.1 | `feat/v0.5-registry-oci` | Design doc (gated) → manifest schema + types. Per [`prompts/ws10-registry-oci.md`](prompts/ws10-registry-oci.md). Reassigned from macOS UI parity on 2026-05-16 (no Mac dev-host); original prompt preserved at [`prompts/ws-future-macos-ui-parity.md`](prompts/ws-future-macos-ui-parity.md). | Awaiting session launch (2026-05-16) |
| 11 | vmrun ↔ VMware backend convergence | `feat/v0.5-vmware-convergence` | Design doc (gated) → parity test suite (before merge). Per [`prompts/ws11-vmrun-vmware-convergence.md`](prompts/ws11-vmrun-vmware-convergence.md). | Awaiting session launch (2026-05-16) |
| 12 | OSS release-readiness | `feat/v0.5-oss-release-readiness` | `signalman --version` verb. Per [`prompts/ws12-oss-release-readiness.md`](prompts/ws12-oss-release-readiness.md). | Awaiting session launch (2026-05-16) |

WS1–WS6 ran on the parallel-worktree pattern (one `signalman-<stream>/` worktree per stream); that scaffolding was retired after consolidation. **WS7 onward runs directly off `main` with a feature branch** — no separate worktree. The 2026-05-15 cleanup removed the stale worktrees and branches; see the post-merge state notes for context.

**WS9–WS12 form the second 4-parallel cohort** (the first was WS1–WS6 in May 2026). Cross-stream coordination rules for this cohort are documented in [`../../ROADMAP.md`](../../ROADMAP.md) §"Next cohort (WS9–WS12)" — short matrix because file overlap is minimal by design. WS9, WS10, and WS11 are **design-gated**: Milestone 0 is a design doc the operator approves before any production code lands. WS12 has no design gate; the scope is concrete enough that the first-hour operator-question round is sufficient.

Each workstream updates this table by editing the Status column when its first milestone lands. Subsequent milestones are tracked in the workstream's own `.workstream-status.md` at the repo root (no more per-worktree status files).
