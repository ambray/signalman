---
name: signalman-edit-target
description: Edit an existing Signalman deploy target's name and/or connection. `kind` and `id` are intentionally NOT editable; for that, remove + re-add. Trigger when the user says "rename target <x>", "edit target", "update <target>'s connection", "change the VM name on target <x>", "the docker host moved", or any "target settings need updating" intent.
allowed-tools: mcp__signalman__signalman_target_edit
---

# Edit a Signalman deploy target

`signalman_target_edit` updates a registered target's `name` and/or
`connection` in place. The target's `id` and `kind` are NOT editable
— `kind` would invalidate the deploy-backend assumptions of past
deployments, and `id` is the primary key. For a kind change, the
operator path remains `signalman-register-target` (remove + re-add).

**Snapshot semantics**: past deployments reference the target by
`id` and are NOT retroactively updated. Health-check, rollback, and
new deploys against this target use the *current* (post-edit)
connection — which is the correct semantic ("the target lives here
now"). The audit log records `target.edited` with before/after detail
so historical context isn't lost.

## What you need from the user

- **`name`** — the current target name (the lookup key).
- At least one of:
  - **`new_name`** — rename the target. Must be unique among active
    targets in the same org.
  - **`connection`** — the new connection JSON. Replaces the existing
    object whole; not a partial patch.

Calling with neither field is rejected at the input boundary as an
operator mistake.

## How to invoke

```jsonc
// Rename only
{ "name": "win11-test", "new_name": "win11-test-1" }

// Update connection only
{
  "name": "win11-test-1",
  "connection": { "vmName": "Win11_test_v2", "backend": "hyperv" }
}

// Both at once
{
  "name": "old-name",
  "new_name": "new-name",
  "connection": { "vmName": "NewVM" }
}
```

## Expected response

The updated target row:

```jsonc
{
  "id": "01HX1234ABCD...",
  "orgId": "01HW...",
  "name": "win11-test-1",
  "kind": "vm_test",
  "connection": { "vmName": "Win11_test_v2", "backend": "hyperv" },
  "createdAt": "2026-05-14T...",
  "updatedAt": "2026-05-15T...",
  "deletedAt": null
}
```

## What NOT to do

- **Don't try to edit `kind`.** The MCP tool doesn't accept it; if the
  user wants to change a target from `vm_test` to `docker_test`, that's
  a different target shape. Use `signalman-register-target` (remove
  + re-add).
- **Don't pass a partial connection patch.** The `connection` field
  replaces the whole object. If the user says "just change the
  backend," you must fetch the current target (`signalman_target_list`
  or `signalman_target_show` if it exists), merge the change, and
  send the merged object.
- **Don't silently rewrite past deployments.** They reference this
  target by id and intentionally keep their original snapshot in the
  ledger. Edits affect future operations only.
- **Don't edit a target the user is mid-deploying-to.** A deploy
  in flight that hasn't yet read the connection will pick up the
  new value; a deploy that already has the old connection cached will
  keep running. Surface this risk before editing during an active
  deploy window.

## Follow-up suggestions

- After a rename: `signalman_target_list` to confirm the new name is
  resolvable and the old name no longer is.
- After a connection edit: `signalman_health_check` to confirm the
  new connection still reaches the target. A bad connection edit
  surfaces as `TargetUnreachableError` on the next deploy or check.
- For an `audit` of when this target's connection changed: look at
  the `target.edited` entries in `signalman_audit_query` (P2 gap,
  closed in milestone 5). Until then, the entries are in HTTP
  `GET /v1/audit?entity_type=target`.
