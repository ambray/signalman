---
name: signalman-manage-cloud-budget
description: Set or inspect a per-org monthly cloud-spend budget. Trigger when the user says "set a budget for org X", "what's our cloud spend this month", "limit AWS spend to $500/month", "why did this provision fail with budget_exceeded". Per-org budgets gate `signalman_cloud_provision` — over-budget calls refuse with `budget_exceeded` BEFORE any vendor API call.
allowed-tools: mcp__signalman__signalman_budget_get, mcp__signalman__signalman_budget_set, mcp__signalman__signalman_budget_usage, Bash
---

# Manage per-org cloud-spend budget

This skill drives v0.3.0-5 sub-task 5 cost-budget controls. The budget
gate sits in front of every cloud provision; soft-warns at 80% of the
monthly limit and hard-refuses at 100%.

## What you need from the user

- **Org id.** All operations are per-org. Use "default" for local-mode
  installs where multi-tenancy isn't surfaced yet.
- **For `set`**: monthly limit in **cents** (e.g. `50000` = $500/month).
  Optional `soft_warn_pct` defaults to 80.
- **Billing month = calendar month UTC.** Usage rolls over at the
  first of each UTC month; previous month's spend doesn't count.

## How to invoke

**Set/update budget (MCP)**:

```jsonc
{
  "org_id": "acme",
  "monthly_cents_limit": 50000,
  "soft_warn_pct": 80
}
```

**Set budget (CLI)**:

```bash
signalman cloud budget set --org acme --monthly-cents 50000 [--soft-warn-pct 80]
```

**Get budget + current usage**:

```jsonc
// signalman_budget_get { "org_id": "acme" }
```

```bash
signalman cloud budget get --org acme [--format json]
```

**List per-instance usage rows for current month**:

```jsonc
// signalman_budget_usage { "org_id": "acme" }
```

```bash
signalman cloud budget usage --org acme [--format json]
```

## Expected response

`get`:

```jsonc
{
  "ok": true,
  "value": {
    "orgId": "acme",
    "budget": {
      "orgId": "acme",
      "monthlyCentsLimit": 50000,
      "softWarnPct": 80,
      "createdAt": "...",
      "updatedAt": "..."
    },
    "usageCents": 12340,
    "monthStart": "2026-05-01T00:00:00.000Z"
  }
}
```

When `budget` is `null`, the org has no budget configured — provisions
are unlimited (back-compat default).

## What happens on over-budget provision

When `signalman_cloud_provision` is called for an org over its budget:

```jsonc
{
  "ok": false,
  "error": {
    "code": "budget_exceeded",
    "message": "org 'acme' would exceed budget: usage=49500¢ + estimate=2500¢ = 52000¢ > limit=50000¢ (104.0% of monthly budget)."
  }
}
```

The CLI `signalman cloud provision` maps `budget_exceeded` to **exit 3**
(not 4) so CI scripts can distinguish budget exhaustion from generic
vendor errors.

## Error codes

| `code` | Meaning | Operator fix |
|---|---|---|
| `budget_exceeded` | Over 100% of monthly limit. | Raise the limit OR wait for next month OR terminate unused instances to reclaim budget |
| `budget_not_found` | Reserved for explicit-budget-required flows; v0.3.0-5 doesn't emit this — absent budget = unlimited. Reserved for v0.3.x | n/a |

## Cost model — read this before quoting numbers

Estimates come from a **static SKU × region → cents/hour table**
(see `host/src/cloud/cost.ts`). Cover ~30 common AWS + Azure SKUs at
Q1-2026 list prices. Unknown SKUs use a high default rate
(50¢/hour) — operator-favouring "over-protect not under-estimate".

This is intentionally naive per design §13.5; vendor real-pricing
API integration (AWS Price List, Azure RateCard) is a v0.3.x
followup. Treat estimates as a guardrail against catastrophic
mistakes, not as a billing-grade quote.

## What NOT to do

- **Never** set a budget without operator confirmation of the dollar
  figure. The monthly_cents_limit is in CENTS; a typo of `5000000`
  instead of `50000` means $50,000/mo not $500/mo
- **Never** disable the gate to "let a critical provision through".
  Raise the limit explicitly so the operator's intent is recorded
- **Never** quote the cost-table prices as authoritative bills.
  They're approximations; AWS / Azure bill on actual usage with
  per-second granularity that the static table doesn't capture

## Follow-up suggestions

- After hitting `budget_exceeded`, list usage with
  `signalman_budget_usage` to see what's accumulating; run the
  reaper if past-TTL instances are eating into budget
- For pre-flight estimates on OpenTofu stacks, use
  `signalman_stack_plan_cost` BEFORE `signalman_stack_apply` —
  the stack-cost flow surfaces the monthly estimate without
  applying
