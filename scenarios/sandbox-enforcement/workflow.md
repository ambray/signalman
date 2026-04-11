# Sandbox Enforcement E2E — Workflow

> **Narrator**: This workflow validates that Cursor IDE is properly sandboxed
> by the Ospiri agent when the sandbox enforcement policy is active. Unlike
> the restrict scenario (which uses network-level blocking), the sandbox
> scenario places Cursor inside a Windows Server Silo with an AppContainer
> token, providing kernel-level process and network isolation.

## Prerequisites

The `setup.yaml` has already:
- Provisioned a Windows 11 VM (`endpoint-1`)
- Installed Cursor IDE via winget
- Deployed the `sandbox-policy.rego` policy
- Restarted the Ospiri agent

## Step 1: Deploy Sandbox Policy

Verify the sandbox policy is loaded and the agent recognises it.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Ospiri\\logs\\agent.log' -Tail 30 | Select-String 'sandbox|policy.*loaded|sandbox-policy'"]
```

The agent log should show the sandbox policy was loaded successfully. If no
log entries match, the policy may have failed to parse or the agent did not
reload configuration.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "& 'C:\\Ospiri\\ospiri-agent.exe' policy-status --format json"]
```

The output should show the sandbox policy as `active`.

## Step 2: Launch Cursor IDE

Launch Cursor and allow the agent time to detect and sandbox it.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Users\\revntest\\AppData\\Local\\Programs\\cursor\\Cursor.exe"
  args: ["--new-window"]
  timeout_ms: 15000
```

Wait for Cursor to fully load and for the agent to apply the sandbox.

```tool
wait:
  duration_ms: 10000
```

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-sandboxed-launch.png
```

The screenshot should show Cursor's main window. The agent may display a
notification indicating the application has been sandboxed.

## Step 3: Verify Cursor Is Running in a Silo

Check that the Cursor process has been assigned to a server silo by the
Ospiri agent. The agent exposes this via its process inspection command.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "& 'C:\\Ospiri\\ospiri-agent.exe' test-rule --process-name cursor.exe --format json"]
```

The output should show `enforcement: sandbox` and `silo_assigned: true`.

Also check via the agent log for silo assignment evidence:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Ospiri\\logs\\agent.log' -Tail 50 | Select-String 'silo.*assign|sandbox.*cursor|NtAssignProcessToServerSilo'"]
```

## Step 4: Verify Cursor Cannot Enumerate Host Processes

A properly silo'd process should not be able to see processes outside its
silo. Verify by checking what the Cursor process can observe.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$cursorPid = (Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -First 1).Id; if ($cursorPid) { & 'C:\\Ospiri\\ospiri-agent.exe' silo-inspect --pid $cursorPid --check process-enumeration --format json } else { Write-Output 'Cursor not running' }"]
  timeout_ms: 30000
```

The `process-enumeration` check should report that the silo'd process can
only see processes within its own silo, not host-level processes like
`explorer.exe`, `svchost.exe`, or `ospiri-agent.exe`.

## Step 5: Verify Cursor's AI Features Are Network-Blocked

The sandbox policy combines silo isolation with AppContainer network rules.
AI API endpoints should be unreachable from within the sandbox.

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

Check the agent log for blocked network attempts:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Ospiri\\logs\\agent.log' -Tail 50 | Select-String 'blocked.*network|sandbox.*denied|appcontainer.*block'"]
```

## Step 6: Verify Cursor's Core IDE Features Still Work

The sandbox must not break core IDE functionality. Verify file editing and
the integrated terminal work correctly.

### 6a: File Creation and Editing

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Set-Content -Path 'C:\\Users\\revntest\\Desktop\\sandbox-test.py' -Value 'print(\"sandbox test\")'"]
```

Open the file in Cursor:

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Users\\revntest\\AppData\\Local\\Programs\\cursor\\Cursor.exe"
  args: ["C:\\Users\\revntest\\Desktop\\sandbox-test.py"]
  timeout_ms: 10000
```

```tool
wait:
  duration_ms: 5000
```

```tool
vm_screenshot:
  vm: endpoint-1
  output: cursor-sandboxed-file-edit.png
```

The file should open and be editable. If the sandbox blocks file I/O to the
user's home directory, the policy is too restrictive.

### 6b: Integrated Terminal

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
  output: cursor-sandboxed-terminal.png
```

The terminal panel should be visible and responsive.

### 6c: Clean Shutdown

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Process -Name Cursor -ErrorAction SilentlyContinue | Stop-Process -Force"]
  timeout_ms: 10000
```

Verify the silo was cleaned up after Cursor exited:

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Get-Content 'C:\\Ospiri\\logs\\agent.log' -Tail 20 | Select-String 'silo.*terminated|silo.*cleanup|sandbox.*removed'"]
```

## Expected Outcomes

| Check | Expected |
|-------|----------|
| Sandbox policy loaded | Agent log confirms policy active |
| Cursor launches | Window visible in screenshot |
| Cursor in silo | `silo_assigned: true` in agent output |
| Process enumeration blocked | Silo'd Cursor cannot see host processes |
| AI network blocked | `Test-NetConnection` returns False for AI endpoints |
| Network violations logged | Agent log shows blocked attempts |
| File editing works | Can create and open files |
| Terminal works | Integrated terminal responsive |
| Silo cleanup on exit | Agent log confirms silo terminated |
