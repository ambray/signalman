# Live UI Sidecar Smoke

Validate that the guest agent can reach the interactive user-session sidecar and drive the Windows desktop through the normal scenario workflow surface.

```tool
ui_screenshot:
  vm: Win11_test
  format: png
  output: ./output/live-ui-sidecar-smoke/desktop.png
  timeout_ms: 15000
```

```tool
ui_find:
  vm: Win11_test
  selector: "[name='Start']"
  find_timeout_ms: 15000
  timeout_ms: 20000
```

```tool
ui_click:
  vm: Win11_test
  selector: "[name='Start']"
  click_type: left
  timeout_ms: 15000
```

```tool
wait:
  duration_ms: 500
```

```tool
ui_type:
  vm: Win11_test
  text: "signalman ui smoke"
  timeout_ms: 15000
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
