# E2E Test Migration Plan: Correlator Pester Tests to Signalman Scenarios

This document maps the correlator project's 87 Pester VM tests and 4 orchestrator
scripts to Signalman's scenario engine, identifies assertion type mappings, and
tracks what is ready to migrate now versus what needs new Signalman capability.

---

## Source Inventory

### Pester Test Files (4 files, ~87 tests total)

| File | Test Count | Category | Description |
|------|-----------|----------|-------------|
| `Invoke-AgentServiceValidation.Tests.ps1` | ~25 | Script validation | Validates the agent validation script structure, checks coverage (10 checks), cleanup, VM config |
| `Invoke-FullE2EValidation.Tests.ps1` | ~35 | Script validation | Validates full E2E script structure: 18-tool catalog, 8 phases, dashboard verification, reporting, stub strategy |
| `Invoke-RealWorldValidation.Tests.ps1` | ~15 | Module/prereq validation | Validates Confirm-AgentDetection and TestVMs module exports, script syntax, prerequisites |
| `TestVMs.Tests.ps1` | ~10 | Module validation | Validates TestVMs module exports (6 functions), tool catalog (26 tools) |

### Orchestrator Scripts (4 primary, ~15 helper scripts)

| Script | Role | What It Does |
|--------|------|-------------|
| `Invoke-AgentServiceValidation.ps1` | Core | 10-check validation: service exists/running, ETW session, logs, process detection, DNS detection, backend registration, heartbeat, telemetry upload, service lifecycle |
| `Invoke-FullE2EValidation.ps1` | Master | 8-phase orchestration: build, backend, VM setup, agent validation, tool detection (18 tools), dashboard verification (Playwright), reporting, cleanup |
| `Invoke-FullTestSuite.ps1` | Parallel | 26-tool parallel batch testing across multiple VMs with HTML/JSON reporting |
| `Invoke-TierAValidation.ps1` | Signal matrix | Per-signal detection validation across all registered agents |
| `Invoke-ToolTest.ps1` (in tools/) | Per-tool | 5-step flow: install (winget), launch (real or stub), DNS traffic, wait, verify detection |
| 10x `Test-*.ps1` (in tools/) | Wrappers | Per-tool configs delegating to Invoke-ToolTest.ps1 |

---

## Test Category Mapping

### Category 1: Agent Service Validation (10 checks)

These are the core checks from `Invoke-AgentServiceValidation.ps1`. Each maps
directly to Signalman scenario steps + assertions.

| Pester Check | PowerShell Command | Signalman Action | Signalman Assertion |
|---|---|---|---|
| ServiceExists | `Get-Service -Name "MyAgent"` | `vm_run_command` (powershell) | `stdout_contains: "Running"` or `json_field` |
| ServiceRunning | `Get-Service` + Status check | `vm_run_command` | `stdout_contains: "Running"` |
| EtwSessionActive | `logman query -ets` + log grep | `vm_run_command` | `stdout_matches: "myagent\|ETW"` |
| AgentLogs | `Get-WinEvent` + file search | `vm_run_command` | `json_field` on structured output |
| ProcessDetection | Copy stub exe, launch, query backend | `vm_copy_file` + `vm_run_command` + `vm_run_command` | `stdout_contains` or `json_field` |
| DnsDetection | `[System.Net.Dns]::GetHostAddresses` + backend query | `vm_run_command` + `vm_run_command` | `json_field` |
| AgentRegistered | `Invoke-RestMethod /api/v1/endpoints` | `vm_run_command` (curl/powershell) | `json_field` |
| Heartbeat | Check `last_heartbeat` field | `vm_run_command` | `json_field` with `not_eq` null |
| TelemetryUpload | `/api/v1/endpoints/{id}/ai-tools` | `vm_run_command` | `json_field` with `gt: 0` |
| ServiceLifecycle | `Stop-Service` + `Start-Service` | `vm_run_command` (two steps) | `exit_code: 0` + `stdout_contains: "Running"` |

