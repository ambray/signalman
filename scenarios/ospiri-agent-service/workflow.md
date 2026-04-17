# Example Agent Service Validation

Validates the 10 core agent service checks, migrated from the correlator
project's `Invoke-AgentServiceValidation.ps1` Pester orchestrator.

## Step 1: Check Service Exists

Verify the Example agent Windows service is installed.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$svc = Get-Service -Name 'ExampleAgent' -ErrorAction SilentlyContinue; if (-not $svc) { $svc = Get-Service -Name 'ai-observability-agent' -ErrorAction SilentlyContinue }; if (-not $svc) { $svc = Get-Service -Name 'AIObservabilityAgent' -ErrorAction SilentlyContinue }; if ($svc) { @{ Exists=$true; Name=$svc.Name; Status=$svc.Status.ToString() } | ConvertTo-Json } else { @{ Exists=$false; Name=''; Status='NotFound' } | ConvertTo-Json }"]
  timeout_ms: 15000
```

## Step 2: Check Service Running

Verify the agent service is in Running state. If stopped, attempt to start it.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$svc = Get-Service -Name 'ExampleAgent' -ErrorAction SilentlyContinue; if (-not $svc) { $svc = Get-Service -Name 'ai-observability-agent' -ErrorAction SilentlyContinue }; if (-not $svc) { $svc = Get-Service -Name 'AIObservabilityAgent' -ErrorAction SilentlyContinue }; if ($svc -and $svc.Status -ne 'Running') { Start-Service $svc.Name -ErrorAction SilentlyContinue; Start-Sleep 5; $svc = Get-Service $svc.Name }; @{ Status=$svc.Status.ToString() } | ConvertTo-Json"]
  timeout_ms: 30000
```

## Step 3: Check ETW Session Active

Wait for ETW session creation, then query active trace sessions.

```tool
wait:
  duration_ms: 10000
```

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$sessions = logman query -ets 2>&1 | Out-String; $hasSession = $sessions -match 'ai.observability|example|AIObservability|UserTrace'; $logHint = ''; @('C:\\ProgramData\\Example\\agent.log','C:\\Program Files\\Example\\agent.log') | ForEach-Object { if (Test-Path $_) { $tail = Get-Content $_ -Tail 50 -ErrorAction SilentlyContinue | Out-String; if ($tail -match 'ETW|etw|session.*created|provider.*registered') { $hasSession = $true; $logHint = 'ETW in agent log' } } }; @{ HasSession=[bool]$hasSession; LogHint=$logHint } | ConvertTo-Json"]
  timeout_ms: 20000
```

## Step 4: Check Agent Logs

Verify the agent is producing log output (Windows Event Log or file-based).

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$eventCount = 0; try { $events = Get-WinEvent -LogName Application -FilterXPath \"*[System[Provider[@Name='AIObservabilityAgent' or @Name='ExampleAgent']]]\" -MaxEvents 10 -ErrorAction SilentlyContinue; $eventCount = if ($events) { $events.Count } else { 0 } } catch {}; $logFiles = @(); @('C:\\Program Files\\Example\\*.log','C:\\ProgramData\\Example\\*.log','C:\\Example\\*.log','C:\\Example\\logs\\*.log','C:\\Example\\logs\\*.jsonl') | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue | ForEach-Object { $logFiles += $_.FullName } }; @{ EventLogEntries=$eventCount; LogFileCount=$logFiles.Count; HasLogs=($eventCount -gt 0 -or $logFiles.Count -gt 0) } | ConvertTo-Json"]
  timeout_ms: 15000
```

## Step 5: Process Detection

Create a stub `claude.exe` process and verify the agent detects it via the
ETW classification pipeline.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "New-Item -Path 'C:\\example-stubs' -ItemType Directory -Force | Out-Null; Copy-Item \"$env:SystemRoot\\System32\\cmd.exe\" 'C:\\example-stubs\\claude.exe' -Force; Start-Process 'C:\\example-stubs\\claude.exe' -ArgumentList '/c timeout /t 30' -NoNewWindow; 'stub launched'"]
  timeout_ms: 15000
```

Wait for the ETW + classification pipeline to process the event.

```tool
wait:
  duration_ms: 15000
```

Query the backend to check if the agent detected the process.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$hostname = $env:COMPUTERNAME; $agents = Invoke-RestMethod 'http://172.30.0.1:48001/api/v1/endpoints' -ErrorAction SilentlyContinue; $agent = $agents | Where-Object { $_.hostname -eq $hostname } | Select-Object -First 1; if ($agent) { $tools = Invoke-RestMethod \"http://172.30.0.1:48001/api/v1/endpoints/$($agent.agent_id)/ai-tools\" -ErrorAction SilentlyContinue; $hasClaude = ($tools | Where-Object { $_.process_name -match 'claude' }).Count -gt 0; @{ AgentId=$agent.agent_id; ProcessDetected=$hasClaude } | ConvertTo-Json } else { @{ AgentId=$null; ProcessDetected=$false } | ConvertTo-Json }"]
  timeout_ms: 30000
```

