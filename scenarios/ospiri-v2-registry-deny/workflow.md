# Example v2 Registry Rule Deny — Workflow

> **Narrator**: This scenario proves the scope-based registry enforcement
> introduced in Sprint 60.8a Phase 6. Our driver owns a scope primitive
> (a `u32` ScopeId + per-scope rule table + PID→ScopeId map) that lives
> entirely inside the driver — no dependency on Windows Containers or
> kernel silos.

## Prerequisites confirmed by setup.yaml
- `test-signing-enabled` checkpoint restored on `endpoint-1`
- `C:\Example\drv\example.sys` (test-signed, `/INTEGRITYCHECK`-linked) deployed
- `C:\Example\tools\silo-spawn-helper.exe` deployed
- `sc create example type=kernel start=demand` ran; service is STOPPED

## Step 1: Load the driver

```tool
driver_load:
  service: example
  expect_status: 0
  timeout_ms: 15000
```

## Step 2: Start ETW capture targeting Example.Driver's ENFORCEMENT stream

Sprint 60.11 landed the `Example.Driver` TraceLogging provider
(`{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}`). Keyword 0x10 =
ENFORCEMENT = `RuleMatched` events only (one per DENY verdict).
kernel_etw_stop (Step 4 below) returns per-event-name counts that
assertions.yaml keys on — this is how we prove ETW-level enforcement
telemetry actually reaches user-mode, not just that the worker's
RegCreateKeyExW returned ACCESS_DENIED.

```tool
kernel_etw_start:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  keywords: "0x10"
  level: 5
  timeout_ms: 180000
```

## Step 3: Run the scope-based enforcement sequence

`silo-spawn-helper.exe --mode orchestrator` performs (in order):

| Sub-step | Call                                                     | Expect                  |
| -------- | -------------------------------------------------------- | ----------------------- |
| a        | `CreateFileW("\\\\.\\example")`                           | success                 |
| b        | `IOCTL_OSP_REG_INIT_SCOPE` (ScopeId=0x42)                | STATUS_SUCCESS          |
| c        | `IOCTL_OSP_REG_ADD_RULE` (DENY+PREFIX, `ExampleV2RegDeny`) | STATUS_SUCCESS, RuleId  |
| d        | `IOCTL_OSP_REG_LIST_RULES`                               | RuleCount == 1          |
| e        | `CreateProcessW` (CREATE_SUSPENDED)                      | success                 |
| f        | `IOCTL_OSP_REG_BIND_PROCESS` (ScopeId=0x42, pid=worker)  | STATUS_SUCCESS          |
| g        | `ResumeThread`                                           | success                 |
| h        | (worker inside) `RegCreateKeyExW HKLM\Software\ExampleV2RegDeny\Created` | ERROR_ACCESS_DENIED (5) |
| i        | (worker inside) `RegCreateKeyExW HKLM\Software\ExampleV2RegAllow\Created` | ERROR_SUCCESS           |
| j        | `IOCTL_OSP_REG_DESTROY_SCOPE`                            | STATUS_SUCCESS          |

The orchestrator exits 0 iff every sub-step matched its expected
outcome. Non-zero exit fails this scenario.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Example\\tools\\silo-spawn-helper.exe"
  args: ["--mode", "orchestrator", "--verbose", "--output", "C:\\Example\\logs\\silo-spawn-worker.json"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 4: Stop ETW capture and parse events

`kernel_etw_stop` runs `logman stop <session> -ets`, pulls events via
`Get-WinEvent -Path <etl>`, filters to the Example.Driver GUID, and
returns `event_counts` as structured JSON. For this scenario we
expect exactly **1** `RuleMatched` (one CM callback fires DENY when
the worker tries to open `\REGISTRY\MACHINE\SOFTWARE\ExampleV2RegDeny`;
no other scoped process is active so no other RuleMatched events
fire).

The timeout budget is generous (180 s) because on a cold-booted VM
`Get-WinEvent` has to load its ETW parser cache before it can read
the ETL; first invocation after boot can take 30-60 s, subsequent
ones are sub-second.

```tool
kernel_etw_stop:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  max_events_returned: 20
  timeout_ms: 180000
```

## Step 5: Capture worker report for post-run inspection

The orchestrator wrote `C:\Example\logs\silo-spawn-worker.json` with
the worker's per-step pass/fail matrix. Pull it back to the host so
signalman can surface the details via `stdout_contains` on the step
output.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-NoProfile", "-Command", "Get-Content -Raw -Path 'C:\\Example\\logs\\silo-spawn-worker.json'"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 6: Driver unload

Driver Verifier runs leak-check on unload — any scope state,
process-map entry, or RCU-freed rule-table leak would bugcheck here.

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
| 2    | silo-spawn-helper orchestrator + worker   | exit 0            |
| 3a   | DRAIN_EVIDENCE                            | STATUS_SUCCESS    |
| 3b   | driver_unload                             | exit 0, Stopped   |

A green run proves ExampleReg scope-based enforcement works on stock
Win11 24H2 under Driver Verifier with **zero** dependency on the
Windows Containers feature.
