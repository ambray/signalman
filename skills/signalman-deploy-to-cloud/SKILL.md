---
name: signalman-deploy-to-cloud
description: 'Deploy a Signalman release to a cloud target — either an already-provisioned cloud VM (cloud_vm) or an OpenTofu stack (cloud_stack). cloud_vm runs a reachability probe at the guest agent port; cloud_stack re-applies the HCL module with per-release vars (release_tag, release_id, release_commit_sha + optional image_var_name override). Trigger when the user says "deploy v1.2.3 to the AWS box", "ship the release to the cloud stack", "promote to cloud target X", "re-apply the cloud stack with the new tag", or asks about cloud-routed releases. CLI parity: `signalman release deploy --target <cloud-target>`. Requires the target to already exist via signalman_target_add with kind=cloud_vm or kind=cloud_stack.'
allowed-tools: mcp__signalman__signalman_release_deploy, mcp__signalman__signalman_target_add, mcp__signalman__signalman_target_list, mcp__signalman__signalman_cloud_provision, mcp__signalman__signalman_release_show, Bash
---

# Deploy a release to a cloud target

WS6 M8 introduced two new target kinds for cloud-routed deploys:

| Kind | What it pins | Deploy semantic |
|---|---|---|
| `cloud_vm` | A specific `CloudInstanceHandle` ({ provider, region, instance_id, name, network_mode? }) | Resolve public IP via the cloud backend, run a TCP reachability probe at the guest agent port (default 443), record the Deployment row. |
| `cloud_stack` | An OpenTofu stack ({ stack_name, module_path, image_var_name?, extra_vars? }) | Invoke `tofu apply` with per-release vars (`release_tag`, `release_id`, `release_commit_sha` + optional `<image_var_name>=<release.tag>`), record the Deployment row with the apply outcome. |

Both share the same Deployment row lifecycle (audit-log start, run the
kind-specific operation, record health-check, finalise). Failures
mark the deployment as `failed` with the cause in the audit log.

## When to use which

- **`cloud_vm`** — you already provisioned a VM (via
  `signalman_cloud_provision` or by hand) and you want Signalman to
  consider it the "test/demo/prod" environment for a product.
  Reachability-only deploy semantic: the VM is assumed to either
  auto-pull the release artifact (via cloud-init / userdata / a
  separate runner) or for the operator to script a post-deploy step.
- **`cloud_stack`** — you have an OpenTofu / Terraform module that
  describes the full environment (VMs + load balancers + DNS + …)
  and you want each release to re-apply that module with the new
  release tag wired into the template (typically as an AMI / image
  SKU pin). Signalman owns the apply lifecycle; the HCL owns the
  shape.

## What you need from the user

### For `cloud_vm`

A target row with `kind: "cloud_vm"` and these connection fields:

```jsonc
// signalman_target_add
{
  "name": "scenario-checkout-staging",
  "kind": "cloud_vm",
  "connection": {
    "provider": "aws",          // or "azure"
    "region": "us-east-1",
    "instance_id": "i-0abc1234567890",
    "name": "scenario-checkout-staging-ec2",
    "network_mode": "public_mtls",   // optional; default is public_mtls
    "guest_agent_port": 443           // optional; default 443
  }
}
```

`network_mode` accepts `public_mtls` / `aws_ssm` / `azure_bastion`,
but only `public_mtls` is dialable today — `aws_ssm` and
`azure_bastion` raise a clear error pointing at the v0.3.x deferred
tunneling-driver work. If the operator's VM is in SSM/Bastion mode,
either re-provision in `public_mtls` mode OR wait for the tunneling
drivers to ship.

### For `cloud_stack`

A target row with `kind: "cloud_stack"` and these connection fields:

```jsonc
// signalman_target_add
{
  "name": "demo-stack",
  "kind": "cloud_stack",
  "connection": {
    "stack_name": "checkout-demo",
    "module_path": "/abs/path/to/hcl/module",
    "image_var_name": "ami_id",  // optional; if set, gets release.tag
    "extra_vars": {              // optional; merged with release_* vars
      "instance_type": "t3.medium",
      "region": "us-east-1"
    }
  }
}
```

