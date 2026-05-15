---
name: selvedge-sast-fix
description: Drive a Selvedge SAST finding to a triaged resolution. Read rule + code region, propose a codebase-idiomatic fix, explain it in the rule's language, then record state via selvedge.triage (fixed / dismissed / needs-review / accepted).
allowed-tools: [selvedge.scan_code, selvedge.list_findings, selvedge.triage, Read, Grep, Glob, Edit]
---

# SAST fix

Every SAST finding needs a triage state recorded before you move on. An `open` finding looks
identical to a new one on the next scan.

## Six-step loop

1. **Read the rule and the code region.** Use `Read` on `context.code_region.path` over
   `start_line..=end_line` plus surrounding context. Don't fix from the snippet alone.
2. **Prioritize by reachability.** If the Pro plugin is loaded, call `selvedge.reachable()` on
   the anchor. Otherwise treat `Unknown` reachability as reachable and fix in severity +
   confidence order: critical → high → medium → low.
3. **Learn from prior triage.** Call `selvedge.list_findings` with the same `rule_id` and
   `triage_state: "dismissed"` to see how similar findings were resolved. A consistent past
   dismissal reason may apply — verify before reusing.
4. **Propose a fix.** Priority: rule fix template → codebase-idiomatic adaptation (use `Grep` /
   `Glob` to find the local helper) → minimal correct fix. Do not refactor unrelated code.
5. **Explain the fix in the rule's language.** Connect the change back to what the rule was
   checking for. Example: "`py.dangerous-eval` flagged this because `eval()` runs user input
   as code. I switched to `ast.literal_eval`, which only accepts literals — closing the
   `__import__('os').system(...)` injection path."
6. **Record a triage state via `selvedge.triage`.** Every finding ends at `fixed`,
   `dismissed`, `needs-review`, or `accepted` — never left at `open`.

## Triage state guide

| state | when to use | required |
|---|---|---|
| `fixed` | code was patched and rerunning the scanner on the same path shows no hit | short reason describing the fix |
| `dismissed` | false positive or sanitized/unreachable in context | reason explaining why |
| `needs-review` | you can't determine if the finding is real | reason summarizing what you checked |
| `accepted` | risk acknowledged but left in place — use sparingly | reason |

## Tool-call shape

```json
{
  "tool": "selvedge.triage",
  "arguments": {
    "finding_id": "01J9XKZW...",
    "state": "fixed",
    "reason": "Replaced raw string concatenation with parameterized sqlx::query!.",
    "actor": { "kind": "agent", "id": "claude-code" }
  }
}
```

## Invariants

- Always read the actual file before proposing a fix — snippets lose context.
- Never dismiss without a `reason`; the reason is the audit trail.
- Never mark `fixed` without rerunning `selvedge.scan_code` narrowed to the affected path to
  confirm the rule stops firing.
- Do not refactor beyond the fix. Other issues → separate findings.
- One triage decision per finding. When multiple findings share a function, fix them together
  but triage each.

## Companion tools

- `selvedge.scan_code` — rerun with `paths: [<fixed file>]` to confirm the rule no longer fires.
- `selvedge.list_findings` — browse prior triage history before deciding.
