# Live Browser CDP Workflow

Validate the scenario-level browser workflow blocks against a live user-session sidecar and Microsoft Edge CDP target.

```tool
ui_ensure_sidecar:
  vm: Win11_test
  username: test
  engine: native
  run_now: true
  wait_ready_ms: 60000
  timeout_ms: 75000
```

```tool
vm_run_command:
  vm: Win11_test
  command: powershell.exe
  args:
    - -NoProfile
    - -ExecutionPolicy
    - Bypass
    - -Command
    - |
      $ErrorActionPreference = 'Stop'
      Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like '*browser-workflow-server.ps1*' } |
        ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
      $scriptPath = 'C:\ProgramData\Signalman\browser-workflow-server.ps1'
      @'
      $ErrorActionPreference = 'Stop'
      $html = '<!doctype html><html><head><title>Signalman Browser Workflow</title></head><body><main><h1 id="title">Signalman Browser Workflow</h1><button id="mark" onclick="document.title=''Clicked''; location.hash=''clicked''; document.body.setAttribute(''data-clicked'',''true'');">Mark</button></main></body></html>'
      $body = [Text.Encoding]::UTF8.GetBytes($html)
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('127.0.0.1'), 18081)
      $listener.Start()
      while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
          $stream = $client.GetStream()
          $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
          while (($line = $reader.ReadLine()) -ne $null -and $line.Length -gt 0) {}
          $newline = [string][char]13 + [string][char]10
          $headers = "HTTP/1.1 200 OK" + $newline +
            "Content-Type: text/html; charset=utf-8" + $newline +
            "Content-Length: " + $body.Length + $newline +
            "Connection: close" + $newline + $newline
          $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
          $stream.Write($headerBytes, 0, $headerBytes.Length)
          $stream.Write($body, 0, $body.Length)
          $stream.Flush()
        } finally {
          $client.Close()
        }
      }
      '@ | Set-Content -LiteralPath $scriptPath -Encoding UTF8
      Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath)
      Start-Sleep -Seconds 2
      $probe = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18081/' -TimeoutSec 5
      @{ StatusCode = $probe.StatusCode; Length = $probe.Content.Length } | ConvertTo-Json -Compress
  timeout_ms: 30000
```

```tool
ui_key:
  vm: Win11_test
  keys: "{ESC}"
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 500
```

```tool
ui_key:
  vm: Win11_test
  keys: "#r"
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 500
```

```tool
ui_type:
  vm: Win11_test
  text: "\"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\" --remote-debugging-port=9222 --no-first-run --no-default-browser-check --user-data-dir=\"C:\\ProgramData\\Signalman\\browser-cdp-profile\" about:blank"
  timeout_ms: 30000
```

```tool
ui_key:
  vm: Win11_test
  keys: "{ENTER}"
  timeout_ms: 15000
```

```tool
vm_run_command:
  vm: Win11_test
  command: powershell.exe
  args:
    - -NoProfile
    - -Command
    - |
      $deadline = [DateTime]::UtcNow.AddSeconds(30)
      do {
        try {
          $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2
          if ($response.StatusCode -eq 200) {
            @{ Ready = $true; ContentLength = $response.Content.Length } | ConvertTo-Json -Compress
            exit 0
          }
        } catch {}
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)
      @{ Ready = $false } | ConvertTo-Json -Compress
      exit 1
  timeout_ms: 40000
```

```tool
browser_navigate:
  vm: Win11_test
  url: "http://127.0.0.1:18081/"
  timeout_ms: 90000
```

```tool
browser_click:
  vm: Win11_test
  css_selector: "#mark"
  timeout_ms: 90000
```

```tool
browser_expect:
  vm: Win11_test
  expression: "({ title: document.title, clicked: document.body.dataset.clicked === 'true', hash: location.hash })"
  expected:
    title: Clicked
    clicked: true
    hash: "#clicked"
  timeout_ms: 90000
  poll_interval_ms: 500
  screenshot_on_failure: true
  output: ./output/live-browser-cdp-workflow/browser-failure.png
```

```tool
browser_snapshot:
  vm: Win11_test
  expression: "document.title"
  format: png
  full_page: false
  output: ./output/live-browser-cdp-workflow/browser.png
  timeout_ms: 90000
```

```tool
vm_run_command:
  vm: Win11_test
  command: powershell.exe
  args:
    - -NoProfile
    - -Command
    - "Get-CimInstance Win32_Process -Filter \"name = 'powershell.exe'\" | Where-Object { $_.CommandLine -like '*browser-workflow-server.ps1*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }; Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue; @{ Done = $true } | ConvertTo-Json -Compress"
  timeout_ms: 30000
```