## Deploy

Both kinds use the standard `signalman_release_deploy` MCP tool / CLI
verb — the dispatcher routes to the cloud adapter based on
`target.kind`:

```jsonc
// MCP
{
  "release_id": "01HX...",       // or product_name + tag
  "target_name": "demo-stack"
}
```

```bash
signalman release deploy --release <id> --target demo-stack
# or
signalman release deploy --product checkout --tag v1.2.3 --target demo-stack
```

## How the deploy looks

### cloud_vm

1. Validate the connection JSON (provider, region, instance_id, name).
2. Reject `aws_ssm` / `azure_bastion` early (no Deployment row created).
3. Create Deployment row in `pending` status; audit `release.deploy.started`.
4. Move to `deploying`.
5. Resolve the cloud backend; call `getInstanceIp(handle)` (no IP → fail).
6. TCP-connect to `<ip>:<guest_agent_port>` with 5s timeout.
7. Record `cloud_vm_reachable` health check (pass or fail).
8. On fail: mark deployment `failed`, audit `release.deploy.failed`, rethrow.
9. On pass: supersede prior active deployment (if any), mark `active`,
   audit `release.deploy.completed` with `{ip, port}` in detail.

### cloud_stack

1. Validate connection JSON (stack_name, module_path).
2. Create Deployment row; audit `release.deploy.started` with stack info.
3. Compose vars: `release_tag`, `release_id`, `release_commit_sha` always;
   `<image_var_name>=<release.tag>` if set; merged with `extra_vars`.
4. Call `TofuDriver.applyModule({ stackName, modulePath, vars })`.
5. On throw: record `stack_apply=fail` health check, mark deployment
   `failed`, audit `release.deploy.failed` with error, rethrow.
6. On success: record `stack_apply=pass` with add/change/destroy
   summary; mark `active`; audit `release.deploy.completed` with
   stack outputs.

## Rollback

`signalman release rollback` for cloud targets is **not yet supported**.
The two kinds have different rollback shapes:

- `cloud_vm` would need the same reachability + re-install dance as
  deploy, against the prior release's artifact — that's not modelled
  yet because the install path itself is operator-driven for cloud_vm.
- `cloud_stack` would mean re-applying with the prior release's vars,
  which is functionally identical to `release deploy --release <prior>`.

Today, redeploy the prior release explicitly:

```bash
signalman release deploy --release <prior-release-id> --target <cloud-target>
```

The CLI / MCP returns a clear error pointing at this workflow.

## What NOT to do

- **Never** create a `cloud_vm` target with `network_mode: aws_ssm`
  expecting it to work — the dialer side of SSM is v0.3.x.
- **Never** assume `cloud_vm` deploys the release artifact onto the VM.
  Today it's a reachability check + Deployment row. The actual install
  is operator-driven (cloud-init / userdata / post-deploy webhook /
  separate runner). A future milestone wires install-bundle through.
- **Never** target a `cloud_stack` at an HCL module that's not
  idempotent under re-apply. Each release deploy re-applies; if the
  template recreates a stateful resource on every apply, you'll
  destroy state every release.
- **Never** put secrets in `extra_vars` — they're stored in
  `target.connection` JSON and logged into audit-log details. Use
  TF's own secret management (data sources, tfvars files outside
  Signalman) for credentials.

## Follow-up suggestions

- After a successful cloud_vm deploy, pair with
  `signalman_schedule_add` (the schedule-health skill) to keep
  recurring reachability probes flowing — they pair with the WS6 M7
  promotion health gate.
- For cloud_stack: inspect `signalman_release_show <release_id>` —
  the deployment row's audit detail includes the stack outputs,
  useful for "what URL did this stack land at?"
- If you're moving from a `vm_test` / `vm_demo` target to a cloud
  equivalent, do NOT edit the target's kind (kinds are immutable by
  design). Create a new target with `kind: cloud_vm` or
  `cloud_stack`, point promotion policies at the new target, and
  leave the old target as an audit trail.
