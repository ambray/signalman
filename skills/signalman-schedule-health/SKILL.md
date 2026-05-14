---
name: signalman-schedule-health
description: Set up a periodic health-check schedule against a deployed target. Lists existing schedules, registers a new one with an interval and (optional) probe-name filter, and surfaces disable/remove paths. Trigger when the user says "schedule health checks for <target>", "ping <target> every N minutes", "set up periodic probes on <target>", or asks to list/disable an existing schedule.
allowed-tools: Bash
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

Run one tick manually (useful for CI cron paths and for verifying a schedule before letting it run unattended):

```bash
signalman schedule run-once
```

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
