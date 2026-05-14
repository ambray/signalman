---
name: signalman-apply-cloud-stack
description: Apply an OpenTofu HCL module as a Signalman cloud stack. Materialises the module into a workspace under .signalman/tofu-workspaces/<stack_name>/, runs tofu init+apply+output, and returns the parsed outputs + a change summary. Trigger on "apply the network stack", "stand up the test fixture from infra/<dir>", "run tofu apply on <module>". Refuses stack names that aren't safe filesystem identifiers. Recommended workflow: run `signalman-estimate-stack-cost` FIRST to see the projected monthly cost before applying. CLI parity: `signalman stack apply`.
allowed-tools: mcp__signalman__signalman_stack_apply, mcp__signalman__signalman_cloud_backends, mcp__signalman__signalman_stack_plan_cost, Bash
---

# Apply an OpenTofu stack

This skill drives `signalman_stack_apply`, the MCP entry point onto
the `TofuDriver.applyModule` API. The driver isolates each stack into
its own workspace, so two scenarios applying the same module under
different `stack_name` values get independent state.

OpenTofu must be installed on the host (`tofu` on PATH). If the binary
isn't found, the driver surfaces `tofu_not_found`.

## What you need from the user

- **`stack_name`** — a Signalman-stable identifier. Must match
  `^[a-z0-9][a-z0-9_-]{0,62}$` (lowercase alnum, optionally with `_`
  or `-`, max 63 chars, must start with alnum). Used as the
  workspace dir name, so the constraint is filesystem-safe.
- **`module_path`** — relative path under the project root pointing
  at a directory of `.tf` files. The driver symlinks (or copies on
  Windows) the HCL files into the workspace; `.terraform`,
  `.tofu`, and `terraform.tfstate*` are excluded so they can't
  leak across stacks.
- (Optional) **`vars`** — `Record<string, string>` passed via
  `-var key=value` to apply. Vendor-credential vars belong in
  environment / vendor SDK config, NOT here.
- (Optional) **`auto_approve`** — defaults to true (Signalman never
  prompts interactively; passing false will fail the apply because
  the driver pipes no stdin).

## How to invoke

```jsonc
// signalman_stack_apply
{
  "stack_name": "checkout-flow-net",
  "module_path": "infra/scenarios/checkout-flow/network",
  "vars": { "region": "us-east-1", "scenario_id": "abc123" }
}
```

## Expected response envelope

Success:

```jsonc
{
  "ok": true,
  "value": {
    "stackName": "checkout-flow-net",
    "workspacePath": "/path/to/.signalman/tofu-workspaces/checkout-flow-net",
    "changeSummary": { "add": 3, "change": 0, "destroy": 0 },
    "outputs": {
      "vpc_id": "vpc-0abc...",
      "subnet_ids": ["subnet-0...", "subnet-1..."]
    }
  }
}
```

The `outputs` object is your handoff to downstream steps — e.g. pass
`outputs.subnet_ids` into a subsequent `signalman_cloud_provision`
call's `network.subnet_id`.

Error envelope (`isError: true`):

```jsonc
{ "ok": false, "error": { "code": "tofu_failed", "message": "exit 1: Error: ..." } }
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `invalid_stack_name` | The stack name violated the regex. | Suggest a fix; e.g. lowercase, replace spaces with `-`. |
| `module_path_missing` | The directory at `module_path` doesn't exist or has no `.tf` files. | Operator must check the path / module contents. |
| `project_root_invalid` | The host's configured project root doesn't exist. | Host misconfiguration; operator must fix `TofuDriver`'s `projectRoot`. |
| `tofu_not_found` | `tofu` binary not on PATH. | Install OpenTofu (`brew install opentofu`, etc). |
| `tofu_failed` | `tofu init` or `tofu apply` exited non-zero. | Surface the stderr tail — it tells the user which resource failed. |
| `auth_failed` | Vendor credentials missing or rejected by the provider in the HCL. | Operator fixes env / IAM. |

## What NOT to do

- **Never** auto-retry on `tofu_failed`. The underlying HCL or vendor
  state needs operator inspection; a blind retry usually fails the
  same way and may leave partial state.
- **Never** apply a stack with `stack_name` that collides with an
  unrelated scenario. Workspaces are keyed by name; two applies
  under the same name share state. Use scenario-qualified names
  (`<scenario>-<purpose>`) by convention.
- **Never** put credentials in `vars`. The vendor providers in the
  HCL read from environment / IAM role / vendor SDK config; passing
  secrets as Tofu vars leaks them into state files and stderr logs.
- **Never** edit `.signalman/tofu-workspaces/<name>/` by hand. The
  driver re-materialises the workspace on each apply; manual edits
  get clobbered.

## Follow-up suggestions

- Pipe `outputs` into the next step (provision a VM into the new
  subnet, register the new DNS record, etc).
- When the scenario completes: `signalman_stack_destroy` with the
  same `stack_name`. Idempotent — destroying a never-applied stack
  returns `alreadyEmpty: true`.
- For ad-hoc inspection: `signalman_cloud_list` doesn't surface
  stack-managed VMs unless they were created via
  `signalman_cloud_provision`. Stack-created VMs live entirely in
  Tofu state.
