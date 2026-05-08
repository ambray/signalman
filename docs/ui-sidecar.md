# User Session UI Sidecar

Signalman's guest agent is normally installed as a Windows service. That is the right place for privileged process, file, and verification RPCs, but services do not own the logged-in user's desktop. UI automation needs a small companion process running inside the interactive user session.

The same guest binary can run in sidecar mode:

```powershell
signalman-guest.exe --ui-sidecar --ui-sidecar-bind 127.0.0.1:50151
```

The service-facing guest agent proxies UI RPCs to this loopback sidecar. The sidecar address defaults to `127.0.0.1:50151`; override it for the service process with `SIGNALMAN_UI_SIDECAR_ADDR` and for the sidecar process with `SIGNALMAN_UI_SIDECAR_BIND`.

The default automation engine remains `powershell-process`, which launches a
fresh STA PowerShell process for each UI action. For lower-latency local
validation, set `SIGNALMAN_UI_ENGINE=powershell-helper` on the sidecar process.
That keeps a single STA PowerShell helper alive and sends action scripts over
stdin/stdout.

For production-style Windows UI validation, set `SIGNALMAN_UI_ENGINE=native`.
The native engine runs in-process inside the sidecar and currently supports
health, screenshot, find, click, type, and key operations without per-action
PowerShell startup. It uses Windows UI Automation for element discovery,
GDI-based screen capture for screenshots, and `SendInput` for mouse and keyboard
input.

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

Scenario workflows use the same operation names without the `vm_` prefix,
including `ui_ensure_sidecar` for self-contained live smokes.

UI tool responses include per-RPC timing metadata. Single operations report
`duration_ms`; snapshots split that into `screenshot_duration_ms` and
`find_duration_ms` so LLM-enabled tests can distinguish slow capture from slow
UI Automation enumeration.

Selectors currently support these exact forms:

```text
[name='Save']
[automationId='save-button']
[className='Button']
[controlType='Button']
[controlType='ControlType.Button']
[value='typed text']
```

Plain selector text falls back to fuzzy name matching or exact automation id matching.
`[value='...']` matches exact current Value-pattern text for controls that expose it.

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

The native implementation is intentionally narrow but now covers the common
LLM-test interaction loop: observe with `vm_ui_snapshot`, locate controls with
`vm_ui_find` / `vm_ui_wait_for`, then use targeted `vm_ui_click`, `vm_ui_type`,
and `vm_ui_key` calls. Prefer explicit selectors for typing and keyboard input;
untargeted input still goes to whatever window currently owns focus.

Native `vm_ui_find` honors the element wait timeout by polling UI Automation
until a matching element appears or the timeout expires. Empty-selector
inventory calls return immediately so snapshots stay cheap.

When a native UI Automation element supports the Value pattern, its current
value is included in the normalized element descriptor. This lets scenarios
assert the text of edit controls directly instead of relying only on screenshots
or neighboring result labels.

`vm_ui_key` accepts the cross-engine subset Signalman uses in smoke and product
flows today: `{ENTER}`, `{ESC}` / `{ESCAPE}`, `{TAB}`, `{BACKSPACE}` / `{BS}`,
`{SPACE}`, `~`, alphanumeric key sequences, and one-letter Ctrl chords such as
`^a`. Native key sequences can combine tokens, for example
`{TAB}{TAB}{ENTER}` or `^a{BACKSPACE}`. The PowerShell engines still accept
broader Windows SendKeys syntax, but scenarios intended to run on the native
engine should stay within the documented subset.

More complex desktop workflows still need richer eventing and eventually a
first-class browser/UI observation loop. Native UI Automation is the preferred
path for Windows desktop workflows; the PowerShell engines remain useful
fallbacks and compatibility probes.

`vm_ui_health` reports the active engine (`powershell-process`,
`powershell-helper`, or `native`) through the same health surface every backend
uses. The sidecar dispatches requests through an engine boundary, so workflows
can choose PowerShell process, PowerShell helper, or native automation without
changing the loopback, guest-agent, MCP, or workflow contracts.

`vm_ui_find`, `vm_ui_wait_for`, and `vm_ui_snapshot` return normalized element
descriptors for LLM-enabled tests. Each descriptor includes a deterministic
`element_id`, a reusable selector, normalized `bounds` with center coordinates,
state flags, and the raw UI Automation payload. The `element_id` is stable for a
single snapshot/find result and is meant for logs and assertions; actions still
take selectors so a future native backend can keep the same workflow contract.

For longer LLM-driven runs, UI MCP tools accept `recover_username`,
`recover_engine`, and `recover_wait_ready_ms`. When `recover_username` is set and
an action cannot reach the sidecar, the host re-runs the sidecar scheduled-task
setup once and retries the UI call. Workflow tool blocks expose the same behavior
as `sidecar_username`, `sidecar_engine`, and `sidecar_wait_ready_ms`.