**Migration readiness: READY NOW** -- All Signalman actions and assertion types exist.

### Category 2: Tool Detection Testing (26 tools, 5 signals each)

Each tool follows the same 5-step pattern from `Invoke-ToolTest.ps1`:

1. **Install** via winget (or skip) -> `vm_install` or `vm_run_command`
2. **Launch** real binary or create stub -> `vm_run_command` (with fallback to `vm_copy_file` + run)
3. **DNS traffic** -> `vm_run_command` (DNS resolve)
4. **Wait** for detection pipeline -> `wait` action
5. **Verify** signals via backend API -> `vm_run_command` + assertions

Per-tool signals verified:
- ProcessDetected (process name in backend telemetry)
- DnsDetected (domain in DNS events)
- ClassificationFound (AI tool classified)
- PolicyEnforced (policy decision rendered)
- DashboardVisibility (tool appears in dashboard views)

**Migration readiness: READY NOW** -- The pattern is fully expressible in Signalman YAML.

### Category 3: Dashboard Verification (Playwright)

The full E2E script runs Playwright specs against the dashboard:
- `tier-b-data-flow.spec.ts` -- data flow visualization
- `api-data-flow.spec.ts` -- API data flow

**Migration readiness: DEFERRED** -- Signalman currently focuses on VM guest
assertions. Dashboard E2E via Playwright is a separate concern (runs on the host,
not inside the VM). Could be integrated as a custom tool executor that shells out
to `npx playwright test`, but not a priority for the first migration pass.

### Category 4: Script Structure Validation (~87 Pester tests)

