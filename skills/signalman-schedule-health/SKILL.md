---
name: signalman-schedule-health
description: 'Set up periodic health-check schedules against deployed targets and manually trigger one-shot tick runs. Lists existing schedules, registers a new one with an interval and (optional) probe-name filter, surfaces disable/enable/remove, and fires `signalman_schedule_run_once` for verify-before-daemon flows or CI cron paths. Trigger when the user says "schedule health checks for <target>", "ping <target> every N minutes", "set up periodic probes on <target>", "run the scheduler once", "fire all schedules now", "verify the schedule fires", or asks to list/disable an existing schedule. CLI parity: `signalman schedule {list,add,disable,enable,remove,run-once,start}`.'
allowed-tools: mcp__signalman__signalman_schedule_list, mcp__signalman__signalman_schedule_add, mcp__signalman__signalman_schedule_disable, mcp__signalman__signalman_schedule_enable, mcp__signalman__signalman_schedule_remove, mcp__signalman__signalman_schedule_run_once, Bash
---

# Schedule periodic health checks

## What you need from the user

- **Target name** — must already exist. If the user is unsure, run `signalman target list`.
- **Interval** — minimum gap between runs, in seconds. The schema floor is 60s.
- **Probes (optional)** — comma-separated probe names from the target's active release's `signalman.build.yaml`. Omit for "all declared probes" (default).

## How to invoke

Add a schedule:

```bash
signalman schedule add --target <NAME> --interval-seconds <N> [--probes a,b,c] --format json
```

List schedules (optionally narrowed to a target):

```bash
signalman schedule list [--target <NAME>] --format json
```

Disable / re-enable / remove:

```bash
signalman schedule disable <ID>
signalman schedule enable <ID>
signalman schedule remove <ID>
```

### Run one tick manually (`signalman_schedule_run_once`)

Drive `signalman_schedule_run_once` when the operator says "fire the
scheduler now", "verify the schedule before I leave it running",
or pairs Signalman with an external cron / Kubernetes CronJob (the
cron entry calls `signalman schedule run-once` every N seconds in
place of the long-lived daemon):

```jsonc
// MCP
{}
```

```bash
signalman schedule run-once
```

Behaviour:

- Wakes once, enumerates all **enabled** schedules whose
  `next_run_at` has elapsed, runs each, records results.
- Disabled schedules are skipped even if they're past-due.
- Returns the count of schedules fired + any per-schedule
  pass/fail/error breakdown for the agent to surface.
- Idempotent across rapid-fire calls: a schedule that just ran
  won't run again until its interval has elapsed.

Two-mode operator pattern:

| Pattern | Fire path |
|---|---|
| Long-running host process | `signalman schedule start --tick-ms 60000` (daemon owns the tick loop). |
| External scheduler (cron / k8s CronJob / Jenkins / GHA cron) | `signalman_schedule_run_once` per tick. Lets the operator centralise scheduling on infra they already operate. |

Run the scheduler as a long-lived daemon (Ctrl-C to stop):

```bash
signalman schedule start [--tick-ms 60000]
```

## Expected behaviour

- Each tick wakes once per `tick-ms` (default 60s), enumerates active schedules, and runs the configured probes against the target's current active deployment.
- Results land in the existing `health_check` table — `signalman health history --target <NAME>` shows scheduled runs alongside operator-triggered ones.
- An audit-log entry is written per tick: `health.scheduled.pass`, `health.scheduled.fail`, or `health.scheduled.error`.
- A schedule with an empty `probes` list runs **all** declared probes (matches `signalman health check`'s default).

## Exit codes

| Exit | Meaning | What to say |
|------|---------|--------------|
| 0 | Command succeeded. | Surface the JSON output to the user. |
| 4 | Validation or infra error (target missing, interval too small, etc.). | Surface stderr; do NOT auto-retry. |

## What NOT to do

- Don't auto-shrink an interval the operator chose. If they ask for 30s and the schema rejects it (floor 60s), surface the error verbatim.
- Don't soft-delete or disable a schedule the user didn't ask you to touch — show them `schedule list` and let them pick.
- Don't poll `schedule run-once` in a tight loop to simulate the daemon — use `schedule start` instead.

## Follow-up suggestions

- After adding a schedule: `signalman schedule run-once` to verify the configured probes succeed.
- `signalman health history --target <NAME>` to inspect the trailing results once a few ticks have elapsed.
- If pairing with webhooks (Epic 2): `signalman webhook add` so failure events reach Slack / email / a generic endpoint.
