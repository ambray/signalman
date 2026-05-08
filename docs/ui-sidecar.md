# User Session UI Sidecar

Signalman's guest agent is normally installed as a Windows service. That is the right place for privileged process, file, and verification RPCs, but services do not own the logged-in user's desktop. UI automation needs a small companion process running inside the interactive user session.

The same guest binary can run in sidecar mode:

```powershell
signalman-guest.exe --ui-sidecar --ui-sidecar-bind 127.0.0.1:50151
```

The service-facing guest agent proxies UI RPCs to this loopback sidecar. The sidecar address defaults to `127.0.0.1:50151`; override it for the service process with `SIGNALMAN_UI_SIDECAR_ADDR` and for the sidecar process with `SIGNALMAN_UI_SIDECAR_BIND`.

The default automation engine is `powershell-process`, which launches a fresh
STA PowerShell process for each UI action. For lower-latency local validation,
set `SIGNALMAN_UI_ENGINE=powershell-helper` on the sidecar process. That keeps a
single STA PowerShell helper alive and sends action scripts over stdin/stdout.

## MCP Tools

The host registers these MCP tools when guest-agent access is available:

- `vm_ui_ensure_sidecar`: create or update the scheduled task that launches
  the sidecar in a named user's interactive session, then wait for the
  loopback sidecar port and report `ready`.
- `vm_ui_health`: report whether the sidecar is reachable, which automation
  engine it is using, its PID, and its uptime.
- `vm_ui_snapshot`: capture a screenshot and a bounded UI Automation element
  inventory in one response for LLM observation loops.
- `vm_ui_screenshot`: capture a PNG or JPEG screenshot from the interactive session.
- `vm_ui_find`: find UI Automation elements by selector.
- `vm_ui_wait_for`: wait for an element and fail the tool call when it is absent.
- `vm_ui_click`: click a UI Automation element.
- `vm_ui_key`: send a Windows SendKeys chord or special-key sequence.
- `vm_ui_type`: type text into the active session, optionally targeting an element first.

UI tool responses include per-RPC timing metadata. Single operations report
`duration_ms`; snapshots split that into `screenshot_duration_ms` and
`find_duration_ms` so LLM-enabled tests can distinguish slow capture from slow
UI Automation enumeration.

Selectors currently support these exact forms:

```text
[name='Save']
[automationId='save-button']
[className='Button']
[controlType='ControlType.Button']
```

Plain selector text falls back to fuzzy name matching or exact automation id matching.

## Deployment Pattern

Start the sidecar at user logon with a scheduled task configured for the test account and "Run only when user is logged on." `vm_ui_ensure_sidecar` creates that task through the guest agent using an `InteractiveToken` principal, so the sidecar runs on the user's desktop rather than in the service session. Keep the guest service installed separately. The sidecar should bind loopback only; the host should still talk to the guest service over the existing guest-agent channel.

This gives LLM-enabled tests a practical path for desktop workflows:

1. Restore or boot the VM.
2. Ensure the test user is logged in.
3. Run `vm_ui_ensure_sidecar` for that user, or rely on the scheduled task from a previous setup.
4. Confirm the tool returns `ready: true`; increase `wait_ready_ms` for slow logons.
5. Use normal guest-agent RPCs for setup.
6. Use `vm_ui_snapshot` for the model's observation loop, then `vm_ui_wait_for`,
   `vm_ui_find`, `vm_ui_click`, `vm_ui_key`, and `vm_ui_type` for targeted
   interaction.
7. Use screenshots plus UIA element data as the feedback loop.

## Current Limits

The first implementation is intentionally narrow. It uses Windows UI Automation and SendKeys through a PowerShell STA process per action. `vm_ui_key` accepts Windows SendKeys syntax such as `{ENTER}`, `{ESC}`, `{TAB}`, and `^a`. That is fine for smoke tests and product flows, but more complex test runs should eventually move the automation engine into native Rust or a long-lived Windows helper so we avoid per-action PowerShell startup cost and get richer eventing.

`vm_ui_health` reports the active engine (`powershell-process` or
`powershell-helper`) through the same health surface the future native helper
will use.
