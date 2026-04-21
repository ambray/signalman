# Example v2 Network Egress Multi-Threaded Torture — Workflow

> **Narrator**: This scenario is the concurrent-load companion to
> `example-v2-network-egress`. Where that scenario proves single-
> threaded correctness of the WFP classify callback, this one proves
> the driver holds up under 16 threads x 100 iterations of concurrent
> `connect()` (both DENY and ALLOW) alongside a mutator thread
> rotating rules in and out of the same scope. If RCU snapshotting,
> PID->scope bind inheritance, or the WFP classify fast-path has any
> data race, torn state, or missed-drain bug, this scenario is where
> it shows up.

## Prerequisites confirmed by setup.yaml
- `test-signing-warm` checkpoint restored on `endpoint-1`
- `C:\Example\drv\example.sys` (test-signed, `/INTEGRITYCHECK`-linked) deployed
- `C:\Example\tools\net-spawn-helper-torture.exe` deployed
- `sc create example type=kernel start=demand` ran; service is STOPPED

## Step 1: Load the driver

```tool
driver_load:
  service: example
  expect_status: 0
  timeout_ms: 15000
```

## Step 2: Start ETW capture targeting Example.Driver's ENFORCEMENT stream

For the torture profile we only care about ENFORCEMENT (0x10 =
`NetRuleMatched`). SCOPE and RULES lifecycle events would drown the
capture with mutator-thread noise — 100 ADD_RULE + LIST_RULES round
trips — so we narrow to ENFORCEMENT only. This keeps the Get-WinEvent
parse time bounded and the assertion surface focused on the actual
question: "did every BLOCK verdict emit telemetry?"

```tool
kernel_etw_start:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  keywords: "0x1C"
  level: 5
  timeout_ms: 180000
```

## Step 3: Run the torture binary

`net-spawn-helper-torture.exe` is single-binary, no worker subprocess.
It runs the whole torture inside the main process:

| Sub-step | Call                                                                | Expect                  |
| -------- | ------------------------------------------------------------------- | ----------------------- |
| a        | `CreateFileW("\\\\.\\example")`                                      | success                 |
| b        | `IOCTL_OSP_NET_INIT_SCOPE` (ScopeId=0x42)                           | STATUS_SUCCESS          |
| c        | `IOCTL_OSP_NET_ADD_RULE` (DENY+EXACT_V4 93.184.216.34:443)          | STATUS_SUCCESS, RuleId  |
| d        | `IOCTL_OSP_NET_BIND_PROCESS` (ScopeId=0x42, pid=self)               | STATUS_SUCCESS          |
| e        | Spawn 16 std::thread workers; each runs 100 iter of:                |                         |
|          |   connect(93.184.216.34:443) -> expect WFP BLOCK                    |                         |
|          |   connect(10.0.0.1:443)      -> expect NOT BLOCK                    |                         |
|          |   every 10 iters: IOCTL_OSP_NET_LIST_RULES -> count >= 1            |                         |
| f        | Spawn 1 mutator thread; 100 iter of (ADD_RULE rotating port + LIST) | zero failures           |
| g        | Join all threads; aggregate counts + mismatches                     | unexpected_count == 0   |
| h        | Write `example-net-torture-<pid>.json` with the full report          | success                 |
| i        | `IOCTL_OSP_NET_UNBIND_PROCESS` (pid=self)                           | STATUS_SUCCESS          |
| j        | `IOCTL_OSP_NET_DESTROY_SCOPE` (0x42)                                | STATUS_SUCCESS          |

A 5-minute timeout budget (300_000 ms) covers worst-case kernel
scheduler contention; typical runs finish in <30 s on a 4-vCPU VM.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Example\\tools\\net-spawn-helper-torture.exe"
  args: ["--verbose", "--output", "C:\\Example\\logs\\net-torture-report.json"]
  expect_exit_code: 0
  timeout_ms: 300000
  run_as: SYSTEM
```

## Step 4: Stop ETW capture and parse events

`kernel_etw_stop` pulls events via `Get-WinEvent`, filters to the
Example.Driver GUID, and returns `event_counts` as structured JSON.
Expected volume: at least 1600 NetRuleMatched events (16 threads x
100 iter of DENY connects). `max_events_returned` is 100 (enough to
see the variety without blowing up the scenario payload — we only
need one event of each keyword to prove the path, and the count is
already bounded by the worker's own report).

`max_events_returned` caps at 100 events; the torture emits ~1600
NetRuleMatched, so only a representative sample surfaces. That's
fine — the assertion below keys off the keyword pattern, not the
absolute count.

```tool
kernel_etw_stop:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  max_events_returned: 100
  timeout_ms: 180000
```

## Step 5: Capture torture report for post-run inspection

The torture binary wrote `C:\Example\logs\net-torture-report.json`
with the aggregate JSON report. Pull it back to the host so
signalman can surface the details via `stdout_contains`.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-NoProfile", "-Command", "Get-Content -Raw -Path 'C:\\Example\\logs\\net-torture-report.json'"]
  expect_exit_code: 0
  timeout_ms: 60000
  run_as: SYSTEM
```

## Step 6: Driver unload

Driver Verifier runs leak-check on unload — any scope state,
process-map entry, or RCU-freed rule-table leak from 1600+ RCU swap
cycles would bugcheck here.

```tool
driver_unload:
  service: example
  expect_status: 0
  timeout_ms: 15000
```

## Expected outcomes

| Step | Check                                             | Expected          |
| ---- | ------------------------------------------------- | ----------------- |
| 1    | driver_load                                       | exit 0, Running   |
| 2    | kernel_etw_start                                  | status 0          |
| 3    | net-spawn-helper-torture                          | exit 0            |
| 4    | kernel_etw_stop + ENFORCEMENT keyword seen        | keyword 0x10 seen |
| 5    | torture report JSON, unexpected_count==0          | match             |
| 6    | driver_unload                                     | exit 0, Stopped   |

A green run proves:

  (a) WFP classify under 1600+ concurrent connect() calls never
      misroutes a DENY connect as ALLOW or vice-versa
  (b) RCU snapshotting (SwapRuleTable under concurrent readers)
      holds up — no torn rule-table reads from worker threads'
      LIST_RULES during mutator ADD_RULE swaps
  (c) PID->scope bind state is correctly inherited by all child
      threads (not just the creating thread) — classifies route
      through the same scope
  (d) ETW ENFORCEMENT emission does not drop events under load —
      at least one NetRuleMatched surfaces in the capture
  (e) Driver Verifier sees zero leaks after 1600+ RCU cycles +
      100 mutator ADD_RULE calls
