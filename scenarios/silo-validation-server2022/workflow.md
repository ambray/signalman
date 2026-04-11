# Server Silo Validation (Server 2022) — Workflow

> **Narrator**: This workflow is identical to the Windows 11 silo validation
> but targets a Windows Server 2022 VM. Server 2022 has full container and
> silo support built in, so we expect higher pass rates and more robust
> API availability compared to desktop Windows.

## Prerequisites

The `setup.yaml` has already:
- Provisioned a Windows Server 2022 VM (`endpoint-1`) at `172.30.0.20`
- Restored the `agent-installed` checkpoint

## Step 1: Deploy Silo Validation Binary

Copy the pre-built `silo-validation.exe` tool into the VM.

```tool
vm_copy_file:
  vm: endpoint-1
  src: ./artifacts/silo-validation.exe
  dest: "C:\\Example\\tools\\silo-validation.exe"
```

Verify the binary is in place:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Test-Path 'C:\\Example\\tools\\silo-validation.exe'"]
  expect_stdout: "True"
```

## Step 2: Run Full Validation Suite

Execute the validation binary with `--all` to run every test.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Example\\tools\\silo-validation.exe"
  args: ["--all", "--output", "C:\\Example\\logs\\silo-results.json"]
  timeout_ms: 120000
```

## Step 3: Retrieve Results JSON

Copy the results file back to the host for assertion evaluation.

```tool
vm_copy_file:
  vm: endpoint-1
  src: "C:\\Example\\logs\\silo-results.json"
  dest: ./results/silo-results.json
  direction: from_vm
```

Inspect the summary:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty summary | Format-List"]
```

## Step 4: Validate Silo APIs Are Available

On Server 2022, silo APIs should always be present.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty summary | Select-Object -ExpandProperty silo_apis_available"]
```

The output must be `True`. Server 2022 ships with full silo support.

## Step 5: Check Process Assignment Behaviour

Verify suspended-process assignment to a silo works correctly.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty tests | Where-Object { $_.name -like '*assign*suspended*' } | Format-List"]
```

Also check running-process assignment:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty tests | Where-Object { $_.name -like '*assign*running*' } | Format-List"]
```

## Step 6: Check Handle Close Behaviour

Verify handle isolation when a silo is terminated.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty tests | Where-Object { $_.name -like '*handle*' } | Format-List"]
```

## Step 7: Check ETW Visibility from Silo'd Processes

Verify ETW events from silo'd processes are visible to the host ETW session.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty tests | Where-Object { $_.name -like '*etw*' } | Format-List"]
```

## Step 8: Check AppContainer + Silo Composition

Verify AppContainer + silo composition works on Server 2022.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Example\\logs\\silo-results.json' | ConvertFrom-Json | Select-Object -ExpandProperty tests | Where-Object { $_.name -like '*appcontainer*silo*compose*' } | Format-List"]
```

## Expected Outcomes

| Check | Expected |
|-------|----------|
| Silo APIs available | `True` (Server 2022 always supports silos) |
| Assign suspended process | `pass` |
| Assign running process | `fail` (expected restriction) |
| Handle isolation | `pass` |
| ETW visibility | `pass` |
| AppContainer + Silo composition | `pass` |
| Overall pass rate | >= 6 of total tests pass |
| Errors | 0 crashes or exceptions |
