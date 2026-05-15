---
name: signalman-health-history
description: Query past health-check results for a target's deployments, newest first. Returns per-deployment probe outcomes with timestamps. Trigger when the user says "show health history for <target>", "when did deploys to <target> last fail", "what's the probe history on win11-test", "audit the recent health checks", "did the demo target ever go red", or any "history" / "past" / "when did" intent against a target.
allowed-tools: mcp__signalman__signalman_health_history
---

# Read a target's past health checks

`signalman_health_history` is the historical companion to
`signalman_health_check`. Where `check` runs probes *right now*,
`history` returns the stored results from past `check` invocations
(implicit at deploy time + explicit operator runs), newest first.

Use this when:

- A deploy is now failing and the user wants to see whether health
  was already drifting on prior runs.
- The user is preparing a postmortem and needs the timeline of probe
  outcomes for one or more deployments.
- A target is on a `failed` deployment and the user wants to know
  when it last had a healthy run.

## What you need from the user

- **`target`** — target name (required). The user usually has this
  from `signalman_target_list` or knows it directly.
- (Optional) **`since`** — ISO-8601 lower bound on `checked_at`.
  `"2026-05-01T00:00:00Z"` returns entries from May onward. Omit for
  the full history.
- (Optional) **`limit`** — max entries per deployment. Default is
  unbounded (newest deployments tend to have only a few entries
  anyway). Set this when the user is asking for "the last N checks"
  rather than the full timeline.

## How to invoke

```jsonc
// signalman_health_history — full history for a target
{ "target": "win11-test-1" }

// scoped to a recent window
{
  "target": "win11-test-1",
  "since": "2026-05-07T00:00:00Z",
  "limit": 20
}
```

## Expected response

```jsonc
[
  {
    "deployment_id": "01HX…",
    "release_id": "01HW…",
    "release_tag": "v1.4.3",
    "entries": [
      {
        "checked_at": "2026-05-14T18:22:01Z",
        "probe_name": "api-up",
        "status": "pass",
        "latency_ms": 142,
        "detail": "HTTP 200, body matched /ok/"
      },
      {
        "checked_at": "2026-05-14T18:22:01Z",
        "probe_name": "queue-drained",
        "status": "fail",
        "latency_ms": 31000,
        "detail": "expected queue depth 0, observed 47"
      }
    ]
  },
  { "deployment_id": "01HW…", "release_id": "…", "entries": [ … ] }
]
```

Each row is one deployment's history; entries are newest-first within
each deployment. Multi-probe checks emit a row per probe per
`checked_at` instant.

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `TargetNotFoundError` | Target name doesn't exist. | Surface `signalman_target_list` for the right name. |
| `ValidationError` | Bad `since` (not ISO-8601) or non-positive `limit`. | Surface verbatim; ask for the corrected value. |

## What NOT to do

- **Don't re-run failing probes from this skill.** History is
  read-only. If the user wants to know "is it still failing right
  now," that's `signalman-health-check`, not this skill.
- **Don't paraphrase the `detail` field.** The probe authors put
  diagnostic information there for a reason — the matcher mismatch,
  the body excerpt, the exit code. Quote it.
- **Don't conflate `degraded` (reserved for partial-pass; not
  emitted in v0.2 — only `pass` / `fail` today) with `fail` if you
  see it in older history.** Surface what's stored.
- **Don't use this as a deploy audit log.** `signalman_health_history`
  only knows about probe outcomes. Operator-visible "who deployed
  what when" is in the HTTP `/v1/audit` log (P2 gap — no CLI/MCP
  surface today; the user has to `curl` it from `signalman serve`).

## Follow-up suggestions

- Recent `fail` entries: read the `detail` field aloud and offer
  `signalman_health_check` to confirm the failure is still live.
- A stretch of pass→fail→pass: ask the user if there's a redeploy
  between them; `signalman_release_list --product <name>` can
  correlate by `release_tag`.
- All entries `pass` but the user reports a problem: the failure is
  outside the declared probe set. Suggest adding a probe to the
  product's `signalman.build.yaml`; that's a product-repo change,
  not a Signalman change.
