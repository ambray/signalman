# WS6 post-WS3 handoff — paste into the WS6 owner's session

**Audience**: the agent running in `~/source/repos/signalman-audit-skills` (branch `chore/audit-and-skills`).

**Purpose**: rebase WS6 onto the new `main` (which now carries WS1 + WS2 + WS3) so WS6 can merge cleanly and close out Wave A. WS3 just shipped via the same procedure WS6 outlined for them in `docs/handoffs/ws3-rebase-prompt.md`; the conflict shapes were as predicted and the playbook there is exactly the playbook you'll execute here.

## What changed since you wrote the WS3 handoff

- WS3 rebased and merged. `main` tip is now expected to be the WS3 tip (`6d23aef` at handoff write-time) or further along — check `git log -1 main`. Before WS3 rebase, main was `f8ffc77`; after the operator's `git merge --ff-only feat/v0.4.0-release-ops`, main carries 12 additional WS3 commits.
- WS3's `feat/v0.4.0-release-ops` had the conflict shape you predicted (storage drivers, cli.ts, server.ts, verbs/control-plane.ts) plus `.workstream-status.md` add/add. Resolution strategy that worked: `git checkout --ours <file>` to take main's clean version, then append WS3 additions in commit order. All WS3 hunks are end-of-file or new-section additive, so the file-level scoped append landed cleanly. The `.workstream-status.md` collisions were resolved by taking main's version and dropping WS3 changes; WS3 then shipped `.workstream-status-ws3.md` alongside as the per-workstream status doc.
- WS3 dropped one commit during the rebase: `2b5c0de` "cross-link approver identity to signalman-cloud contract" was pure-status-doc and became empty after status changes were dropped. Its technical content (the cross-link to `signalman-cloud:docs/contracts/promotion-approvers.md`) is already shipped on the cloud side at `b2f3930` and was not lost.
- Wave A consolidated test count post-WS3-merge: **2305 tests passing**, coverage **83.68% lines / 82.04% branches / 87.47% functions / 83.68% statements** — all above the 80/70/80/80 gates. Add your WS6 tests on top and re-verify.

## Pre-flight

1. Confirm the operator has already merged WS3 into main. If `git log -1 main` shows a tip of `6d23aef` or a later commit (where the subject mentions `WS3` or `v0.4.0-release-ops`), the merge has landed. If main is still at `f8ffc77`, wait for the operator before continuing.
2. Verify pre-state from inside `~/source/repos/signalman-audit-skills`:
   ```bash
   git status                                    # should be clean
   git log --oneline -3                          # confirms your c905398 tip (or wherever you parked)
   git fetch                                     # pull main in case the operator pushed
   git log --oneline main..HEAD | wc -l          # confirms 19 WS6 commits (or your current count)
   git log --oneline 558e0ed..main | wc -l       # confirms WS1+WS2+WS3 between your base and main
   ```
3. Fresh-install host deps before the rebase, since WS3 added `nodemailer` and `@types/nodemailer`:
   ```bash
   cd host
   rm -rf node_modules package-lock.json
   npm install
   cd ..
   git restore host/package-lock.json   # if the install rewrote the lockfile, restore yours; conflicts on it resolve in step 4
   ```

## Predicted conflict shape

WS6's branch overlaps with WS3's additions in 8 host files (confirmed by `comm -12` of the file-name sets):

