---
name: signalman-deploy-runner
description: 'Deploy a Signalman build runner to a remote target via one of five transports — script, ssh, winrm, docker, or cloud (provision-and-deploy). The runner binary comes from any HTTP(S) URL (typically a @signalman/registry blob URL); the transport downloads it on the remote, writes registration config, and starts the service. By default waits up to 60s for the runner to heartbeat. Trigger when the user says "deploy a runner to <host>", "spin up a runner on AWS", "get a runner running in this docker container", "bootstrap signalman runner on a Windows box", "generate a runner install script", or asks how to add capacity to the queue. CLI parity: `signalman runner deploy --transport <kind>`.'
allowed-tools: mcp__signalman__signalman_runner_deploy, mcp__signalman__signalman_runner_list, mcp__signalman__signalman_api_key_create, Bash
---

# Deploy a Signalman runner

WS6 M9 closes the M3.5 deferral. Five transports, one verb: each
takes the runner binary URL + registration config + a transport-
specific addressing block and bootstraps a runner on the target. By
default the verb waits for the runner to heartbeat before declaring
success — turning "successful bootstrap" into "successfully running."

## Which transport to use

| Transport | When | Auth model | Verification |
|---|---|---|---|
| `script` | Operator wants to run the install themselves (air-gapped, custom bootstrap, audit trail). | None (no remote auth) | Operator runs; verification deferred. |
| `ssh` | Linux / macOS target the operator has SSH-key access to. | Operator-supplied `IdentityFile`. | Heartbeat poll. |
| `winrm` | Windows target with WinRM configured (`Enable-PSRemoting`). | Operator-supplied `username` + `password`. | Heartbeat poll. |
| `docker` | Containerised runner on a local or remote Docker daemon. | Docker context (operator pre-configures). | Heartbeat poll. |
| `cloud` | "Give me a runner on AWS / Azure in <region>" — provisions a fresh VM then bootstraps via ssh / winrm. | Cloud creds (env or per-org) + inner ssh/winrm creds. | Heartbeat poll. |

Defaults to `ssh` is the most common case for "I have a host I want a
runner on." `cloud` is the "and I don't even have the host yet" case.

## Common inputs (every transport)

- **`binary_url`** — HTTP(S) URL to the runner binary. Typical
  shape: `https://<registry>/v1/blobs/sha256:<hash>` from a
  `@signalman/registry` push. Any URL the remote can `curl` works.
- **`binary_sha256`** (optional) — 64 hex chars. When set, the
  transport verifies after download and refuses to install on
  mismatch. If the URL is a registry blob URL, the sha is extracted
  from the path even when this field is omitted.
- **`control_plane_url`** — URL the runner reports to.
- **`token`** — API key the runner authenticates with. Mint via
  `signalman_api_key_create` first; the key is returned ONCE.
- **`worker_name`** — friendly name; surfaces in the runners table.
- **`wait_timeout_ms`** (optional) — heartbeat-verification budget.
  Default 60000. Set to 0 to fire-and-forget.

## How to invoke

### script (operator-driven install)

```jsonc
{
  "binary_url": "https://reg/v1/blobs/sha256:abc...",
  "control_plane_url": "http://control-plane:7777",
  "token": "tok-xyz",
  "worker_name": "operator-mac",
  "transport": { "kind": "script", "os": "macos" }
}
```

Returns `bootstrap.script` containing the bash/pwsh body. Operator
runs it on the target. Verification is skipped (operator may not
run the script immediately).

### ssh

```jsonc
{
  "binary_url": "...",
  "control_plane_url": "...",
  "token": "...",
  "worker_name": "linux-runner-01",
  "transport": {
    "kind": "ssh",
    "host": "deploy@host-01.lan",
    "identity_path": "/home/operator/.ssh/signalman-deploy",
    "port": 22,
    "service_manager": "systemd"
  }
}
```

`service_manager` is `systemd` (default), `launchd`, or `none`.
`launchd` writes a per-user plist; `none` installs the binary +
config but doesn't auto-start.

### winrm

