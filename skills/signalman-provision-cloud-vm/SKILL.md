---
name: signalman-provision-cloud-vm
description: 'Provision an ephemeral cloud VM (AWS EC2 or Azure VM) tagged with signalman-managed=true so the cost-reaper owns its TTL. Trigger when the user says "spin up an EC2 box", "give me an Azure VM for scenario X", "provision a cloud target", or any variant of "create a test VM on AWS / Azure". Returns a handle the operator can pass to status / terminate. v0.3.0-5: budget-gated (over-budget orgs refuse with `budget_exceeded`); `network.mode` supports public_mtls / aws_ssm / azure_bastion; per-org credentials inject when org_id is set and a cred row exists. CLI parity: `signalman cloud provision`.'
allowed-tools: mcp__signalman__signalman_cloud_provision, mcp__signalman__signalman_cloud_backends, mcp__signalman__signalman_cloud_status, Bash
---

# Provision an ephemeral cloud VM

This skill drives `signalman_cloud_provision`, the MCP entry point onto
the `CloudBackend.provisionInstance` abstraction. It waits for the
cloud to confirm `running` before returning — the handle you get back
is known-startable.

## What you need from the user

- **Provider** — `aws` or `azure`. If they didn't say, ask. (You can
  list registered backends via `signalman_cloud_backends` if uncertain
  which are wired in this host.)
- **Region** — provider-specific (`us-east-1`, `eastus`, etc.). No
  default; the abstraction refuses to guess.
- **Instance type / SKU** — `t3.medium`, `Standard_D2s_v3`, etc.
- **Image reference** — opaque to the abstraction. AWS expects an AMI
  id (`ami-...`); Azure expects a managed-image resource id or an
  `urn:publisher:offer:sku:version` form. If the user only knows "the
  latest Ubuntu", help them pick a concrete value — the backend will
  reject vague inputs with `invalid_config`.
- **Friendly name** — surfaces as a vendor tag.
- (Optional) `org_id` — defaults to `"default"` for local-mode. In
  multi-tenant hosted mode, surface as a required field.
- (Optional) `ttl_minutes` — defaults to 60. The cost-reaper polls
  past-TTL instances and terminates them. If the user wants a longer
  scenario, ask them to set this explicitly so the reaper doesn't
  surprise them.
- (Optional) `tags` — extra vendor tags. `signalman-managed=true` and
  `signalman-org=<org_id>` are always added; caller tags cannot
  override the sentinels (the backend filters them).
- (Optional) `network` — `{ subnet_id?, security_group_ids?,
  assign_public_ip? }`. Defaults to a public-IP VM in the vendor's
  default VPC / vnet.

## How to invoke

**MCP**:

```jsonc
// signalman_cloud_provision
{
  "provider": "aws",
  "region": "us-east-1",
  "instance_type": "t3.medium",
  "image_ref": "ami-0123456789abcdef0",
  "name": "scenario-checkout-flow",
  "org_id": "acme",
  "ttl_minutes": 90,
  "tags": { "scenario": "checkout-flow" },
  "network": { "mode": "aws_ssm" }
}
```

**CLI** (v0.3.0-5 sub-task 8):

```bash
signalman cloud provision \
  --provider aws \
  --region us-east-1 \
  --instance-type t3.medium \
  --image-ref ami-0123456789abcdef0 \
  --name scenario-checkout-flow \
  --org-id acme \
  --ttl-minutes 90 \
  --network-mode aws_ssm \
  [--tag k=v] \
  [--format json]
```

**Per-org credential auto-injection** (v0.3.0-5 sub-task 8): when
`org_id` is set AND a credential row exists for (org, provider) via
`signalman_creds_set`, provision uses those credentials. Otherwise
falls back to the SDK default credential chain. See
`signalman-manage-cloud-credentials` skill.

**Network mode** (v0.3.0-5 sub-task 6): `aws_ssm` forces no-public-IP
(security invariant). `azure_bastion` is Azure-only. Cross-vendor
mode passes raise `invalid_config`. See `signalman-build-cloud-connection`
skill for how to dial the resulting handle.

## Expected response envelope

Success:

```jsonc
{
  "ok": true,
  "value": {
    "id": "i-0abc...",
    "backend": "aws",
    "name": "scenario-checkout-flow",
    "region": "us-east-1"
  }
}
```

The whole object is the handle. Save it verbatim — `terminate` and
`status` need every field.

Error envelope (`isError: true` on the MCP result):

```jsonc
{ "ok": false, "error": { "code": "provision_failed", "message": "EC2 quota exceeded" } }
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `unsupported_provider` | The provider isn't registered on this host. | List registered backends via `signalman_cloud_backends` and re-ask. |
| `auth_failed` | Vendor credentials missing or rejected. | Surface verbatim — the operator must fix env / IAM. |
| `invalid_config` | One of the inputs is malformed for the vendor (bad AMI, bad SKU, etc.). | Echo the message — usually says which field. |
| `quota_exceeded` | Vendor rate-limit or capacity quota hit. | Wait + retry once, or pick a different region/instance_type. |
| `provision_failed` | Generic vendor error mid-provision. | Surface the message; cause is usually the vendor SDK error verbatim. |

## What NOT to do

- **Never** call `signalman_cloud_provision` repeatedly on the same
  config to "test" it — every call mints a VM that bills until the
  reaper kills it. If the first call returned a handle, that's the
  VM; use `status` to inspect, not another `provision`.
- **Never** override `signalman-managed` or `signalman-org` via the
  `tags` field. The backend filters them, but if the caller is
  trying, ask the user what they actually meant — they may be
  attempting to hide an instance from the reaper, which is exactly
  what the sentinel tags exist to prevent.
- **Never** assume a TTL longer than 60min without explicit operator
  input. A typo of `ttl_minutes: 6000` instead of `60` keeps the VM
  alive for ~4 days; surface the chosen TTL back to the user so they
  can sanity-check it.

## Follow-up suggestions

- `signalman_cloud_status` with the handle — confirms `state: "running"`
  + returns the public IP for SSH / probes.
- Hand the handle to whatever scenario-runner step needs the IP.
- When done: `signalman_cloud_terminate` with the same handle. The
  reaper will eventually clean it up, but explicit termination is
  cheaper.
