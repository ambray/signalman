---
name: signalman-reap-cloud-instances
description: Run the cost-reaper to terminate Signalman-managed cloud VMs whose TTL has expired. Trigger when the user says "clean up past-TTL VMs", "run the reaper", "kill anything expired in AWS/Azure", or asks why a forgotten test VM is still running. Each provisioned VM carries a `signalman-ttl-expires-at` tag (epoch seconds); the reaper polls every registered backend, terminates expired instances via the backend's idempotent terminate, and reports per-backend counts.
allowed-tools: mcp__signalman__signalman_reaper_run_once, mcp__signalman__signalman_reaper_status, Bash
---

# Reap past-TTL cloud instances

This skill drives the v0.3.0-5 sub-task 5 cost-reaper. The reaper is the
operator's defence against runaway cloud bills — every Signalman-provisioned
VM carries an expires-at tag at provision time, and the reaper terminates
anything past it.

## What you need from the user

- **Whether to run now or just check status.** "Run the reaper now" =
  `run_once` (one sweep, returns counts). "What did the last sweep do?"
  = `status` (returns the cached last result from the MCP server's
  process; null if it hasn't run yet).

The reaper is backend-agnostic — it sweeps every registered cloud
backend (AWS + Azure today). No per-provider flag needed.

## How to invoke

**Force a sweep (MCP)**:

```jsonc
// signalman_reaper_run_once
{}
```

**Force a sweep (CLI — useful in cron / CI)**:

```bash
signalman cloud reaper run [--format json]
```

**Check last sweep's result**:

```jsonc
// signalman_reaper_status
{}
```

```bash
signalman cloud reaper status [--format json]
```

## Expected response

Success (run_once):

```jsonc
{
  "ok": true,
  "value": {
    "startedAt": "2026-05-14T...Z",
    "finishedAt": "2026-05-14T...Z",
    "totalTerminated": 2,
    "backends": [
      {
        "backend": "aws",
        "inspected": 5,
        "noTtl": 1,
        "malformed": 0,
        "terminated": 2,
        "terminateErrors": []
      },
      {
        "backend": "azure",
        "inspected": 0,
        "noTtl": 0,
        "malformed": 0,
        "terminated": 0,
        "terminateErrors": []
      }
    ]
  }
}
```

Per-backend counts decompose:
- `inspected` — `listInstances` returned this many handles
- `noTtl` — instances without `signalman-ttl-expires-at` tag (legacy /
  externally-managed; skipped)
- `malformed` — instances whose TTL tag was non-numeric / negative /
  NaN (skipped + logged; guardrail against a single bad tag triggering
  mass-terminate)
- `terminated` — instances past TTL that were successfully terminated
- `terminateErrors` — per-instance terminate failures (vendor 503 etc)

CLI `run` exits 4 (not 0) if any backend hit a list-error or
terminate-error so CI scripts can detect a degraded sweep.

## Error codes you may see

The reaper itself rarely errors at the top level — per-backend errors
are recorded in the result, not thrown. Top-level failures are limited
to:

| `code` | What happened | What to tell the user |
|---|---|---|
| `auth_failed` | A backend's auth lapsed during sweep. The other backends still ran. | Surface the listError on the affected backend; operator fixes vendor creds. |
| `unsupported_provider` | A backend kind in the registry isn't recognised. | Should be impossible in production; flag for engineering. |

## What NOT to do

- **Never** terminate handles by hand based on reaper output without
  the operator's review. The reaper's intent is "clean up the
  past-TTL ones I provisioned"; an agent acting on listed handles
  outside that contract risks killing live workloads
- **Never** retry on a `terminateErrors` entry without surfacing the
  cause. Vendor 503s are usually transient but persistent ones
  indicate state drift (e.g. an instance moved to "stopping" between
  list and terminate)
- **Never** disable the reaper to "let a long-running scenario
  finish". The right knob is the scenario's `ttl_minutes` on
  provision — that's what the tag is computed from

## Follow-up suggestions

- After a sweep with non-zero `terminated`, the operator may want to
  check budget usage via `signalman_budget_usage` to see how much the
  reaped instances had accrued
- If `noTtl > 0`, those are pre-v0.3.0-5 instances or operator-tagged
  ones; the operator may want to re-tag them out-of-band so future
  sweeps catch them
- For continuous reaping, wire `signalman cloud reaper run` into cron
  / systemd (every 5 minutes per design §13.5). The MCP server can
  also run a background scheduler via `reaper.start()` (sub-task 6/7
  followup wires this into `signalman serve`)