```jsonc
{
  "binary_url": "...",
  "control_plane_url": "...",
  "token": "...",
  "worker_name": "win-runner-01",
  "transport": {
    "kind": "winrm",
    "host": "win-01.corp",
    "username": "CORP\\deploy",
    "password": "...",
    "use_ssl": true
  }
}
```

`Enable-PSRemoting -Force` must be set on the target ahead of time.
The transport registers a Windows service named
`SignalmanRunner_<workerName>`.

### docker

```jsonc
{
  "binary_url": "https://reg/v1/blobs/sha256:abc...",
  "control_plane_url": "...",
  "token": "...",
  "worker_name": "docker-runner-01",
  "transport": {
    "kind": "docker",
    "image": "ghcr.io/operator/signalman-runner:0.4.x",
    "context": "default",
    "extra_env": { "EXTRA_KEY": "VALUE" }
  }
}
```

For docker, `binary_url` is informational — the runner binary lives
inside the operator's image. The transport runs `docker pull` →
`docker rm -f` (idempotent) → `docker run -d` with the registration
env vars passed in. Remote daemons via `docker context create`.

### cloud (provision + bootstrap in one call)

```jsonc
{
  "binary_url": "https://reg/v1/blobs/sha256:abc...",
  "control_plane_url": "...",
  "token": "...",
  "worker_name": "aws-runner-checkout",
  "transport": {
    "kind": "cloud",
    "provider": "aws",
    "region": "us-east-1",
    "instance_type": "t3.medium",
    "image_ref": "ami-0123456789abcdef0",
    "name": "scenario-checkout-runner",
    "os_family": "linux",
    "inner_ssh_identity_path": "/home/operator/.ssh/aws-deploy",
    "ttl_minutes": 60
  }
}
```

The cloud transport:

1. Provisions a fresh VM (cost-reaper owns its TTL).
2. Polls for a public IP (up to 2min).
3. Dispatches to `ssh` (linux) or `winrm` (windows) using the
   inner credentials supplied.

If the inner bootstrap fails AFTER provisioning, the VM stays alive
(operator can terminate manually via `signalman_cloud_terminate` or
let the reaper handle it).

## Common errors

| Error pattern | Cause | What to do |
|---|---|---|
| `exec timeout` | Remote unreachable (firewall, wrong host, ssh server down). | Verify with manual `ssh -i <key> <host>` or `Test-NetConnection`. |
| `exited with 255` (ssh) | SSH auth or host-key failure. | Pre-populate `known_hosts`; verify the identity file path. |
| `pull exited with 1` (docker) | Image not found / auth required. | Verify `docker pull <image>` manually first. |
| `did not surface a public IP` (cloud) | VM provisioned but networking is delayed. | Often resolves on retry; if persistent, check the AMI's first-boot time. |
| `verification timeout` | Bootstrap succeeded but the runner didn't heartbeat. | SSH/RDP into the target and inspect the runner process (systemd journal, sc.exe queryex). |

## What NOT to do

- **Don't put the runner token in audit-log search results.** The
  token grants control-plane writes; if it leaks, rotate via
  `signalman_api_key_revoke` + remint.
- **Don't reuse worker_name across hosts.** Heartbeat upserts by
  `(org, name)`; two hosts heartbeating under the same name will
  fight for the row.
- **Don't deploy with `service_manager: none` and expect heartbeats.**
  The binary is installed but not running; verification will time
  out by definition.
- **Don't run cloud transport without an explicit `ttl_minutes`** if
  the operator wants a long-lived runner — the cost-reaper default
  (60min) will terminate it.
- **Don't bake credentials into the binary URL.** Use a
  `@signalman/registry` blob URL (auth handled by the registry's
  bearer-token layer) instead of a presigned URL with embedded
  creds.

## Follow-up suggestions

- After a successful deploy: `signalman_runner_list` to see the new
  row + its `last_seen_at`. Pair with `signalman_release_build --remote`
  to send work to it.
- For cloud transport: capture the returned `bootstrap.detail.instance_id`
  so the operator can terminate explicitly later (instead of waiting
  for the reaper).
- For script transport: pipe the returned script body into a file
  the operator commits to their bootstrap repo. Idempotent re-runs
  resurrect the runner row in the control plane.
