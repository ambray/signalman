# Cursor under Restrict Policy — Workflow

> **Narrator**: This workflow validates that Cursor IDE functions correctly
> when the Ospiri agent's Restrict policy is active. AI features (Copilot,
> inline completions, chat) should be blocked while core IDE functionality
> remains operational.

## Prerequisites

The `setup.yaml` has already:
- Provisioned a Windows 11 VM (`endpoint-1`)
- Installed Cursor IDE via winget
- Deployed the `restrict-ai.rego` policy
- Restarted the Ospiri agent

## Step 1: Verify Restriction State

First, confirm the Ospiri agent recognises Cursor as restricted.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Ospiri\\logs\\agent.log' -Tail 20 | Select-String 'cursor'"]
```

The agent log should show Cursor detected and policy applied.

## Step 2: Launch Cursor IDE

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Users\\revntest\\AppData\\Local\\Programs\\cursor\\Cursor.exe"
  args: ["--new-window"]
  timeout_ms: 15000
```

Wait for Cursor to fully load.

```tool
wait:
  duration_ms: 8000
```

## Step 3: Verify Cursor Window Appeared

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-launched.png
```

The screenshot should show the Cursor IDE window. If the window is not visible,
the launch may have failed.

## Step 4: Test Core IDE Functionality — File Creation

Create a test file to verify basic editing works.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Set-Content -Path 'C:\\Users\\revntest\\Desktop\\test.py' -Value 'print(\"hello world\")'"]
```

Open the file in Cursor via the command line:

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Users\\revntest\\AppData\\Local\\Programs\\cursor\\Cursor.exe"
  args: ["C:\\Users\\revntest\\Desktop\\test.py"]
  timeout_ms: 10000
```

```tool
wait:
  duration_ms: 5000
```

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-file-open.png
```

## Step 5: Verify AI Features Are Blocked

### 5a: Check Network Connectivity to AI Endpoints

The restrict policy should block outbound connections to AI API servers.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Test-NetConnection -ComputerName api.openai.com -Port 443 -InformationLevel Quiet"]
  expect_stdout: "False"
```

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Test-NetConnection -ComputerName api2.cursor.sh -Port 443 -InformationLevel Quiet"]
  expect_stdout: "False"
```

### 5b: Attempt to Trigger Inline Completion

Type in the editor and verify no AI suggestion appears. This requires UI automation.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Seconds 1; [System.Windows.Forms.SendKeys]::SendWait('def fibonacci{(}n{)}:{ENTER}')"]
  timeout_ms: 10000
```

```tool
wait:
  duration_ms: 5000
```

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-no-completion.png
```

The screenshot should show the cursor with typed code but NO inline AI suggestion
(no grey ghost text, no completion popup from Copilot/Cursor AI).

### 5c: Check for Restriction Violations in Shared Memory

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Ospiri\\logs\\agent.log' -Tail 50 | Select-String 'violation|blocked|restrict'"]
```

The log should show evidence of blocked network attempts from Cursor.

## Step 6: Verify Terminal Still Works

The integrated terminal in Cursor should still function — it's a core IDE feature,
not an AI feature.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^`')"]
  timeout_ms: 5000
```

```tool
wait:
  duration_ms: 3000
```

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-terminal.png
```

The terminal panel should be visible and responsive.

## Step 7: Process Inspection

Verify the Cursor process is running under restriction.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, WorkingSet64 | Format-Table -AutoSize"]
```

Check if the process has an AppContainer token or is in a restricted job object:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "& 'C:\\Ospiri\\ospiri-agent.exe' test-rule --process-name cursor.exe --format json"]
```

## Step 8: Clean Shutdown

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Process -Name Cursor -ErrorAction SilentlyContinue | Stop-Process -Force"]
  timeout_ms: 10000
```

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-closed.png
```

## Expected Outcomes

| Check | Expected |
|-------|----------|
| Cursor launches successfully | Window visible |
| File editing works | Can create and open files |
| AI completions blocked | No ghost text or suggestions |
| Network to AI APIs blocked | `Test-NetConnection` returns False |
| Terminal works | Integrated terminal responsive |
| Restriction violations logged | Agent log shows blocked attempts |
| Process is restricted | AppContainer or job object active |
