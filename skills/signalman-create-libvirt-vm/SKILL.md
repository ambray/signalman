---
name: signalman-create-libvirt-vm
description: 'Create a new libvirt/KVM VM on a local Linux host via signalman_vm_create. Trigger when the user says "spin up a KVM VM", "create a libvirt domain", "provision a local VM on this Linux box", or any variant of "create a VM" on a host where the libvirt backend is selected. The skill handles libvirt-specific prerequisites (storage pool + template YAML) before invoking the tool. v0.5: backend produces a libvirt-managed qcow2 backing-file volume (vol-create-as) so vm_delete cleans up properly. Cloud VMs use signalman-provision-cloud-vm instead.'
allowed-tools: mcp__signalman__signalman_advanced_vm_create, mcp__signalman__signalman_advanced_vm_list, mcp__signalman__signalman_advanced_vm_delete, Bash
---

# Create a libvirt/KVM VM

This skill drives `signalman_vm_create` against the libvirt backend
on a local Linux host. It is **not** for cloud VMs (use
`signalman-provision-cloud-vm`) and not for Hyper-V (use the
existing Hyper-V provisioning flow). Use this when:

- The user is on Linux and has `libvirtd` running locally.
- They want a one-off KVM domain (test bed, isolated repro, ephemeral
  scenario target) rather than going through cloud or a pre-configured
  Hyper-V host.

## What you need from the user

- **VM name** — sanitized through `sanitizeVmName` (`[a-zA-Z0-9_-]+`).
- **Template** — either:
  - A registered template name from `.signalman/templates/<name>.yaml`
    that carries `base_image_path` pointing at an existing qcow2.
  - Or an absolute path to an existing qcow2 image (skill walks the
    user through writing the template YAML first; libvirt's backend
    refuses path-less templates with `invalid_argument`).
- **Guest OS profile** (v0.5 multi-OS) — `osProfile`. Picks
  firmware + security primitives + device defaults appropriate
  for the guest. Defaults to `linux`:
  - `linux` — BIOS, virtio disk/NIC, UTC clock, no TPM/Secure Boot.
    Modern Linux distros (Ubuntu, Alpine, Fedora, Debian) that ship
    virtio drivers in-kernel. **Default; matches v0.5 baseline.**
  - `linux-uefi` — UEFI without Secure Boot. For distros that need
    UEFI but don't enforce keys.
  - `windows-10` — UEFI, virtio, localtime clock, USB tablet input,
    QXL video, VNC. TPM + Secure Boot off by default; operator may
    opt in.
  - `windows-11` — UEFI + Secure Boot + TPM 2.0 + SMM, **all
    mandatory**. Operator overrides for firmware / secureBoot / tpm
    raise `invalid_argument` (Win11 refuses to boot without all
    three; fail-loud at createVM is friendlier than a half-installed
    VM).
- **macOS is NOT supported.** Any `osProfile` starting with `macos`
  is rejected at createVM with a "use Tart" message. See
  `docs/mac-virtualization.md §Non-option: libvirt/KVM`.
- **Memory** — `memoryMB` (default 2048). Integer; range 32-1048576.
- **vCPUs** — `cpus` (default 2). Integer; range 1-240.
- **Disk capacity** — `diskGB` (default 20). Sparse qcow2 backing-file,
  so over-sizing is harmless — the guest physical consumption stays
  bounded by what it actually writes.
- (Optional) **Network** — defaults to the libvirt `default` virbr0
  bridge. Override via `switchName` to point at a different libvirt
  network.
- (Optional) **Per-field overrides** — for unusual setups, the
  operator may set `firmware`, `secureBoot`, `tpm`, `diskBus`,
  `nicModel` individually. Most common case: a Windows 10 VM with
  no virtio-win driver staged — set `diskBus: 'sata'` and
  `nicModel: 'e1000e'` so the in-box Windows drivers handle the
  hardware. Once virtio-win is installed inside the guest the
  operator can flip back to virtio for performance.

## Host prerequisites by profile

| Profile | Host package(s) | Why |
|---|---|---|
| `linux` | `libvirt-clients`, `libvirt-daemon-system`, `qemu-kvm` | Baseline KVM |
| `linux-uefi` | + `ovmf` (OVMF firmware) | UEFI loader |
| `windows-10` | + `ovmf` (always-on UEFI in this profile) | UEFI loader |
| `windows-11` | + `ovmf`, `swtpm`, `swtpm-tools` | vTPM 2.0 emulator |

