---
name: selvedge-audit-completeness
description: Drive a Selvedge completeness (fray) finding to resolution. Identify the category (placeholder-literal / security-stub / todo-in-security / hallucinated-import / hardening-default) → read the code region with context → apply the category-specific fix or document intention → rerun scanner → triage.
allowed-tools: [selvedge.scan_completeness, selvedge.check_package, selvedge.list_findings, selvedge.triage, Read, Grep, Glob, Edit]
---

# Completeness audit

Fray findings signal gaps in security paths, not vulnerability patterns. Each category has its
own resolution strategy.

## Category quick reference

| category | signals | resolution |
|---|---|---|
| `placeholder-literal` | `"changeme"`, `"admin"`, `"your-api-key-here"` in security vars | Replace with env var / vault reference; dismiss if test fixture |
| `security-stub` | `pass` / `return True` / `raise NotImplementedError` in security function | Implement real logic; `needs-review` if context missing |
| `todo-in-security` | TODO/FIXME/XXX near security identifiers | Complete the TODO; dismiss if informational with reason |
| `hallucinated-import` | Import of non-existent package (AI-generated names) | Verify via `selvedge.check_package`, correct to real name |
| `hardening-default` | Framework/library below secure baseline | Apply the recommended secure option |

## Loop

1. **Read the finding.** Extract category from `rule_id` prefix (`completeness.<category>.*`).
   Note severity, confidence, `code_region.path`, `start_line..=end_line`.

2. **Read the actual file.** `Read` the file at `code_region.path`, `start_line..=end_line`
   plus ~10 lines of context. Understand the function's security role and whether it's in a
   production path.

3. **Apply category strategy.**

   **placeholder-literal:**
   - `Grep` the variable name to find usage. If in production auth/crypto/DB: replace with
     `os.environ["VAR"]` / `process.env.VAR` or the codebase's existing secret-loader pattern.
   - Test fixture / docs example → `dismissed` with documented reason.
   - Never inline a real credential.

   **security-stub:**
   - `Grep` the function name to find callers. If called from production paths: implement.
   - Abstract base with concrete subclasses → `dismissed` as "base class; subclasses implement."
   - Can't implement safely without more context → `needs-review` with description of what's needed.

   **todo-in-security:**
   - Actionable security TODO → implement it or set `needs-review` with specifics.
   - Informational / tracking reference → `dismissed` with reason or issue reference.

   **hallucinated-import:**
   - `selvedge.check_package { name, ecosystem }` to verify the package exists.
   - If absent: find the real package name and correct the import.

   **hardening-default:**
   - Apply the secure config option. Run tests.

4. **Rerun scanner after any code change.**
   ```json
   { "tool": "selvedge.scan_completeness", "arguments": { "paths": ["<fixed file>"] } }
   ```
   Confirm the finding no longer fires before marking `fixed`.

5. **Record triage.**
   ```json
   { "tool": "selvedge.triage", "arguments": { "finding_id": "...", "state": "fixed", "reason": "..." } }
   ```

## Invariants

- Read the actual file — snippets lose context.
- Never `fixed` without rerunning the scanner on the patched path.
- Never dismiss a production placeholder without verifying it isn't deployed (check env configs, CI).
- Run `check_package` before concluding an import is hallucinated.