## Step 6: DNS Detection

Resolve known AI tool domains to trigger DNS-Client ETW events, then verify
detection via the backend.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "try { [System.Net.Dns]::GetHostAddresses('api.anthropic.com') | Out-Null } catch {}; try { [System.Net.Dns]::GetHostAddresses('api.openai.com') | Out-Null } catch {}; try { [System.Net.Dns]::GetHostAddresses('copilot.github.com') | Out-Null } catch {}; 'dns resolved'"]
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 10000
```

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$hostname = $env:COMPUTERNAME; $agents = Invoke-RestMethod 'http://172.30.0.1:48001/api/v1/endpoints' -ErrorAction SilentlyContinue; $agent = $agents | Where-Object { $_.hostname -eq $hostname } | Select-Object -First 1; if ($agent) { $events = Invoke-RestMethod \"http://172.30.0.1:48001/api/v1/endpoints/$($agent.agent_id)/events?type=dns\" -ErrorAction SilentlyContinue; $hasAnthro = ($events | Where-Object { $_.domain -match 'anthropic' }).Count -gt 0; @{ DnsDetected=$hasAnthro } | ConvertTo-Json } else { @{ DnsDetected=$false } | ConvertTo-Json }"]
  timeout_ms: 20000
```

## Step 7: Backend Registration

Verify the agent appears in the backend's registered endpoints.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$hostname = $env:COMPUTERNAME; $agents = Invoke-RestMethod 'http://172.30.0.1:48001/api/v1/endpoints' -ErrorAction SilentlyContinue; $agent = $agents | Where-Object { $_.hostname -eq $hostname } | Select-Object -First 1; if ($agent) { @{ Registered=$true; AgentId=$agent.agent_id } | ConvertTo-Json } else { @{ Registered=$false; AgentId=$null } | ConvertTo-Json }"]
  timeout_ms: 30000
```

## Step 8: Heartbeat

Verify the agent's heartbeat is flowing by checking the `last_heartbeat` field.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$hostname = $env:COMPUTERNAME; $agents = Invoke-RestMethod 'http://172.30.0.1:48001/api/v1/endpoints' -ErrorAction SilentlyContinue; $agent = $agents | Where-Object { $_.hostname -eq $hostname } | Select-Object -First 1; if ($agent -and $agent.last_heartbeat) { @{ HasHeartbeat=$true; LastHeartbeat=$agent.last_heartbeat } | ConvertTo-Json } else { @{ HasHeartbeat=$false } | ConvertTo-Json }"]
  timeout_ms: 20000
```

## Step 9: Telemetry Upload

Verify AI tool telemetry has been uploaded to the backend.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$hostname = $env:COMPUTERNAME; $agents = Invoke-RestMethod 'http://172.30.0.1:48001/api/v1/endpoints' -ErrorAction SilentlyContinue; $agent = $agents | Where-Object { $_.hostname -eq $hostname } | Select-Object -First 1; if ($agent) { $events = Invoke-RestMethod \"http://172.30.0.1:48001/api/v1/endpoints/$($agent.agent_id)/ai-tools\" -ErrorAction SilentlyContinue; @{ TelemetryCount=$events.Count; HasTelemetry=($events.Count -gt 0) } | ConvertTo-Json } else { @{ TelemetryCount=0; HasTelemetry=$false } | ConvertTo-Json }"]
  timeout_ms: 20000
```

## Step 10: Service Lifecycle

Stop and restart the agent service to verify clean lifecycle handling.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "$svcName = 'ExampleAgent'; $svc = Get-Service $svcName -ErrorAction SilentlyContinue; if (-not $svc) { $svcName = 'AIObservabilityAgent'; $svc = Get-Service $svcName -ErrorAction SilentlyContinue }; if ($svc) { Stop-Service $svcName -Force -ErrorAction Stop; Start-Sleep 3; $stopped = (Get-Service $svcName).Status -eq 'Stopped'; Start-Service $svcName -ErrorAction Stop; Start-Sleep 3; $restarted = (Get-Service $svcName).Status -eq 'Running'; @{ StopClean=$stopped; RestartClean=$restarted } | ConvertTo-Json } else { @{ StopClean=$false; RestartClean=$false; Error='Service not found' } | ConvertTo-Json }"]
  timeout_ms: 30000
```

## Cleanup

Remove stub processes and files.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args: ["-Command", "Stop-Process -Name 'claude' -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Remove-Item 'C:\\example-stubs' -Recurse -Force -ErrorAction SilentlyContinue; 'cleaned up'"]
  timeout_ms: 10000
```