Ubuntu 26.04 / Debian trixie + ships all of these in the default
repos. Verify before kicking off a Windows-11 create:

```bash
# OVMF firmware variants:
ls /usr/share/OVMF/                 # expect OVMF_CODE_4M.ms.fd + OVMF_VARS_4M.ms.fd
# swtpm for TPM 2.0 emulation:
which swtpm swtpm_setup             # expect /usr/bin/swtpm
```

## Prerequisites (verify before invoking)

The libvirt backend requires three things to exist before
`vm_create` succeeds. If any are missing, surface the gap before
making the MCP call.

### 1. libvirtd reachable

```bash
virsh -c qemu:///system version --daemon
```

Should print the daemon version. `command not found` → install
`libvirt-clients` + `libvirt-daemon-system` (`sudo apt install -y
libvirt-clients libvirt-daemon-system`). `cannot connect to libvirt`
→ ensure libvirtd is running (`systemctl start libvirtd`) and the
user is in the `libvirt` + `kvm` groups.

### 2. A writeable storage pool

The backend writes the new disk into the configured pool. Default
pool name is `default` (`/var/lib/libvirt/images`, root-owned —
operators not running as root usually can't write there). For an
unprivileged-user setup, define a user-owned pool:

```bash
mkdir -p ~/libvirt-images
virsh -c qemu:///system pool-define-as user-pool dir --target ~/libvirt-images
virsh -c qemu:///system pool-start user-pool
virsh -c qemu:///system pool-autostart user-pool
```

Then select it via the environment override:

```bash
export SIGNALMAN_LIBVIRT_STORAGE_POOL=user-pool
```

(Equivalent config-file form: `hypervisor.libvirtStoragePool:
"user-pool"` in `.signalman/config.yaml`.)

### 3. A template YAML with `base_image_path`

`vm_create` looks up the template name via the registry at
`.signalman/templates/<name>.yaml`. The backend's libvirt path
requires `base_image_path` to point at an existing qcow2 used as
the backing file. Example for an Ubuntu cloud-image:

```yaml
# .signalman/templates/ubuntu-noble.yaml
name: ubuntu-noble
base_image_path: /home/aaron/libvirt-images/noble-template.qcow2
memoryMB: 2048
processorCount: 2
networkSwitch: default
```

If the operator only has a URL or no template at all, walk them
through downloading the image into the pool's target directory and
writing the template YAML first.

## How to invoke

**MCP — Linux baseline (default profile):**

```jsonc
// signalman_vm_create
{
  "name": "ubuntu-vm",
  "template": "/home/aaron/libvirt-images/ubuntu-noble.qcow2",
  "cpus": 2,
  "memoryMB": 2048,
  "diskGB": 20,
  "switchName": "default"
  // osProfile omitted → defaults to "linux" (BIOS + virtio + UTC)
}
```

**MCP — Windows 11 with all mandatory security primitives:**

```jsonc
{
  "name": "win11-vm",
  "template": "/home/aaron/libvirt-images/win11-template.qcow2",
  "cpus": 4,
  "memoryMB": 8192,
  "diskGB": 64,
  "osProfile": "windows-11"
  // → UEFI + Secure Boot + TPM 2.0 + virtio + localtime + tablet + QXL + VNC.
  // Operator overrides for firmware/secureBoot/tpm raise invalid_argument.
}
```

**MCP — Windows 10 with no virtio-win staged (in-box SATA driver):**

```jsonc
{
  "name": "win10-bare",
  "template": "/home/aaron/libvirt-images/win10-template.qcow2",
  "osProfile": "windows-10",
  "diskBus": "sata",
  "nicModel": "e1000e"
  // → UEFI + localtime + tablet, but SATA disk + e1000e NIC so a
  // fresh Windows install can see the hardware without virtio-win.
  // Switch back to virtio after installing virtio-win in the guest.
}
```

Note: the MCP `signalman_advanced_vm_create` tool takes the
template as an **absolute path** directly (no registry lookup).
The CLI's `vm create` does the registry-name → path resolution.

**CLI** — `vm create` reads `osProfile` (plus the firmware /
secureBoot / tpm / diskBus / nicModel overrides) from the template
YAML and threads them through to `backend.createVM`. Example
Win11 template:

```yaml
# .signalman/templates/win11-base.yaml
name: win11-base
base_image_path: /home/aaron/libvirt-images/win11-template.qcow2
memoryMB: 8192
processorCount: 4
networkSwitch: default
osProfile: windows-11
```

Then:

```bash
# Linux (baseline):
SIGNALMAN_BACKEND=libvirt \
  signalman vm create ubuntu-vm --template ubuntu-noble

# Win11 (the template's osProfile field drives the libvirt
# backend; UEFI + Secure Boot + TPM 2.0 auto-applied):
SIGNALMAN_BACKEND=libvirt \
SIGNALMAN_LIBVIRT_STORAGE_POOL=user-pool \
  signalman vm create win11-vm --template win11-base
```

`vm create` reads templates from `.signalman/templates/<name>.yaml`
and merges defaults (the existing v0.4.x BYO template surface) with
the new osProfile fields. Backends other than libvirt ignore the
profile fields silently — Hyper-V uses Generation 1/2 selection
internally; Tart picks per-image firmware.

## Expected response envelope

Success:

```jsonc
{
  "ok": true,
  "value": {
    "vmName": "ws-demo",
    "id": "ws-demo",
    "backend": "libvirt"
  }
}
```

`id` equals `vmName` for libvirt (domain name == handle id). Save
this; subsequent `vm_start`, `vm_status`, `vm_run_command`, etc.
take the name positionally.

Error envelope (`isError: true`):

```jsonc
{ "ok": false, "error": { "code": "invalid_argument", "message": "libvirt storage pool 'default' not found. Create it with:\n  virsh pool-define-as default dir --target /var/lib/libvirt/images\n  …" } }
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `invalid_argument` | Pool missing, template not absolute, memoryMB/cpus/diskGB out of range, or template field empty. | Echo the message verbatim — the libvirt backend includes copy-pasteable repair commands for the pool case. |
| `command_failed` | `vol-create-as` failed (usually: backing template missing on disk, or pool not writeable) or `virsh define` failed (usually: domain XML rejected by libvirt). | Surface the message; cause is the underlying virsh stderr. |
| `vm_not_found` | Shouldn't fire on create. If it does, file an issue. | Surface verbatim. |
| `connect_failed` | virsh ran but couldn't reach libvirtd. | Restart `libvirtd`; verify the user is in `libvirt` + `kvm` groups. |
| `virsh_not_found` | `virsh` binary isn't on PATH. | `sudo apt install -y libvirt-clients`. |

## What NOT to do

- **Never** call `vm_create` with a `template` that doesn't exist
  on disk. The backend will fail at `vol-create-as` time; better
  to verify the path first (`test -f <path>`).
- **Never** set `diskGB` to less than the template's virtual size.
  libvirt allows it, but the guest sees a truncated disk and may
  fail to boot. If unsure, omit `diskGB` and accept the 20G default.
- **Never** create a VM with the same name as an existing domain.
  libvirt rejects the `vol-create-as` because the volume already
  exists. Use `vm_list` first to check, or pick a different name.
- **Never** assume `vm_delete` is enough cleanup if the disk was
  created by some other path (e.g. legacy raw `qemu-img` from
  pre-v0.5 signalman). v0.5+ disks are pool-managed and clean up
  fully; older raw-qemu-img disks orphan and need manual `rm`.

## Follow-up suggestions

- `signalman_vm_start` with the name — boots the domain.
- `signalman_vm_wait_heartbeat` with `timeoutMs: 180000` —
  blocks until qemu-guest-agent responds (only useful if the
  guest image has QGA installed; CirrOS doesn't, Ubuntu cloud-image
  + cloud-init does).
- `signalman_vm_status` — confirms `state: "running"` and reports
  IP if libvirt has a DHCP lease.
- `signalman_vm_run_command` — exec a command in-guest (needs QGA).
- `signalman_vm_checkpoint` + `signalman_vm_restore` —
  snapshot lifecycle.
- `signalman_vm_delete` — domain + disk go away (v0.5+ behavior;
  the disk now cleans up correctly because it's pool-managed).
