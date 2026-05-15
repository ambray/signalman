---
name: signalman-record-scenario
description: Capture an ad-hoc agent-driven investigation as a reusable signalman scenario by starting a recording session, doing work, then finalising into setup/workflow/assertions placeholders for operator review. Trigger when the user says "record this as a scenario", "save what we're doing", "turn this session into a scenario", "start a recording", "finalise the recording", "promote rec_<id>", or any variant of "make this repeatable".
allowed-tools: mcp__signalman__signalman_record, mcp__signalman__signalman_record_finalize
---

# Record an agent session as a scenario

Record/replay is the agent-first differentiator (v0.3.0-1). Two MCP
tools: `signalman_record` opens a capture session that wraps every
subsequent `signalman_*` MCP call in a `withRecording` envelope and
appends it to `.signalman/recordings/<safe_name>/<recording_id>/calls.jsonl`;
`signalman_record_finalize` reads that capture and synthesises
candidate `setup.yaml` + `workflow.md` + `assertions.yaml` files for
operator review.

**The synthesised scenario is intentionally incomplete** — it's tagged
`[recorded, candidate]` and contains placeholders for VM template,
network class, and assertion outcomes. Operator review is mandatory
before promotion.

## What you need from the user

For `signalman_record`:

- **Scenario name** (`name`) — the slug the recording will live under.
  Pick something descriptive; the user will see it again at finalise
  time. `myproject/checkout-flow-v2` is better than `test`.
- (Optional) `duration_seconds` — defaults to 600s (10min). Recording
  expires automatically; running past expiry is a no-op (calls aren't
  captured).

For `signalman_record_finalize` — one of:

- `recording_id` — short form, e.g. `rec_2026-05-…_abc`. The most
  recent recording's id is the easiest path.
- `recording_path` — the full directory under
  `.signalman/recordings/<safe_name>/<recording_id>/`. Useful when
  multiple parallel sessions could collide.
- (Optional) `scenario_id` — override where the synthesised files go
  (default: `recordings/<safe_name>/<recording_id>/`).
- (Optional) `force` — overwrite an existing candidate at the target
  path. Default `false`; surface the existing path to the user before
  setting `true`.

## How to invoke

Start a recording:

```jsonc
// signalman_record
{ "name": "myproject/checkout-flow-v2", "duration_seconds": 1200 }
```

Response:

```jsonc
{
  "recording_id": "rec_2026-05-14T16-30Z_abc123",
  "path": ".signalman/recordings/myproject_checkout-flow-v2/rec_…/",
  "expires_at": "2026-05-14T16:50:00Z"
}
```

Now do the work — any `signalman_*` MCP call is captured. When done:

```jsonc
// signalman_record_finalize
{ "recording_id": "rec_2026-05-14T16-30Z_abc123" }
```

Response:

```jsonc
{
  "scenario_id": "recordings/myproject_checkout-flow-v2/rec_…",
  "files_written": [
    ".signalman/scenarios/recordings/.../setup.yaml",
    ".signalman/scenarios/recordings/.../workflow.md",
    ".signalman/scenarios/recordings/.../assertions.yaml"
  ],
  "tags": ["recorded", "candidate"],
  "review_needed": [
    "vms[0].template — synthesiser inferred win11-base; confirm",
    "assertions — no observed-failure pairs; consider adding stdout_matches per step"
  ]
}
```

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `RecordValidationError` | Bad name (special chars, etc.) or `duration_seconds` out of range. | Surface the validation message verbatim. |
| `ScenarioAlreadyExistsError` | Finalise target exists and `force` is `false`. | Surface the existing path; ask the user whether to set `--force` (destructive) or pick a new `scenario_id`. |
| `RecordingNotFoundError` | Bad `recording_id` / `recording_path`. | The recording may have been hand-deleted; surface where you looked. |

## What NOT to do

- **Do NOT call `signalman_record_finalize` with `force: true` without
  showing the user the conflicting path.** The synthesiser overwrites
  the entire scenario directory; an unintended overwrite can lose
  hand-edited reviewed scenarios.
- **Do NOT promote the synthesised scenario into the main scenario
  library by moving files yourself.** The `[recorded, candidate]` tag
  is the contract that says "operator must review before promotion."
  Tell the user to inspect, edit, then commit; promotion is their
  gesture, not yours.
- **Do NOT include secret tokens, passwords, or API keys in the
  recording session.** The capture path redacts known sensitive keys
  (`token`, `password`, `secret`, `auth`, `api_key`, `bearer`,
  `private_key`), but if the user types a literal secret into a free-form
  field, it will land in `calls.jsonl`. Surface this risk if the user
  is about to record a session that touches credentials.
- **Do NOT call `signalman_record` while another recording is active
  on the same name.** Multiple parallel recordings under one slug get
  unique `recording_id`s, but you'll confuse the user about which one
  to finalise. Surface the existing session.

## Follow-up suggestions

After finalise:

- Surface the `review_needed` list verbatim — the synthesiser tells
  the user exactly what placeholders exist.
- Suggest opening the synthesised `workflow.md` first — it's the
  natural-language anchor and where reviewer attention is highest-leverage.
- Once the user has reviewed + committed, the scenario joins the
  normal library and runs via `signalman-run-scenario` with the
  scenario id.
- Remind the user: the `[candidate]` tag stays until they remove it
  explicitly — that's the signal to readers that this scenario is
  promotion-pending.
