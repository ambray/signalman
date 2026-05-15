---
name: signalman-deregister-runner
description: Deregister a Signalman build runner by name or id. Soft-deletes the row; a worker that heartbeats again under the same name will resurrect the row with a fresh registered_at. Trigger when the user says "deregister <name>", "remove the dead runner", "retire builder-mac-01", "clean up stale runners", "this runner is gone", or any "stop tracking this worker" intent.
allowed-tools: mcp__signalman__signalman_runner_deregister
---

# Deregister a build runner

`signalman_runner_deregister` soft-deletes a registered runner row.
The row is preserved in the database for audit history; only the
"active" view in `signalman runner list` and the heartbeat upsert
treat it as gone.

**This is reversible by re-registering.** If the worker process
restarts and heartbeats again under the same name, the row is
resurrected with a fresh `registered_at`. Use deregister when the
worker is *intentionally* retired (decommissioned, rotated out),
not as a way to "fix" a stale runner that might come back.

## What you need from the user

Exactly one of:

- **`name`** — runner name. Preferred for operator-readable use
  ("deregister builder-mac-01").
- **`id`** — runner ULID. Preferred for automation that's already
  carrying the row.

Passing both or neither is an operator mistake; the verb requires one
or the other.

## How to invoke

```jsonc
// By name (most common)
{ "name": "builder-mac-01" }

// By id (automation path)
{ "id": "01HX1234ABCD..." }
```

## Expected response

```jsonc
{
  "deregistered": {
    "id": "01HX1234ABCD...",
    "name": "builder-mac-01"
  }
}
```

## What NOT to do

- **Don't deregister a fresh runner.** "Fresh" = `is_stale: false`
  on the most recent `signalman_runner_list` call. A fresh runner
  is actively polling the queue; deregistering it stops the next
  heartbeat's upsert from finding the row but doesn't actually stop
  the worker process. The worker will resurrect the row on the next
  heartbeat. If the operator wants the worker to stop entirely, the
  right path is `SIGINT` to the `signalman runner start` process,
  not a deregister.
- **Don't loop deregister + heartbeat.** That's the resurrection
  path. If the operator says "the row keeps coming back," tell them
  to stop the worker process first.
- **Don't deregister all stale runners as a batch operation.** Each
  decision is operator-owned. Some stale workers will come back
  (laptop closed for the night, network blip); deregistering them
  prematurely just adds noise to the audit log when they resurrect.
- **Don't conflate deregister with "delete from history."** Deregister
  preserves the row in `deleted_at IS NOT NULL` state for audit.
  There is no hard-delete; the row stays forever.

## Follow-up suggestions

- After deregister: `signalman_runner_list` to confirm the row no
  longer appears in the active list.
- If the runner was the only worker against this control plane, tell
  the operator their builds will queue until they register another
  worker. Point at `signalman-register-runner`.
- For audit: the `runner.deregistered` event lands in the audit log.
  Surface it via `signalman_audit_query` (P2 gap, closed in milestone
  5; HTTP `GET /v1/audit?entity_type=runner` until then).
