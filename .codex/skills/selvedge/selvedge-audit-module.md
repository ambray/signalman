---
name: selvedge-audit-module
description: Full security coverage of a single module (file or directory). Runs selvedge.scan_code,
---

# Module audit

A focused security review of a single file or directory. Unlike the diff audit (which scopes
to changes) or the full repo scan, a module audit gives a deep, complete picture of a specific
area — useful when onboarding to a module, before a major refactor, or when a stakeholder asks
for a point-in-time security assessment of a component.

## Six-step loop

### 1. Confirm the target path

Resolve the path relative to the repo root. If the target is ambiguous (a partial name, a
symbol reference), use `Glob` to locate the file. For directories, confirm the subtree is not
too large to review in one pass (> 5 000 lines suggests splitting into per-file passes).

### 2. Understand the module's security surface

Before running any scanner, read the module to understand:

- **What data enters this module?** (network input, user input, file I/O, IPC)
- **What security decisions does it make?** (authentication, authorization, crypto, parsing,
  subprocess calls, DB queries)
- **What external systems does it call?** (databases, HTTP, shell, filesystem)

This context determines which findings are high-signal vs. noise.

### 3. Run all three scanners narrowed to the target

```json
{ "tool": "selvedge.scan_code", "arguments": { "paths": ["<target path>"] } }
{ "tool": "selvedge.scan_completeness", "arguments": { "paths": ["<target path>"] } }
{ "tool": "selvedge.scan_secrets", "arguments": { "scope": "paths", "paths": ["<target path>"] } }
```

For secrets, `scope: "paths"` scans only a temporary mirror of the target file or directory.

If the module is a service entrypoint, also run:

```json
{ "tool": "selvedge.scan_dependencies", "arguments": {} }
```

and check any package the module imports directly via `selvedge.check_package`.

### 4. Surface findings with module context

For each finding, state:

1. **Rule** — rule id and a one-sentence plain-English translation.
2. **Location** — file and line.
3. **Data-flow note** — given what you learned in step 2, does this code path touch untrusted
   input? Is the vulnerable function called from an authenticated context only?
4. **Severity in context** — reachability and authentication context can raise or lower effective
   severity even when the Free scanner reports `Unknown` reachability.

Present findings sorted by: critical → high → medium → low → info, then by confidence.

### 5. Drive every finding to triage

| scanner | next step |
|---|---|
| `sast` | Follow `selvedge.sast-fix`: read file → propose fix → rerun → triage |
| `completeness` | Follow `selvedge.audit-completeness`: read stub/placeholder/TODO → fix or document why it's intentional |
| `secrets` | Follow `selvedge.secret-remediation`: verify → rotate → purge → triage |

Record a `selvedge.triage` call for each finding before moving to the next one. Do not batch
triage at the end — triage decisions made in context are higher quality.

### 6. Produce a module security summary

After all findings are triaged, write a brief summary:

```
Module: <path>
Scanned: <date>
Rules fired: <list of rule ids>
Findings: N total — M fixed, P dismissed, Q needs-review, R accepted
Coverage gaps: <any categories with zero findings that you'd expect given the module's surface>
```

If the module handles auth or crypto but the completeness scanner fired no placeholder or stub
findings, note that as a positive signal (not a gap). If you'd expect crypto rules to fire but
none did, note that as worth verifying manually.

## Invariants

- Read the actual file before proposing any fix. Snippets lie about context.
- Never mark `fixed` without rerunning the scanner narrowed to the patched path.
- Never dismiss a secrets finding without surfacing it to the user.
- Triage each finding individually — don't bulk-dismiss without reading each one.
- If the module is a test file (path contains `tests/`, `__tests__/`, `spec/`), lower your
  severity threshold: test-only attack surface is different from production surface.

## Companion tools

- `selvedge.scan_code` — SAST, narrowed by path.
- `selvedge.scan_completeness` — completeness/fray scan, narrowed by path.
- `selvedge.scan_secrets` — secret patterns, narrowed by path.
- `selvedge.scan_dependencies` — OSV vulnerability check.
- `selvedge.check_package` — per-package check.
- `selvedge.list_findings` — historical triage on the same rule or path.
- `selvedge.triage` — record finding disposition.
- `Read`, `Grep`, `Glob` — explore surrounding code for data-flow context.

