# WS6 starting prompt — Capability audit + skills

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman-audit-skills`.

---

You are working on Signalman, an agent-first DevOps platform. Host is TypeScript (`host/`); guest agent is Rust (`guest/`). v0.2.0 shipped 2026-05-12 (release pipeline, meta-build, HTTP control plane, Postgres, S3 blobs, audit log, signing). v0.3.0-1 through v0.3.0-4 + v0.3.0-5 sub-task 4 have landed (cloud abstraction + AWS/Azure/OpenTofu backends + MCP tools + 5 cloud skills). Main is at `558e0ed`. Five other workstreams (WS1-5) are in flight in parallel — **you are NOT auditing their in-flight work** (it isn't done). You are auditing **everything shipped through `main` at `558e0ed`**.

**Your worktree**: `C:\Users\ucale\source\repos\signalman-audit-skills` — branch `chore/audit-and-skills`. `cd` there. All git ops from inside that worktree. **Do NOT push to origin.**

## Orientation reading (in order, before any code)

1. `docs/workstreams/PLAN.md` in your worktree if present — cross-stream coordination rules
2. `CLAUDE.md` at repo root — Loom protocol
3. `README.md` and `ROADMAP.md` — capability surface as documented
4. `docs/design/meta-build-system.md` — design intent per capability
5. `host/src/server.ts` — full MCP tool registration list (your "MCP-exposed?" oracle)
6. `host/src/cli.ts` and `host/src/verbs/` — CLI verb list (your "CLI-exposed?" oracle)
7. `skills/` directory — every existing SKILL.md (your "skill-covered?" oracle)
8. Walk `host/src/` by directory: `cloud/`, `control-plane/{release,deploy,probes,storage,blobs,audit,build,events}`, `kernel-debug/`, `provisioning/`, `scenarios/`, `runner/`, `verbs/`, `guest/` (RPC surface)

## Your milestone — two phases

### Phase A: Capability matrix (must ship)

Produce `docs/audit/capability-matrix-2026-05.md` with a table:

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |

Enumerate (non-exhaustive; walk the source for completeness):
- Product lifecycle: register, list, show
- Release pipeline: build (local), build (remote runner), list, show, verify, sign, rollback
- Deploy: VM target, docker-compose, cloud_vm, cloud_stack
- Target management: add, list, remove, connection-detail edit
- Runner management: register, list, deploy, deregister
- Scenario execution: run, record, list, describe, plan
- Health: check, history
- Probes: registry, individual probe types
- Audit log: query, post
- Storage: SQLite, Postgres, S3 blobs, local-FS blobs
- Signing: key generate, key fingerprint, manifest sign + verify
- Cloud: provision VM, terminate VM, list instances, backends discovery, stack apply, stack destroy
- Hypervisors: Hyper-V, Tart, cloud (AWS/Azure)
- Kernel-debug: KD session, ETW handlers, exception handlers
- UI automation: UIA elements, browser, sidecar
- Provisioning: ephemeral VMs, differencing disks, cleanup reaper, vendor templates
- Hermetic envelope: lineage hash, scenario hash, agent version

For each row, mark each column **✅ / ❌ / PARTIAL** with a short note. **Functional** = tests pass OR demonstrated working in an integration lane. **MCP-exposed** = a `server.tool(...)` registration in `host/src/server.ts`. **CLI-exposed** = a verb in `host/src/cli.ts` or `host/src/verbs/`. **Skill-covered** = a `skills/<name>/SKILL.md` exists with trigger phrases for that capability.

After the table, write a **gap list** prioritised by operator impact:
- **P0**: shipped + functional + MCP-exposed + CLI-exposed but **no skill** — agents can't discover it
- **P1**: shipped + functional + CLI-exposed but **not MCP-exposed** — agents must shell out
- **P2**: shipped + functional but neither MCP nor skill — operator-only
- **P3**: shipped but tests are missing or PARTIAL — silent-regression risk

### Phase B: Skill generation for top P0 gaps

For each P0 gap (aim for 5-8 highest-impact ones), write `skills/<name>/SKILL.md` following the existing pattern (reference `skills/signalman-build-from-tag/SKILL.md` and `skills/signalman-provision-cloud-vm/SKILL.md`). Each skill:
- Frontmatter: `name`, `description` with natural-language trigger phrases, `allowed-tools` scoped to the minimum
- "What you need from the user" section
- "How to invoke" section with concrete example
- "Expected response" section
- "Error codes you may see" table
- "What NOT to do" guardrails
- "Follow-up suggestions"

**Don't try to also close P1/P2/P3** — flag them in the gap list for followup. P3 in particular needs ENG work (writing tests), not just doc work.

## Test taxonomy

Mostly a documentation milestone, but:
- Add `host/src/__tests__/skills-frontmatter.test.ts` that walks `skills/`, parses each SKILL.md's YAML frontmatter, asserts `name` + `description` + `allowed-tools` fields are present and well-formed
- Validate every skill's `allowed-tools` references a real MCP tool (cross-check `host/src/server.ts` registrations) OR a real CLI verb

## Definition of Done

1. `cd host && npm test` — full suite green (your frontmatter validator joins it)
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd host && npm run coverage -- --testTimeout=30000` — coverage doesn't drop below baseline (86.59% lines / 81.65% branches at the time the workstream started)
4. **4-lens audit completed** — write a `## 4-lens audit` section in `.workstream-status.md` covering QA / Architecture / Product / Security. This is a documentation-heavy milestone but the audit still applies: **QA** = test for frontmatter validator works; **Architecture** = skill set covers the surface coherently; **Product** = trigger phrases and operator narrative; **Security** = `allowed-tools` scoped correctly (no over-broad grants like Bash on every skill).
5. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>) but **NOT pushed**.

## Commit pattern

- Commit 1: `docs(audit): capability matrix 2026-05` (the matrix doc + gap list)
- Commit 2: `test(skills): frontmatter validator` (the test that pins SKILL.md shape)
- Commit 3+: one commit per new skill (`feat(skills): <skill-name>`), so the operator can review each independently
- Subject format: per above

## Status report (when complete)

Write `.workstream-status.md` at the worktree root with sections:
- `## Commits`
- `## Capability matrix summary` — counts by ✅/❌/PARTIAL across the four columns
- `## Gap list summary` — counts by P0/P1/P2/P3
- `## Skills added` — names + 1-line description each
- `## Tests added` — paths + counts
- `## 4-lens audit` — full audit per Definition of Done
- `## Deferred` — every P1/P2/P3 gap, listed for followup
- `## Operator review needed`

Return a ≤300 word summary highlighting the top P0 gaps you closed and the most concerning P3 gaps.

## Scope discipline

- This is **Phase A + targeted Phase B**. Do NOT attempt to audit what WS1-WS5 are producing in parallel — that's a Wave 2 audit after those workstreams consolidate.
- Do NOT push to origin.

## Conventions

- TypeScript strict for any TS you write
- No emojis in docs or code
- Match existing skill frontmatter exactly
- Read CLAUDE.md; use Loom MCP tools if available

Start by `cd C:\Users\ucale\source\repos\signalman-audit-skills`, walk the source tree, build the matrix, then write skills for the top P0 gaps.
