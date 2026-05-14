---
name: signalman-build-cloud-connection
description: Build a control-plane → guest-agent connection descriptor for a cloud VM given its handle. Trigger when the user says "how do I reach this VM", "give me the connection info for the SSM tunnel", "what's the bastion connection for this VM". The descriptor carries the addressing parameters (region/instance_id for SSM, subscription/RG/vm_name for Bastion, host/port for public_mtls); actual tunnel dialing is the caller's job.
allowed-tools: mcp__signalman__signalman_cloud_connection_descriptor, mcp__signalman__signalman_cloud_status, Bash
---

# Build a cloud connection descriptor

This skill drives v0.3.0-5 sub-task 6 commit 1. Given a cloud VM
handle and the operator's network mode (recorded on the handle at
provision time), it returns a tagged-union descriptor with the
addressing parameters a control-plane client needs to dial the
guest agent.

## Background — three modes per design §13.6

- `public_mtls` (default): vendor assigns a public IP; security
  group restricts inbound to gRPC port; control plane dials the
  public IP with mutual TLS. Simplest but biggest attack surface
- `aws_ssm`: AWS-only; no public IP; control plane reaches the
  guest via AWS SSM Session Manager port forwarding. Zero public
  surface; requires SSM agent in the AMI + an IAM instance
  profile granting `AmazonSSMManagedInstanceCore`
- `azure_bastion`: Azure-only; equivalent via Azure Bastion native
  client port forwarding

The mode is chosen at `signalman_cloud_provision` time
(`network.mode` in the config) and recorded on the returned
handle.

## What you need from the user

- A `handle` — output of `signalman_cloud_provision` or one of the
  entries from `signalman_cloud_list`. Must carry `id`, `backend`,
  `name`, `region`. If `network_mode` is absent the descriptor
  defaults to `public_mtls` (back-compat for pre-sub-task-6 handles)
- (Optional) **`port`** — gRPC port (defaults to 443)
- **For `azure_bastion` mode only**: `subscription_id` +
  `resource_group` of the VM (the handle alone doesn't carry them)

## How to invoke

**MCP**:

```jsonc
{
  "handle": {
    "id": "i-0abc1234def",
    "backend": "aws",
    "name": "scenario-x",
    "region": "us-east-1",
    "network_mode": "aws_ssm"
  }
}
```

**CLI**:

```bash
signalman cloud connection-descriptor \
  --provider aws \
  --id i-0abc1234def \
  --name scenario-x \
  --region us-east-1 \
  --network-mode aws_ssm \
  [--port 443] \
  [--format json]
```

For `azure_bastion`, also pass `--subscription-id` + `--resource-group`.

## Expected response

**public_mtls** (default mode):

```jsonc
{ "ok": true, "value": { "kind": "public_mtls", "port": 443 } }
```

Note `host` is absent — the caller must resolve the public IP via
`signalman_cloud_status` (or `signalman_cloud_list` if the handle
came from there) before dialing.

**aws_ssm**:

```jsonc
{
  "ok": true,
  "value": {
    "kind": "aws_ssm",
    "region": "us-east-1",
    "instance_id": "i-0abc1234def",
    "port": 443
  }
}
```

The caller invokes AWS SSM Session Manager port forwarding with
these:

```bash
aws ssm start-session --target i-0abc1234def \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["443"],"localPortNumber":["44443"]}'
# Then dial localhost:44443 with mutual TLS
```

**azure_bastion**:

```jsonc
{
  "ok": true,
  "value": {
    "kind": "azure_bastion",
    "subscription_id": "...",
    "resource_group": "...",
    "vm_name": "scenario-x",
    "port": 443
  }
}
```

The caller invokes Azure Bastion native client port forwarding.

## Resolving the public IP for public_mtls mode

The descriptor for public_mtls intentionally returns without a
`host` — public IPs aren't on the handle. Fetch it separately:

```jsonc
// signalman_cloud_status { provider, id, name, region }
```

The status response carries `public_ip`. Combine with the
descriptor's `port` for the connection target.

The TS-internal helper `withResolvedHost(descriptor, ip)` does this
combination cleanly; via MCP the caller does the equivalent
client-side.

## Error codes you may see

| Cause | Error |
|---|---|
| `aws_ssm` mode on an Azure handle | Thrown — `aws_ssm is only valid for AWS handles` |
| `azure_bastion` mode on an AWS handle | Thrown — `azure_bastion is only valid for Azure handles` |
| `azure_bastion` without `subscription_id` | Thrown — `azure_bastion connection descriptor requires opts.subscriptionId` |
| `azure_bastion` without `resource_group` | Thrown — `azure_bastion connection descriptor requires opts.resourceGroup` |

CLI exit codes: 0 on success, 4 on any of the above, 64 on missing
required flags.

## What NOT to do

- **Never** try to dial a public_mtls VM without first resolving
  the IP via `signalman_cloud_status`. The descriptor returns
  `host: undefined` deliberately — it's not a free lookup
- **Never** assume the SSM tunnel will work without checking the
  AMI has the SSM agent + the instance profile grants
  `AmazonSSMManagedInstanceCore`. The descriptor only carries
  addressing; the actual SSM dial fails with a clear AWS error
  if the prerequisites are missing
- **Never** hardcode `port: 443` in your tooling — the descriptor
  carries the port so future scenarios can use alternative ports
  (e.g. 8443 for non-standard mTLS terminators)

## Follow-up suggestions

- For public_mtls: chain with `signalman_cloud_status` to get the
  IP, then dial directly
- For aws_ssm: pair with the AWS CLI's
  `start-session --document-name AWS-StartPortForwardingSession`
  for the actual tunnel
- For azure_bastion: pair with `az network bastion tunnel`
- The actual tunneling helpers (a `signalman cloud connect <handle>`
  verb that produces a live forwarded socket) are a v0.3.x followup;
  this skill ships the addressing contract that those helpers will
  consume
