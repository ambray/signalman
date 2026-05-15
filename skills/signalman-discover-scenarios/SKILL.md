---
name: signalman-discover-scenarios
description: Discover what signalman scenarios are available in the current project and read their contents without running them. Trigger when the user says "what scenarios are there", "list scenarios", "show me what's in scenario X", "what does <scenario> do", "describe <scenario>", or any variant of "browse the scenario library". The right starting move before run or plan.
allowed-tools: mcp__signalman__signalman_list, mcp__signalman__signalman_describe
---

# Discover signalman scenarios

This is the read-only entry point onto the scenario library. Two MCP
tools: `signalman_list` enumerates scenarios under
`.signalman/scenarios/`; `signalman_describe` returns one scenario's
parsed `setup.yaml` + `assertions.yaml` + workflow markdown. Neither
mutates state.

## What you need from the user

For `signalman_list` — nothing required:

- (Optional) `tag` — filter by tag string (`smoke`, `live`, `recorded`,
  `candidate`, etc.).
- (Optional) `pattern` — glob over the scenario id, e.g. `mygroup/**`,
  `live-*`, `**/smoke-*`. Use this when the project has many scenarios
  and the user is asking about a subtree.

For `signalman_describe` — the scenario `id`:

- The user's wording often maps to the scenario id directly
  (`live-hyperv-basic` etc.). If they're vague ("the deployment one"),
  list first, then pick from the result.

## How to invoke

```jsonc
// signalman_list
{ "tag": "smoke" }            // or {} for the full set

// signalman_describe
{ "id": "live-hyperv-basic" }
```

## Expected response

`signalman_list` returns an array of scenario summaries:

```jsonc
[
  {
    "id": "live-hyperv-basic",
    "name": "smoke: hyperv basic",
    "tags": ["smoke", "live"],
    "scenario_hash": "0a1b2c…",
    "last_run": { "status": "passed", "finished_at": "2026-05-10T…" }
  }
]
```

`scenario_hash` is the canonical-form SHA-256 over the three scenario
files; it changes on any semantic edit and is stable across whitespace
or comment changes. The `last_run` field is `null` when no run has been
recorded yet.

`signalman_describe` returns the parsed scenario contents:

```jsonc
{
  "id": "live-hyperv-basic",
  "setup": { "name": "…", "version": "…", "vms": [ … ], "setup": [ … ] },
  "assertions": { "assertions": [ … ] },
  "workflow_markdown": "# Hyper-V Basic Smoke\n…"
}
```

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `ScenarioNotFoundError` | The id doesn't exist under `.signalman/scenarios/`. | Surface the id; offer to run `signalman_list` to show what's actually there. |
| `ScenarioValidationError` | One of the scenario files (setup/assertions/workflow) failed to parse. | Surface the validation issue verbatim — it usually identifies the offending file + line. Do NOT attempt to "fix" the YAML; the operator owns the scenario authoring loop. |

## What NOT to do

- **Don't run the scenario from this skill.** Discovery is read-only.
  If the user moves from "what's there" to "run it," hand off to the
  `signalman-run-scenario` skill (or `signalman-plan-scenario` if they
  want a dry-run first).
- **Don't filter by `tags: [recorded, candidate]` silently** — recorded
  candidates are promotion-pending, not first-class scenarios. Surface
  them with the `[candidate]` marker if you list them, or filter them
  out by default if the user is browsing for "what can I run."
- **Don't paraphrase the workflow markdown.** It's the natural-language
  contract between scenario authors and LLM drivers; passing it through
  a paraphrase can drop steps. Quote verbatim or refer to it.

## Follow-up suggestions

After listing or describing:

- `signalman-plan-scenario` — dry-run the chosen scenario; resolves
  parameters and lists the step plan without mutating anything.
- `signalman-run-scenario` — execute the scenario and stream events.
- For a scenario tagged `[recorded, candidate]`, point the user at the
  scenario directory for review before they promote it to a regular
  scenario — `signalman record finalize` synthesised placeholders that
  need operator approval.
