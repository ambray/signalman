---
name: signalman-plan-scenario
description: Dry-run a signalman scenario without executing it. Resolves parameter overrides, validates the loaded setup/assertions/workflow, and returns the step plan plus the resources the run would touch. Trigger when the user says "plan <scenario>", "dry-run <scenario>", "what would <scenario> do", "preview the steps for <scenario>", "validate the parameter overrides", or any variant of "check before I run."
allowed-tools: mcp__signalman__signalman_plan
---

# Plan (dry-run) a scenario

`signalman_plan` is the safe pre-flight verb. It loads the scenario,
applies parameter overrides, validates the result, and returns the
expanded step plan + the list of affected resources (VMs, files,
networks). **No state mutation, no VM boot, no command execution.**

Use this when:

- A scenario has unresolved parameters and the user wants to confirm
  what their `--param` overrides resolve to before committing.
- The user wants a human-readable preview of what the orchestrator
  will do, step-by-step.
- A `signalman_run` failed at the validation stage and the user wants
  to see exactly which parameter or assertion blocked it without
  re-firing the run.

## What you need from the user

- **Scenario `id`** — required. If the user is vague, list first
  (`signalman-discover-scenarios`).
- (Optional) `parameters` — a `Record<string, unknown>` of override
  values, matching the scenario's declared parameter set. The plan
  step is the right place to verify parameter typing before a real
  run.

## How to invoke

```jsonc
// signalman_plan
{
  "id": "mygroup/v2/checkout-flow",
  "parameters": {
    "user_count": 5,
    "skip_seeding": false
  }
}
```

## Expected response

```jsonc
{
  "id": "mygroup/v2/checkout-flow",
  "scenario_hash": "0a1b2c…",
  "parameters_resolved": { "user_count": 5, "skip_seeding": false, "browser": "edge" },
  "vms": [ { "name": "endpoint-1", "template": "win11-base", "network_class": "default-switch" } ],
  "steps": [
    { "index": 0, "action": "vm_run_command", "vm": "endpoint-1", "command": "powershell.exe", "args": [ … ] }
  ],
  "assertions": [ { "type": "command_succeeded", "vm": "endpoint-1", "step": 0 } ]
}
```

The `scenario_hash` here is the same value `signalman_run` will record
on the result envelope — useful if the user wants to confirm the
canonical form before running.

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `ScenarioNotFoundError` | Bad id. | Surface the id; suggest `signalman_list`. |
| `ScenarioValidationError` | The scenario files are malformed. | Surface the validation issue verbatim; this is a scenario-author bug. |
| `ParameterUnresolvedError` | The scenario declares a parameter that has no value (no default, no override). | List the unresolved names; ask the user for values. **Do NOT make them up.** |

## What NOT to do

- **Do not call `signalman_run` automatically after a successful plan.**
  Plan is the *checkpoint*; the user should explicitly say "run it"
  before you fire the orchestrator. Surface the plan, then ask.
- **Do not edit the scenario to "fix" a `ScenarioValidationError`.**
  The scenario lives in version control; the operator owns it.
- **Do not silently apply a default for a `ParameterUnresolvedError`.**
  The whole point of the plan step is to surface what the user owes
  the scenario.

## Follow-up suggestions

After a clean plan:

- `signalman-run-scenario` — execute with the same `id` + `parameters`.
- If the plan reveals an unexpected `vm_lineage_hash`-affecting
  ephemeral VM, point the user at the scenario's `setup.yaml` so they
  can confirm the template version before paying the boot cost.
