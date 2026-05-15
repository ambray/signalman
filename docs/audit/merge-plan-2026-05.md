# Six-workstream consolidation plan

**Author**: WS6 agent
**Date**: 2026-05-15
**Scope**: merging WS1–WS5 into `main` and re-running WS6's audit afterward (Wave 2).

## State of each workstream

All six branches have committed work; none has pushed to origin. Each has a `.workstream-status.md` at its worktree root.

| WS | Branch | Worktree | Commits ahead of `558e0ed` | Status doc |
|---|---|---|---|---|
| 1 — Cloud completion | `feat/v0.3.0-5-cloud-finish` | `signalman-cloud-finish` | 13 | 674 lines — sub-tasks 5/6/8 shipped |
| 2 — Kubernetes | `feat/v0.3.0-6-kubernetes` | `signalman-kubernetes` | 10 | 233 lines — both sub-tasks shipped |
| 3 — Release ops | `feat/v0.4.0-release-ops` | `signalman-release-ops` | 12 | 205 lines — three epics shipped |
| 4 — Cross-platform | `feat/v0.4.0-cross-platform` | `signalman-cross-platform` | 9 | 365 lines — three chunks shipped |
| 5 — Artifact registry | `feat/v0.4.0-registry` | `signalman-registry` | 10 | 131 lines — scaffolding shipped; 1 file pending in WT |
| 6 — Audit + skills | `chore/audit-and-skills` | `signalman-audit-skills` | 33 | this branch — WS6 0/1/2/3 milestones shipped |

WS5 has one uncommitted file in the worktree — confirm with that branch's operator-review section before merging.

## Conflict map

Every workstream's first commit was supposed to NOT touch shared files (per PLAN.md §119). They mostly held to that, but later commits inevitably wire things into `server.ts` / `cli.ts` / `types.ts` / `driver.ts`. Below is what each WS touched in those files.

| File | WS1 | WS2 | WS3 | WS4 | WS5 | WS6 |
|---|---|---|---|---|---|---|
| `host/src/server.ts` | yes (cloud cost-estimate flag) | yes (`signalman_k8s_*` block) | yes (`signalman_schedule_*` / `_webhook_*` / `_promotion_*` blocks) | — | — | **yes (P1 wrappers + target-edit + runner-list/deregister blocks)** |
| `host/src/cli.ts` | yes (cloud + stack verbs, sub-task 8) | yes (`runner deploy-k8s`) | yes (`schedule/webhook/promotion` verbs) | — | — | **yes (cloud + stack verbs, target edit, runner list/deregister)** |
| `host/src/control-plane/types.ts` | yes (cloud error codes, budget shapes) | yes (k8s target kinds) | yes (event/schedule/webhook/promotion types) | — | — | **yes (`Runner`)** |
| `host/src/control-plane/storage/driver.ts` | yes | — | yes | — | — | **yes (`RunnerRepo` + `TargetRepo.update`)** |
| `host/src/cloud/types.ts` | yes (cost-estimate types) | — | — | — | — | — |
| Migrations | `0040_cloud_budgets.sql`, `0041_cloud_credentials.sql` | `0050_target_kind_k8s.{pg,sqlite}.sql` | `0060_health_schedule.sql`, `0065_webhook_subscription.sql`, `0070_promotion_policy.sql` | — | own SQLite under `registry/` | **`0005_runners.sql`** |
| `host/package.json` | — | — | yes (deps for HMAC / SMTP) | — | — | — |
| `ROADMAP.md` | — | — | — | yes | — | — |
| `registry/` (new package) | — | — | — | — | **yes (entire dir)** | — |
| `guest/` (Rust agent) | — | — | — | yes (platform split) | — | — |

**Migrations**: numbers are reserved per PLAN.md §110. No two streams claim the same number. WS6 (mine) added `0005` in the unreserved gap below WS1's 0040 — flagged below as the one item I should verify before merging.

## Critical collision — cloud + stack CLI verbs (WS1 vs WS6)

**Both** branches landed `signalman cloud *` and `signalman stack *` CLI verbs. Different argument shapes; same surface area.

| Aspect | WS1 (commit `322777d`) | WS6 (commit `ce51fa8`) |
|---|---|---|
| Tag input | `--tag k=v` repeated | `--tags '<json>'` JSON map |
| Var input | `--var k=v` repeated | `--vars '<json>'` JSON map |
| Credential flags | `--aws-profile X`, `--azure-credentials Y` | not added |
| `signalman cloud creds set/get/remove` | yes (sub-task 6 → 8) | not added |
| Helpers module | inline functions in `cli.ts` | extracted `host/src/cli-helpers.ts` + 30 tests |

The collision is genuine — `cmdCloud` + `cmdStack` dispatchers and the matching subcommands exist in both branches with different bodies.

