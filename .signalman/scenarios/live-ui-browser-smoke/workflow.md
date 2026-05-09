# Live UI Browser Smoke

Validate that Signalman can launch a browser through the interactive user-session UI sidecar and observe the resulting desktop state with the same UIA snapshot/find loop used by LLM-enabled tests.

```tool
ui_ensure_sidecar:
  vm: Win11_test
  username: test
  engine: native
  run_now: true
  wait_ready_ms: 15000
  timeout_ms: 30000
```

```tool
ui_health:
  vm: Win11_test
  timeout_ms: 15000
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
    - "Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue"
  timeout_ms: 30000
```

```tool
wait:
  duration_ms: 1000
```

```tool
ui_key:
  vm: Win11_test
  keys: "{ESC}"
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 300
```

```tool
ui_open_url:
  vm: Win11_test
  url: "http://example.test/signalman-browser-smoke"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
wait:
  duration_ms: 3000
```

```tool
ui_find:
  vm: Win11_test
  selector: "[value='example.test/signalman-browser-smoke']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_click:
  vm: Win11_test
  selector: "[name='Address and search bar']"
  timeout_ms: 15000
```

```tool
ui_key:
  vm: Win11_test
  selector: "[automationId='view_1021']"
  keys: "^l"
  timeout_ms: 15000
```

```tool
ui_type:
  vm: Win11_test
  selector: "[automationId='view_1021']"
  text: "http://example.test/signalman-browser-interaction"
  clear_first: true
  timeout_ms: 15000
```

```tool
ui_key:
  vm: Win11_test
  selector: "[automationId='view_1021']"
  keys: "{ENTER}"
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 2000
```

```tool
ui_find:
  vm: Win11_test
  selector: "[value='example.test/signalman-browser-interaction']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_snapshot:
  vm: Win11_test
  format: png
  output: ./output/live-ui-browser-smoke/browser.png
  max_elements: 80
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_key:
  vm: Win11_test
  keys: "%{F4}"
  timeout_ms: 15000
```
