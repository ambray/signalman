---
name: signalman-health-check
description: Run signalman health probes against a target VM and summarize the result. Default behavior runs every probe declared in the active release's signalman.build.yaml. Triggers on "check health of <target>", "are the probes passing on <target>", "is <target> healthy".
allowed-tools: Bash
---

# Health-check a target

Two layers always run:

1. **`vm_reachable`** floor — is the VM running and reachable from the host service.
2. **Declared probes** — every entry from `probes:` in the active release's `signalman.build.yaml`. Typical entries include service-status checks (`agent_service`), kernel-component checks (`driver_minifilter`), HTTP health endpoints (`backend_health`), and any other operator-declared probes.

Each probe result becomes a `health_check` row attached to the target's current active deployment.

## How to invoke

```bash
# All declared probes:
signalman health check --target <NAME>

# Subset (comma-separated):
signalman health check --target <NAME> --probe agent_service,backend_health

# Against a specific release (not the active one):
signalman health check --target <NAME> --release <RELEASE_ID>
```

`--format json` is supported for structured output.

## Reading the result

Plain-text output is one line per probe:

```
Target 'win11-demo' — release v1.2.0 (01K…)
  vm_reachable: pass  (ip=10.0.0.5)
  agent_service: pass  (exit=0)
  backend_health: fail  (expected HTTP 200, got 502)
  dashboard_load: pass  (status=200)
  …
```

Exit code is `0` when every probe passes, `1` when any probe fails (so CI can branch on it), `4` on infra errors.

## When to use which mode

- **Default (all probes)** — quick "is everything OK".
- **Filtered probes** — when triaging a specific failure ("is the backend up?" → `--probe backend_health`).
- **`--release` override** — comparing a candidate release against the current target state without deploying. Note: this runs the candidate's probes against *whatever's currently on the VM*; it doesn't deploy anything.

## What NOT to do

- Don't gate a deploy on this — the deploy executor already runs the same probes as its own gate.
- Don't loop this skill on a fast interval expecting it to "fix" something. Probes observe; they don't repair.

## Follow-up suggestions

- `signalman health history --target <NAME>` for the full timeline.
- `signalman release rollback --target <NAME>` if probes are failing and the current release is suspect.
