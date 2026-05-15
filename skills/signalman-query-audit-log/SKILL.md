---
name: signalman-query-audit-log
description: 'Query and append entries to the Signalman audit log. The log is immutable, append-only — no update or delete. Trigger on "what happened to deployment X", "show audit log for target Y", "who deployed v1.2.3", "record a manual restart in audit", "audit entries since yesterday". Use for forensic / postmortem / compliance reviews and for operators to log out-of-band gestures alongside the executor-driven appends. CLI parity: `signalman audit query|append`.'
allowed-tools: mcp__signalman__signalman_audit_query, mcp__signalman__signalman_audit_append
---

# Query + append Signalman audit-log entries

The Signalman audit log is an immutable, append-only timeline of
state-changing events for the active org. Executors (build, deploy,
target edit, runner deregister, promotion approve/reject) auto-emit
entries; operators can append additional entries to document
out-of-band gestures (incident response, manual interventions,
postmortem decisions). This skill covers both verbs.

## When to use which verb

| Verb | Purpose |
|---|---|
| `signalman_audit_query` | Forensics: "what happened to X", "who did Y", "show recent activity". Read-only. |
| `signalman_audit_append` | Record an operator-driven action that the auto-emit path doesn't already cover. Write-only. |

The log being immutable matters: there is no `audit_delete` or
`audit_edit`. If a typo lands, it stays; recommend the operator append
a corrective entry rather than asking for an edit.

## What you need from the user

### For `signalman_audit_query`

All filters are optional and AND-combined. With no filters you get
the full log for the active org (cap at 1000).

- (Optional) **`entity_type`** — narrow by kind: `target`, `release`,
  `deployment`, `runner`, `promotion`, `webhook`, etc.
- (Optional) **`entity_id`** — narrow by the specific ULID or name.
  Often paired with `entity_type`.
- (Optional) **`actor`** — `cli`, `ci`, `scheduler`, or an operator
  identifier.
- (Optional) **`action`** — exact match: `target.edited`,
  `release.deploy`, `runner.deregistered`, etc.
- (Optional) **`since`** — ISO-8601 lower bound on `created_at`. Drops
  older entries. Useful for "what happened since the incident at
  14:22Z."
- (Optional) **`limit`** — 1-1000. Default unbounded.

### For `signalman_audit_append`

All four entity fields are **required** and non-empty:

- **`actor`** — who did this. By convention: `cli`, `ci`,
  `scheduler`, or a human identifier (`operator:alice`).
- **`action`** — what was done. Use dotted lowercase: `incident.restart`,
  `manual.intervention`, `postmortem.decision`.
- **`entity_type`** — kind being acted on.
- **`entity_id`** — the entity's ULID or canonical name.
- (Optional) **`detail`** — free-form JSON object. Stored verbatim;
  no schema enforced. Good for "reason", "ticket id", "alert link".

## How to invoke

### Query

```jsonc
// Everything since the incident timestamp
{ "since": "2026-05-15T14:22:00Z" }

// All events touching a specific target
{ "entity_type": "target", "entity_id": "win11-test" }

// Who deployed releases via CI today?
{ "action": "release.deploy", "actor": "ci", "since": "2026-05-15T00:00:00Z" }

// Most recent 50 entries, any kind
{ "limit": 50 }
```

### Append

```jsonc
{
  "actor": "operator:alice",
  "action": "incident.restart",
  "entity_type": "target",
  "entity_id": "win11-test",
  "detail": { "reason": "VM stuck post-deploy", "ticket": "INC-4271" }
}
```

## Expected response

### Query

```jsonc
{
  "entries": [
    {
      "id": "01HX...",
      "org_id": "default",
      "actor": "cli",
      "action": "target.edited",
      "entity_type": "target",
      "entity_id": "win11-test",
      "detail": { "before": { ... }, "after": { ... } },
      "at": "2026-05-15T14:25:00Z",
      "created_at": "2026-05-15T14:25:00.123Z"
    }
  ]
}
```

Entries are returned newest-first. Empty array means no entries match
— not an error.

### Append

```jsonc
{
  "entry": {
    "id": "01HX...",
    "org_id": "default",
    "actor": "operator:alice",
    "action": "incident.restart",
    "entity_type": "target",
    "entity_id": "win11-test",
    "detail": { "reason": "VM stuck post-deploy" },
    "at": "2026-05-15T14:30:00Z",
    "created_at": "2026-05-15T14:30:00.456Z"
  }
}
```

The `id` is the canonical reference for the new entry — surface it to
the user in case they want to reference it later.

## Common queries by intent

| Intent | Query |
|---|---|
| "What changed on deployment X recently?" | `{ "entity_type": "deployment", "entity_id": "<id>" }` |
| "Who's pushed to prod today?" | `{ "action": "release.deploy", "since": "<today 00:00Z>" }` |
| "Show all CI-driven activity" | `{ "actor": "ci" }` |
| "Did anyone touch target Y?" | `{ "entity_type": "target", "entity_id": "Y" }` |
| "Audit trail for last hour" | `{ "since": "<now - 1h>", "limit": 200 }` |

## What NOT to do

- **Never** advertise the log as editable. It's not. If the user
  asks to "fix" an entry, explain the immutability and offer to
  append a correction entry instead.
- **Never** loop `audit_query` to "watch" for events. The log is a
  forensic surface, not an event bus. If real-time visibility is the
  ask, point at the recording / events subsystem instead.
- **Never** spam `audit_append` to make the log "look busy". Each
  entry should map to a real operator gesture. Bot-spam degrades the
  forensic value of the log.
- **Never** assume omitted filters mean "nothing happened." A query
  with `actor: "ci"` returning empty just means no CI actor matched
  — manual operator activity won't surface. Broaden the query before
  drawing conclusions.

## Follow-up suggestions

- After a forensic query, if the entries point at a specific target,
  consider `signalman_health_history` for the runtime view to pair
  with the audit view.
- For incident response: append a `incident.start` entry at the
  start, an `incident.resolve` at the end, both with the same
  `entity_id` — operators can later reconstruct the incident window
  by querying that `entity_id`.
- If an append fails with "actor must be non-empty" (or similar),
  the verb is enforcing non-empty fields. Re-prompt for the missing
  value; don't auto-substitute a placeholder.
