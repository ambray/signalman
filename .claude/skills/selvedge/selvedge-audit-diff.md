---
name: selvedge-audit-diff
description: Security audit of changed files before a commit or PR merges. Get changed paths → run scan_code + scan_completeness + scan_secrets narrowed to those paths → surface findings by severity → drive each to triage before the change lands.
allowed-tools: [selvedge.scan_code, selvedge.scan_completeness, selvedge.scan_secrets, selvedge.scan_dependencies, selvedge.check_package, selvedge.list_findings, selvedge.triage, Read, Grep, Glob, Edit, Bash]
---

# Diff audit

Scope every scanner to the changed paths only. Don't re-triage pre-existing debt.

## Loop

1. **Get changed paths.** `Bash`: `git diff --name-only --diff-filter=AM HEAD` (or the relevant
   range). Filter to source files; partition by extension.

2. **Run scanners in parallel on changed paths.**
   - `selvedge.scan_code` with `paths: [<changed files>]`
   - `selvedge.scan_completeness` with `paths: [<changed files>]`
   - `selvedge.scan_secrets` with `scope: "paths", paths: [<changed files>]`

3. **Check new/upgraded deps.** If any manifest changed (`package.json`, `pyproject.toml`,
   `requirements*.txt`, `Cargo.toml`, `go.mod`): `selvedge.scan_dependencies` then
   `selvedge.check_package` for each new or bumped package.

4. **Present findings** sorted critical → high → medium → low → info. For each: scanner, rule_id,
   file:line, snippet, one-sentence impact in context of this diff.

5. **Drive each to triage** before declaring clean:
   - `sast` → read file → fix → rerun → `selvedge.triage { state: "fixed" | "dismissed" | ... }`
   - `completeness` → read file → fix gap or record reason → triage
   - `secrets` → verify → surface to user → rotate if live → triage (never self-approve a cred dismissal)
   - `dependencies` → assess risk → triage or flag for upgrade

## Exit condition

All findings at `fixed` / `dismissed` / `needs-review` / `accepted`. Zero `open`. Report:
"N found — M fixed, P dismissed, Q needs-review."

## Invariants

- Read the actual file for every finding — snippets lose context.
- Never mark `fixed` without rerunning the scanner on the patched path.
- Never self-dismiss a secrets finding — surface to user first.
