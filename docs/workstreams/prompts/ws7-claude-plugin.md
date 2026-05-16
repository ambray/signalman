# WS7 starting prompt — Claude Code plugin (v0.1.0 MVP)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. WS7 runs **directly on main with a feature branch**, not in a separate worktree — the parallel-worktree pattern was retired after Wave-B + Wave-3 merged (see the 2026-05-15 cleanup notes).

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). Host is TypeScript (`host/`); guest agent is
Rust (`guest/`); artifact registry is TypeScript (`registry/`); Loom
plugin is Rust (`plugins/signalman-loom-plugin/`). v0.4.0 shipped
through 2026-05-15 with auto-promotion, webhooks, scheduled health,
cross-platform parity (libvirt + Tart), registry virtual-upstream
mirroring, and full cloud + k8s support. Main is at `074b6a8`.

**Your branch:** `feat/v0.5-claude-plugin` off `main`. Cut it from the
repo root (`C:\Users\ucale\source\repos\signalman`). All git ops from
that root. **Do NOT push to origin** until the operator approves the
first milestone.

## What WS7 is

Build the **v0.1.0 MVP of the OSS Signalman Claude Code plugin**, per
`plugin/ROADMAP.md`. Goal: a plugin that packages the existing surface
(MCP server + 6 skills + one slash command + a permission preset) into
a single one-click install that's **independently useful for OSS users
with no cloud features required**.

This is not greenfield — most of the product value is in the existing
44 skills. WS7 is largely packaging, manifest authoring, and a small
set of net-new additions (the slash command + permission preset).

## Orientation reading (in order, before any code)

1. `plugin/ROADMAP.md` — the strategic context. Read all of it.
2. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.
3. `skills/` — pick three skills at random and read them to internalize
   the frontmatter pattern (`name`, `description`, `allowed-tools`).
   `signalman-build-from-tag/SKILL.md` and `signalman-promote-release/SKILL.md`
   are good canonical examples.
4. `host/src/mcp/` (or wherever the MCP server lives — search `mcp.tool`
   or `registerTool` if path drifted) — what verbs are exposed today.
5. `docs/STATUS.md` — current state of the product.
6. **Claude Code plugin format spec.** As of 2026-05-15 the plugin
   manifest format is in flux. Do a focused web check (or use the
   claude-code-guide agent) to confirm the current manifest filename
   (`plugin.json` vs `manifest.json`), the required schema fields, and
   the MCP-server registration shape. Do not invent fields.

## Open product questions — resolve these in the first hour

`plugin/ROADMAP.md` lists 5 carry-forward questions. Surface them to
the operator at the start of the session and get explicit answers
before writing the manifest:

1. **Distribution channel** — Anthropic marketplace, git-URL self-host, both?
2. **Audience priority for MVP** — bootstrap evaluator vs day-2 SRE?
   Drives the flavor of `/signalman-status` (greenfield-friendly vs
   incident-friendly).
3. **Skill location** — keep at repo-root `skills/`, or move into
   `plugin/skills/`? Default rec: keep at root.
4. **Telemetry** — out of scope for MVP (defer to v1.0.0); confirm.
5. **Subagent vs slash command** for incident-responder — slash command
   in v0.1.0; confirm.

Use `AskUserQuestion` to collect answers in one batch.

## Milestone — v0.1.0 MVP

Ship in this order:

### Milestone 1: Plugin scaffold + MCP registration (smallest, lowest risk — ship first)

- Create `plugin/` directory with:
  - Manifest (`plugin.json` / `manifest.json` per spec confirmation)
  - `README.md` — install, uninstall, what's inside, version compat note
  - `LICENSE` — Apache-2.0 (same as repo)
- Manifest declares:
  - Plugin name: `signalman`
  - Version: `0.1.0`
  - MCP server registration pointing at `signalman serve --mcp` (or
    the equivalent invocation — confirm against `host/src/cli.ts`)
  - Empty skills, slash-commands, hooks arrays (filled in later milestones)
- Manual install test on this machine: `claude plugin install ./plugin`
  succeeds; `claude plugin list` shows it; uninstall is clean.

**Commit:** `feat(plugin): v0.1.0 scaffold + MCP registration`

### Milestone 2: Skill index for the MVP 6

Wire the existing 6 skills into the plugin manifest:

- `signalman-build-from-tag`
- `signalman-deploy-to-test`
- `signalman-rollback`
- `signalman-promote-release`
- `signalman-query-audit-log`
- `signalman-register-target`

Default recommendation from the roadmap is to **keep skills at repo-root
`skills/` and reference them from the manifest**. The plugin manifest
declares each skill by name + path; Claude Code resolves them at load
time. Test: open a fresh Claude Code session in a sibling directory,
install the plugin, verify all 6 skills are listed by `/help` or the
equivalent and that one of them (e.g. `signalman-query-audit-log`)
actually invokes.

**Commit:** `feat(plugin): register the MVP 6 skills`

### Milestone 3: `/signalman-status` slash command

The demo. Synthesizes recent state into a 10-line answer:

- Recent releases (last 5, with status: built / signed / deployed / failed)
- Pending promotions (any `approval.status='pending'` with their age)
- Failing probes (any `health_check.status='fail'` in the last hour)
- Stale runners (no heartbeat in > 5 minutes)
- Cloud budget status (only if cloud is configured; suppress otherwise)

