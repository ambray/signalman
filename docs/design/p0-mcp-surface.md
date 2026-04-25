# P0: MCP Surface Inversion — Design

**Status**: Draft, awaiting PM review
**Target**: v0.1.0
**Author**: P0 design pass, 2026-04-24
**Locks down**: API surface that P1 (service), P3 (envelope), P5 (Loom) consume.

## TL;DR

Today Signalman ships ~25 fine-grained MCP tools (`vm_*`, `docker_*`) registered in [`host/src/server.ts:155-177`](../../host/src/server.ts). Each is its own permission prompt; agents must compose 5–10 of them per task. We invert the surface: **the scenario is the unit of action**. Default agent surface becomes six verbs (`signalman.list / describe / plan / run / record / status`); the 25 fine-grained tools survive behind a `signalman.advanced.*` prefix that Claude Code permission rules can deny by default. Project layout moves from `signalman.yaml` + `scenarios/` to a `.signalman/` directory (mirrors `.github/workflows/`). CLI parity is locked from day one — same execution path, same envelope, same exit codes. `signalman.run` returns a **handle**; events stream over `signalman.status` long-poll, so the agent can react step-by-step.

---

## 1. The six MCP verbs

All verbs are exposed as MCP tools named `signalman_list`, `signalman_describe`, etc. (MCP SDK forbids `.` in tool names; the dot is user-facing convention.) All return JSON; protocol errors return MCP `isError: true` with a structured `error` body.

### 1.1 `signalman.list`

Enumerate scenarios under `.signalman/scenarios/` (recursive). No execution.

Params: `tag?: string`, `pattern?: string` (glob on id).

Return:
```json
{ "scenarios": [
  { "id": "ospiri-v2-network-egress",
    "path": ".signalman/scenarios/ospiri-v2-network-egress",
    "name": "Ospiri v2 Network Egress IOCTL Surface",
    "tags": ["driver","kernel","network"],
    "scenario_hash": "sha256:7e1c…",
    "last_run": {"started_at":"2026-04-23T18:02:11Z","result":"pass","duration_ms":187432} } ] }
```

`scenario_hash` = SHA-256 over canonicalized `setup.yaml` + `assertions.yaml` + `workflow.md`. `last_run` read from `.signalman/recordings/<id>/last-run.json` if present.

**Errors**: per-scenario YAML parse failures replace that entry's body with `{"id":"…","error":"yaml-parse: …"}`; the call still succeeds.

### 1.2 `signalman.describe`

Return scenario contents without executing.

Params: `id: string`.

Return:
```json
{ "id":"ospiri-v2-network-egress", "scenario_hash":"sha256:7e1c…",
  "setup": {/*parsed setup.yaml*/}, "assertions": {/*parsed assertions.yaml*/},
  "workflow_markdown": "## Step 1 — Load driver\n\n```tool\ndriver_load:\n  …\n```\n…",
  "capabilities": {"hosts":[], "networks":[]} }
```

`capabilities` is reserved for P4 (§3). v0.1.0 echoes whatever the YAML declared but does not enforce.

