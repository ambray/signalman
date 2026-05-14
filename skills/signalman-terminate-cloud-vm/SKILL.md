---
name: signalman-terminate-cloud-vm
description: Terminate an ephemeral cloud VM previously provisioned by Signalman. Idempotent — terminating an already-terminated handle returns success, not an error. Trigger on "kill that EC2 box", "tear down the Azure VM", "destroy <handle>", or any "clean up the test VM" variant. Refuses untagged instances (only Signalman-managed handles can be terminated through this path).
allowed-tools: mcp__signalman__signalman_cloud_terminate, mcp__signalman__signalman_cloud_status
---

# Terminate an ephemeral cloud VM

This skill drives `signalman_cloud_terminate`, the MCP entry point onto
`CloudBackend.terminateInstance`. The call is idempotent by contract:
terminating a stale or already-terminated handle returns success.
This is intentional — the cost-reaper depends on it so repeat sweeps
don't error on race-deletions.

## What you need from the user

The full handle returned by `signalman_cloud_provision`:

- `provider` — `aws` or `azure`
- `id` — vendor instance id (`i-0abc...`, Azure resource id, ...)
- `name` — friendly name the VM was provisioned under
- `region` — provider-specific region

If the user only knows the friendly name, list instances via
`signalman_cloud_list` filtered by tag and pick the matching handle
before calling terminate.

## How to invoke

```jsonc
// signalman_cloud_terminate
{
  "provider": "aws",
  "id": "i-0abc1234def567890",
  "name": "scenario-checkout-flow",
  "region": "us-east-1"
}
```

## Expected response envelope

Success (including the idempotent case):

```jsonc
{ "ok": true, "value": null }
```

Error envelope (`isError: true`):

```jsonc
{ "ok": false, "error": { "code": "terminate_failed", "message": "..." } }
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `terminate_failed` | Vendor rejected the terminate call (not the same as "already gone"). Usually a permissions or vendor-side state error. | Surface the message; the operator must investigate. |
| `auth_failed` | Vendor credentials missing or rejected. | Operator fixes env / IAM. |
| `unsupported_provider` | The provider isn't registered on this host. | Use `signalman_cloud_backends` to verify wiring. |

Note: `instance_not_found` is **not** an error here by design — the
backend swallows it as a successful idempotent terminate.

## What NOT to do

- **Never** call terminate in a tight loop "to make sure". The
  contract guarantees idempotency; spamming the vendor is wasteful.
- **Never** terminate a handle the user didn't authorise just because
  it appeared in `signalman_cloud_list`. The cost-reaper is the
  designated automation for past-TTL cleanup; an interactive agent
  should only terminate what the operator named.
- **Never** retry on `terminate_failed` without surfacing the cause —
  it usually indicates a permissions drift or a vendor-side state
  the operator should know about.

## Follow-up suggestions

- After success, optionally call `signalman_cloud_status` once with
  the handle — you should see `state: "terminated"` (or `"unknown"`
  if the vendor garbage-collected the record).
- If the operator is tearing down a whole scenario, also consider
  whether any HCL stacks were applied — those need
  `signalman_stack_destroy`, not VM terminate.
