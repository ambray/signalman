---
name: signalman-register-runner
description: 'Register a Signalman build runner against a control plane. Two-step flow: build + validate the config envelope, then persist it to disk. Trigger when the user says "register a runner", "set up a build worker", "wire this machine into the control plane", "save runner config", "configure runner pointing at <URL>", or any "this is my new build runner" intent.'
allowed-tools: mcp__signalman__signalman_runner_build_config, mcp__signalman__signalman_runner_persist_config
---

# Register a Signalman build runner

Runner registration is a two-step MCP flow. The split (rather than a
single atomic verb) is intentional — it lets agents inspect or
transform the config envelope before commit, and lets a hosted-mode
agent stage the config on one machine and apply it on another.

1. `signalman_runner_build_config` — accepts URL + token + optional
   worker name; validates them; returns the envelope and the path
   the persist step would target. Writes nothing.
2. `signalman_runner_persist_config` — writes the envelope to the
   default `$SIGNALMAN_DATA_DIR/runner.yaml` (or
   `~/.signalman/runner.yaml`), mode 0600 on POSIX. Accepts an
   optional `target_path` override.

After persist, the host machine can start the worker via
`signalman runner start` (CLI; no MCP equivalent — runner is a
daemon-style process).

## What you need from the user

For `signalman_runner_build_config`:

- **`control_plane_url`** — the URL of the Signalman HTTP control
  plane (e.g. `http://control.example.com:8765`).
- **`token`** — a bearer-token API key minted on the control-plane
  host. If the user doesn't have one, mint it with
  `signalman-mint-api-key` against the *control plane*, not the
  runner. The token gets stored in `runner.yaml` on the runner host.
- (Optional) **`worker_name`** — friendly identifier the worker will
  use when polling. Default: the runner derives one from
  `${hostname}:${pid}` at start time.

For `signalman_runner_persist_config`:

- Same three fields, plus optional **`target_path`** if writing
  somewhere other than the default. Useful for tests and non-default
  install layouts.

## How to invoke

Step 1 — build + inspect:

```jsonc
// signalman_runner_build_config
{
  "control_plane_url": "http://control.example.com:8765",
  "token": "sk_ABC12345_XXXXXXXXXXXXXXXXXXXXXXXXXX",
  "worker_name": "builder-mac-01"
}
```

Response:

```jsonc
{
  "config": {
    "control_plane_url": "http://control.example.com:8765",
    "token_prefix": "sk_ABC12345_…",
    "worker_name": "builder-mac-01"
  },
  "envelope": {
    "controlPlaneUrl": "http://control.example.com:8765",
    "token": "sk_ABC12345_XXXXXXXXXXXXXXXXXXXXXXXXXX",
    "workerName": "builder-mac-01"
  },
  "target_path": "/home/operator/.signalman/runner.yaml"
}
```

The `config` summary masks the token; `envelope` carries the full
secret so step 2 can write it.

Step 2 — persist:

```jsonc
// signalman_runner_persist_config (using envelope from step 1)
{
  "control_plane_url": "http://control.example.com:8765",
  "token": "sk_ABC12345_XXXXXXXXXXXXXXXXXXXXXXXXXX",
  "worker_name": "builder-mac-01"
}
```

Response:

```jsonc
{ "written": true, "path": "/home/operator/.signalman/runner.yaml" }
```

## What NOT to do

- **Never** call `signalman_runner_persist_config` without
  first running `signalman_runner_build_config` and surfacing the
  `target_path` to the operator. The persist step is destructive —
  it overwrites an existing `runner.yaml`. If the operator already
  has a runner registered against a different control plane, this
  swaps the credential without warning. Show the target path first.
- **Don't** call this against the *control plane's* host — registering
  a runner is for the *worker* machines that will poll the control
  plane for jobs. The control plane itself doesn't need a
  `runner.yaml` (it serves the queue, doesn't claim from it).
- **Don't** mint the bearer token from this skill — that's
  `signalman-mint-api-key`'s job and runs on the control-plane host
  (or via MCP against it). Tokens are then handed to runner hosts
  for registration.
- **Don't** echo the token to chat after persist confirms. The token
  is now on disk; the agent doesn't need it again.
- **Don't** persist with a hand-edited token without confirming the
  prefix matches a key the operator owns. A typo in the token would
  silently land in `runner.yaml` and only surface as auth failures
  on the next `signalman runner start`.

## Follow-up suggestions

After persist:
- Tell the operator to start the worker: `signalman runner start`
  (CLI; daemon-style — no MCP equivalent). The worker reads
  `runner.yaml` and begins polling.
- Suggest `signalman runner start --worker-name <distinct>` if the
  worker_name in the persisted config is meant to be overridden per
  invocation.
- For multi-host setups: tell the operator each worker machine
  needs its own `signalman_runner_persist_config` call, ideally with
  a distinct `worker_name`. Sharing a token across hosts is allowed
  but makes the audit log harder to read.
