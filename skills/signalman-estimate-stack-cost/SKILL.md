---
name: signalman-estimate-stack-cost
description: Pre-flight cost estimate for an OpenTofu stack before applying. Runs `tofu plan -json`, sums the create-actions against a static SKU × region cost table, returns the estimated monthly cents. Trigger when the user says "what would this stack cost", "estimate the bill before I apply", "is this scenario going to blow our budget", or any "dry-run cost" variant. Read-only; does NOT mutate cloud state.
allowed-tools: mcp__signalman__signalman_stack_plan_cost, Bash
---

# Pre-flight cost estimate for OpenTofu stacks

This skill drives v0.3.0-5 sub-task 5 control 3. Operators run it
before `signalman stack apply` to confirm "is this stack going to
cost ~$X/month?" without committing to the deployment.

## What you need from the user

- **`stack_name`** — same identifier the operator will pass to
  `signalman_stack_apply`. Must match `^[a-z0-9][a-z0-9_-]{0,62}$`.
- **`module_path`** — relative path under the project root to the
  HCL module directory (same as `apply`).
- (Optional) **`vars`** — `--var k=v` pairs passed to tofu, same
  shape as apply.

## How to invoke

**MCP**:

```jsonc
{
  "stack_name": "checkout-flow-net",
  "module_path": "infra/scenarios/checkout-flow/network",
  "vars": { "region": "us-east-1" }
}
```

**CLI**:

```bash
signalman stack plan-cost \
  --stack-name checkout-flow-net \
  --module-path infra/scenarios/checkout-flow/network \
  [--param region=us-east-1] \
  [--format json]
```

## Expected response

```jsonc
{
  "ok": true,
  "value": {
    "stackName": "checkout-flow-net",
    "workspacePath": "/.../signalman-cloud-finish/.signalman/tofu-workspaces/checkout-flow-net",
    "changeSummary": { "add": 3, "change": 0, "destroy": 0 },
    "estimatedMonthlyCents": 28800,
    "costedResources": [
      { "address": "aws_instance.web", "sku": "t3.medium", "region": "us-east-1", "monthlyCents": 2920 },
      { "address": "aws_instance.db",  "sku": "m5.large",  "region": "us-east-1", "monthlyCents": 7300 }
    ],
    "untrackedResources": [
      "aws_s3_bucket.assets",
      "aws_iam_role.app",
      "aws_security_group.web"
    ],
    "durationMs": 4321
  }
}
```

**`estimatedMonthlyCents`** is the headline: cents/month for the
compute resources the plan would CREATE. The CLI emits this as
`$288.00/month` in the human-readable output.

**`costedResources`** lists the per-resource breakdown the estimate
came from. Use this to identify the biggest contributors.

**`untrackedResources`** are resources the cost estimator does NOT
recognise — S3 buckets, IAM roles, security groups, etc. Free or
near-free to provision; the estimate excludes them. NOT the same
as "they cost nothing in production" — S3 storage + transfer
costs accrue separately and aren't visible in `tofu plan`.

## Recognised resource types

The cost estimator pattern-matches on resource type:

- `aws_instance` — extracts `instance_type` + `availability_zone`
- `azurerm_linux_virtual_machine` / `azurerm_windows_virtual_machine`
  / `azurerm_virtual_machine` — extracts `size` + `location`

Anything else lands in `untrackedResources`. The cost table covers
~30 common AWS + Azure SKUs; unknown SKUs use a high fallback
(50¢/hour × 730 hours = $365/month) so an unpriced instance still
consumes meaningful "estimate budget" — conservative on purpose.

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `invalid_stack_name` | Stack name violated the regex. | Suggest lowercase, replace spaces with dashes |
| `module_path_missing` | Directory at `module_path` doesn't exist or has no .tf files | Operator must check the path |
| `tofu_not_found` | `tofu` binary not on PATH. | Install OpenTofu (brew / apt / scoop) |
| `tofu_failed` | `tofu init` or `tofu plan` exited non-zero | Surface stderr tail — usually missing variable or auth |
| `auth_failed` | Vendor credentials rejected by the provider in the HCL | Operator fixes env / IAM |

## What NOT to do

- **Never** quote `estimatedMonthlyCents` as the actual bill. It's
  list-price for compute SKUs only; ignores storage, data transfer,
  managed-service overhead, support plans, etc.
- **Never** skip plan-cost before apply on a stack you haven't seen
  before. Even a wrong-by-50% estimate catches catastrophic
  mistakes (a wrong instance-type with 50 copies)
- **Never** apply via this skill — it's read-only by design. Use
  `signalman-apply-cloud-stack` (or its CLI verb) when you're
  satisfied with the estimate

## Follow-up suggestions

- If `estimatedMonthlyCents` exceeds the org's budget headroom
  (check via `signalman_budget_get`), surface that before applying
- If `untrackedResources` is large, the estimate is more
  approximate than usual — flag this to the operator
- After applying via `signalman_stack_apply`, the actual instances
  will appear in `signalman_cloud_list` and consume real budget
  via the gate
