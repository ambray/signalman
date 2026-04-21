# Ospiri v2 Network Egress IOCTL Surface — Workflow

> **Narrator**: This scenario proves the scope-based network-egress
> control plane introduced in Sprint 60.11 C-2. Our driver owns an
> OspriNet scope primitive (a `u32` ScopeId + per-scope V2 rule table
> + PID->ScopeId map, parallel to OspriReg's primitive). This scenario
> is deliberately **pre-WFP** — it exercises the IOCTL dispatcher,
> V2 wire format, and PID->scope binding, but does **not** test the
> classify callback that will emit NetRuleMatched. That lands in
> queue item 4.

## Prerequisites confirmed by setup.yaml
- `test-signing-enabled` checkpoint restored on `endpoint-1`
- `C:\Ospiri\drv\ospiri.sys` (test-signed, `/INTEGRITYCHECK`-linked) deployed
- `C:\Ospiri\tools\net-spawn-helper.exe` deployed
- `sc create ospiri type=kernel start=demand` ran; service is STOPPED

## Step 1: Load the driver

```tool
driver_load:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

## Step 2: Start ETW capture targeting Ospiri.Driver's SCOPE+RULES streams

Sprint 60.11 landed the `Ospiri.Driver` TraceLogging provider
(`{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}`). For this scenario we
capture three keywords:

  * `0x4`  SCOPE       - NetScopeCreated / NetScopeDestroyed /
                         NetProcessBound / NetProcessUnbound
  * `0x8`  RULES       - NetRuleAdded / NetRulesListed
  * `0x10` ENFORCEMENT - NetRuleMatched (WFP classify callback)

Combined mask: `0x1C`.

Unlike the registry-deny scenario, we capture SCOPE + RULES keywords
so the scope/rule IOCTL lifecycle events surface. ENFORCEMENT is
pre-included but the scenario expects 0 NetRuleMatched events until
WFP wire-up (queue item 4) activates the classify callback. Pre-
including the keyword here means queue item 4 only needs to add a
single NetRuleMatched assertion — no workflow.md profile changes
required at that point.

```tool
kernel_etw_start:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  keywords: "0x1C"
  level: 5
  timeout_ms: 180000
```

## Step 3: Run the OspriNet IOCTL sequence

`net-spawn-helper.exe --mode orchestrator` performs (in order):

| Sub-step | Call                                                     | Expect                  |
| -------- | -------------------------------------------------------- | ----------------------- |
| a        | `CreateFileW("\\\\.\\ospiri-net")`                       | success                 |
| b        | `IOCTL_OSP_NET_INIT_SCOPE` (ScopeId=0x42)                | STATUS_SUCCESS          |
| c        | `IOCTL_OSP_NET_ADD_RULE` (DENY+DOMAIN_SUFFIX example.invalid, port 0) | STATUS_SUCCESS, RuleId  |
| d        | `IOCTL_OSP_NET_ADD_RULE` (ALLOW+EXACT_V4 10.0.0.1, port 443) | STATUS_SUCCESS, RuleId  |
| e        | `IOCTL_OSP_NET_LIST_RULES`                               | RuleCount == 2          |
| f        | `CreateProcessW` worker (CREATE_SUSPENDED)               | success                 |
| g        | `IOCTL_OSP_NET_BIND_PROCESS` (ScopeId=0x42, pid=worker)  | STATUS_SUCCESS          |
| h        | `ResumeThread`                                           | success                 |
| i        | `WaitForSingleObject` (worker)                           | worker exit code == 0   |
| j        | `IOCTL_OSP_NET_UNBIND_PROCESS` (pid=worker)              | STATUS_SUCCESS          |
| k        | `IOCTL_OSP_NET_DESTROY_SCOPE` (0x42)                     | STATUS_SUCCESS          |

The worker (child process), running inside its bound scope,
performs:

| Sub-step | Call                                                     | Expect                  |
| -------- | -------------------------------------------------------- | ----------------------- |
| w1       | `list_rules_as_bound_child`: LIST_RULES on 0x42          | RuleCount == 2          |
| w2       | `init_foreign_scope`: INIT_SCOPE on 0xDEAD               | STATUS_SUCCESS          |
| w3       | `destroy_foreign_scope`: DESTROY_SCOPE on 0xDEAD         | STATUS_SUCCESS          |

The worker writes `{matched, steps[], mismatches[], scope_id, device}`
JSON to `--output` and exits 0 iff all 3 sub-steps passed. The
orchestrator exits 0 iff every sub-step (orchestrator + worker)
matched its expected outcome.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\tools\\net-spawn-helper.exe"
  args: ["--mode", "orchestrator", "--verbose", "--output", "C:\\Ospiri\\logs\\net-spawn-worker.json"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 4: Stop ETW capture and parse events

`kernel_etw_stop` runs `logman stop <session> -ets`, pulls events via
`Get-WinEvent -Path <etl>`, filters to the Ospiri.Driver GUID, and
returns `event_counts` as structured JSON. For this scenario we
expect (per-event-name counts):

| Event              | Expected | Why                                                  |
| ------------------ | -------- | ---------------------------------------------------- |
| NetScopeCreated    | 2        | orchestrator INIT 0x42 + worker INIT 0xDEAD          |
| NetRuleAdded       | 2        | orchestrator's DENY + ALLOW rules                    |
| NetProcessBound    | 1        | orchestrator BIND worker to 0x42                     |
| NetProcessUnbound  | 1        | orchestrator explicit UNBIND                         |
| NetScopeDestroyed  | 2        | orchestrator DESTROY 0x42 + worker DESTROY 0xDEAD    |
| NetRulesListed     | >=2      | orchestrator LIST + worker LIST (diag only)          |
| NetRuleMatched     | 0        | WFP classify callback not wired yet (queue item 4)   |

The timeout budget is generous (180 s) because on a cold-booted VM
`Get-WinEvent` has to load its ETW parser cache before it can read
the ETL; first invocation after boot can take 30-60 s, subsequent
ones are sub-second.

`max_events_returned` is bumped to 40 (vs the registry scenario's 20)
because this scenario emits 2x-3x the event volume across its scope
+ rule + bind lifecycle.

```tool
kernel_etw_stop:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  max_events_returned: 40
  timeout_ms: 180000
```

## Step 5: Capture worker report for post-run inspection

The orchestrator wrote `C:\Ospiri\logs\net-spawn-worker.json` with
the worker's per-step pass/fail matrix. Pull it back to the host so
signalman can surface the details via `stdout_contains` on the step
output.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-NoProfile", "-Command", "Get-Content -Raw -Path 'C:\\Ospiri\\logs\\net-spawn-worker.json'"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 6: Driver unload

Driver Verifier runs leak-check on unload — any OspriNet scope
state, process-map entry, or RCU-freed V2 rule-table leak would
bugcheck here.

```tool
driver_unload:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

## Expected outcomes

| Step | Check                                     | Expected          |
| ---- | ----------------------------------------- | ----------------- |
| 1    | driver_load                               | exit 0, Running   |
| 2    | kernel_etw_start                          | status 0          |
| 3    | net-spawn-helper orchestrator + worker    | exit 0            |
| 4    | kernel_etw_stop + event counts            | counts match      |
| 5    | worker JSON report                        | matched=true      |
| 6    | driver_unload                             | exit 0, Stopped   |

A green run proves:

  (a) the OspriNet IOCTL dispatcher works end-to-end
  (b) the V2 wire format encoder/decoder round-trips cleanly
  (c) PID -> scope binding is observable from inside the bound child
  (d) the new ETW emissions in net_ioctl.c reach user-mode

...with **zero** dependency on WFP. Queue item 4 adds the classify
callback and a single new `NetRuleMatched` assertion to prove
enforcement actually fires on a real connect() attempt.
