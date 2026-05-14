---
name: signalman-list-cloud-instances
description: Enumerate Signalman-tagged cloud instances for a given provider. Filters by signalman-managed=true internally — only Signalman-provisioned VMs surface, never operator-owned workloads. Trigger on "what cloud VMs are running", "list test boxes on AWS", "audit signalman cloud usage", "find that VM from yesterday". Use for audit, recovery, and cost-reaper sanity checks.
allowed-tools: mcp__signalman__signalman_cloud_list, mcp__signalman__signalman_cloud_backends, mcp__signalman__signalman_cloud_status
---

# List Signalman-tagged cloud instances

This skill drives `signalman_cloud_list`, the MCP entry point onto
`CloudBackend.listInstances`. The backend filters by
`signalman-managed=true` internally; callers may further narrow via
the `tags` filter.

## What you need from the user

- **Provider** — `aws` or `azure`. (You can call
  `signalman_cloud_backends` first to enumerate registered backends.)
- (Optional) **Tag filter** — `{ "scenario": "checkout-flow" }`
  narrows to instances also carrying that tag. The
  `signalman-managed` and `signalman-org` sentinels are applied
  automatically; you don't need to add them.

## How to invoke

```jsonc
// signalman_cloud_list
{
  "provider": "aws",
  "tags": { "signalman-org": "acme" }
}
```

Or, list everything Signalman-managed on AWS:

```jsonc
{ "provider": "aws" }
```

## Expected response envelope

Success (always returns an array, possibly empty):

```jsonc
{
  "ok": true,
  "value": [
    { "id": "i-0abc...", "backend": "aws", "name": "vm-1", "region": "us-east-1" },
    { "id": "i-0def...", "backend": "aws", "name": "vm-2", "region": "us-east-1" }
  ]
}
```

Each entry is a handle suitable for `terminate` / `status`.

Error envelope (`isError: true`):

```jsonc
{ "ok": false, "error": { "code": "quota_exceeded", "message": "..." } }
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `quota_exceeded` | Result set exceeded a single vendor page. Pagination is deliberately not exposed; the contract is "narrow your filter and re-list". | Suggest a more specific tag filter (e.g. by org or scenario). |
| `auth_failed` | Vendor credentials missing or rejected. | Operator fixes env / IAM. |
| `unsupported_provider` | The provider isn't registered. | Use `signalman_cloud_backends` to verify wiring. |

## What NOT to do

- **Never** use this listing to drive bulk terminate without operator
  confirmation. The cost-reaper is the designated automation for
  past-TTL cleanup; an interactive agent listing instances is
  expected to surface them, not act on them.
- **Never** assume the absence of an instance in this list means
  "nothing is running on the vendor". This only sees
  Signalman-managed VMs. Operator-owned workloads are invisible to
  this surface by design.
- **Never** call list in a polling loop — it's a vendor API call. If
  you need to watch state changes, use `signalman_cloud_status` on a
  known handle with backoff instead.

## Follow-up suggestions

- For each handle of interest: `signalman_cloud_status` to see
  `state`, `public_ip`, `private_ip`.
- For cleanup: `signalman_cloud_terminate` per handle the operator
  confirms.
- If listing is returning surprising results (e.g. a VM the operator
  forgot they provisioned), surface the `ttl_minutes` situation —
  the reaper handles the long-term case but it's worth understanding
  why something escaped expected lifecycle.
