---
name: signalman-deploy-to-test
description: Deploy a built signalman release to a test-tier target VM. Stages every artifact, takes a pre-deploy checkpoint, runs declared health probes, promotes on pass and restores on fail. Trigger when the user says "deploy <release> to test", "push to win11-test", "test the latest build of <product>".
allowed-tools: Bash
---

# Deploy a release to a test VM

The test surface is the **disposable** half of the two-tier deploy model (per the operator's release operating model). Aggressive iteration here is fine — checkpoint/revert/disrupt freely. The clean demo surface is a separate skill (`signalman-deploy-to-demo`).

## What you need from the user

- **Release identity** — either:
  - an explicit release id (`signalman release list` to find one), OR
  - product name + tag (the most recent build at that tag).
- **Target name** — must already exist with `kind: vm_test`. Check with `signalman target list`. If it's missing, ask the user how they want it created (`signalman target add --name <NAME> --kind vm_test --vm-name <HYPERV_VM_NAME>`).

## How to invoke

```bash
# By release id:
signalman release deploy --release <ID> --target <TEST_TARGET> --format json

# Or by product + tag:
signalman release deploy --product <NAME> --tag <TAG> --target <TEST_TARGET> --format json
```

Stderr streams checkpoint creation, blob copies, the in-VM manifest, and health-probe results.

## Expected stdout on success

```json
{
  "deployment": { "id": "...", "status": "active", ... },
  "release_id": "...",
  "target_id": "...",
  "health": { "total": N, "pass": N, "fail": 0, "degraded": 0, ... }
}
```

## Exit codes and failure modes

| Exit | Meaning | What to say |
|------|---------|-------------|
| 0 | Deployment is active, all probes passed. | Surface the deployment id + probe pass count. |
| 2 | `DeployHealthFailedError` or `DeployBlockedError`. The pre-deploy checkpoint was restored automatically — the VM is back to where it started, the new deployment row is `failed`. | Surface which probe(s) failed (from `signalman health history --target <NAME>`). |
| 4 | Infra error (couldn't reach the VM, copy failed, etc.). | Surface the message; the operator may need to start the VM or fix mTLS. |

## What NOT to do

- Don't deploy to a `vm_demo` target with this skill — that's the demo skill's job. Refuse and point the user at `/signalman-deploy-to-demo`.
- Don't run the deploy if the release's `status` isn't `ready` (the executor will refuse with `DeployBlockedError` — surface that).
- Don't pre-clean or pre-checkpoint manually — the executor owns staging.

## Follow-up suggestions

- `signalman health check --target <NAME>` — re-run the probes on demand.
- `signalman release rollback --target <NAME>` — undo this deploy (redeploys the previous active release).
