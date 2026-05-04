# Ospiri Agent ↔ Driver End-to-End — Workflow

> **Narrator**: This workflow walks the integration boundary that Sprint
> 60.12 created: the agent service owning the `ospiri` kernel driver
> from SCM registration through ETW consumption.  It runs only after
> setup.yaml has installed the agent (which must auto-install the driver
> via `driver::start` → `lifecycle::Win32DriverLifecycle`).

## Acceptance criteria mapping

| Criterion (sprint-60.12-driver-integration.md)               | Step      | Status today  |
|--------------------------------------------------------------|-----------|---------------|
| 1. agent registers/starts/stops `ospiri` SCM service         | 1, 2, 9   | verifiable    |
| 2. backend-pushed Rego → INIT_SCOPE+ADD_RULE IOCTL sequence  | 5, 6      | partial       |
| 3. RuleMatched ETW captured by agent                         | 7         | needs 60.11   |
| 4. AgentEvent.RegistryDeny at backend within 2 s             | 8         | needs 60.11   |

`partial` and `needs 60.11` steps land as `severity: info` assertions
that flip to `critical` as the underlying capability ships.

## Step 1 — Agent service is running

Smallest possible health probe: agent's user-mode service is in
`Running` state.  Setup.yaml just `sc start OspiriAgent`d it; this
re-queries SCM after the 10-second settle window so a crash in
`driver::start` shows up here rather than masquerading as a downstream
failure.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$svc = Get-Service -Name 'OspiriAgent' -ErrorAction SilentlyContinue; if ($svc) { @{ Exists=$true; Status=$svc.Status.ToString() } | ConvertTo-Json } else { @{ Exists=$false; Status='NotFound' } | ConvertTo-Json }"]
  timeout_ms: 15000
```

## Step 2 — Driver service is running (agent owns lifecycle)

Sprint 60.12 Phase A acceptance: the agent's `lifecycle::Win32DriverLifecycle`
calls `CreateServiceW` + `StartServiceW` on `ospiri` from inside
`driver::start()` during agent service startup.  We assert the SCM end
state — Running — without touching the service ourselves.

If this step fails, the most likely causes are (in observed-frequency order):
  1. Driver binary not at `C:\Ospiri\drv\ospiri.sys` (setup.yaml copy step).
  2. `bcdedit /set testsigning on` not in effect (driver-ready snapshot).
  3. Agent config has `driver.enabled = false` (config.yaml mismatch).
  4. `driver::start` returned `Err(StartError::Lifecycle(...))` and the
     agent kept running in degraded mode — check `C:\Ospiri\logs\agent.log`
     for the `error =` line.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$svc = Get-Service -Name 'ospiri' -ErrorAction SilentlyContinue; if ($svc) { @{ Exists=$true; Status=$svc.Status.ToString() } | ConvertTo-Json } else { @{ Exists=$false; Status='NotFound' } | ConvertTo-Json }"]
  timeout_ms: 15000
```

## Step 3 — Agent log records driver subsystem startup

Anchor evidence that the agent's `driver::start()` reached the
`agent::driver: ospiri.sys installed and started` info-line — that's
the post-`lifecycle.install` + post-`lifecycle.start` checkpoint, the
strongest signal that driver Phase A (lifecycle ownership) is live.

> **Why this isn't `Kernel driver subsystem started`**: the
> downstream `lib.rs` info-line that says exactly that fires only
> after `OspiriEtwConsumer::start()` returns successfully.  Against
> the current Phase 8a-era driver (no Sprint 60.11 TraceLogging
> provider yet), `ferrisetw::UserTrace::start()` blocks waiting for
> the provider to register.  So the `Kernel driver subsystem started`
> line is an unreliable witness today, even though all upstream
> lifecycle steps succeed.  We anchor on `ospiri.sys installed and
> started` instead, which is logged immediately after the SCM start
> call returns and proves the driver service is live.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$log = 'C:\\Ospiri\\logs\\agent.log'; if (-not (Test-Path $log)) { @{ HasLog=$false } | ConvertTo-Json; exit 0 }; $tail = Get-Content $log -Tail 500 | Out-String; $hasDriverStart = $tail -match 'ospiri\\.sys installed and started'; $hasEtwStart = $tail -match 'Ospiri\\.Driver ETW consumer started'; @{ HasLog=$true; HasDriverStart=$hasDriverStart; HasEtwStart=$hasEtwStart } | ConvertTo-Json"]
  timeout_ms: 15000