**Root cause**: I added these verbs in WS6 M3 (operator-authorised "ship them" for P1') without checking WS1's status doc, which showed sub-task 8 already shipped. The audit prompt explicitly told WS6 not to look at in-flight work — but it didn't tell me to keep my hands off the same surface in later milestones.

**Resolution options** (operator picks):

1. **Drop WS6's cloud + stack additions** (recommended). Revert `ce51fa8`'s cloud + stack handlers from M3, keep `cli-helpers.ts` if WS1 wants to adopt its parser module, or drop the helpers along with the handlers. WS1's implementation is the authoritative one — it has the credential flags + creds subcommand that mine doesn't. Smallest delta, cleanest history.

2. **Drop WS1's sub-task 8 commits**, keep WS6's. Requires re-implementing the credential flags + `cloud creds` subcommand on top of mine. Throws away WS1's tested work.

3. **Merge both** into a hybrid that accepts either `--tag k=v` (WS1 shape) or `--tags '<json>'` (WS6 shape). Most code, most testing. Operator pays in complexity to not pick a side.

My recommendation: **option 1**. I'll prep the revert as a separate WS6 commit on a clean follow-up branch so the operator can apply it before merging WS6.

## Smaller collisions (resolvable by rebase)

- **`host/src/cli.ts` runner-dispatcher** — WS2 added `case "deploy-k8s":` to `cmdRunner`; WS6 added `case "list":` and `case "deregister":`. Same `switch` block, different cases. Standard 3-way merge will resolve as long as both versions are in the merge stack; if one's a fast-forward over the other it may need a manual rebase keeping both `case` arms.

- **`host/src/server.ts` tool registrations** — append-only blocks. WS1/WS2/WS3/WS6 each register new `server.tool(...)` calls. No two streams register the same tool name. A 3-way merge resolves this trivially; the file just grows.

- **`host/src/control-plane/types.ts`** — each WS adds new type definitions and (sometimes) extends a union. The `CloudBackendErrorCode` union gets `budget_exceeded` from WS1 and a couple new codes from WS2's k8s driver. Watch for `target.kind` enum widening in WS2 (`k8s_test` / `k8s_demo`).

- **`host/src/control-plane/storage/driver.ts`** — WS1 adds `cloudBudgetsRepo` / `cloudCredentialsRepo`; WS3 adds `healthScheduleRepo` / `webhookRepo` / `promotionRepo`; WS6 adds `runners` + `TargetRepo.update`. All append to `StorageDriver`. Same-file but additive; standard merge.

## Recommended merge order

PLAN.md §161 prescribes fast-forward when possible. With six branches all forking from `558e0ed`, only the first FF works; the rest need rebases. Order matters because each rebase exposes the rebased branch to the prior branches' new files + interface changes.

**Wave A — schema and tool registrations first** (these touch most shared files):

1. **WS1 (Cloud completion)** — first because:
   - It owns the lowest migration block (0040-0049) so subsequent migrations sort cleanly behind it.
   - WS6's M3 cloud + stack CLI additions need to be reverted *before* this merges, OR WS1 needs to rebase over WS6's revert. Either way, WS1 has to land its cloud + stack CLI first.
   - WS1's per-org credentials work modifies the storage driver shape that WS3 might depend on for the webhook auth contract.

2. **WS2 (Kubernetes)** — second:
   - Migration block 0050-0059; smaller than WS3's. Lower numerical sorts first.
   - Adds `k8s_test` / `k8s_demo` to the target-kind enum — WS3's webhook/promotion logic may want to gate on target kind.
   - `runner deploy-k8s` CLI verb runs alongside WS6's `runner list` / `deregister` cleanly (different cases in the same switch).

3. **WS3 (Release ops)** — third:
   - Largest migration block (0060-0079, three epics).
   - Webhook + promotion features fire on events that WS2's k8s deploys will emit.
   - `package.json` dep additions (HMAC, SMTP). Lock-file regeneration is a known merge headache; do this fast and then resolve the lock-file conflict by `npm install` after merge.

**Wave B — independent**:

4. **WS4 (Cross-platform)** — only touches `guest/` (Rust) + `ROADMAP.md`. No host conflicts. Run `cargo build --all-features && cargo test --all-features && cargo clippy --all-features -- -D warnings` per PLAN.md §134 before merging.

5. **WS5 (Artifact registry)** — adds `registry/` as a new package; touches `host/` only via the `signalman-registry` BlobDriver in `@signalman/host`, which is a small contained addition. The 1 uncommitted file in the worktree needs to be resolved by the WS5 operator (or me if you authorise it) before merging.

**Wave C — re-audit + ship**:

6. **WS6 (this branch)** — last:
   - Doc-only after the cloud + stack CLI revert lands.
   - Skills can be merged independently (one per commit) so any that conflict with later workstreams' MCP renames can be picked individually.
   - The capability-matrix doc anchors at `558e0ed`. After WS1-5 merge, the matrix is stale; the Wave-2 audit refreshes it.

## What I need to do to make WS6 mergeable

1. **Revert the cloud + stack CLI block from M3** to resolve the WS1 collision. Specifically:
   - Drop `cmdCloud`, `cmdStack`, and their subcommands from `cli.ts`.
   - Drop the dispatch cases from `main()`.
   - Drop the `cloud` / `stack` help-text lines.
   - **Keep** `cli-helpers.ts` and `cli-helpers.test.ts` — they're standalone, well-tested, and WS1 can adopt them if useful. Or drop with the rest if cleaner.

2. **Drop the cloud + stack skills if duplicated**. WS1's sub-task 8 commit `5cf383d` is "consolidated skills for sub-tasks 5/6/8 (sub-task 8 commit 3)". My status doc shows I added `signalman-edit-target`, `signalman-list-runners`, `signalman-deregister-runner` in M3 — those are unique. I did NOT add cloud + stack skills in WS6 (those are pre-WS6, in `main` as of `558e0ed`).

3. **Refresh the capability matrix doc** post-Wave-A merge as the Wave-2 audit. New matrix at `docs/audit/capability-matrix-2026-05-wave2.md`. Same shape, anchored at the new `main` HEAD. Re-run the prompt's enumeration against the consolidated tree.

4. **Re-run the frontmatter validator + full coverage** against the consolidated `main`. The validator's static parser may discover new MCP tools from WS1/WS2/WS3 that should be referenceable from skills. The 28 existing WS6 skills should all still pass; new WS1/WS2/WS3 skills validate too.

5. **The migration number `0005_runners.sql`** is in the unreserved gap below WS1's 0040. Confirm no other workstream is also using 0005 (none of WS1-5 should, per the conflict map above, but worth a `find . -path "*migrations/0005*"` sweep after Wave-A lands).

## Pre-merge gates per workstream (PLAN.md §131-134)

Before merging each branch, verify against that branch:

```bash
cd ~/source/repos/signalman-<ws-name>
cd host && npx tsc --noEmit                            # zero errors
cd host && npm test                                     # full suite green
cd host && npm run coverage -- --testTimeout=30000      # >=80/70/80/80
# For WS4 only:
cd ../guest && cargo build --all-features && cargo test --all-features && cargo clippy --all-features -- -D warnings
```

If any gate fails, the branch isn't ready; fix in the workstream's own branch before merging.

## Wave-2 audit deliverables (after all six land)

Producing these on the new consolidated `main`:

1. **`docs/audit/capability-matrix-2026-05-wave2.md`** — fresh enumeration. Estimated new rows: ~30-40 (cloud cost-guardrails, k8s targets, schedule/webhook/promotion, libvirt/vmrun backends, registry surface).

2. **`docs/audit/wave-2-gap-list.md`** — same P0/P1/P1'/P2/P3 tiering applied to the new surface. Likely findings:
   - P0 skill gaps for each new MCP tool that's still skill-uncovered (`signalman_k8s_*`, `signalman_schedule_*`, `signalman_webhook_*`, `signalman_promotion_*`).
   - P1/P1' inversions for any new tool that's MCP-only or CLI-only (the registry has its own HTTP API but no MCP surface per WS5 brief — that's intentional, flag it but don't move on it).
   - P2 still has audit-log surface unclosed (queued for M5).

3. **Refresh `.workstream-status.md`** to reflect Wave-2 reality. The current doc is anchored at the pre-merge state; after consolidation it needs a new section explaining what landed and what the next operator should pick up.

4. **Consolidate frontmatter validator** to read tool names from the merged `server.ts` and confirm every new WS1/WS2/WS3 tool has either a skill or is documented as deliberately-not-skill-covered.

## Open questions for the operator

1. **Cloud + stack CLI collision** — confirm option 1 (drop WS6's additions) as recommended above. If you'd rather keep mine, say so before WS1 merges.

2. **WS5 uncommitted file** — should I look at it / commit it on the WS5 branch's behalf, or wait for the WS5 operator?

3. **`runner deploy` (was M3.5 plan)** — still queued? After WS2's `runner deploy-k8s` lands, the slot is partially filled. The general `runner deploy` for non-k8s transports is still useful but lower-leverage. Confirm whether to keep it on the followup register or close it out as "WS2 covers k8s; other transports are a future workstream."

4. **Wave-2 audit scope** — full re-enumeration, or just delta-from-Wave-1? Delta is faster; full is more reusable when the next workstream lands.

5. **Push to origin** — PLAN.md §123 says "do NOT push to origin from any workstream session." After consolidation the operator pushes from `main`. Confirm I should keep my local commits unpushed even after the cloud + stack revert.
