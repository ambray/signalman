---
name: signalman-promote-release
description: 'Drive Signalman''s auto-promotion + approval pipeline end-to-end. Configures promotion policies (auto / manual / time-delay); lists active policies; surfaces pending approvals; fires approve/reject decisions; and ticks the time-delay queue. Trigger when the user says "set up auto-promotion", "promote releases from test to demo", "approve the pending promotion", "what is pending approval", "show pending approvals", "list promotion policies", "tick the auto-approve queue", or asks about gate behaviour for a product. CLI parity: `signalman promotion {add,list,remove,approve,reject,approvals,tick}`.'
allowed-tools: mcp__signalman__signalman_promotion_add, mcp__signalman__signalman_promotion_list, mcp__signalman__signalman_promotion_remove, mcp__signalman__signalman_promotion_approve, mcp__signalman__signalman_promotion_reject, mcp__signalman__signalman_promotion_approvals, mcp__signalman__signalman_promotion_tick, Bash
---

# Auto-promote a release

## What you need from the user

For a new policy:

- **Product** — must already be registered. Use `signalman product list` to confirm.
- **Dest target** — where the policy promotes TO.
- **Source target** — optional. Omit it to make this the initial-tier policy that fires when a release is freshly built. Include it for tier-to-tier (e.g. `--source test --dest demo`) once that workflow lands.
- **Gate kind**:
  - `auto` — deploy fires immediately when the listener triggers.
  - `manual` — listener creates a pending approval; operator (or this skill) flips it via `promotion approve`.
  - `time_delay` — listener creates a pending approval with `auto_approve_at = now + delay_seconds`. The `promotion tick` pass dispatches it once that time elapses.

For an approval decision:

- **Approval id** — from `signalman promotion approvals --status pending`.
- **Optional `--decided-by`** and `--reason` — audit-log metadata.

## How to invoke

Register a policy:

```bash
signalman promotion add \
  --product <NAME> \
  --dest <TARGET> \
  [--source <TARGET>] \
  --gate <auto|manual|time_delay> \
  [--delay-seconds 600 | --gate-config '{"delay_seconds":600}'] \
  [--description "..."] \
  --format json
```

List policies / pending approvals:

```bash
signalman promotion list [--format json]
signalman promotion approvals [--status pending] [--format json]
```

### Querying pending approvals (`signalman_promotion_approvals`)

When the operator asks "what's waiting for me?", "show pending approvals",
or "is anything queued for review", drive `signalman_promotion_approvals`
directly:

```jsonc
// MCP
{ "status": "pending" }
```

The `status` filter is one of `pending` / `approved` / `rejected` /
`auto_approved`. Omit the filter to get every approval row. The
response is an array of approval objects with `id`, `release_id`,
`dest_target`, `gate_kind`, `auto_approve_at` (for time-delay rows),
`status`, `decided_by`, `decided_at`, `reason`, `deploy_outcome`.

Typical patterns:

- **"What's pending right now?"** → `{ "status": "pending" }`.
- **"What did the time-delay queue auto-approve last hour?"** →
  `{ "status": "auto_approved" }` then filter by `decided_at` in the
  caller.
- **"Did my approve fire the deploy?"** → look up the row by `id`;
  `deploy_outcome` says `succeeded` / `failed` / `pending`.

Decide on a pending approval:

```bash
signalman promotion approve <APPROVAL_ID> [--decided-by alice] [--reason "smoke tests green"]
signalman promotion reject  <APPROVAL_ID> [--decided-by alice] [--reason "rollback in progress"]
```

Process due time-delay approvals:

```bash
signalman promotion tick
```

## Expected behaviour

- `signalman release build` lands a release as `ready` → the listener walks active policies for that product (matching `source IS NULL`) and either deploys (auto) or queues an approval (manual / time_delay).
- `signalman release deploy` that lands as `status=active` (i.e., health probes passed) → the listener walks active policies whose `source` matches the just-deployed target and fires the same way. Tier-to-tier promotion = "test → demo → prod" without an operator pulling the trigger.
- Failed / rolled-back deploys do NOT promote — only `status=active` triggers the next-tier listener.
- The promotion path is idempotent on (release, dest_target). A re-fire of the listener returns the existing approval row, never queues a duplicate.
- `signalman release show <release_id>` now includes an `approvals` array surfacing the per-target promotion state.
- Approval/rejection emits `promotion-approved` / `promotion-rejected` webhook events (Epic 2). Pair this skill with `signalman webhook add --events promotion-approved,promotion-rejected --kind slack ...` to mirror decisions into chat.

### Approver allow-list (honour-system)

Add an `approvers` array to a manual policy's gate config to require `--decided-by` matches one of the listed identities:

```bash
signalman promotion add --product p --dest demo --gate manual \
  --gate-config '{"approvers": ["alice@example", "bob@example"]}'
```

`signalman promotion approve <id>` then refuses any `--decided-by` that isn't in the list (and refuses if `--decided-by` was omitted). The check is honour-system: `--decided-by` is caller-supplied. It surfaces accidental self-approval and creates an audit trail for small teams; it is not a defence against an adversary with CLI access. Deployments that need authenticated approver identity should front this control plane with an external auth layer.

## Exit codes

| Exit | Meaning | What to say |
|------|---------|--------------|
| 0 | Command succeeded (auto/manual approval deployed cleanly). | Surface the JSON output. |
| 4 | Validation error or the dispatched deploy failed. | The approval row is preserved with `deploy_outcome=failed`; surface stderr and let the user investigate. |

## What NOT to do

- **Never re-approve an already-decided approval.** The verb refuses with a clear error; surface it. The user wants a fresh promotion, they create a new policy fire (today: rebuild) or wait for v0.5+ "re-run pending promotion".
- **Don't fabricate approval reasons.** If the operator didn't supply `--reason`, leave it blank.
- **Don't approve as `decided_by="claude"` silently.** If the user is the approver, capture their name / handle and pass it via `--decided-by`. The audit-log row is the operator's accountability trail.

## Follow-up suggestions

- After `promotion add`: rebuild the product (or wait for the next release) to verify the listener fires correctly.
- Use `signalman promotion approvals --status pending` to see what's queued.
- For time-delay policies, prefer running `signalman promotion tick` from a cron job (matches the existing `signalman schedule run-once` ergonomics).
- Webhook integration: pair with `signalman webhook add --kind slack --events promotion-approved,promotion-rejected` so approval decisions surface in chat without anyone refreshing the CLI.