**Errors**: `not-found`, `yaml-parse`, `path-traversal` (mirrors today's [`runner.ts:222`](../../host/src/scenarios/runner.ts) check).

### 1.3 `signalman.plan`

Dry-run: load, validate, return resolved step plan without mutating state. Shares the runner code path through orchestrator entry; aborts before any backend mutation.

Params: `id: string`, `parameters?: object`.

Return:
```json
{ "id":"ospiri-v2-network-egress", "scenario_hash":"sha256:7e1c…",
  "vms":[{"name":"endpoint-1","template":"windows-11-clean","checkpoint_restore":"test-signing-warm"}],
  "steps":[
    {"kind":"vm.restore","vm":"endpoint-1","checkpoint":"test-signing-warm"},
    {"kind":"vm.copy_file","vm":"endpoint-1","src":"…drv.sys","dest":"C:\\Ospiri\\drv\\ospiri.sys"},
    {"kind":"tool.driver_load","vm":"endpoint-1","params":{}}],
  "affected_resources":{"vms":["endpoint-1"],"networks":["RevnTestSwitch"],
    "host_paths_read":["E:\\…\\drv\\…"],"host_paths_written":[]},
  "warnings":["scenario references host path outside .signalman/"] }
```

**Errors**: as `describe`, plus `parameter-unresolved` if a `${param:X}` reference has no matching supplied value.

### 1.4 `signalman.run`

Execute a scenario. **Returns a run handle synchronously**; events stream via `signalman.status` long-poll (§1.6). The agent calls `run`, then loops `status` until terminal.

Why handle, not block-to-completion: scenarios run for minutes. MCP stdio has no server-push primitive, and an agent blocked on `run` can't react step-by-step. Handle + subscribe is the only design that gives CLI tailing and agent reasoning the same primitive.

Params: `id: string`, `parameters?: object`, `network_class?: "isolated"|"nat"|"internet"` (default `"isolated"`; declared, not enforced — P4).

Return (immediate):
```json
{ "run_id":"run_2026-04-24T18-02-11Z_a3f2","scenario_id":"ospiri-v2-network-egress",
  "scenario_hash":"sha256:7e1c…","started_at":"2026-04-24T18:02:11Z","status":"running" }
```

When terminal, `status` returns the full envelope (§4).

**Errors**: `not-found`, `validation-error` (Zod), `backend-unavailable` returned at protocol level. `setup-failure` is reported in-envelope as a non-pass result, not as a protocol error.

### 1.5 `signalman.record` (stub for v0.1.0)

Captures the next N MCP calls into `.signalman/recordings/<run_id>/` as a candidate scenario. Full impl in v0.2.0; v0.1.0 stub returns:

```json
{ "status":"not-implemented", "message":"signalman.record lands in v0.2.0 (ROADMAP v0.2.0-1)." }
```

Params: `name: string`, `duration_seconds?: number` (default 600). The stub exists in v0.1.0 so prompts and Loom registration target the final shape; callers get "not implemented" rather than `tool-not-found`.

### 1.6 `signalman.status`

Two modes by param shape:

- **Environment** (no `run_id`): host health, backend, VM list, recent runs.
- **Run** (`run_id` set): drain events since `since_event_seq`; long-poll up to `wait_ms` for next event.

Params: `run_id?: string`, `since_event_seq?: number` (default 0), `wait_ms?: number` (default 0).

Run-mode return:
```json
{ "run_id":"run_…","status":"running",
  "events":[{"seq":12,"ts":"…","type":"step.started","step_index":4,"tool":"kernel_etw_start"}],
  "next_event_seq":13, "envelope": null }
```

When `status ∈ {passed, failed, error}`, `envelope` is the full §4 object and no further events will arrive.

Env-mode return: `{service_status, backend, vms[], recent_runs[]}`.

---

## 2. `.signalman/` directory layout

Mirrors `.github/workflows/` — discoverable, in-tree, version-controlled.

```
.signalman/
├── config.yaml             # replaces signalman.yaml (host config; same schema)
├── scenarios/              # in-tree scenarios this repo defines
│   ├── smoke/
│   │   ├── setup.yaml
│   │   ├── assertions.yaml
│   │   └── workflow.md
│   └── …
├── templates/              # VM templates referenced by setup.yaml `template:`
│   └── windows-11-clean.yaml
└── recordings/             # v0.2.0 record/replay; in v0.1.0 used only for last-run.json
    └── <scenario-id>/
        └── last-run.json
```

**Comparison with current**: `signalman.yaml` lives at repo root, shape-compatible with `.signalman/config.yaml` (same schema as [`config.ts:88`](../../host/src/config.ts)). `scenarios/` lives at root; its loader hard-codes `<projectRoot>/scenarios` ([`runner.ts:212-213`](../../host/src/scenarios/runner.ts)). New layout adds `templates/` (today's templates are in-code at [`templates.ts`](../../host/src/scenarios/templates.ts)) and `recordings/` (new).

**Migration plan** (no code in this PR):
1. Loader honors **both** locations during v0.1.0: `.signalman/scenarios/` first, fall back to `scenarios/` with a deprecation warning. `.signalman/config.yaml` similarly preempts `signalman.yaml`.
2. **Scenario relocation** (separate PR per ROADMAP "Examples" section):
   - `scenarios/ospiri-*`, `scenarios/silo-validation`, `scenarios/sandbox-enforcement` → `examples/` (Ospiri-owned).
   - Add 1–2 minimal in-tree scenarios under `.signalman/scenarios/` (e.g. `smoke/`) so the default project ships runnable.
3. `signalman init` subcommand scaffolds `.signalman/` with a default `config.yaml` and `scenarios/.gitkeep`.

---

## 3. Scenario YAML schema (v0.1.0 baseline)

The existing Zod schema in [`host/src/scenarios/schema.ts`](../../host/src/scenarios/schema.ts) (with `.passthrough()`) is the v0.1.0 baseline. Below are the **new** top-level fields P0 reserves; everything else (vms, setup, teardown, checkpoints, kernel_debug, sandbox_modes) carries forward unchanged.

```yaml
name: "Smoke — agent reachable"
version: "1.0"
tags: ["smoke"]

# RESERVED for P4 — v0.1.0 accepts but does not enforce.
# Documents what the scenario will touch; runner will refuse to step
# outside this set once P4 lands.
capabilities:
  hosts: ["endpoint-1"]
  networks: ["RevnTestSwitch"]
  host_paths:
    read:  ["./artifacts/**"]
    write: []

# RESERVED for P4 — secret reference primitive.
# `${secret:NAME}` resolves at run-time from a host-side keychain or
# env var. Never persisted in logs, recordings, or the result
# envelope (replaced with `***` in event payloads).
parameters:
  api_key: "${secret:OSPIRI_API_KEY}"
  endpoint: "${param:endpoint:-https://default.example}"

# Existing v0.1.0 fields (no change):
vms: [...]
setup: [...]
teardown: [...]
checkpoints: {...}
sandbox_modes: [...]    # optional, existing
```

Reservation rules for v0.1.0:
- `capabilities` and `parameters` parse with `.passthrough()` and are emitted on the `describe` response, but the runner does not gate on them.
- `${secret:NAME}` strings are tokenized but not resolved; if a scenario references one, `plan` returns a warning.
- `${param:NAME}` and `${param:NAME:-default}` are resolved at run time from `signalman.run`'s `parameters` arg.

The substitution implementation lives in the same scope as today's `${SANDBOX_MODE}` substitution ([`runner.ts:60-69`](../../host/src/scenarios/runner.ts)).

---

## 4. Result envelope JSON schema

Emitted identically by `signalman.run` (terminal) and the CLI (stdout, `--format json`).

```json
{ "envelope_version":"0.1.0",
  "run_id":"run_2026-04-24T18-02-11Z_a3f2",
  "scenario_id":"ospiri-v2-network-egress",
  "scenario_hash":"sha256:7e1c0a…",
  "agent_version":"signalman/0.1.0+abc1234",
  "network_class":"isolated",
  "started_at":"2026-04-24T18:02:11.014Z",
  "finished_at":"2026-04-24T18:05:18.477Z",
  "duration_ms":187463,
  "result":"pass", "exit_code":0,
  "assertions":{ "total":14, "passed":14, "failed":0,
    "results":[{"id":"etw-net-rule-matched-fired","passed":true,"severity":"critical","duration_ms":41}] },
  "events":[
    {"seq":0,"ts":"…014Z","type":"run.started","scenario_id":"ospiri-v2-network-egress"},
    {"seq":1,"ts":"…118Z","type":"vm.state_changed","vm":"endpoint-1","from":"Off","to":"Running"},
    {"seq":2,"ts":"…204Z","type":"step.started","step_index":0,"kind":"vm.restore"},
    {"seq":3,"ts":"…312Z","type":"step.completed","step_index":0,"duration_ms":108},
    {"seq":4,"ts":"…891Z","type":"assertion.passed","id":"etw-net-rule-matched-fired"},
    {"seq":5,"ts":"…477Z","type":"run.finished","result":"pass"}],
  "errors":[] }
```

### Event taxonomy

| Type | When emitted | Required fields |
|---|---|---|
| `run.started` | First event of every run | `scenario_id`, `scenario_hash` |
| `run.finished` | Last event of every run | `result` (`pass` / `fail` / `error`) |
| `step.started` | Each setup / teardown / workflow step | `step_index`, `kind` |
| `step.completed` | Successful step completion | `step_index`, `duration_ms` |
| `step.failed` | Step raised | `step_index`, `error` |
| `assertion.passed` | Assertion eval pass | `id` |
| `assertion.failed` | Assertion eval fail | `id`, `expected`, `actual` |
| `vm.state_changed` | Hypervisor reports VM transition | `vm`, `from`, `to` |
| `tool.started` / `tool.completed` | Each `signalman.advanced.*` tool invocation inside a workflow.md `tool` block | `tool`, `params_redacted` |
| `log` | Free-form host-side log line surfaced to client | `level`, `message` |

### Reserved for v0.2.0

- **`vm_lineage_hash`** (top-level): lands with ephemeral VM provisioning per ROADMAP "Hermetic Envelope (full triple)". v0.1.0 clients MUST treat the envelope as non-hermetic (VM is a soft input) when this field is absent.
- **`recording_path`** (top-level): lands when `signalman.record` ships.

---

## 5. CLI parity

Every MCP verb has a one-line CLI. Same execution path (the CLI imports the same handlers from `host/src/`), same envelope, same exit codes.

| MCP verb | CLI command | Notes |
|---|---|---|
| `signalman.list` | `signalman list [--tag T] [--pattern P]` | Default human table; `--format json` for envelope-shaped output |
| `signalman.describe` | `signalman describe <id>` | `--workflow` to print only workflow.md, `--format json` for full |
| `signalman.plan` | `signalman plan <id> [--param k=v]…` | Always JSON to stdout when `--format json`, otherwise human |
| `signalman.run` | `signalman run <id> [--param k=v]… [--follow]` | `--follow` (default true) tails events to stderr; `--format json` writes envelope to stdout on completion |
| `signalman.record` | `signalman record <name> [--duration 600]` | Stub in v0.1.0 |
| `signalman.status` | `signalman status [--run RUN_ID]` | No `run_id` ⇒ environment mode |

### Exit codes

The CLI maps the envelope's `exit_code` field 1:1 to its process exit code.

| Code | Meaning | When |
|---|---|---|
| 0 | `result == "pass"` | All assertions passed and threshold met |
| 1 | `result == "fail"` (assertions) | Any critical assertion failed, or score < threshold |
| 2 | `result == "fail"` (workflow) | A workflow tool block failed before assertions ran |
| 3 | `result == "error"` (setup) | Setup step or VM provisioning failed |
| 4 | `result == "error"` (infra) | Backend unavailable, host service unreachable |
| 5 | Validation error | Scenario YAML failed Zod parse, path traversal, etc. |
| 64 | Usage error | Bad CLI args; never sourced from envelope |

`signalman list` / `describe` / `plan` exit 0 on success regardless of underlying scenario state; their job is to return data, not to gate.

---

## 6. Advanced namespace

**Recommendation: tool-name prefix in a single MCP server, with default-deny on the prefix.**

[`server.ts`](../../host/src/server.ts) registers the six `signalman_*` verbs unconditionally, and registers the existing 25 fine-grained tools under names like `signalman_advanced_vm_run_command`. Claude Code's permission rules scope by prefix:

```jsonc
// .claude/settings.json (recommended project default)
{ "permissions": {
    "allow": ["mcp__signalman__signalman_*"],
    "deny":  ["mcp__signalman__signalman_advanced_*"] } }
```

Users who want raw VM ops opt in by replacing the deny rule with a narrower allow.

### Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Prefix in single server (recommended)** | One install path; permission-gated as Claude Code already supports; agents can be told to ignore advanced. | Both surfaces share one process — buggy advanced tool can take down `signalman.list`. | Pick. |
| Two stdio servers | Hard isolation; second server literally absent if not installed. | Doubles install + config; can't share VM cache; muddies CLI parity. | Reject. |
| Runtime capability toggle | Single registration. | Permission prompt still sees the advanced tool name, defeating the point. | Reject. |

Forward-compatible with P5 Loom: Loom registers only the six verbs, never the advanced ones, so the Loom-surfaced agent loop is the inverted one by default.

---

## 7. Migration plan: existing 25 tools

For each tool registered via `createAllTools` ([`tools/index.ts:34-46`](../../host/src/tools/index.ts)), specify destination. **Do not retire tools that scenarios use** — workflow.md `tool` blocks call them by name.

| Current tool | Disposition | Notes |
|---|---|---|
| `vm_list`, `vm_status` | Advanced + surfaced via `signalman.status` env mode | Default agent never lists raw VMs |
| `vm_start`, `vm_stop` | Advanced | Scenario `setup`/`teardown` owns lifecycle |
| `vm_run_command`, `vm_copy_file` | Advanced | Most-used in workflow.md `tool` blocks |
| `vm_install` | Advanced | Tool-detection / sandbox scenarios |
| `vm_screenshot` | Advanced | Stub today |
| `vm_checkpoint`, `vm_restore`, `vm_list_checkpoints` | Advanced | Used heavily in setup.yaml |
| `docker_compose_up/down`, `docker_status/logs/exec/wait_healthy` | Advanced | |
| `kernel_etw_start/stop` | Advanced | Workflow tool blocks |
| `driver_load/unload/ioctl`, `kernel_expect_bugcheck`, `kernel_break_on` | Advanced | Workflow tool blocks |

**Retirements**: none in v0.1.0. Revisit in v0.2.0 once scenarios are the only consumer — at that point the advanced tools could become fully internal (no MCP exposure).

**Mechanical change in [`server.ts`](../../host/src/server.ts)**: prepend `signalman_advanced_` to every tool name returned by `createAllTools`; register six new `signalman_*` verbs separately. ~30 LOC; Zod conversion + sanitization paths unchanged.

---

## 8. Open questions

Items unresolved from code + ROADMAP. Ordered by blocking-impact.

1. **(BLOCKING) Run handle lifetime + persistence.** If the host restarts mid-run (e.g. P1 service redeploy), does `run_id` survive? Options: (a) in-memory — restart returns `run_id-not-found` next `status`; (b) persist handle to `.signalman/recordings/<run_id>/state.json`, allow resume/query; (c) write-once envelope on completion, no resume. **Recommend (b)** for unattended-CI but it's more work. Need PM call.

2. **(BLOCKING) Parameter passing.** Per-invocation parameters: (a) `parameters:` section in setup.yaml declares names + defaults; run-time overrides from `--param k=v` or MCP `parameters` arg — strict, gives `describe` something to surface to the agent; (b) free-form `${param:X}` resolved from run-time bag — loose, no doc surface. **Recommend (a)**.

3. **(BLOCKING) Sub-directory scenario ids.** `.signalman/scenarios/smoke/setup.yaml` → id `smoke`. But `.signalman/scenarios/ospiri/v2/network-egress/setup.yaml` — id `ospiri/v2/network-egress`, `ospiri-v2-network-egress`, or forbid nesting? **Recommend**: id = relative path with `/` retained; forbid only when a directory has both `setup.yaml` and a child with `setup.yaml`.

4. Event buffer cap on `signalman.status`. Long scenarios emit thousands of events. `since_event_seq` paginates; pick a per-call cap (suggest 1000) and document.

5. `signalman.plan` — purely static, or probe backend cheaply (backend reachable, VM name resolves, checkpoint exists)? Static is faster; probing surfaces real failures earlier. Recommend cheap probe, no state mutation.

6. Allow scenarios outside `.signalman/scenarios/`? CI may want `--scenario ./examples/ospiri-v2-network-egress`. The traversal check at [`runner.ts:222`](../../host/src/scenarios/runner.ts) would need a configurable root.

7. Loom + advanced namespace. P5 says sibling-MCP / decoupled lifecycle. Confirm Loom registers only the six verbs, never the advanced ones (so the Loom-surfaced agent loop is inverted by default).

8. `network_class` enforcement timing. Declared-only in v0.1.0. Should v0.1.0 at least *log* declared-vs-actual divergence (cheap, loud if mismatched), or wait for P4?