The majority of the 87 Pester tests validate *script structure* (e.g., "script
has all 10 checks", "script has proper help block", "script requires Administrator").
These are meta-tests that verify the PowerShell scripts themselves are well-formed.

**Migration readiness: NOT APPLICABLE** -- These tests validate the Pester
infrastructure, not the system under test. Once the behavior they guard (the 10
checks, the tool catalog, etc.) is migrated to Signalman scenarios, the meta-tests
are redundant. They do not need to migrate.

---

## Assertion Type Mapping

| Pester Pattern | PowerShell Example | Signalman Assertion Type | Notes |
|---|---|---|---|
| `Should -Be $true` | Service exists check | `json_field` with `expected: true` | Wrap command output as JSON |
| `Should -Match 'regex'` | Log content grep | `stdout_matches` with `pattern` | Direct mapping |
| `Should -BeGreaterOrEqual N` | Event count check | `json_field` with `comparison: gte` | Direct mapping |
| `Should -Not -BeNullOrEmpty` | Module export check | `stdout_contains` or `json_field` with `not_eq` | Map to not_eq null |
| `Should -Be 0` | Error count | `exit_code` or `json_field` with `expected: 0` | Direct mapping |
| REST API response check | `Invoke-RestMethod` + field check | `json_field` | Parse JSON output from curl/Invoke-RestMethod |
| Process running check | `Get-Process` | `process_running` | Direct guest agent callback |
| File existence check | `Test-Path` | `file_exists` | Direct guest agent callback |
| Network reachability | `Test-NetConnection` | `network_reachable` | Direct guest agent callback |

---

## PowerShell Commands to Guest Agent RPCs

| PowerShell Pattern | Signalman Step Action | Guest Agent RPC |
|---|---|---|
| `Invoke-Command -VMName $VM -ScriptBlock { ... }` | `vm_run_command` | `ExecuteCommand` gRPC |
| `Copy-Item` (host to VM via PSSession) | `vm_copy_file` (direction: to_vm) | `UploadFile` gRPC |
| `Get-Content` (VM file to host) | `vm_copy_file` (direction: from_vm) | `DownloadFile` gRPC |
| `winget install --id $pkg` | `vm_install` (source: winget) | `ExecuteCommand` gRPC (winget wrapper) |
| `Start-Process $exe` | `vm_run_command` | `ExecuteCommand` gRPC |
| `Stop-Service` / `Start-Service` | `vm_run_command` (powershell) | `ExecuteCommand` gRPC |
| `Get-Service` | `vm_run_command` (powershell) | `ExecuteCommand` gRPC |
| `logman query -ets` | `vm_run_command` | `ExecuteCommand` gRPC |
| `Invoke-RestMethod` (from VM) | `vm_run_command` (powershell) | `ExecuteCommand` gRPC |
| `Start-Sleep -Seconds N` | `wait` (duration_ms) | N/A (host-side delay) |
| `New-TestVM` | `vms:` in setup.yaml | Hypervisor backend (Hyper-V/VMware) |
| `Remove-TestVM` | `teardown: vm_restore` | Hypervisor backend |
| `Restore-TestVM` | Checkpoint restore | Hypervisor backend |

---

## Migration Phases

### Phase 1: Agent Service Validation (this PR)

Migrate the 10 core checks from `Invoke-AgentServiceValidation.ps1` into a
single Signalman scenario: `scenarios/agent-service/`.

- setup.yaml: VM config, agent installation checkpoint
- workflow.md: 10-step narrative
- assertions.yaml: 10+ assertions covering all checks

### Phase 2: Single Tool Detection (this PR, sample)

Migrate one tool test (Claude Desktop) as a template scenario:
`scenarios/tool-detection/`. This demonstrates the 5-step pattern
that all 26 tools follow.

### Phase 3: Full Tool Catalog (future)

Create a parameterized scenario generator (or 26 scenario directories) for
the complete tool catalog. Consider a YAML anchor/template approach:

```yaml
# scenarios/tool-detection/tools.yaml
tools:
  - id: claude-desktop
    process: claude.exe
    domain: api.anthropic.com
    winget: Anthropic.Claude
    type: desktop
  - id: cursor
    process: cursor.exe
    domain: cursor.sh
    winget: Anysphere.Cursor
    type: desktop
  # ... 24 more
```

This requires a "parameterized scenario" feature in the Signalman runner.

### Phase 4: Parallel Execution (future)

The Pester suite runs 8 VMs in parallel via PowerShell jobs. Signalman's
orchestrator currently runs one scenario at a time. To match the correlator's
`Invoke-FullTestSuite.ps1` parallel strategy, Signalman needs:

- Multi-scenario batch execution
- Parallel VM provisioning (already supported by hypervisor backend)
- Aggregated reporting across scenarios

### Phase 5: Dashboard + Host-Side Verification (future)

Integrate Playwright dashboard verification as a host-side action that runs
after VM-based assertions pass.

---

## Gaps Requiring New Signalman Capability

| Gap | Priority | Description |
|-----|----------|-------------|
| Parameterized scenarios | Medium | Run same scenario template with different tool configs (avoids 26 duplicated directories) |
| Multi-scenario batching | Medium | Execute N scenarios in parallel, aggregate results |
| Backend API queries from host | Low | Some Pester checks query the backend REST API from the host; Signalman assertions run against guest command output. Workaround: run curl inside the VM or add a host-side `http_request` assertion type. |
| Stub process creation | Low | Pester creates stub processes by copying cmd.exe. Signalman can do this via `vm_run_command` + `vm_copy_file`, but a dedicated `vm_create_stub_process` action would be cleaner. |
| Detection pipeline wait | Low | Pester uses `Start-Sleep 15-30s` between stimulus and verification. Signalman has `wait` action. Consider a `wait_until` action that polls a condition. |

---

## Summary

- **87 Pester tests**: ~87 meta-tests validating script structure (NOT migrated -- redundant once behavior migrates)
- **10 service checks**: All map to existing Signalman actions + assertions. **Ready now.**
- **26 tool detections**: 5-step pattern maps cleanly. **Ready now** (1 tool sample in this PR; parameterization needed for scale).
- **Dashboard verification**: Deferred (Playwright on host, not VM guest).
- **Parallel execution**: Deferred (needs multi-scenario batching in Signalman).