| File | WS6's additions | WS3's additions | Conflict shape |
|---|---|---|---|
| `host/src/control-plane/storage/driver.ts` | `RunnerRepo` interface declaration; field in `StorageDriver` | `HealthScheduleRepo` / `WebhookSubscriptionRepo` / `PromotionPolicyRepo` / `ApprovalRepo` interfaces + field declarations | Same insertion-point race as WS1×WS3 had. Resolve by keeping main's complete declarations (now including WS3's) and appending WS6's `RunnerRepo` declaration. |
| `host/src/control-plane/index.ts` | `get runners()` accessor | `get healthSchedules / webhookSubscriptions / promotionPolicies / approvals` | Same — append WS6's getter after main's. |
| `host/src/control-plane/storage/sqlite.ts` | `SqliteRunnerRepo` class + `mapRunner` | `SqliteHealthScheduleRepo`, `SqliteWebhookSubscriptionRepo`, `SqlitePromotionPolicyRepo`, `SqliteApprovalRepo` classes + their mappers | This was the worst tangle in WS3's rebase — the `prep + try/catch + mapSqliteError` boilerplate gets matched across repo classes and conflict regions cut mid-method. **Use the `git checkout --ours` + append-at-end pattern.** Don't try to merge in-place. |
| `host/src/control-plane/storage/postgres.ts` | `PgRunnerRepo` | WS3's four Pg* classes | Same boilerplate-tangle pattern via `pgQuery`/`pgPositional`. Same fix. |
| `host/src/cli.ts` | `signalman target edit`, `signalman runner register/list/deregister`, etc. | `signalman schedule`, `signalman webhook`, `signalman promotion` subcommands | New dispatch cases + new handler functions. Append WS6's after WS3's via the existing section pattern. |
| `host/src/server.ts` | New `server.tool()` registrations for target-edit + runner verbs | WS3's 17 new `server.tool()` registrations for schedule/webhook/promotion | Append in a new WS6 block after WS3's last tool, before `// ── Start Server`. |
| `host/src/verbs/control-plane.ts` | `runTargetEdit`, `runRunnerRegister`, `runRunnerList`, etc. | WS3's scheduler/webhook/promotion verbs | Append. |
| `host/src/control-plane/types.ts` | `Runner` type | `HealthSchedule`, `WebhookSubscription`, `PromotionPolicy`, `Approval`, `PromotionGateKind`, `ApprovalStatus`, `WebhookKind` types | Likely auto-merges (insertions in non-adjacent type blocks). |

Plus the **`.workstream-status.md` add/add collision** every commit that touches the file: WS1 owns the file in main; WS3 added `.workstream-status-ws3.md` alongside. Mirror WS3's strategy — take main's version on every conflict, then ship `.workstream-status-ws6.md` (or your preferred name) as a single new commit at the end with the post-rebase WS6 audit narrative.

**One thing that will NOT collide**: your migration `0005_runners.sql`. Main has `0001-0004` (baseline) + `0040_cloud_budgets.sql` / `0041_cloud_credentials.sql` (WS1) + `0050_target_kind_k8s.{sqlite,pg}.sql` (WS2). WS3 added `0060_health_schedule.sql` / `0065_webhook_subscription.sql` / `0070_promotion_policy.sql`. Your `0005` slots in cleanly between the baseline and WS1's `0040`. The migration runner applies in filename order: 0001, 0002, 0003, 0004, **0005 (you)**, 0040, 0041, 0050, 0060, 0065, 0070. Runners don't depend on cloud / k8s / scheduler schemas, so ordering is safe.

**Your pre-resolved revert (`e75544e`) stays.** That commit dropped WS6's cloud + stack CLI additions because WS1's implementation is authoritative. Don't undo. The revert keeps WS6's CLI surface in a state that doesn't double-add the cloud verbs WS1 already shipped.

## Recommended procedure (mirrors what worked for WS3)

```bash
cd ~/source/repos/signalman-audit-skills

# 1. Capture pre-state (so you can `git reset --hard <tip>` if rebase goes sideways)
git rev-parse HEAD > /tmp/ws6-pre-rebase-tip
git diff 558e0ed..HEAD > /tmp/ws6-full.patch   # reference patch, not applied

# 2. Start the rebase
git rebase main
```

For each commit's conflicts:

