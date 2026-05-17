# Mac Virtualization Strategy

Signalman's Windows path uses a privileged control-plane service to broker
Hyper-V operations. On macOS, the equivalent problem is different: Apple's
Virtualization.framework requires the calling process to have the
`com.apple.security.virtualization` entitlement, and macOS guests are supported
on Apple Silicon. That makes a plain Rust or Node daemon awkward unless we also
build, sign, and entitle a native macOS helper.

## Status (2026-05)

WS4 (cross-platform parity) shipped the Tart backend as the v0.2.x Mac
runner in v0.2.0. The current macOS surface is:

- **Tart backend** — `host/src/hypervisors/tart.ts`. `HypervisorBackend`
  parity with `HyperVBackend` / `LibvirtBackend` / `VmwareBackend` for
  `createVM` / `startVM` / `stopVM` / `executeCommand` /
  `vmCheckpoint(save|restore|delete)`. Selected via
  `SIGNALMAN_BACKEND=tart` or `hypervisor: tart` in `signalman.yaml`.
- **Guest agent on macOS** — the `Platform` trait in
  [`guest/src/platform/`](../guest/src/platform/) has a `Macos` impl
  alongside `Windows`, `Linux`, and `Other`. `WriteFile` jails into
  `SIGNALMAN_WORKSPACE`, `ExecuteCommand` uses `/bin/sh` for shell-mode
  execution, and the [LaunchDaemon installer](../scripts/macos/install-guest-agent.sh)
  installs it as `com.signalman.guest`.
