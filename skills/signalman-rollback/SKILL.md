---
name: signalman-rollback
description: Roll back a signalman target by redeploying its previous-active release. Triggers on "roll back <target>", "undo the last deploy", "revert <target> to the previous version". For an explicit older release, takes `--to-release`.
allowed-tools: Bash
---

# Roll back a target

Rollback in the signalman model is **redeploying the previous release**, not "undoing" the current deploy. This keeps the model uniform — every state the system can reach is reachable via a deploy. The deploy executor's pre-deploy checkpoint handles failure-during-deploy automatically; rollback is for the post-deploy "this deploy succeeded but is bad" case.

## What you need from the user

- **Target name** — `signalman target list`.
- **Optionally:** a specific older release id to roll back to (default is the most recent superseded deployment on this target).

## How to invoke

```bash
# Roll back to the previous superseded release:
signalman release rollback --target <NAME> --format json

# Roll back to a specific older release:
signalman release rollback --target <NAME> --to-release <RELEASE_ID> --format json
```

## Prerequisites

The target must have at least one **superseded** deployment in its history. `signalman health history --target <NAME>` shows the history. If the only deployment ever was the current active one, rollback has nothing to land on — surface that as a `DeployBlockedError`.

## Expected stdout on success

```json
{
  "deployment": { "id": "...", "status": "active", ... },
  "release_id": "<previous_release>",
  "target_id": "...",
  "health": { "total": N, "pass": N, "fail": 0, ... }
}
```

The previously-active deployment is now `superseded`; the redeploy of the older release is now `active`.

## Exit codes and failure modes

Same as `release deploy`:

- 0 success
- 2 `DeployBlockedError` (no superseded history) or `DeployHealthFailedError` (probes failed during the rollback's redeploy — VM was restored from the rollback's pre-deploy checkpoint, so the *previously-failing* active deployment is **still active**; nothing changed). Surface this clearly to the user — rollback failed and they're still on the bad release.
- 4 infra error.

## What NOT to do

- Never delete the current active deployment row manually to "make rollback work" — that violates the catalog invariant.
- Don't run rollback to "fix" a failed deploy. A failed deploy already restored the checkpoint; the previous active release is already running. There's nothing to roll back from.
- Don't roll back across major version boundaries without operator confirmation — surface the version difference and ask.