- **For each conflicted code file**: `git checkout --ours <file>` to take main's clean version (which already has WS1+WS2+WS3 content properly placed), then re-apply WS6's additions to that file using `git diff <parent-of-this-commit>..<this-commit> -- <file>` as your source-of-truth diff. Extract the WS6 hunks (they're additive) and apply them at the end of the file or in their semantic section. **Be sure to also re-add the field declaration and constructor wiring** in driver classes — WS3 lost those during `--ours` and had to add them back manually. Same trap will hit you.

- **For `.workstream-status.md`**: always `git checkout --ours .workstream-status.md`. WS1 owns it; your status content goes in a separate file at the end.

- After each commit's resolution, run `cd host && npx tsc --noEmit` before `git rebase --continue` — this catches missing field declarations / constructor wires immediately (this saved WS3 from compounding mistakes through later commits).

When the rebase finishes successfully:

```bash
# 3. Write the final WS6 status doc
$EDITOR .workstream-status-ws6.md   # see WS3's .workstream-status-ws6.md as a template — WS3 named theirs .workstream-status-ws3.md
git add .workstream-status-ws6.md
git commit -m "docs: WS6 post-rebase status"
```

## Definition of Done (mirrors WS3's gates)

```bash
cd host
npx tsc --noEmit                              # zero errors
npm test                                      # full suite green (~2305 + your additions)
npm run coverage -- --testTimeout=30000       # >=80/70/80/80
```

## Wave A close-out

After your DoD gates pass, notify the operator. They'll do `git merge --ff-only chore/audit-and-skills` from `~/source/repos/signalman` and Wave A is done.

The Wave-2 capability-matrix refresh (`docs/audit/capability-matrix-2026-05-wave2.md`, referenced at the end of your original WS3 prompt) is your next deliverable on top of the merged main. Now's the time. It should enumerate the full post-Wave-A surface:

- WS1's cloud verbs (cloud + stack, budget, creds) — `signalman_cloud_*`, `signalman_stack_*`
- WS2's k8s verbs — `signalman_k8s_deploy/_rollback/_status`, `signalman runner deploy-k8s`
- WS3's scheduled-health verbs — `signalman_schedule_*` (6 MCP tools, 7 CLI subcommands)
- WS3's webhook verbs — `signalman_webhook_*` (4 + 4)
- WS3's promotion verbs — `signalman_promotion_*` (7 + 7)
- WS6's runner / target-edit verbs already in your branch

## Open coordination questions to surface back

- Did any WS6 commit need to be reshaped during this rebase (a hunk that was supposed to land in a WS1/2/3-touched region got dropped silently)? WS3 explicitly verified none of theirs did; do the same check and log in `.workstream-status-ws6.md`.
- Does the post-WS6-merge surface need a follow-up commit to wire WS6's runner table into WS3's promotion auto-approver? My read is no — they're orthogonal — but the WS3 status doc flags this as a "no integration needed" so worth a quick sanity check from your side.
- After Wave A merges, the operator may want to cut a v0.4.0-rc1 tag. The CHANGELOG entries for v0.3.0-5 (WS1), v0.3.0-6 (WS2), v0.4.0-1/-2/-3 (WS3), and Wave-A-skills (WS6) need to be consolidated.

## What "done" looks like

When you ship, main carries (in order):

- pre-Wave-A baseline through `558e0ed`
- WS1's v0.3.0-5 completion (cloud cost guardrails, per-org budgets, per-org credentials, CLI wrappers): commits roughly `dfd6d53` ... `5cf383d`
- WS2's v0.3.0-6 Kubernetes (KubectlDriver, HelmDriver, MCP, CLI, skills, `runner deploy-k8s`): commits roughly `194ad0c` ... `f8ffc77`
- WS3's v0.4.0 Epics 1-3 (scheduled health, webhooks, promotion): commits `ef79a0f` ... `6d23aef`
- **WS6's audit + skills + runner + target-edit**: your branch after this rebase

Wave-2 capability matrix lands on top.

## Notes from the WS3 rebase that might save you time

1. **`git checkout --ours` during a rebase reverts the file completely** — including any prior conflict resolutions you made on the same file in this same rebase invocation. WS3 lost the `readonly healthSchedules: HealthScheduleRepo` field declaration this way (it was in the conflict region) and had to re-add. Solution: after taking main's version, ALWAYS re-add field declarations and constructor wiring before continuing.

2. **Run `tsc --noEmit` after each commit's resolution, not just at the end.** WS3 caught one missing field declaration this way; it would have compounded through subsequent commits.

3. **Don't try `git apply --3way`** — won't apply because the index isn't merged. Use the manual diff-and-append approach.

4. **`git checkout --ours` resolves the file but doesn't update the index.** Don't forget to `git add <file>` before `git rebase --continue`.

5. **For commits that touch ONLY `.workstream-status.md`** and become empty after dropping your changes — use `git rebase --skip`. WS3 had one (`2b5c0de`); your branch may not have any since you committed status updates per-milestone, but check.

Good luck. The shape is the same one you predicted for WS3, the playbook is exactly what your handoff doc suggested for them, and the predicted file count is the same (8 + status). Estimated time at WS3's pace: ~1.5 to 2 hours for the rebase + verification + status doc.
