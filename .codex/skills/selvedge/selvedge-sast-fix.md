---
name: selvedge-sast-fix
description: 'Interpret a Selvedge SAST finding and drive the fix loop: read the rule rationale'
---

# SAST fix

Whenever `selvedge.scan_code` returns a finding, or `selvedge.list_findings` surfaces one with
`scanner = "sast"`, drive the finding to a resolution before moving on. A SAST finding is not
informational — every one needs a triage state recorded via `selvedge.triage` so the next
scan doesn't re-surface the same decision.

## Six-step loop

Run every step in order. Do not skip straight to a fix without reading the rule and inspecting
the code region.

### 1. Read the rule and the code region

Each finding carries:

- `rule_id` — for example `py.dangerous-eval`, `ts.sql-raw-query`.
- `message` — one-sentence description of the vulnerability.
- `context.code_region` — `{ path, start_line, end_line, snippet }`.
- `severity` and `confidence`.

Open the file at `code_region.path` and read lines `start_line..=end_line` plus enough surrounding
context to understand the data flow. Do not try to fix from the snippet alone — the snippet is an
excerpt, not the full picture.

### 2. Prioritize by reachability (Pro only)

If the Pro plugin is loaded, call `selvedge.reachable()` on the finding's anchor to learn whether
the vulnerable code is reachable from an entrypoint. Prefer reachable findings. If reachability
is `Unknown` (the default in Free), treat it as reachable and fix in severity + confidence order:
critical → high → medium → low.

### 3. Learn from prior triage

Before proposing a fix, look for similar past decisions on the same rule:

```json
{
  "tool": "selvedge.list_findings",
  "arguments": {
    "scanner": "sast",
    "rule_id": "<same rule_id>",
    "triage_state": "dismissed"
  }
}
```

If the same rule was dismissed repeatedly with a consistent reason (e.g., "sanitized by
framework"), that pattern probably applies here too — but verify before dismissing again.

### 4. Propose a fix

Fix strategy in descending preference:

1. **Rule-level fix template.** Many rules carry a `fix_template` example in their metadata. Use it
   as a starting point.
2. **Codebase-idiomatic adaptation.** If the repo already uses a safe helper (for example
   a parameterized-query helper, a HTML-escape utility, a subprocess wrapper), adapt the fix to
   match existing style. Use `loom.search` or `loom.get_symbol` to find the local convention.
3. **Minimal correct fix.** If no local convention exists, apply the smallest change that closes
   the vulnerability. Do not refactor unrelated code.

### 5. Explain the change in the rule's language

When you present the fix to the user, frame the explanation around what the rule was checking for.
Example:

> The rule `py.dangerous-eval` flagged this because `eval()` executes arbitrary user input as
> Python. I replaced `eval(expr)` with `ast.literal_eval(expr)`, which only evaluates literals
> (strings, numbers, tuples, lists, dicts, sets, booleans, `None`). The original attack vector —
> injecting `__import__('os').system(...)` — is closed because `literal_eval` refuses anything
> that isn't a literal.

Do not explain the fix in isolation; connect it back to the rule's rationale so the user can
judge whether the fix is adequate.

### 6. Record a triage decision

Every finding ends at one of these states via `selvedge.triage`:

- **`fixed`** — the code was patched. Call `selvedge.triage` with `state: "fixed"` and a short
  reason summarizing the fix. Rerun `selvedge.scan_code` narrowed to the same path to confirm
  the finding no longer fires.
- **`dismissed`** — the finding is a false positive or the code is unreachable/sanitized. Set
  `state: "dismissed"` with a `reason` that explains why. Future scans will honor the
  dismissal on the same stable key.
- **`needs-review`** — you couldn't determine whether the finding is real. Set
  `state: "needs-review"` with a reason describing what you checked, so a human can finish
  the triage.
- **`accepted`** — the risk is acknowledged but left in place (e.g., a deliberate debug surface
  guarded elsewhere). Set `state: "accepted"` with a reason. Use sparingly.

Do not leave a finding in `open`. An un-triaged SAST finding is indistinguishable from a new one
on the next scan.

## Tool-call examples

### Triage a fix

```json
{
  "tool": "selvedge.triage",
  "arguments": {
    "finding_id": "01J9XKZW...",
    "state": "fixed",
    "reason": "Replaced raw string concatenation with parameterized query via sqlx::query!.",
    "actor": { "kind": "agent", "id": "claude-code" }
  }
}
```

### Dismiss a false positive

```json
{
  "tool": "selvedge.triage",
  "arguments": {
    "finding_id": "01J9XKZW...",
    "state": "dismissed",
    "reason": "String is a hard-coded table name from an enum, not user input.",
    "actor": { "kind": "agent", "id": "claude-code" }
  }
}
```

## Invariants

- Always read the actual file before proposing a fix. Snippets lie about context.
- Never dismiss without a reason. The reason is the audit trail for future scans.
- Never mark `fixed` without rerunning the scanner on the affected path to confirm the rule no
  longer fires.
- Do not refactor beyond the fix. If the file has broader issues, file them as separate findings
  (or skip them) rather than folding them into this change.
- When multiple findings live in the same function, address them together so the fix is coherent
  — but record one triage decision per finding.

## Companion tools

- `selvedge.scan_code` — run after a fix, narrowed to the file you changed, to confirm the rule
  stops firing.
- `selvedge.list_findings` — browse prior triage history on the same rule before deciding.
- `loom.get_symbol` / `loom.search` — pull surrounding code so the fix matches project style.

