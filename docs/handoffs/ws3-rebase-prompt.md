# WS3 rebase handoff — paste into the WS3 owner's session

**Audience**: the agent running in `~/source/repos/signalman-release-ops` (branch
`feat/v0.4.0-release-ops`).

**Purpose**: rebase WS3 onto the new `main` (which now carries WS1 + WS2) so
WS3 can merge cleanly. The WS6 agent attempted this from outside and hit
tangled conflicts that need WS3's commit-level context to resolve safely.

**Background you didn't have when you started**:

- `main` is no longer at `558e0ed`. It now carries WS1's full v0.3.0-5
  cloud-completion work (sub-tasks 5/6/8: TTL reaper, per-org budgets,
  per-org credentials at rest, network connection descriptor, cloud +
  stack CLI verbs with `--tag`/`--var`/`--aws-profile`/`--azure-credentials`
  flags + `signalman cloud creds set/get/remove`) and WS2's full v0.3.0-6
  Kubernetes work (KubectlDriver, HelmDriver, `signalman_k8s_deploy` /
  `_rollback` / `_status` MCP tools, `signalman k8s` CLI subcommands,
  `signalman runner deploy-k8s` CLI verb, three k8s skills).
- Main HEAD is now `f8ffc77 feat(v0.3.0-6): runner deploy-k8s CLI verb`.
- WS6 (audit + skills) is separately ready to merge after WS3 lands.

## What the WS6 agent saw and why it stepped back

Attempting `git rebase main` on `feat/v0.4.0-release-ops` from outside,
the first WS3 commit (`48ea5f7 feat(v0.4.0-3): scheduled health-check
schema + scheduler`) hit conflicts in **7 shared files**:

| File | Conflict shape | Why it tangled |
|---|---|---|
| `host/src/control-plane/storage/driver.ts` | 1 small region | WS1 added `cloudBudgets` / `cloudUsage` / `cloudCredentials` repos to the `StorageDriver` interface; WS3 wants to add `healthSchedules` / `webhookSubscriptions` / `promotionPolicies` / `approvals` at the same insertion point |
| `host/src/control-plane/index.ts` | 1 small region | Same pattern: WS1 added `get` accessors; WS3 adds the same shape |
| `host/src/cli.ts` | 6 regions, mid-range | WS1 added cloud + stack + reaper + budget + creds verbs; WS3 wants to add schedule + webhook + promotion verbs in the same dispatch + handler block |
| `host/src/server.ts` | 4 regions, tangled | Both branches added new `server.tool()` registrations. `git` matched up the closing `}),` boilerplate of WS1's handlers with WS3's handlers, producing conflict regions that cut mid-handler |
| `host/src/verbs/control-plane.ts` | 1 large region (~300 lines per side) | Both branches added many new `run*` verb functions in adjacent positions |
| `host/src/control-plane/storage/sqlite.ts` | 6 regions, the worst tangle | WS1 added `SqliteCloudUsageRepo` + `SqliteCloudBudgetRepo` + `SqliteCloudCredentialsRepo` with shared `prep + try/catch + mapSqliteError` boilerplate; WS3 wants `SqliteHealthScheduleRepo` etc. with the same boilerplate. `git` matched the boilerplate as common ground, splitting WS1's class bodies and WS3's class bodies across multiple conflict regions |
| `host/src/control-plane/storage/postgres.ts` | 4 regions, same shape as sqlite | Same pattern with `pgQuery` boilerplate |

Plus an add/add conflict on `.workstream-status.md` (each WS has its own).

The WS6 agent tried two strategies and they both produced incorrect output:

1. **Strip conflict markers** — simple sed `/^<<<<<<< /d; /^=======$/d; /^>>>>>>> /d` left the result with WS1's `recordCreate` method body cut mid-flow and WS3's `mapHealthSchedule` function inserted into it. tsc surfaced ~30 syntax errors.

2. **`git rebase -X ours main`** — silently dropped WS3's k8s-like additions (the `-X ours` flag's semantics during rebase preferred main's content, treating WS3's new code as "the change to discard"). One commit was also silently dropped as "patch contents already upstream" (a docs commit).

Neither strategy was correct. The agent surfaced the situation to the operator, who instructed: pause WS3, ship Wave A as WS1+WS2, hand off to WS3's owner with this prompt.

## Why this is structurally hard from outside

The conflicts are **mechanically resolvable** but require commit-by-commit decisions only the WS3 author has context on. Specifically:

- WS3's three epics (scheduled-health, webhooks, promotion) all share the same shape: schema commit → CLI/MCP commit → skill commit. Each schema commit conflicts with WS1's cloud schema in the same way. Resolving requires understanding which WS3 commit's additions go where so the resulting history is coherent.

- Decisions you (WS3 owner) need to make:
  - **Each storage class addition** (`SqliteHealthScheduleRepo`, `SqliteWebhookSubscriptionRepo`, etc.) should land after WS1's storage classes — `signalman_cloud_*` and `cloud_org_budgets`. Append your classes at the end of `sqlite.ts` / `postgres.ts` after WS1's content.
  - **Each new `server.tool()` registration** should be appended after WS1's cloud tools and WS2's k8s tools, in a new `// ── WS3: scheduled health / webhooks / promotion ───` block.
  - **The WS3 `runner deploy-k8s` integration question**: WS2 added `runner deploy-k8s` (commit `f8ffc77`). WS3's promotion approver allow-list logic may need to play nice with the k8s deployment path. Check whether your `tier-to-tier listener` listens to k8s deploy events (it should, but the current WS3 branch was written before WS2's k8s landed).
  - **The `.workstream-status.md` collision**: WS1's status doc is already in main. Either (a) drop the WS3 status commits (you can re-write your status after the rebase lands), or (b) rename WS3's status to `.workstream-status-ws3.md` so they coexist.

