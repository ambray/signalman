---
name: signalman-register-target
description: Register, list, or soft-delete a signalman deploy target (a VM or docker-compose host that release deploy can push onto). Trigger when the user says "add target <name>", "register a test VM", "register a docker target", "list targets", "remove target <name>", or hits a TargetNotFoundError from release deploy and needs to register first.
allowed-tools: mcp__signalman__signalman_target_add, mcp__signalman__signalman_target_list, mcp__signalman__signalman_target_remove
---

# Manage signalman deploy targets

A *target* is the deployable surface (a Hyper-V / Tart VM, or a docker
host) that `signalman release deploy` pushes onto. Every deploy
references a registered target. Three MCP tools cover the lifecycle:
`signalman_target_add`, `signalman_target_list`, `signalman_target_remove`.

This is the **precondition skill** — if a deploy returns
`TargetNotFoundError`, this is the recovery path.

## What you need from the user

For `signalman_target_add`:

- **`name`** — unique per org. Convention: include the tier (`-test`,
  `-demo`, `-staging`) in the name so the deploy skills can pick the
  right one.
- **`kind`** — one of `vm_test`, `vm_demo`, `docker_test`, `docker_demo`.
  The kind determines which deploy backend handles it. Test tiers are
  the disposable surface; demo tiers are the clean surface (see the
  two-tier deploy skills).
- **Connection details** — one of:
  - For VM kinds: **`vm_name`** (the Hyper-V / Tart VM name) and
    optionally **`backend`** (config override if you need a non-default
    hypervisor for this target).
  - For docker kinds: a **`connection`** object — raw JSON forwarded to
    the deploy backend. Schema is `kind`-specific; ask the user for
    the connection string from their docker host setup.
- Caller can pass a raw `connection` object that overrides the
  individual `vm_name` / `backend` fields. Useful for advanced cases
  (custom socket paths, etc.).

For `signalman_target_list` — nothing required.

For `signalman_target_remove`:

- **`name`** — soft-delete; past deployments stay in the ledger and
  are still visible via `signalman_health_history`.

## How to invoke

```jsonc
// signalman_target_add — VM
{
  "name": "win11-test-1",
  "kind": "vm_test",
  "vm_name": "Win11_test_1",
  "backend": "hyperv"        // optional override
}

// signalman_target_add — docker
{
  "name": "demo-stack",
  "kind": "docker_demo",
  "connection": {
    "host": "ssh://deploy@demo.example.com",
    "compose_project": "myapp"
  }
}

// signalman_target_list
{}

// signalman_target_remove
{ "name": "win11-test-1" }
```

## Expected response

`signalman_target_add` returns the new target record:

```jsonc
{
  "id": "01HX…",
  "name": "win11-test-1",
  "kind": "vm_test",
  "connection": { "vmName": "Win11_test_1", "backend": "hyperv" },
  "created_at": "2026-05-14T…"
}
```

`signalman_target_list` returns active targets:

```jsonc
{
  "targets": [
    { "id": "…", "name": "win11-test-1", "kind": "vm_test", "connection": { … } }
  ]
}
```

`signalman_target_remove` returns `{ "removed": true }`.

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `TargetAlreadyExistsError` | `add` against an existing name. | Surface the existing target from `list`; ask whether to remove + re-add or keep. |
| `TargetNotFoundError` | `remove` (or downstream `deploy`) against a non-existent name. | Surface `list` so the operator can pick the right name. |
| `ValidationError` | Malformed kind, empty name, missing `vm_name` for a VM kind, etc. | Surface verbatim. |

## What NOT to do

- **Don't try to "edit" a target's connection details.** Signalman
  v0.3.0-5 has no `target edit` verb; the recovery path is `remove` +
  re-`add` with the new connection. Surface this to the user before
  they ask why the verb doesn't exist.
- **Don't pre-validate that the VM exists by booting it from the
  skill.** Target registration is metadata-only; the first deploy
  will surface a `TargetUnreachableError` with a clearer host-side
  message if `vm_name` is wrong. Cheap registration is intentional.
- **Don't soft-delete a target the user is actively deploying to.**
  The soft-delete is recoverable through the database but not through
  the CLI/MCP; if they only want to "pause" deploys, ask the user
  first.
- **Don't conflate target *kind* and target *tier*.** Two targets can
  share `kind: vm_test` but represent different VMs; the kind drives
  the deploy backend, not the operator's deploy policy. The
  `signalman-deploy-to-test` and `signalman-deploy-to-demo` skills
  encode the tier policy on top.

## Follow-up suggestions

After `add`:

- For VM kinds: `signalman_advanced_vm_status --name <vm_name>` to
  confirm signalman can reach the VM before the first deploy.
- `signalman-deploy-to-test` / `signalman-deploy-to-demo` — push the
  first release once the target is registered.

After `list`:

- If the user is browsing for "where can I push," point them at the
  deploy skills.

After `remove`:

- Surface that past deployments remain in `signalman_health_history`
  so the operator knows historical data isn't lost.
