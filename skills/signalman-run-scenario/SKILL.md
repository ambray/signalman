---
name: signalman-run-scenario
description: Execute a signalman scenario and stream its events. Returns a run handle synchronously; events drain incrementally via signalman_status long-poll until the run terminates. Trigger when the user says "run <scenario>", "execute <scenario>", "kick off <scenario>", "do <scenario> on <target>", "test <product> with scenario X", or any clear "run this now" intent.
allowed-tools: mcp__signalman__signalman_run, mcp__signalman__signalman_status
---

# Run a scenario

`signalman_run` is the orchestrator entry point. It returns a run
handle synchronously; the run executes in the background and streams
events that `signalman_status` drains. Every run ends in one of four
exit-mapped states (pass / assert fail / setup error / infra error)
and produces a `ScenarioResult` envelope.

## What you need from the user

- **Scenario `id`** — required.
- (Optional) `parameters` — same shape as `signalman_plan`. **Prefer a
  prior `signalman_plan` call when parameters are involved** — it's
  cheap and surfaces unresolved fields before the VM boots.
- (Optional) `network_class` — one of `isolated`, `nat`, `internet`.
  This is **recorded in the result envelope; it is not a host
  network-policy switch.** Do not promise the user that "isolated"
  blocks egress; it only labels the run's hermetic identity.
- (Optional) `trace_id` — 32-char hex or dashed UUID. When you're
  invoked from a workflow that has a parent trace, pass the parent
  trace_id so log streams across host / service / guest correlate by
  `grep $trace_id`. Otherwise signalman generates one.

## How to invoke

Fire the run:

```jsonc
// signalman_run
{
  "id": "mygroup/v2/checkout-flow",
  "parameters": { "user_count": 5 },
  "network_class": "nat"
}
```

You'll get a handle:

```jsonc
{ "run_id": "run_2026-05-…_abc", "scenario_hash": "0a1b…", "trace_id": "…" }
```

Then drain events with long-poll. Repeat until the response carries a
terminal envelope:

```jsonc
// signalman_status (incremental)
{ "run_id": "run_2026-05-…_abc", "since_event_seq": 0, "wait_ms": 10000 }
```

A typical response while running:

```jsonc
{
  "run": { "status": "running", "started_at": "…" },
  "events": [
    { "seq": 0, "kind": "setup.vm.boot", "vm": "endpoint-1", "ts": "…" },
    { "seq": 1, "kind": "step.start", "step_index": 0, "ts": "…" }
  ],
  "next_since_event_seq": 2
}
```

When the run terminates, the response carries the full envelope:

```jsonc
{
  "run": { "status": "passed" },
  "envelope": {
    "status": "passed",
    "duration_ms": 18345,
    "setup_results": [ … ],
    "assertion_results": [ … ],
    "scenario_hash": "0a1b…",
    "vm_lineage_hash": "f4e5…",
    "agent_version": "0.2.1",
    "network_class": "nat"
  }
}
```

## Run-status mapping

| `envelope.status` | Meaning | What to surface |
|---|---|---|
| `passed` | All setup steps succeeded and every assertion held. | Run id + duration + assertion pass count. |
| `assertion_failed` | Setup ran clean; at least one assertion failed. | Surface the failing assertions verbatim — they identify which step + which expectation didn't hold. Do NOT auto-retry. |
| `setup_error` | A setup step failed before assertions could run. | Surface the setup step + error message. The scenario didn't reach the assertion phase. |
| `infra_error` | The orchestrator itself couldn't reach a VM / start an agent / copy a file. | Surface the message; this is usually a host-side fix (start the VM, fix mTLS, etc.). Different from `setup_error` which is in-scenario. |

## What NOT to do

- **Don't pass a `trace_id` you invented.** The whole point of trace
  correlation is that the upstream workflow root supplied it; making
  one up just hides the lineage. If you don't have one, omit it and
  let signalman generate it.
- **Don't poll `signalman_status` in a tight loop.** Use `wait_ms` (up
  to 30000) so the call long-polls. A tight loop wastes resources and
  isn't faster — the server returns when an event arrives or the
  timeout hits.
- **Don't promise hermetic identity when `network_class: "internet"`.**
  An internet-class run can pull in changing remote state and reduce
  the value of caching on `scenario_hash`. Surface this trade-off to
  the user.
- **Don't kill the host process to "stop" a run.** v0.3.0 doesn't
  expose a cancel verb; if the user wants to abort, ask them to
  confirm — orphaning ephemeral VMs costs them money on cloud, and
  the reaper takes its time.

## Errors you may see

| Error class | Likely cause | What to tell the user |
|---|---|---|
| `ScenarioNotFoundError` | Bad id. | Run `signalman_list` to find the right id. |
| `ScenarioValidationError` | Malformed scenario file. | Surface the validation message; this is a scenario-author bug. |
| `ParameterUnresolvedError` | A declared parameter has no value. | Ask the user for the missing parameter(s); don't guess. |

## Follow-up suggestions

After a terminal envelope:

- `passed` — point the user at the envelope's `scenario_hash` and
  `vm_lineage_hash` for caching context.
- `assertion_failed` — `signalman-discover-scenarios` to re-read the
  assertions, then propose specific edits (the operator owns the
  scenario file, you propose).
- `setup_error` / `infra_error` — surface the host-side log; the
  operator needs to fix the environment before re-running.
