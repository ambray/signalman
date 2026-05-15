---
name: signalman-cloud-status
description: Get the current state of a Signalman-managed cloud VM by handle — returns state (pending / running / stopped / terminated / unknown), IPs when running, and a reason string when state is unknown. Trigger when the user says "is the VM up", "what state is <handle>", "check on the EC2 box", "is my Azure VM running", "is the cloud VM ready", or any "what's happening with that VM" intent.
allowed-tools: mcp__signalman__signalman_cloud_status
---

# Get cloud VM state

`signalman_cloud_status` is the inspection verb for a previously
provisioned cloud VM. It maps to `CloudBackend.getInstanceStatus` and
is the right tool for "is this VM up yet" without paying the cost of
a re-provision.

## What you need from the user

All four fields are required — `signalman_cloud_status` is keyed off
the full handle returned by `signalman_cloud_provision`:

- **`provider`** — `aws` or `azure`.
- **`id`** — vendor instance id (`i-abc123…` for AWS, an ARM resource
  id for Azure).
- **`name`** — friendly name the VM was provisioned with.
- **`region`** — provider region (`us-east-1`, `eastus`, …).

If the user only has a partial handle, they should pull the full
handle from the earlier `provision` response — the cost-reaper does
not track partial handles. (`signalman_cloud_list` can re-discover
the full handle if the user lost it.)

## How to invoke

```jsonc
// signalman_cloud_status
{
  "provider": "aws",
  "id": "i-0abc1234567890abc",
  "name": "scenario-checkout-flow",
  "region": "us-east-1"
}
```

## Expected response

Success envelope (`ok: true`):

```jsonc
{
  "ok": true,
  "value": {
    "state": "running",
    "publicIp": "203.0.113.42",
    "privateIp": "10.0.1.17",
    "reason": null
  }
}
```

State enum:

| `state` | What it means | What to surface |
|---|---|---|
| `pending` | The vendor accepted the create but the VM isn't ready yet. | "Still starting — try again in 30s." |
| `running` | Booted, the IPs in `publicIp` / `privateIp` are valid. | The IPs the user is waiting on. |
| `stopped` | Powered off but not terminated. Costs less than running; can be restarted. | Tell the user the VM is paused, not gone. |
| `terminated` | The vendor has the row in its trash. May still be billing for the EBS root volume on AWS for a few minutes; gone within Azure's normal delete delay. | "Already gone — `signalman_cloud_provision` to remint." |
| `unknown` | The vendor returned a state we don't recognize, or the API errored mid-poll. | Surface the `reason` field verbatim; the operator decides. |

## Errors you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `unsupported_provider` | Backend not registered on this host. | List registered backends via `signalman_cloud_backends`. |
| `auth_failed` | Vendor credentials missing or rejected. | Surface verbatim; operator must fix env / IAM. |
| `not_found` | Vendor reports no such instance. Two causes: (1) the handle is stale (terminated long enough ago that the row was reaped from the vendor's history), (2) the handle is from a different account/region than the host's current credentials. | Surface both possibilities; ask the user to confirm the credentials they're scoped to. |

## What NOT to do

- **Don't poll in a tight loop.** Cloud APIs rate-limit and Signalman
  does not currently expose a long-poll variant. If the user is
  waiting for `pending → running`, ask them to wait 30 seconds
  between checks. (A `wait_for_running` helper is on the P3 follow-up
  list — not shipped today.)
- **Don't terminate from this skill** even if the VM is in an
  unexpected state. `signalman-terminate-cloud-vm` is the destructive
  verb; status is read-only.
- **Don't synthesise an SSH command from the IP** for the user.
  Surface the IP; let the operator pick their own SSH key / user /
  port. Signalman doesn't provision SSH keys on cloud VMs by default.
- **Don't assume `terminated` means the bill has stopped.** AWS keeps
  root EBS volumes around briefly. If the user is asking about cost,
  point them at the vendor's billing console, not the Signalman
  status response.

## Follow-up suggestions

- `running`: hand the IPs to whatever scenario-runner step needs them
  (`signalman-run-scenario` with parameters referencing the IPs).
- `stopped`: surface the cost trade-off (cheaper than running, but
  the cost-reaper TTL doesn't pause on a stopped instance —
  `terminate` is what stops the bill).
- `pending` for more than 5 minutes is unusual on AWS / Azure for
  standard SKUs — suggest the user check the vendor console for
  capacity issues.
- `terminated` or `not_found`: `signalman-provision-cloud-vm` to mint
  a fresh one.