The slash command lives in `plugin/commands/signalman-status.md` (or
the path the spec dictates). It chains a small number of MCP calls
behind one entry point — operators shouldn't have to know the verb
names.

Acceptance: against a freshly-bootstrapped signalman with one product
+ one release, the command returns a coherent answer in < 5 seconds.

**Commit:** `feat(plugin): /signalman-status slash command`

### Milestone 4: Permission preset

Per `plugin/ROADMAP.md`:

- **auto-allow:** `list`, `get`, `status`, `audit query`, `forensic`
- **prompt:** `build`, `deploy`, `promote approve`, `rollback`, `cloud-creds set`
- **deny:** `key generate`, `rotate-certs`, `cloud-creds remove`

The preset lives in the manifest (`permissions` block per spec) or as
a separate file referenced from the manifest. Verify each category by
attempting one verb from each and confirming the expected behavior.

**Commit:** `feat(plugin): permission preset for read/write/destructive verbs`

### Milestone 5: README + install docs

Document:

- Install: `claude plugin install signalman` (or the marketplace URL,
  pending question 1)
- What's included: 6 skills + slash command + MCP server + permission
  preset
- Uninstall
- Version-compat matrix: which signalman host version this plugin
  works against (v0.4.x at MVP).
- Pointer to `plugin/ROADMAP.md` for the v0.2.0 + v1.0.0 outlook.

Cross-link from repo-root `README.md` (a single line in the Components
section).

**Commit:** `docs(plugin): install + uninstall + version-compat`

## Out of scope for MVP (defer explicitly)

Per `plugin/ROADMAP.md`:

- Subagents (v0.2.0)
- Destructive-command hooks (v0.2.0)
- Cloud-aware skill loading (v0.2.0)
- The `signalman-cloud` proprietary sibling plugin (v1.0.0)
- All 44 skills registered (v0.2.0; MVP is 6)
- Telemetry (v1.0.0)

If you find yourself reaching for any of these to make the MVP "feel
right," stop and surface the gap to the operator. Don't quietly grow
scope.

## Test strategy

This work is mostly manifest authoring + integration testing, not
production code paths. Test taxonomy is light:

- **Unit:** none required (no new product code).
- **Integration:** none required.
- **System:** the manual install + invoke loop on a real Claude Code
  install. Document the exact steps you used in
  `plugin/TESTING.md` so the next contributor can repeat them.
- **4-lens audit** is still required per the standing workstream rules
  (see `docs/workstreams/README.md`).

If you find yourself adding new product code in `host/`, stop —
that's not WS7's scope. Open a separate task with the operator.

## Definition of Done (must pass at milestone 5 completion)

1. `claude plugin install ./plugin` succeeds on the dev host (Windows
   confirmed; document macOS + Linux as "expected to work, untested" if
   not verified).
2. `/signalman-status` returns a coherent 10-line answer against a
   real signalman install.
3. The 6 skills are invokable through Claude Code (verified by
   inducing each one with its trigger phrase).
4. Permission preset behaves per spec (verified by category).
5. `plugin/README.md` documents install + uninstall + what's inside.
6. `plugin/TESTING.md` documents the manual verification steps.
7. **4-lens audit completed** — write a `## 4-lens audit` section in
   `.workstream-status.md` at repo root covering QA / Architecture /
   Product / Security; each ends **PASS** or **specific concern**.
8. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**. Operator pushes after
   review.

## Commit pattern

- Milestone 1: scaffold + MCP — 1 commit
- Milestone 2: skills — 1 commit
- Milestone 3: slash command — 1 commit
- Milestone 4: permissions — 1 commit
- Milestone 5: docs — 1 commit
- Subject format: `feat(plugin): <what>` or `docs(plugin): <what>`
- If bash heredoc commit messages hit quoting issues, use
  `.commit-msg-temp.txt` + `git commit -F`. Per project convention,
  keep commit messages free of internal-product references (the history
  rewrite is recent; don't reintroduce leaks).

## Status report (when complete)

Write `.workstream-status.md` at the repo root with sections:

- `## Commits` (5 expected)
- `## Open questions resolved` — answers to the 5 from `plugin/ROADMAP.md`
- `## Manual test log` — what you verified, on what OS / Claude Code version
- `## 4-lens audit`
- `## Deferred to v0.2.0` (explicit list with rationale)
- `## Operator review needed` — anything that requires a human call before push

Then return a ≤300 word summary.

## Conventions

- TypeScript strict if you write any TS; no `any` without justifying comment
- No emojis in source or docs
- Read `CLAUDE.md`; use Loom MCP tools if available (per the
  project-level memory, Loom is currently broken — skip its approval
  surface)
- Don't touch `host/`, `guest/`, `service/`, `registry/`, `plugins/`
  source — WS7 is plugin-packaging only. If you find yourself
  wanting to change verb behavior, surface to operator instead.
- Don't push to origin without operator approval.

## Parallel work to be aware of

The operator is working through other roadmap items in parallel:

- Signing-service epic (next-10 #5.5)
- Mac UI automation parity (next-10 #7)
- OSS-hygiene trio (next-10 #10)

WS7 should not collide with any of these — the plugin work is in a
new `plugin/` directory and a single new branch. If you find yourself
touching files in `host/` or `service/`, stop.

Start by reading `plugin/ROADMAP.md` end to end, then ask the operator
the 5 open questions, then begin Milestone 1.
