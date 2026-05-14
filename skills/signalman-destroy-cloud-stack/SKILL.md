---
name: signalman-destroy-cloud-stack
description: Destroy a previously-applied OpenTofu stack. Runs tofu destroy in the workspace under .signalman/tofu-workspaces/<stack_name>/, then returns. Idempotent — destroying a never-applied stack returns alreadyEmpty: true. Trigger on "tear down the network stack", "destroy <stack_name>", "clean up the scenario fixture".
allowed-tools: mcp__signalman__signalman_stack_destroy
---

# Destroy an OpenTofu stack

This skill drives `signalman_stack_destroy`, the MCP entry point onto
`TofuDriver.destroyModule`. The destroy path is idempotent: if the
workspace directory doesn't exist (because the stack was never
applied), the driver returns success with `alreadyEmpty: true`
instead of an error. This matches the cloud-VM terminate contract
and is what makes scenario teardown robust against partial-apply
failures.

## What you need from the user

- **`stack_name`** — the same identifier used in
  `signalman_stack_apply`. Must match the validated regex
  `^[a-z0-9][a-z0-9_-]{0,62}$`.
- (Optional) **`vars`** — same shape as apply. Usually unnecessary,
  but providers that require credentials at destroy time still need
  the same env / SDK config the apply used.
- (Optional) **`auto_approve`** — defaults to true.

## How to invoke

```jsonc
// signalman_stack_destroy
{
  "stack_name": "checkout-flow-net"
}
```

## Expected response envelope

Normal destroy after a prior apply:

```jsonc
{
  "ok": true,
  "value": {
    "stackName": "checkout-flow-net",
    "alreadyEmpty": false,
    "changeSummary": { "add": 0, "change": 0, "destroy": 3 }
  }
}
```

Idempotent no-op (workspace didn't exist):

```jsonc
{
  "ok": true,
  "value": { "stackName": "checkout-flow-net", "alreadyEmpty": true }
}
```

Either case is success. The `alreadyEmpty` flag is informational —
scenarios that always destroy on teardown will sometimes hit it
when a prior step short-circuited.

Error envelope (`isError: true`):

```jsonc
{ "ok": false, "error": { "code": "tofu_failed", "message": "exit 1: ..." } }
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `invalid_stack_name` | The stack name violated the regex. | Same fix as apply: lowercase, replace spaces, etc. |
| `tofu_not_found` | `tofu` binary not on PATH. | Install OpenTofu. |
| `tofu_failed` | `tofu destroy` exited non-zero. Some resource refused to delete. | Surface the stderr tail; operator must inspect (e.g. a vendor resource has deletion protection on). |
| `auth_failed` | Vendor credentials missing or rejected. | Operator fixes env / IAM. |

## What NOT to do

- **Never** delete `.signalman/tofu-workspaces/<name>/` by hand to
  "force" a destroy. That leaves the vendor resources orphaned with
  no state file to track them. The OpenTofu state inside the
  workspace is how the driver knows what to remove.
- **Never** auto-retry on `tofu_failed` without surfacing the cause.
  A common failure is "resource has dependents" — the operator
  needs to destroy a downstream stack first, not re-run this one.
- **Never** destroy a stack the operator didn't name. Stack teardown
  is cascading: destroying a `network` stack with downstream VMs
  pointing at its subnets will break them. The operator is
  responsible for the ordering.

## Follow-up suggestions

- After a successful destroy: the workspace directory remains on
  disk (with empty state). It's safe to leave; a future apply will
  re-materialise the HCL files over it.
- If the destroy returned `alreadyEmpty: true` and the operator
  insists a vendor resource still exists, check whether it was
  created outside this stack (e.g. via `signalman_cloud_provision`,
  or by a different stack name). The reaper handles past-TTL VMs;
  stale stack-managed resources need their owning stack identified.
