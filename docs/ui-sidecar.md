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
- `vm_ui_open_url`: open an `http://` or `https://` URL in the
  interactive desktop through the Windows Run dialog.
- `vm_ui_navigate_url`: navigate an already-open browser by focusing the
  address bar, typing an `http://` or `https://` URL, pressing Enter, and
  optionally verifying the address value through UI Automation.
- `vm_browser_navigate`, `vm_browser_click`, `vm_browser_evaluate`,
  `vm_browser_screenshot`: expose the reserved guest Browser* RPC contract for
  DOM/CDP control. The guest service routes these calls to the user-session
  sidecar. The native engine now provides an initial loopback-only CDP backend
  for navigation, CSS-selector click, JavaScript page-state evaluation, and
  browser screenshots. PowerShell engines still return the stable
  CDP-unavailable response, and the native engine reports the same boundary
  when no local CDP target is reachable.

Scenario workflows use the same operation names without the `vm_` prefix,
including `ui_ensure_sidecar`, `ui_open_url`, and `ui_navigate_url` for
self-contained live smokes and browser launch/navigation flows.

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
   `vm_ui_find`, `vm_ui_click`, `vm_ui_key`, `vm_ui_type`,
   `vm_ui_open_url`, and `vm_ui_navigate_url` for targeted interaction and
   browser launch/navigation.
7. Use screenshots plus UIA element data as the feedback loop.

## Current Limits

The native implementation is intentionally narrow but now covers the common
LLM-test interaction loop: observe with `vm_ui_snapshot`, locate controls with
`vm_ui_find` / `vm_ui_wait_for`, then use targeted `vm_ui_click`, `vm_ui_type`,
and `vm_ui_key` calls. Prefer explicit selectors for typing and keyboard input;
untargeted input still goes to whatever window currently owns focus.

Native `vm_ui_find` honors the element wait timeout by checking once, then
subscribing to UI Automation structure-change events while it waits for a
matching element. The wait still has a bounded timeout fallback so provider
quirks cannot hang a scenario. Empty-selector inventory calls return
immediately so snapshots stay cheap.

Native `vm_ui_click` treats default/left clicks as semantic UI actions first:
when the target supports UI Automation's Invoke pattern, Signalman invokes the
control directly and falls back to coordinate-based input if Invoke is not
available. Right-click and double-click remain physical coordinate actions.

When a native UI Automation element supports the Value pattern, its current
value is included in the normalized element descriptor. This lets scenarios
assert the text of edit controls directly instead of relying only on screenshots
or neighboring result labels.

`vm_ui_key` accepts the portable subset Signalman uses in smoke and product
flows today: `{ENTER}`, `{ESC}` / `{ESCAPE}`, `{TAB}`, `{BACKSPACE}` / `{BS}`,
`{SPACE}`, `~`, alphanumeric key sequences, and modifier prefixes `^` for Ctrl,
`+` for Shift, and `%` for Alt. The native engine also supports `{DELETE}` /
`{DEL}`, `{INSERT}` / `{INS}`, `{HOME}`, `{END}`, `{PAGEUP}` / `{PGUP}`,
`{PAGEDOWN}` / `{PGDN}`, arrow keys, `{F1}` through `{F24}`, `{PRINTSCREEN}` /
`{PRTSC}`, `{PAUSE}`, `{APPS}`, `{WIN}` / `{LWIN}` / `{RWIN}`, and `#` as a
Win-key modifier. Native key sequences can combine tokens, for example
`{TAB}{TAB}{ENTER}`, `^a{BACKSPACE}`, `^+{ESC}`, `+{F5}`, or `#r`. The
PowerShell engines still accept broader Windows SendKeys syntax, but scenarios
intended to run on the native engine should stay within the documented subset.

More complex desktop workflows still need richer eventing, but the browser
DOM/CDP observation loop now has command, click, evaluate, and screenshot
primitives. The guest proto reserves `BrowserNavigate`, `BrowserClick`,
`BrowserEvaluate`, and `BrowserScreenshot`; the host exposes those as
`vm_browser_navigate`, `vm_browser_click`, `vm_browser_evaluate`, and
`vm_browser_screenshot`, and the guest service forwards them to the
user-session sidecar so CDP control runs in the logged-in desktop session.
`BrowserEvaluate` returns a JSON-encoded value string plus page metadata so LLM
tests can inspect DOM state without relying only on pixels. The native engine
connects only to loopback CDP targets, auto-launches Microsoft Edge with
`--remote-debugging-port` when needed, and uses an isolated temp profile.
Configure the port with `SIGNALMAN_BROWSER_CDP_PORT`; set
`SIGNALMAN_BROWSER_CDP_AUTOLAUNCH=false` to require a pre-existing debug target.
PowerShell engines keep returning `success: false` with the CDP-unavailable
error for navigate/click/evaluate, while screenshots fail because the screenshot
proto has no error field.

