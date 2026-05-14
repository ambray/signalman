# WS3 starting prompt — Release operations (v0.4.0 epics 1-3)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman-release-ops`.

---

You are working on Signalman, an agent-first DevOps platform. Host is TypeScript (`host/`); guest agent is Rust (`guest/`). v0.2.0 shipped 2026-05-12 with the full release pipeline, meta-build system, HTTP control plane, Postgres + S3 blobs, audit log, and Ed25519 manifest signing. v0.3.0-5 sub-task 4 just landed (cloud abstraction). Main is at `558e0ed`.

**Your worktree**: `C:\Users\ucale\source\repos\signalman-release-ops` — branch `feat/v0.4.0-release-ops`. `cd` there. All git ops from inside that worktree. **Do NOT push to origin.**

## Orientation reading (in order, before any code)

1. `docs/workstreams/PLAN.md` in your worktree if present — cross-stream coordination rules
2. `CLAUDE.md` at repo root — Loom protocol
3. `host/src/control-plane/release/` — current release lifecycle (build / deploy / rollback)
4. `host/src/control-plane/storage/schema.ts` and `migrations/` — Postgres schema; existing migration patterns
5. `host/src/control-plane/audit/` (or wherever `POST /v1/audit` lives) — audit-log surface
6. `host/src/control-plane/probes/runner.ts` — existing health probe runner; baseline for scheduled-health
7. `host/src/http/router.ts` — endpoint registration pattern
8. `docs/design/meta-build-system.md` §12 (v0.4 phasing) and ROADMAP.md v0.4.0+ section

## Your milestone — three v0.4.0 epics

Ship in this order: **Epic 3 (scheduled health) first** (smallest, lowest risk) → Epic 2 (webhooks) → Epic 1 (auto-promotion). If scope runs over, ship complete epics — don't half-ship.

### Epic 3: Scheduled health checks (v0.4.0-3) — ship first

- New table `health_schedule` (id, target_id, interval_seconds, probe_ids_json, last_run_at?, active)
- Scheduler module `host/src/control-plane/scheduler/` waking every minute, finding due schedules, invoking the existing probe runner, persisting results
- Hook into audit log + event dispatcher (when Epic 2 lands the dispatcher; for now log structured JSON)
- CLI: `signalman schedule list`, `signalman schedule add --target X --probes Y --interval-seconds Z`, `signalman schedule disable <id>`
- MCP: `signalman_schedule_list`, `signalman_schedule_add`

### Epic 2: Webhooks + outbound notifications (v0.4.0-2)

- Event dispatcher `host/src/control-plane/events/dispatcher.ts` with pluggable subscribers
- `webhook_subscription` table (id, org_id, url, secret_hmac_key, event_kinds_json, kind: 'generic'|'slack'|'email', active)
- Generic-webhook driver — POST JSON with HMAC-SHA256 signature header `X-Signalman-Signature`
- Slack driver — payload formatted as Slack blocks
- Email driver — SMTP via nodemailer; gated by env `SIGNALMAN_SMTP_URL` (absent = silently skip)
- Events fired: release-built, release-deployed, deployment-rolled-back, health-failed, promotion-approved/rejected (the last comes online in Epic 1)
- CLI: `signalman webhook list`, `signalman webhook add`, `signalman webhook test <id>`
- MCP: `signalman_webhook_list`, `signalman_webhook_add`, `signalman_webhook_test`

### Epic 1: Auto-promotion + approval gates (v0.4.0-1)

- New `promotion_policy` table (id, product_id, source_target_id, dest_target_id, gate_kind: 'auto'|'manual'|'time_delay', gate_config_json)
- Listener on build-completed event; for `gate_kind='auto'`, trigger deploy; for `gate_kind='manual'`, create an `approval` row
- CLI: `signalman promotion list`, `signalman promotion add`, `signalman promotion approve <id>`, `signalman promotion reject <id>`
- Surface promotion state on `signalman release show`
- MCP: `signalman_promotion_list`, `signalman_promotion_approve`, `signalman_promotion_reject`

## Reserved migration block

**0060-0079**. Allocate:
- 0060-0064 — Epic 3 (scheduled health) schemas
- 0065-0069 — Epic 2 (webhooks) schemas
- 0070-0074 — Epic 1 (promotion) schemas

## Test taxonomy — write all three layers per epic

- **Unit**: gate-kind decision logic; HMAC signature; Slack-payload formatter; cron-style interval comparison; promotion-policy lookup
- **Integration**: event dispatcher → webhook subscribers using injected HTTP stub; scheduler → probe runner with in-memory SQLite; promotion listener → stub deploy executor
- **System**: full build → ready → auto-promote → deploy flow with stubs; webhook delivery against in-memory `http.Server`; scheduler tick advancing in fake time

Tests in `host/src/__tests__/`: `health-scheduler.test.ts`, `health-scheduler-integration.test.ts`, `webhook-dispatcher.test.ts`, `webhook-slack.test.ts`, `webhook-hmac.test.ts`, `webhook-e2e.test.ts`, `promotion-policy.test.ts`, `auto-promote-e2e.test.ts`, etc.

## Skills to add

Under `skills/`:
- `signalman-schedule-health` — drives scheduled health check setup
- `signalman-add-webhook` — webhook registration + test
- `signalman-promote-release` — auto-promotion approval flow

Use the frontmatter pattern from `skills/signalman-build-from-tag/SKILL.md`.

## Definition of Done (must pass at each epic completion)

1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd host && npm run coverage -- --testTimeout=30000` — ≥80% lines / ≥70% branches / ≥80% functions / ≥80% statements
4. **4-lens audit completed** — write a `## 4-lens audit` section in `.workstream-status.md` per the master plan, covering QA / Architecture / Product / Security with each ending **PASS** or **specific concern**. **Required** at the end of each epic, not just at the end of the workstream.
5. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>) but **NOT pushed**.

Three epics = three audit cycles. Don't skip the audit between epics — surfaces tend to drift.

## Commit pattern

- Epic 3 (scheduled health): ~3 commits (schema + scheduler, CLI + MCP, skill)
- Epic 2 (webhooks): ~4 commits (schema + dispatcher, generic driver, Slack driver, email driver + CLI/MCP + skill)
- Epic 1 (promotion): ~3 commits (schema + listener, CLI + MCP, skill)
- Subject format: `feat(v0.4.0-N): <what>` where N = 1/2/3 per epic
- If bash heredoc commit messages hit quoting issues, use `.commit-msg-temp.txt` + `git commit -F`

## Status report (when complete)

Write `.workstream-status.md` at the worktree root with sections:
- `## Commits`, `## Tests added` (per epic, per layer), `## Coverage`, `## 4-lens audit` (one per epic), `## Deferred`, `## Operator review needed`

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment
- No emojis
- Read CLAUDE.md; use Loom MCP tools if available
- Cross-stream rule: only touch `server.ts` / `cli.ts` / `schema.ts` in your own additions

Start by `cd C:\Users\ucale\source\repos\signalman-release-ops`, read orientation files, then plan, then implement.
