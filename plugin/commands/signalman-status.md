---
name: signalman-status
description: Day-2 SRE one-shot — synthesises recent releases, pending promotions, failing probes, stale runners, and (if configured) cloud budget into a ~10-line "what's broken / pending / stale" answer. Lead with what needs attention; suppress green-state noise.
---

# /signalman-status

You are running the `/signalman-status` slash command for signalman.
Produce a tight, day-2 SRE-flavoured status snapshot. The audience is
an operator on-call who has 15 seconds to decide whether anything
needs their hands on the keyboard.

**Tone:** what's broken / pending / stale. NOT what's set up or
healthy. If everything is green, say "all green" in one line and stop.

**Output budget:** ~10 lines total. Each section gets 1-3 lines.
Suppress sections entirely when they have nothing to report.

## Synthesis logic — the 5 sub-queries

Run these MCP tool calls in parallel (or as close to parallel as the
host allows). Each maps onto a section of the answer.

### 1. Recent releases (last 5)

Call `signalman_release_list` (no filters). Take the 5 most recent.
For each, report:

- Release id (short form)
- Status — one of: built, signed, deployed, failed
- Age relative to now (e.g. "12m ago", "3h ago")

**Lead with any `failed` releases.** If there are no failed releases
in the last 5, summarise as "5/5 recent releases healthy" in one line.

### 2. Pending promotions

Call `signalman_promotion_approvals` to list approvals. Filter to
`status == "pending"`.

- For each pending promotion, report: release id, target env, age.
- Lead with the **oldest** pending promotion (highest blocking risk).
- If nothing is pending, omit this section entirely.

### 3. Failing probes (last hour)

Call `signalman_health_history` filtered to the last 60 minutes. Take
entries where `status == "fail"`.

- Report: target id, probe name, age of failure, last successful
  probe timestamp (if any).
- Group by target if multiple probes failed on the same target.
- If nothing failed, omit this section entirely.

### 4. Stale runners

Call `signalman_runner_list`. For each runner, compute (now -
`last_heartbeat_at`). Report runners where the gap is > 5 minutes.

- Report: runner id, role, stale duration, last known status.
- Lead with the longest-stale runner.
- If all runners are heartbeating, omit this section entirely.

### 5. Cloud budget (only if cloud is configured)

Call `signalman_budget_get`. If the response indicates no cloud
backend is configured (e.g. empty `backends` list or a "not
configured" error), **suppress this section entirely** — most OSS
users will never use cloud, and a "cloud not configured" line is
noise.

If cloud IS configured:

- Call `signalman_budget_usage` and report current spend vs. budget.
- If usage > 80% of budget, lead with this.
- If usage < 50%, condense to a single line.

## Output format

```
signalman status @ <iso-timestamp>

[Releases]
- rel_abc12 deployed 12m ago
- rel_def34 FAILED build 1h ago  ← oldest failure
- (3 more healthy)

[Pending promotions]
- rel_abc12 → prod, awaiting approval 2h ago

[Failing probes]
- target_xyz: http-200 failing 8m (last green: 25m ago)

[Stale runners]
- runner_runner_01 (build-amd64): no heartbeat 12m  ← stalest

[Cloud]
- $43 / $200 monthly budget (22%)
```

If everything is healthy:

```
signalman status @ <iso-timestamp>: all green
- 5/5 recent releases healthy
- no pending promotions
- no failing probes (last hour)
- all runners heartbeating
- cloud not configured
```

## Failure modes — handle gracefully

- **MCP server not running.** If the first tool call errors with
  "connection refused" or similar, surface that as the entire answer:
  `signalman MCP server not reachable; check that 'node host/dist/server.js' is running.`
  Do not attempt the remaining queries.
- **Empty signalman.** If `signalman_release_list` returns zero
  releases AND `signalman_runner_list` returns zero runners, this is
  a fresh install. Output `signalman bootstrapped, no releases or
  runners yet — try /signalman-bootstrap-status` (which will exist in
  v0.2.0; for now, the user knows it's a bootstrap state).
- **Partial failure.** If one of the 5 sub-queries fails but others
  succeed, report what you have and add a single line at the end:
  `[partial] <sub-query-name> failed: <short reason>`.

## Acceptance criterion

Per the WS7 detail design (`docs/design/v0.5-claude-plugin.md` §Story
3): against a freshly-bootstrapped signalman with one product + one
release, this command returns a coherent ~10-line answer in < 5
seconds.

## Why no `signalman_status` direct call

The host exposes a `signalman_status` MCP tool, but its semantics are
scenario-run status, not the deployment/release synthesis we want
here. The 5 sub-queries above produce the SRE-relevant aggregate; do
not call `signalman_status` for this command.