- **Bootstrap doc** — see [`bootstrap.md` §6](bootstrap.md#6-macos-host-bootstrap-tart)
  for the end-to-end install walkthrough on a fresh Apple Silicon host.
- **UI automation** — **not yet shipped.** AppleScript + AX driver
  parity with the Windows `UiAutomation` driver remains the open WS4
  follow-up; see the [Recommendation](#recommendation) section for the
  current plan.

## Requirements

- Host: Apple Silicon Mac for macOS guests. Linux guests can also run through
  Apple's Virtualization.framework on modern macOS, but this document focuses on
  macOS guests.
- Guest image: macOS restore image (`.ipsw`) or a prepared VM image.
- Guest control: either Signalman's guest agent, Tart's guest agent
  (`tart exec`), or SSH into the VM.
- Isolation: NAT is the default. Bridged or Softnet-style isolation should be a
  scenario-level choice once network classes become enforced.
- Licensing: Apple's currently published macOS SLA permits up to two additional
  virtualized macOS instances per Apple-branded Mac for listed uses. Operators
  need to validate their own license terms, especially for hosted or
  multi-tenant use.

## Guest Agent Permissions

The macOS guest should run the Signalman guest agent as the in-guest control
plane. Tart owns VM lifecycle; Signalman owns file operations, command
execution, and eventually UI automation.

Baseline guest agent:

- A LaunchDaemon can run the agent as root for unattended command/file
  operations.
- `scripts/macos/install-guest-agent.sh` installs this LaunchDaemon inside the
  VM. Build or copy `signalman-guest` into the VM, then run the installer with a
  bearer token and optional TLS material.
- `SIGNALMAN_WORKSPACE` should point at the scenario workspace inside the VM;
  guest `WriteFile` refuses writes outside that jail when it is set.
- No special entitlement is required for ordinary file read/write inside the
  agent's OS permissions. Full Disk Access is a TCC grant, not a code-signing
  entitlement; only grant it if scenarios intentionally inspect protected user
  data.
- The host should connect with guest mTLS and/or
  `SIGNALMAN_GUEST_TOKEN` / `SIGNALMAN_AUTH_TOKEN`.

Example guest install:

```bash
cargo build --release -p signalman-guest
sudo scripts/macos/install-guest-agent.sh \
  --binary target/release/signalman-guest \
  --workspace /var/lib/signalman/workspace \
  --token "$SIGNALMAN_AUTH_TOKEN"
```

On the host side:

```bash
export SIGNALMAN_BACKEND=tart
export SIGNALMAN_GUEST_TOKEN="$SIGNALMAN_AUTH_TOKEN"
```

UI automation later:

- Accessibility API control (`AXUIElement`) requires the agent process to be a
  trusted accessibility client. The app/daemon can check this with
  `AXIsProcessTrustedWithOptions`; approval is stored in TCC and is normally
  granted by the user or by an MDM PPPC profile.
- Screenshots should use ScreenCaptureKit. The first run prompts for Screen
  Recording permission and the process needs to restart after approval.
- Persistent unattended screen capture is a restricted Apple entitlement:
  `com.apple.developer.persistent-content-capture`. Apple describes it as for
  VNC-style apps and requires an entitlement request.
- Event injection through CoreGraphics/HID commonly hits Accessibility and/or
  Input Monitoring TCC policy. Treat it as a PPPC/MDM-managed permission, not a
  normal Xcode entitlement.
- A root LaunchDaemon is not enough for UI automation. The UI worker should run
  as a LaunchAgent in the logged-in user session, with the LaunchDaemon reserved
  for privileged setup and file/command operations.

Device management:

- If "manage the device" means MDM/ADE enrollment workflows, Apple exposes
  `com.apple.developer.automated-device-enrollment.add-devices`, but that is
  for adding devices to Automated Device Enrollment and requires Apple's
  approval.
- For scenario setup inside a VM, prefer ordinary root commands, profiles, and
  the guest file API before pursuing restricted device-management entitlements.

## Option A: Tart Backend First

This is the current implementation direction.

Tart is a Swift CLI/app bundle around Virtualization.framework. It already
solves the entitlement, VM image, OCI registry, clone, run, stop, IP lookup, and
command-exec problems that Signalman needs for a first useful macOS runner.

Signalman integration:

- `host/src/hypervisors/tart.ts` implements `HypervisorBackend`.
- `createVM` maps to `tart clone <template> <name>`.
- `startVM` launches `tart run --no-graphics <name>` and waits for Tart to
  report the VM running.
- `executeCommand` maps to `tart exec <vm> <command> ...args`.
- Checkpoints are emulated with local Tart clones named
  `<vm>--signalman-cp--<label>`.

Tradeoffs:

- Fastest path to usable macOS VM execution and CI-style workflows.
- Depends on Tart's CLI contract and license.
- Backend-level Tart file copy is intentionally not implemented yet; scenario
  file copy should use the Signalman guest agent. Mounted directories, SSH/SCP,
  or a future Tart copy command remain useful fallback options.
- Full service-style mTLS control is not present; local process permissions and
  Tart's own entitlements are the trust boundary.

## Option B: First-party Swift Helper

Build a small `signalman-mac-runner` Swift executable/app bundle that uses
Virtualization.framework directly and exposes the existing Signalman
ControlPlane gRPC contract.

Tradeoffs:

- Best long-term control over VM state, logs, save/restore, and packaging.
- Aligns with the Windows service architecture.
- Requires macOS code signing, entitlements, packaging, update flow, and a Swift
  implementation of VM bundle management.
- Re-implements image management that Tart already provides.

This becomes attractive if Tart's license, command surface, or roadmap becomes
misaligned with Signalman's needs.

## Option C: VMware Fusion

The existing `VmwareBackend` can operate VMware VMs via `vmrun`, including on
macOS hosts with Fusion installed.

Tradeoffs:

- Useful fallback for users who already have Fusion VMs.
- Not the right primary path for Apple Silicon macOS CI: VM creation is not
  implemented, credentials are passed to `vmrun`, and macOS image automation is
  weaker than Tart.

## Non-option: libvirt/KVM (v0.5 explicit non-support)

The `LibvirtBackend` does **not** support macOS guests. Any
`config.osProfile` value starting with `macos` raises
`invalid_argument` at `createVM` with a "use Tart" message.

Two reasons:

1. **License.** Apple's macOS EULA constrains the OS to Apple
   hardware. Running macOS on a non-Apple host (which is the
   typical libvirt/KVM deployment) is outside the license terms,
   regardless of whether technical workarounds (OSX-KVM,
   OpenCore, etc.) exist to make it boot.
2. **Architecture.** Modern macOS targets Apple Silicon (ARM64).
   x86 KVM hosts can only run Intel macOS, which Apple no longer
   ships installers for. ARM64 KVM on non-Apple hardware can boot
   Apple Silicon macOS only via the Asahi-style firmware ports,
   which are research-grade and not a stable surface.

Operators who need macOS testing as part of a signalman scenario
run use the **Tart backend on Apple Silicon hardware**. The Tart
backend (`host/src/hypervisors/tart.ts`) ships in v0.2.0+ and
supports the full lifecycle / snapshot / file-transfer /
command-run surface that scenarios depend on.

## Recommendation

**v0.2.0 (shipped).** Tart is the primary Mac runner backend. The
Tart `HypervisorBackend` implementation in
`host/src/hypervisors/tart.ts` is feature-complete for VM lifecycle,
command execution, and checkpoint emulation via clones. CI exercises
the backend through hermetic mocks of the `tart` CLI; smoke testing
against a real Apple Silicon host is documented in
[`bootstrap.md` §6](bootstrap.md#6-macos-host-bootstrap-tart).

**v0.3.x – v0.4.x (current).** The Tart backend is stable; no
first-party Swift helper has been needed for VM lifecycle. The open
WS4 follow-up is **UI automation parity** on macOS:

- Spec out an `AppleScriptDriver` + `AXUIElementDriver` pair that
  mirrors the Windows `UiAutomation` driver shape.
- The driver should run as a LaunchAgent in the logged-in user
  session (the LaunchDaemon stays for privileged file/command
  operations).
- Accessibility + Screen Recording TCC grants are operator
  prerequisites — we will document the manual grant on first run
  and the MDM PPPC profile shape for fleet deployments.

**v0.5+ horizon.** A first-party Swift helper (Option B) remains the
hardening path if Tart's license, command surface, or roadmap
diverges from Signalman's needs, **or** if persistent unattended
screen capture
(`com.apple.developer.persistent-content-capture`) is required for
a hosted demo / screenshot product. The Apple entitlement
application is the long-pole item, so we defer it until a concrete
customer use case appears.

Sources:

- Apple Virtualization framework: https://developer.apple.com/documentation/virtualization
- Apple virtualization entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.virtualization
- Apple macOS VM sample: https://developer.apple.com/documentation/Virtualization/running-macos-in-a-virtual-machine-on-apple-silicon
- Apple entitlements overview: https://developer.apple.com/documentation/bundleresources/entitlements
- Apple ScreenCaptureKit sample: https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos
- Apple Persistent Content Capture entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture
- Apple Accessibility trust API: https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions
- Apple Automated Device Enrollment framework: https://developer.apple.com/documentation/AutomatedDeviceEnrollment
- Apple Software License Agreements: https://www.apple.com/legal/sla/
- Tart quick start: https://tart.run/quick-start/
- Tart guest agent / `tart exec`: https://tart.run/blog/2025/06/01/bridging-the-gaps-with-the-tart-guest-agent/
