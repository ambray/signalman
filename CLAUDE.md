<!-- BEGIN LOOM loom.core.setup.claude-code -->
# Loom Coordination Protocol

- Start from a Loom brief: `loom task start "<task>"`.
- Work from explicit success criteria and keep edits inside the scoped files.
- If you are resuming, run `loom task resume` before making changes.
- Use `loom task digest` when you need a concise task-state summary instead of re-reading the full task history.
- Before executing any non-trivial command, call `policy.check` with the command, args, and cwd.
- If `policy.check` returns `auto`, proceed and keep working.
- If `policy.check` returns `queue`, stop, surface the queued review to the operator, and keep your task summary concise so they can approve quickly.
- If `policy.check` returns `deny`, do not execute the command; surface the reason and ask for an alternative.
- When ownership changes, hand off with `loom handoff --to codex`.
- Before claiming completion, run `loom follow-through --done "<what finished>" --verification "<what you checked>"`.
- Treat `.loom/` as the durable source of task, handoff, and follow-through state.

## Handling Loom errors

### `BranchCollision` from `loom task start` / `task_start` (MCP)

Loom refuses to create a new task when the recommended branch is already claimed by another active task. You will see one of:

- CLI: a non-zero exit with stderr containing `branch \`...\` is already claimed by active task(s): ...`
- MCP: an error result with the same structured message

**Do not auto-retry.** In particular:

- do not silently retry `task_start` with a tweaked title to "fix" the error; the operator has already decided this is the right title for this work, and a slug-shifted retry hides the real coordination issue
- do not pass `allowCollision: true` over MCP; the MCP handler refuses that field anyway, and an agent setting it without operator gesture is exactly the bypass this guard exists to prevent

**Do surface the situation to the operator.** Repeat the colliding task ids, name the three resolution paths from the error message, and ask which one the operator wants:

1. close or cancel one of the colliding active tasks
2. start the new task with a different title (a different slug becomes a different branch)
3. intentionally share the branch by re-running with `--allow-collision` (CLI) or via the TUI `task start` form's "share branch" toggle

`allowCollision` is operator-only; agents cannot set it on the MCP path.

### `BranchCollision` and owner-keyed branches

Loom's recommended branch is `loom/<owner>/<slug>`. Two tasks for the same logical work but different owners (`codex` vs `claude-code`) get different branches and do **not** collide. If you observe a teammate (human or agent) starting work on the same logical task under a different owner, the absence of a `BranchCollision` is not a green light; it is just the current keying. Surface the overlap to the operator before duplicating effort.

### `WorktreeCollision` from `loom task start` / `task_start` (MCP)

Loom also refuses to create a new task when the same worktree is already claimed by another active task on a **different** recommended branch. A single worktree only has one HEAD; two active tasks on different branches in the same worktree are guaranteed to trigger `BranchMismatch` for at least one of them, so the refusal happens up front. Same-branch same-worktree is the `BranchCollision` case above.

You will see one of:

- CLI: a non-zero exit with stderr containing `worktree \`...\` is already claimed by active task(s) on a different branch: ...`
- MCP: an error result with the same structured message

**Do not auto-retry.** The same rules as `BranchCollision`:

- do not silently retry `task_start` with a different title; the worktree is claimed, not the slug
- do not pass `allowWorktreeCollision: true` over MCP; the MCP handler refuses that field, and an agent setting it without operator gesture is exactly the bypass this guard exists to prevent

**Do surface the situation to the operator.** Repeat the colliding task ids and branches, then ask which of the three resolution paths the operator wants:

1. close or cancel one of the colliding active tasks
2. start the new task from a different worktree (e.g. `git worktree add ../<repo-name>-<task-slug>` then `cd` into it and re-run)
3. intentionally share the worktree by re-running with `--allow-worktree-collision` (CLI) or via the TUI `task start` form's "share worktree with another active task on a different branch [y/n]" toggle

`allowWorktreeCollision` is operator-only; agents cannot set it on the MCP path.

**Known limitations the operator should understand:**

- **TOCTOU best-effort, not transactional.** Two concurrent `loom task start` invocations on the same worktree can both pass the collision check and both succeed, leaving two active tasks claiming the same worktree on different branches. Loom does not lock between read and write at task creation. The visibility-layer collision detection (`refresh_task_ownership_summaries`) catches the resulting state at next read, surfacing it as a `BranchMismatch` recovery concern.
- **Enforcement scope is the local `.loom/tasks/` directory.** Sibling worktrees created via `git worktree add` each maintain their own claim set; tasks in `~/repos/main` and `~/repos/main-fix` are mutually invisible to each other's collision check. This is by design; the multi-worktree pattern is the recommended way to coordinate parallel work, but cross-worktree-aware reconciliation is out of scope.

## Reading `gitRecovery` from `task_resume`, `handoff`, and `task_show`

The `gitRecovery` field on `TaskResumeResult`, `HandoffResult`, and `TaskShowResult` is an **advisory** view of whether it is safe to continue work on a task. Loom does not refuse to proceed when the status is `blocked`; it is reporting, not gating. Treat the status as a strong recommendation and surface it to the operator before acting.

`status` values:

- `safe_to_continue`: none of the checked signals fired. Proceed as planned, but remember Loom only checks ownership, dirty state, linked-external sync state, and stale-handoff signals; this is not a comprehensive verification.
- `attention_required`: at least one concern needs operator review. Read the per-concern `recommendedAction` and either resolve or acknowledge before acting.
- `blocked`: at least one concern would likely make the situation worse if you proceed (wrong-branch commits, conflicting remote state, merged PR, worktree mismatch). **Stop and ask the operator** before doing anything that mutates the repo. Do not auto-resolve.

`concerns` are pre-sorted by severity descending; the first entry is always the most-blocking. Each concern carries `kind`, `detail`, and `recommendedAction`. The recommended action is a plain-text suggestion that may include a CLI command; surface it to the operator verbatim rather than paraphrasing.

**Do not** attempt to resolve concerns programmatically (e.g. do not auto-`git checkout` on `branch_mismatch`, do not auto-`git stash` on `dirty_worktree_outside_scope`, do not auto-`loom task sync-github` on `linked_external_conflict`). All of those are operator decisions.

`gitRecovery` is also exposed on every `TaskBriefSummary` returned by `tasks_list` (MCP) / `loom tasks` (CLI), and the surrounding `TasksListSummary` carries `recoveryBlocked`, `recoveryAttention`, and `recoverySafe` aggregate counts that partition the task list. The list is sorted by attention bucket first, then by recovery severity descending within each bucket, so a task at `blocked` already appears ahead of an `attention_required` task within the same attention bucket. You can trust the order returned by `tasks_list` without resorting client-side; the recommended action when surfacing tasks is to scan in the returned order and lead with whichever entries carry a non-safe `gitRecovery.status`.
<!-- END LOOM loom.core.setup.claude-code -->

<!-- selvedge:begin -->
## Selvedge Security Plugin

Selvedge is installed in this environment. Before adding or upgrading any dependency:

1. Call `selvedge.check_package` with the ecosystem, package name, and version.
2. Read the returned `decision_hint`:
- `proceed` — safe to install.
- `warn` — summarize the advisory, suggest the `recommended_version`, ask the user.
- `block` — refuse. Explain the advisory. Propose an alternative.
3. Never install silently. Never strip vulnerability details from what you show.

For deeper reasoning, the `selvedge.pre-install-check` skill is available.
Triage findings with `selvedge.triage <finding-id> <state>`. List findings with
`selvedge.list_findings`.
<!-- selvedge:end -->