```

## Step 4 — Driver IOCTL surface is reachable from user-mode

Sanity-check the device handle the agent opened in `driver::start()`
is also reachable to other callers (the device DACL must permit
SYSTEM-equivalent processes; we open from this Pester step running
under the test admin token).  Issues a minimum-payload
`OSP_IOCTL_DIAG_GET_VERSION` (0x222800) via `silo-test-harness`
re-used from the smoke scenario.

> **Note**: silo-test-harness.exe is NOT yet copied by setup.yaml — if
> this step is enabled, add a vm_copy_file for it.  Left as a
> commented-out reference for now to keep the scenario green on
> first land.  Phase B-followup will wire it in.

```text
# DEFERRED to a follow-up: silo-test-harness.exe is currently a smoke-
# scenario-only artifact.  Adding it here means staging the binary in
# setup.yaml + a driver_ioctl tool block.  Doable but doubles the
# Phase B-followup scope.
```

## Step 5 — Push a Rego policy via backend REST API

Backend-pushed policy → DB row → next `GetConfigUpdate` gRPC poll
includes the Ed25519-signed bundle.  The agent's `config_poll_task`
fetches, verifies, hot-reloads via ArcSwap, and the next classifier
decision evaluates against the new bundle.

This step issues the `POST /api/v1/policies` REST call from the host
(not the VM — auth & policy management is host-side) with a Rego that
emits a `Block` decision plus `kernel_rules.reg` metadata pointing at
a deterministic key path the next step will write to.

> **Note**: Backend's `policy_bundle_bytes` path in
> `backend/src/grpc/service.rs` packages DB-stored policies into a
> SignedPolicyBundle.  The Rego that translates "name matches X" into a
> Block-with-metadata decision is what's needed here.  See the
> `POST /api/v1/policies/rego` endpoint (`save_policy_rego` in
> backend/src/rest/routes/policies.rs) which is currently a stub —
> needs a follow-up to actually persist a Rego source.
>
> For now, this step is **DEFERRED**; the workflow currently asserts
> only that a successful auth login + endpoint listing succeeds (i.e.,
> the backend is reachable from the host) and leaves the Rego push as
> a TODO checkpoint.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "try { $b=@{email='admin@demo.com';password='admin123'}|ConvertTo-Json; $auth=Invoke-RestMethod -Uri 'http://172.30.0.1:48001/api/v1/auth/login' -Method POST -Body $b -ContentType 'application/json' -TimeoutSec 5; $h=@{Authorization=\"Bearer $($auth.access_token)\"}; $r=Invoke-RestMethod -Uri 'http://172.30.0.1:48001/api/v1/policies' -Headers $h -TimeoutSec 5; @{ BackendReachable=$true; PolicyCount=($r.data | Measure-Object).Count } | ConvertTo-Json } catch { @{ BackendReachable=$false; Error=$_.Exception.Message } | ConvertTo-Json }"]
  timeout_ms: 15000
```

## Step 6 — Agent has fetched policy bundle from backend