## Recommended procedure

1. **Verify pre-state**:
   ```bash
   cd ~/source/repos/signalman-release-ops
   git status                 # should be clean
   git log --oneline -3       # should show your 31a153b tip
   git fetch                  # pull origin in case operator pushed
   ```

2. **Fetch the new main**:
   ```bash
   git log --oneline main..HEAD | wc -l   # confirms 12 WS3 commits exist on top
   git log --oneline 558e0ed..main         # confirms WS1+WS2 sit between you and main
   ```

3. **Start the rebase**:
   ```bash
   git rebase main
   ```

4. **When the first conflict hits on `48ea5f7`** (scheduled-health schema):
   - Edit `host/src/control-plane/storage/driver.ts`: keep main's `cloudBudgets` / `cloudUsage` / `cloudCredentials` declarations, then add `healthSchedules: HealthScheduleRepo` after them. Strip the conflict markers.
   - Edit `host/src/control-plane/index.ts`: similar — keep main's getters, append your new getter.
   - Edit `host/src/control-plane/storage/sqlite.ts`: this is the hard one. The cleanest tactic:
     - `git checkout --ours host/src/control-plane/storage/sqlite.ts` (take main's full version, which has WS1's cloud repo classes complete).
     - Open your branch's WS3 version: `git show feat/v0.4.0-release-ops:host/src/control-plane/storage/sqlite.ts > /tmp/ws3-sqlite.ts`
     - Open the common-ancestor version: `git show 558e0ed:host/src/control-plane/storage/sqlite.ts > /tmp/base-sqlite.ts`
     - Diff: `diff -u /tmp/base-sqlite.ts /tmp/ws3-sqlite.ts > /tmp/ws3-additions.patch`
     - The patch shows your additions purely (no WS1 content). Manually apply each hunk to `host/src/control-plane/storage/sqlite.ts` at the corresponding location (the WS3 hunks are all *additive*; they land cleanly at the end of the file or in new mappers / new classes).
   - Same procedure for `host/src/control-plane/storage/postgres.ts`.
   - Same procedure for `host/src/server.ts`, `host/src/cli.ts`, `host/src/verbs/control-plane.ts`.
   - `git add` each resolved file.
   - `npm test` against a couple of WS3 test files to confirm your additions land correctly.

5. **Continue the rebase**:
   ```bash
   git rebase --continue
   ```
   The next conflicts in subsequent commits will be smaller (since the bulk of the conflict was the first schema commit). Resolve them the same way.

6. **When the rebase hits `.workstream-status.md` conflicts** (WS3 commits `0581855` and similar):
   - If keeping your status doc: rename to `.workstream-status-ws3.md` and update the commit message; this requires `git rebase --edit` semantics. Or:
   - **Recommended**: `git rebase --skip` for status-doc commits, then re-author a single WS3 status doc at the end with the new branch state.

7. **After rebase succeeds**:
   ```bash
   cd host
   npx tsc --noEmit          # zero errors
   npm test                  # full suite green
   npm run coverage -- --testTimeout=30000   # >=80/70/80/80
   ```

8. **Notify the operator** so they can `git merge --ff-only feat/v0.4.0-release-ops` into main from `~/source/repos/signalman`.

## What "done" looks like

When you ship, the consolidated main should carry:

- WS1: cloud cost-guardrail reaper + per-org budget + cost estimate (commits `dfd6d53` ... `c005b97`) + per-org credentials (`a8c15cb` ... `776258e`) + CLI wrappers + per-org credential auto-injection + consolidated skills (`322777d` ... `5cf383d`)
- WS2: k8s drivers + executor + MCP + CLI + skills + runner deploy-k8s (commits `194ad0c` ... `f8ffc77`)
- WS3 (you): scheduled health (commits like `48ea5f7` + epic-3 follow-ups) + webhooks (epic-2) + promotion (epic-1) + your skills
- WS6 (audit + skills): waiting in branch `chore/audit-and-skills` to merge after you ship

## A note on the WS6 cloud + stack CLI revert

WS6's branch `chore/audit-and-skills` includes a revert commit (`e75544e`)
that removes a duplicate cloud + stack CLI surface WS6 had added in its M3
work. WS1's implementation (which is now in main) is the authoritative one.
This is pre-resolved; WS6 is ready to merge cleanly once WS3 lands.

## Open questions to surface back when you finish

- Did any WS3 commit need to be re-shaped during the rebase (e.g., a hunk that was supposed to land in the WS1-touched region got dropped)? Log them in `.workstream-status-ws3.md` for the WS6 Wave-2 audit.
- Does WS3's promotion auto-approver work need to integrate with the WS1 per-org-credentials / WS2 k8s-deploy contracts? If yes, a follow-up commit on top of the rebase wires them.
- After landing, the operator + WS6 agent will trigger the Wave-2 capability matrix refresh (`docs/audit/capability-matrix-2026-05-wave2.md`) which re-enumerates the full surface including your scheduled-health + webhooks + promotion verbs.
