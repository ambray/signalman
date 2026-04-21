# Example v2 Network Egress IOCTL Surface — Workflow

> **Narrator**: This scenario proves the scope-based network-egress
> control plane introduced in Sprint 60.11 C-2 AND the live WFP
> classify callback wired in Sprint 60.8b Phase 2 commit 5. Our driver
> owns an ExampleNet scope primitive (a `u32` ScopeId + per-scope V2 rule
> table + PID->ScopeId map, parallel to ExampleReg's primitive), and the
> WFP filter on ALE_AUTH_CONNECT_V4/V6 now actively consults that
> table on every outbound connect(). This scenario exercises the IOCTL
> dispatcher, V2 wire format, PID->scope binding, AND real connect()
> block/allow outcomes — plus the `NetRuleMatched` ETW event (keyword
> 0x10 = ENFORCEMENT) that fires on each BLOCK verdict.

## Prerequisites confirmed by setup.yaml
- `test-signing-enabled` checkpoint restored on `endpoint-1`
- `C:\Example\drv\example.sys` (test-signed, `/INTEGRITYCHECK`-linked) deployed
- `C:\Example\tools\net-spawn-helper.exe` deployed
- `sc create example type=kernel start=demand` ran; service is STOPPED

## Step 1: Load the driver

```tool
driver_load:
  service: example
  expect_status: 0
  timeout_ms: 15000
```

## Step 2: Start ETW capture targeting Example.Driver's SCOPE+RULES streams

Sprint 60.11 landed the `Example.Driver` TraceLogging provider
(`{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}`). For this scenario we
capture three keywords:

  * `0x4`  SCOPE       - NetScopeCreated / NetScopeDestroyed /
                         NetProcessBound / NetProcessUnbound
  * `0x8`  RULES       - NetRuleAdded / NetRulesListed
  * `0x10` ENFORCEMENT - NetRuleMatched (WFP classify callback)

Combined mask: `0x1C`.

Unlike the registry-deny scenario, we capture SCOPE + RULES keywords
so the scope/rule IOCTL lifecycle events surface. The ENFORCEMENT
keyword (0x10) is now **actively** monitored because Sprint 60.8b
Phase 2 commit 5 wired the live WFP classify callback — the worker's
connect() to the DENY target fires a `NetRuleMatched` event per
BLOCK verdict. assertions.yaml keys off the 0x10 keyword to prove
those events reach user-mode.

```tool
kernel_etw_start:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  keywords: "0x1C"
  level: 5
  timeout_ms: 180000
```

## Step 3: Run the ExampleNet IOCTL sequence

`net-spawn-helper.exe --mode orchestrator` performs (in order):

| Sub-step | Call                                                     | Expect                  |
| -------- | -------------------------------------------------------- | ----------------------- |
| a        | `CreateFileW("\\\\.\\example-net")`                       | success                 |
| b        | `IOCTL_OSP_NET_INIT_SCOPE` (ScopeId=0x42)                | STATUS_SUCCESS          |
| c        | `IOCTL_OSP_NET_ADD_RULE` (DENY+DOMAIN_SUFFIX example.invalid, port 0) | STATUS_SUCCESS, RuleId  |
| d        | `IOCTL_OSP_NET_ADD_RULE` (ALLOW+EXACT_V4 10.0.0.1, port 443) | STATUS_SUCCESS, RuleId  |
| d2       | `IOCTL_OSP_NET_ADD_RULE` (DENY+EXACT_V4 93.184.216.34, port 443) | STATUS_SUCCESS, RuleId  |
| e        | `IOCTL_OSP_NET_LIST_RULES`                               | RuleCount == 3          |
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
| w1       | `list_rules_as_bound_child`: LIST_RULES on 0x42          | RuleCount == 3          |
| w2       | `init_foreign_scope`: INIT_SCOPE on 0xDEAD               | STATUS_SUCCESS          |
| w3       | `destroy_foreign_scope`: DESTROY_SCOPE on 0xDEAD         | STATUS_SUCCESS          |
| w4       | `connect(93.184.216.34:443)` from bound worker           | WSAEACCES (10013) — WFP BLOCK verdict surfaced (also accept WSAEHOSTUNREACH 10065 on pre-block-before-sourceaddr builds) |
| w5       | `connect(10.0.0.1:443)` from bound worker                | NOT WSAEACCES — WFP permitted; network-level failure (timeout/refused/unreachable) expected since 10.0.0.1 has no listener |

The worker writes `{matched, steps[], mismatches[], scope_id, device}`
JSON to `--output` and exits 0 iff all 5 sub-steps passed. The
orchestrator exits 0 iff every sub-step (orchestrator + worker)
matched its expected outcome.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Example\\tools\\net-spawn-helper.exe"
  args: ["--mode", "orchestrator", "--verbose", "--output", "C:\\Example\\logs\\net-spawn-worker.json"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 4: Stop ETW capture and parse events

`kernel_etw_stop` runs `logman stop <session> -ets`, pulls events via
`Get-WinEvent -Path <etl>`, filters to the Example.Driver GUID, and
returns `event_counts` as structured JSON. For this scenario we
expect (per-event-name counts):

| Event              | Expected | Why                                                  |
| ------------------ | -------- | ---------------------------------------------------- |
| NetScopeCreated    | 2        | orchestrator INIT 0x42 + worker INIT 0xDEAD          |
| NetRuleAdded       | 3        | orchestrator's DENY (DOMAIN) + ALLOW + DENY (EXACT_V4) |
| NetProcessBound    | 1        | orchestrator BIND worker to 0x42                     |
| NetProcessUnbound  | 1        | orchestrator explicit UNBIND                         |
| NetScopeDestroyed  | 2        | orchestrator DESTROY 0x42 + worker DESTROY 0xDEAD    |
| NetRulesListed     | >=2      | orchestrator LIST + worker LIST (diag only)          |
| NetRuleMatched     | >=1      | WFP classify callback fires on worker's DENY connect |

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

The orchestrator wrote `C:\Example\logs\net-spawn-worker.json` with
the worker's per-step pass/fail matrix. Pull it back to the host so
signalman can surface the details via `stdout_contains` on the step
output.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-NoProfile", "-Command", "Get-Content -Raw -Path 'C:\\Example\\logs\\net-spawn-worker.json'"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 6: Driver unload

Driver Verifier runs leak-check on unload — any ExampleNet scope
state, process-map entry, or RCU-freed V2 rule-table leak would
bugcheck here.

```tool
driver_unload:
  service: example
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

  (a) the ExampleNet IOCTL dispatcher works end-to-end
  (b) the V2 wire format encoder/decoder round-trips cleanly
  (c) PID -> scope binding is observable from inside the bound child
  (d) the new ETW emissions in net_ioctl.c reach user-mode
  (e) the live WFP ALE_AUTH_CONNECT_V4 classify callback blocks the
      DENY target's connect() AND lets the ALLOW target's connect()
      through (Sprint 60.8b Phase 2 commit 5)
  (f) NetRuleMatched (keyword 0x10 = ENFORCEMENT) fires per BLOCK
      verdict and the event reaches user-mode
