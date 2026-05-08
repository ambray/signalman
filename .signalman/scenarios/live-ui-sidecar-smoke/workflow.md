# Live UI Sidecar Smoke

Validate that the guest agent can reach the interactive user-session sidecar and drive the Windows desktop through the normal scenario workflow surface.

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
ui_screenshot:
  vm: Win11_test
  format: png
  output: ./output/live-ui-sidecar-smoke/desktop.png
  timeout_ms: 15000
```

```tool
ui_wait_for:
  vm: Win11_test
  selector: "[automationId='SearchButton']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_click:
  vm: Win11_test
  selector: "[automationId='SearchButton']"
  click_type: left
  timeout_ms: 15000
```

```tool
ui_wait_for:
  vm: Win11_test
  selector: "[automationId='SearchTextBox']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
wait:
  duration_ms: 500
```

```tool
ui_type:
  vm: Win11_test
  selector: "[automationId='SearchTextBox']"
  text: "signalman native smoke"
  clear_first: true
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 1000
```

```tool
ui_find:
  vm: Win11_test
  selector: "[automationId='SearchTextBox']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_find:
  vm: Win11_test
  selector: "[value='signalman native smoke']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_find:
  vm: Win11_test
  selector: "signalman native smoke"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_snapshot:
  vm: Win11_test
  format: png
  output: ./output/live-ui-sidecar-smoke/snapshot.png
  max_elements: 25
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_key:
  vm: Win11_test
  selector: "[automationId='SearchTextBox']"
  keys: "{ESC}"
  timeout_ms: 15000
```
