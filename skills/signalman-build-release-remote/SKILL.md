---
name: signalman-build-release-remote
description: Build a Signalman release on a remote runner via the control-plane job queue, polling until terminal. CLI parity with `signalman release build --remote`. Trigger when the user says "build remotely", "submit a build job", "build on the runner", "build <product> at <tag> on the worker", "queue a remote build", or any "off-host build" intent.
allowed-tools: mcp__signalman__signalman_release_build_remote
---

# Build a release on a remote runner

`signalman_release_build_remote` submits a `release.build` job to the
control-plane queue and polls until terminal. A registered runner
worker (via `signalman-register-runner` + `signalman runner start`)
claims the job, clones the product repo at the tag, runs the build
executor, uploads artifacts, and writes the release row. The
response carries the terminal job state.

This is the MCP parity for `signalman release build --remote`, added
in milestone 2.

## What you need from the user

- **`product`** — registered product name. Must already exist via
  `signalman-register-product`. Resolved via the control plane's
  `productByName` lookup, so a typo surfaces as
  `product not found`.
- **`tag`** — git tag to build. Must exist in the product repo at
  build time (the runner will `git clone` and check out).
- (Optional) **`poll_interval_ms`** — how often to poll the job for
  terminal state. Default 750ms (matches CLI). Bounded to [100,
  10000]. Higher values reduce control-plane load; lower values
  surface terminal state faster but rate-limit.

## Preconditions

- A `runner.yaml` exists on the host running the Signalman agent
  (see `signalman-register-runner`). The MCP tool reads
  `~/.signalman/runner.yaml` (or `$SIGNALMAN_DATA_DIR/runner.yaml`)
  to know which control plane to submit to.
- At least one runner worker is `signalman runner start`-ed against
  that control plane. With no workers, the job stays in `queued`
  forever and the tool will spin.

## How to invoke

```jsonc
// signalman_release_build_remote
{
  "product": "myapp",
  "tag": "v1.4.3",
  "poll_interval_ms": 750
}
```

The call returns when the job hits `succeeded` or `failed`. Cold
builds typically take 30s–5min depending on the product's build
steps and artifact sizes; this tool may run for that long.

## Expected response

Success:

```jsonc
{
  "job": {
    "id": "01HX...",
    "status": "succeeded",
    "kind": "release.build",
    "error": null,
    "result": {
      "release_id": "01HX...",
      "manifest_sha256": "0a1b2c...",
      "artifact_count": 3
    }
  }
}
```

Failure:

```jsonc
{
  "job": {
    "id": "01HX...",
    "status": "failed",
    "kind": "release.build",
    "error": "component build failed: api: exit code 1, see build log",
    "result": null
  }
}
```

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `runner config is not registered` | No `runner.yaml` on the agent host. | Run `signalman-register-runner` first. |
| `HTTP 401` resolving product | Bearer token is missing / expired / revoked. | Rotate via `signalman-mint-api-key` and re-register the runner with the new token. |
| `HTTP 404 product not found` | Product name typo, or the product was soft-deleted. | Suggest `signalman_product_list` to find the right name. |
| Job `failed` with `component build failed` | The product's build commands exited non-zero. **Not the worker's fault.** | Surface the error message; the operator needs to inspect the build log via `signalman_release_show <release_id>` if a release row was created, or the worker's stderr otherwise. |

## What NOT to do

- **Don't** auto-retry a `failed` job — the failure is usually in
  the product's `signalman.build.yaml` or its source tree at that
  tag. Retrying without fixing anything just burns cycles.
- **Don't** set `poll_interval_ms` below ~250ms — the control plane
  serves the job-status endpoint on every poll, and an aggressive
  loop wastes CPU on both sides without faster wall-clock progress.
- **Don't** assume "no workers running" means "tool is broken." With
  zero registered workers, the job sits in `queued` and this tool
  polls forever. Suggest the operator confirm at least one runner
  is `signalman runner start`-ed before submitting.
- **Don't** call this tool to "test the queue" — every submission
  creates a real job row, consumes runner time, and writes a release
  row on success. If the user wants to verify queue health, point
  them at `signalman_release_list` to see recent activity instead.
- **Don't** confuse this with the in-process `signalman_release_build`
  — that tool runs the build inside the host process. The remote
  variant is for "control plane on one host, runners on others."

## Follow-up suggestions

After `succeeded`:
- `signalman_release_show <result.release_id>` to inspect the
  manifest + artifacts.
- `signalman-verify-release` against the new release to confirm the
  signature (if the build signed).
- `signalman-deploy-to-test` or `-to-demo` to push it onto a target.

After `failed`:
- Surface the `error` message verbatim.
- If a partial release row was written, `signalman_release_show <id>`
  may include a `build_log_blob_uri` with the full log.
- Tell the operator to fix the product's build (commit + push a new
  tag) rather than re-submitting the same tag.