The live `scripts/live-browser-cdp-smoke.ps1` harness validates this path on
`Win11_test`: it confirms the named checkpoint exists, starts a guest-local HTTP
page, ensures the native sidecar, launches Edge with CDP through the interactive
Run dialog, calls `BrowserNavigate`, `BrowserClick`, `BrowserEvaluate`, and
`BrowserScreenshot`, writes a screenshot under `output/screenshots/`, and
confirms the checkpoint is still present afterward.

`vm_ui_open_url` is the current browser launch bridge: it validates the target
as `http(s)`, opens the Windows Run dialog with `Win+R`, types the URL into the
Run edit control, and presses Enter. It intentionally does not accept `file:`,
`javascript:`, or shell-like targets, and rejects embedded URL credentials so
secrets are not echoed in tool output.

Once the browser is open, `vm_ui_navigate_url` is the preferred workflow
primitive for page transitions. It validates the URL with the same rules,
discovers an address/search target from UI Automation when selectors are not
provided, clicks that target, sends Ctrl+L to the editable address control,
types the normalized URL, presses Enter, and by default waits for the expected
address value to appear through UI Automation. The response reports
`target_selector`, `target_edit_selector`, `target_kind`, and
`target_confidence` so recordings and LLM agents can explain which observed
control they used. If an auto-discovered target goes stale before it can be
clicked or focused, Signalman retries once with the current Microsoft Edge
selectors (`[name='Address and search bar']` and `[automationId='view_1021']`)
and reports `target_fallback: true`. Explicit `address_selector` /
`address_edit_selector` overrides skip discovery and stale-target fallback so
pinned browser-specific flows fail clearly. If discovery finds no browser
target, Signalman uses the same Edge selectors as the default path. Native UI
Automation is the preferred path for Windows desktop workflows; the PowerShell
engines remain useful fallbacks and compatibility probes.

The live `live-ui-browser-smoke` scenario pins this browser-launch and
interaction contract on `Win11_test`: it starts the native sidecar, closes stale
Edge processes, opens an isolated `example.test` URL, confirms the normalized
URL reported by `ui_open_url`, observes the browser address value through UI
Automation, navigates to a second URL through `ui_navigate_url`, captures a
browser screenshot plus element inventory, verifies the address bar appears as
a compact action target, and closes the window.

`vm_ui_health` reports the active engine (`powershell-process`,
`powershell-helper`, or `native`) through the same health surface every backend
uses. The sidecar dispatches requests through an engine boundary, so workflows
can choose PowerShell process, PowerShell helper, or native automation without
changing the loopback, guest-agent, MCP, or workflow contracts.

`vm_ui_find`, `vm_ui_wait_for`, and `vm_ui_snapshot` return normalized element
descriptors for LLM-enabled tests. Each descriptor includes a deterministic
`element_id`, a reusable selector, normalized `bounds` with center coordinates,
state flags, a browser-friendly `role`, a fallback `label`, conservative action
hints (`click`, `type`, `key`), and the raw UI Automation payload. These
responses also include an `action_targets` list: a compact menu of visible,
enabled elements that have at least one action hint, with only the selector,
name, role, label, type, value, actions, and bounds needed for the next
interaction.

Snapshot/find responses also include `browser_targets`: a smaller, scored list
of likely browser address or search boxes. Discovery is conservative: targets
must be enabled, visible, typeable controls and gain confidence from
address/search labels, URL-looking values, wide edit bounds, or known browser
automation ids. Each target reports `kind`, `confidence`, `selector`,
`edit_selector`, `value`, and `reasons`, so LLM-enabled workflows can pick a
navigation target from observation data before calling `vm_ui_navigate_url`.
The `element_id` is stable for a single snapshot/find result and is meant for
logs and assertions; actions still take selectors so a future native backend can
keep the same workflow contract.

For longer LLM-driven runs, UI MCP tools accept `recover_username`,
`recover_engine`, and `recover_wait_ready_ms`. When `recover_username` is set and
an action cannot reach the sidecar, the host re-runs the sidecar scheduled-task
setup once and retries the UI call. Workflow tool blocks expose the same behavior
as `sidecar_username`, `sidecar_engine`, and `sidecar_wait_ready_ms`.
