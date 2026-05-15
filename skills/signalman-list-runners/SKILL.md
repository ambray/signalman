---
name: signalman-list-runners
description: List registered Signalman build runners and their last-seen timestamps. Each row carries an `is_stale` flag computed from `last_seen_at` plus a configurable threshold. Trigger when the user says "list runners", "what runners are alive", "is the runner heartbeating", "show registered workers", "any builders online", or any "who's polling the queue" intent.
allowed-tools: mcp__signalman__signalman_runner_list
---

# List Signalman build runners

`signalman_runner_list` returns the registered runners for the
active org. Each entry includes:

- the raw runner row (`id`, `name`, `last_seen_at`, `registered_at`,
  `meta`)
- a derived `is_stale` boolean: `true` when `last_seen_at` is older
  than the staleness threshold (default 90s — matches the worker
  heartbeat cadence of 30s with two missed beats)

Stale rows are NOT auto-removed. They stay in the list so operators
can see "this worker was here recently and stopped." To actually
prune a dead worker, hand off to `signalman-deregister-runner`.

## What you need from the user

Nothing required. The tool defaults to the standard 90-second
threshold.

- (Optional) **`stale_threshold_seconds`** — change the staleness
  cutoff. Range [1, 86400]. Useful when the operator's heartbeat
  cadence is non-default or they want to see "anyone alive in the
  last hour."

## How to invoke

```jsonc
// Default threshold (90s)
{}

// Hourly check (anything that hasn't heartbeat in an hour is stale)
{ "stale_threshold_seconds": 3600 }
```

## Expected response

```jsonc
{
  "runners": [
    {
      "id": "01HX1234ABCD...",
      "name": "builder-mac-01",
      "last_seen_at": "2026-05-15T14:22:01.123Z",
      "registered_at": "2026-05-14T08:00:00.000Z",
      "meta": { "hostname": "mac-01.lan", "version": "0.3.0-5" },
      "is_stale": false
    },
    {
      "id": "01HW9876ZYXW...",
      "name": "ci-builder-2",
      "last_seen_at": "2026-05-15T14:18:42.000Z",
      "registered_at": "2026-04-30T...",
      "meta": null,
      "is_stale": true
    }
  ]
}
```

The list is sorted newest-`last_seen_at`-first. An empty `runners`
array means no workers are registered against this control plane (or
all have been deregistered).

## Interpreting `is_stale`

| Pattern | What it likely means |
|---|---|
| All `is_stale: true` | The control plane is up but no workers are running. Builds will queue indefinitely. Suggest `signalman runner start` somewhere. |
| Mixed stale + fresh | Some workers dropped; others are healthy. The fresh ones will pick up new work; the stale ones either need restarting or deregistering. |
| All `is_stale: false` | Fleet healthy. New `release.build` jobs should claim within ~1 poll interval. |

## What NOT to do

- **Don't auto-deregister stale runners.** Staleness is a heuristic;
  the operator may know the worker is "paused for maintenance" or
  "rebooting between jobs." Surface stale rows; let the operator
  decide.
- **Don't poll this aggressively.** The list is for human / agent
  inspection, not a heartbeat substitute. Workers already heartbeat
  every 30s; polling this MCP tool every second wastes resources.
- **Don't infer "this runner can claim job X" from the list.** The
  list shows who's *alive*; capability filtering (which job kinds a
  runner handles) is per-job and not exposed in this row.
- **Don't conflate `is_stale` with `failed`.** A stale runner may
  come back when the worker process restarts (heartbeat resurrects
  the row with a fresh `registered_at`). A failed deploy is a
  separate concept (see `signalman-health-history`).

## Follow-up suggestions

- All `is_stale: true`: tell the operator to run
  `signalman runner start` on a host that has `~/.signalman/runner.yaml`.
  If they don't have one yet, point at `signalman-register-runner`.
- A stale runner that should be permanently retired:
  `signalman-deregister-runner` with the row's name or id.
- Diagnosing "why isn't my build picking up": call this skill first;
  if the fleet is healthy, the issue is on the job side (look at
  `signalman_release_list --status failed` or the job's error
  message via `signalman release show <id>`).
