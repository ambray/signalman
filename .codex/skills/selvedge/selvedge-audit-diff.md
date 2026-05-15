---
name: selvedge-audit-diff
description: Security audit of a git diff before a commit or PR merge. Extracts the changed file
---

# Diff audit

Before a commit or PR merges, run every Selvedge scanner over only the changed files. This
constrains the finding surface to what the author actually touched — new vulnerabilities introduced
by this change — and avoids re-surfacing pre-existing debt that belongs in a separate backlog.

## Five-step loop

### 1. Identify changed paths

Get the diff and extract file paths that were added or modified (ignore pure deletes). Use the
narrowest scope available:

```bash
# Staged changes only
git diff --name-only --diff-filter=AM HEAD

# A specific commit range
git diff --name-only --diff-filter=AM <base>..<head>

# A PR (if gh CLI is available)
gh pr diff <pr-number> --name-only
```

Partition the paths by language extension so you can target the right scanner invocations. Skip
non-source files (images, lock files, compiled artifacts).

### 2. Run all three scanners narrowed to changed paths

Run in parallel when the agent framework supports it.

**SAST — static pattern analysis:**

```json
{
  "tool": "selvedge.scan_code",
  "arguments": {
    "paths": ["<changed file 1>", "<changed file 2>"]
  }
}
```

**Completeness — stubs, placeholders, TODOs:**

```json
{
  "tool": "selvedge.scan_completeness",
  "arguments": {
    "paths": ["<changed file 1>", "<changed file 2>"]
  }
}
```

**Secrets — credential patterns and history:**

```json
{
  "tool": "selvedge.scan_secrets",
  "arguments": {
    "scope": "paths",
    "paths": ["<changed file 1>", "<changed file 2>"]
  }
}
```

For secrets, `scope: "paths"` scans only a temporary mirror of the requested files/directories.

### 3. Triage dependency changes

If any `package.json`, `pyproject.toml`, `requirements*.txt`, `Cargo.toml`, or `go.mod` was
modified, call `selvedge.scan_dependencies` and then `selvedge.check_package` for each new or
upgraded package. A dependency bump is a supply-chain event.

### 4. Surface and prioritize findings

Merge findings from all scanners. Present them sorted by severity (critical → high → medium →
low → info) with confidence as the tiebreaker. For each:

- State the scanner, rule id, file, and line.
- Quote the snippet from `context.code_region.snippet`.
- Say in one sentence why it matters in the context of this diff.

### 5. Drive every finding to triage

For each finding, follow the appropriate fix loop:

| scanner | follow-up skill |
|---|---|
| `sast` | `selvedge.sast-fix` — read rule → propose fix → confirm → triage |
| `completeness` | `selvedge.audit-completeness` — understand gap → fix or dismiss |
| `secrets` | `selvedge.secret-remediation` — verify → rotate → purge → triage |
| `dependencies` | `selvedge.audit-dependency-change` — check package → assess risk |

Record a triage state via `selvedge.triage` before declaring the diff clean.

## Exit condition

The diff is audit-clean when:

1. Every finding is at `fixed`, `dismissed`, `needs-review`, or `accepted` — none left at `open`.
2. No new secrets are present (or all are verified as test fixtures and dismissed with a reason).
3. Any new dependency has been checked via `selvedge.check_package`.

Report the count: "N findings found, M fixed, P dismissed, Q need-review."

## Invariants

- Scope to changed paths. Do not re-triage pre-existing findings that this diff didn't touch.
- Read the actual file for every SAST/completeness finding — snippets lose context.
- Never mark `fixed` without rerunning the scanner narrowed to the patched path.
- Flag any secret finding to the user before dismissing. Secrets dismissals require human
  confirmation; agents should not self-approve a credential dismissal.

## Companion tools

- `selvedge.scan_code` — SAST, narrowed by path.
- `selvedge.scan_completeness` — completeness/fray scanner, narrowed by path.
- `selvedge.scan_secrets` — secret pattern scanner, narrowed by path.
- `selvedge.scan_dependencies` — OSV vulnerability check on lockfiles.
- `selvedge.check_package` — per-package reputation + vulnerability check.
- `selvedge.list_findings` — review prior triage on the same rule or path.
- `selvedge.triage` — record the final disposition of each finding.