Wait one full `config_poll_interval_secs` (default 30 s) so the agent
runs at least one fetch cycle.  Then assert that the agent log shows
either a successful `policy_bundle` apply OR a benign skip ("policy
bundle empty" — no policies to push).

```tool
wait:
  duration_ms: 35000
```

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$log = 'C:\\Ospiri\\logs\\agent.log'; if (-not (Test-Path $log)) { @{ HasLog=$false } | ConvertTo-Json; exit 0 }; $tail = Get-Content $log -Tail 1000 | Out-String; $polled = $tail -match 'config_poll|GetConfigUpdate|configuration update'; $applied = $tail -match 'policy bundle|signed bundle|policy_bundle_applied'; $errors = $tail -match 'policy.*error|signature.*invalid|bundle.*reject'; @{ HasLog=$true; ConfigPollObserved=$polled; PolicyApplied=$applied; PolicyErrors=$errors } | ConvertTo-Json"]
  timeout_ms: 15000
```

## Step 7 — Drive registry traffic, confirm OM drain loop is alive

Use the registry-sim.exe binary to generate ~20K registry ops in 2 s
across 4 threads.  Each op fires the driver's `CmRegisterCallbackEx`
callback, populating the evidence ring even without any active deny
rules (Sprint 60.8a — callbacks observe everything; rules only filter
the access-decision result).

After the workload, query agent diagnostics via the agent log.  Sprint
60.12 Phase 4 added an OM-evidence drain loop that ticks every
`om_drain_interval_ms` (1 s in our config) and emits a debug-level
log line on each successful drain.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\registry-sim.exe"
  args: ["--threads", "4", "--duration-ms", "2000"]
  expect_exit_code: 0
  timeout_ms: 10000
```

```tool
wait:
  duration_ms: 5000
```

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$log = 'C:\\Ospiri\\logs\\agent.log'; if (-not (Test-Path $log)) { @{ HasLog=$false } | ConvertTo-Json; exit 0 }; $tail = Get-Content $log -Tail 2000 | Out-String; $drainTicks = ([regex]::Matches($tail, 'om_drain|OmEvidenceDrain|drain.*record')).Count; $hasEvidence = $drainTicks -gt 0; @{ HasLog=$true; DrainTickCount=$drainTicks; HasEvidenceFlow=$hasEvidence } | ConvertTo-Json"]
  timeout_ms: 15000
```

## Step 8 — Backend has agent-side telemetry (heartbeat)

Confirm the round-trip: agent → backend → REST API.  We don't yet
assert a `RegistryDeny` event lands here (that needs Sprint 60.11
ETW provider + Step 5 Rego push to fire); we assert only that the
agent's heartbeat is flowing.  This proves the upload pipeline is
intact while the kernel-deny pipeline ships in 60.11.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "try { $b=@{email='admin@demo.com';password='admin123'}|ConvertTo-Json; $auth=Invoke-RestMethod -Uri 'http://172.30.0.1:48001/api/v1/auth/login' -Method POST -Body $b -ContentType 'application/json' -TimeoutSec 5; $h=@{Authorization=\"Bearer $($auth.access_token)\"}; $hostname = $env:COMPUTERNAME; $agents = Invoke-RestMethod 'http://172.30.0.1:48001/api/v1/endpoints' -Headers $h -TimeoutSec 5; $agent = $agents.data | Where-Object { $_.hostname -eq $hostname } | Select-Object -First 1; if ($agent -and $agent.last_heartbeat -and $agent.last_heartbeat -gt 0) { @{ HasHeartbeat=$true; LastHeartbeat=$agent.last_heartbeat } | ConvertTo-Json } else { @{ HasHeartbeat=$false; Reason='no-agent-or-no-hb' } | ConvertTo-Json } } catch { @{ HasHeartbeat=$false; Error=$_.Exception.Message } | ConvertTo-Json }"]
  timeout_ms: 20000
```

## Step 9 — Agent shutdown also stops the driver service

Sprint 60.12 Phase A — the agent's shutdown path stops the `ospiri`
service via `lifecycle::Win32DriverLifecycle::stop` before the agent
process itself exits.  Stopping the agent here and immediately
querying the driver service status proves the lifecycle ownership
covers shutdown as well as startup.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Stop-Service -Name 'OspiriAgent' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 4; $agentSvc = Get-Service -Name 'OspiriAgent' -ErrorAction SilentlyContinue; $drvSvc = Get-Service -Name 'ospiri' -ErrorAction SilentlyContinue; @{ AgentStopped = ($agentSvc.Status -eq 'Stopped'); DriverStopped = ($drvSvc -eq $null -or $drvSvc.Status -eq 'Stopped'); AgentStatus = $(if ($agentSvc) { $agentSvc.Status.ToString() } else { 'NotFound' }); DriverStatus = $(if ($drvSvc) { $drvSvc.Status.ToString() } else { 'NotFound' }) } | ConvertTo-Json"]
  timeout_ms: 30000
```

## Step 10 — Cleanup

Remove any artefacts the workflow left behind so the on_failure
checkpoint isn't polluted.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Stop-Process -Name 'registry-sim' -Force -ErrorAction SilentlyContinue; 'cleaned up'"]
  timeout_ms: 10000
```

## Expected outcomes

| Step | Check                                       | Severity                |
| ---- | ------------------------------------------- | ----------------------- |
| 1    | OspiriAgent service Running                 | critical                |
| 2    | ospiri driver service Running (agent-owned) | critical                |
| 3    | Driver subsystem startup logged             | critical                |
| 4    | (DEFERRED) IOCTL probe                      | info — phase-B follow-up|
| 5    | Backend reachable from VM (REST listing)    | high                    |
| 6    | Agent fetched at least one config update    | high                    |
| 7    | OM evidence drain loop ticked at least once | high                    |
| 8    | Agent heartbeat in backend's endpoints API  | high                    |
| 9    | Agent stop also stops driver service        | critical                |

A green run on the `critical` rows proves Sprint 60.12 Phase A
(lifecycle ownership) is solid.  A green run on the `high` rows proves
the policy-fetch and OM-drain plumbing is end-to-end.  RuleMatched +
AgentEvent.RegistryDeny remain pending until Sprint 60.11 ships the
driver-side TraceLogging provider with enforcement events.
