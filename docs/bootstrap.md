# Signalman Bootstrap

End-to-end walkthrough: fresh host with a supported hypervisor enabled
to a green `signalman run` against a provisioned VM. Every command
below maps to code already on `main`.

The Hyper-V path is the most-trodden and is documented first. Linux
(libvirt), macOS (Tart), and cloud-VM (AWS / Azure) walkthroughs land
in sections 5–7 with the deltas from the Hyper-V flow rather than
repeating the whole sequence — the verb surface is uniform across
backends.

If you only want a 30-second taste, skip to the [README Quick
Start](../README.md#quick-start). This document is the fully-traced
path with expected output for every step, written so an LLM agent can
follow it and detect divergence without reading source.

> **Voice convention**: declarative, second-person. When something is
> not yet wired, the prose says "until <epic> lands". Cross-references
> to `host/src/...` are the source of truth — when the doc and the
> code disagree, the code wins.

## 1. Prerequisites

Confirm everything below before running any Signalman command.

| Item | Required | Verify |
|---|---|---|
| Windows 11 22H2+ or Windows Server 2022 with the Hyper-V role enabled | yes | `Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All` returns `Enabled` |
| Node 22.5 or newer (the v0.2+ control plane uses the built-in `node:sqlite` module that landed in 22.5) | yes | `node --version` reports `v22.5` or higher |
| PowerShell 7 (`pwsh`) — the cert script and `scripts/release-dry-run.ps1` use it | yes | `pwsh --version` |
| Rust stable toolchain | only when building from source | `rustc --version` |
| `cargo-wix` 0.3.9 | only when building MSI packages locally | `cargo install cargo-wix --locked --version 0.3.9` |
| `openssl` on `PATH` (Git for Windows ships one at `C:\Program Files\Git\usr\bin\openssl.exe` — auto-detected by the cert script) | yes (cert generation) | `openssl version` |
| Hyper-V virtual switch named `Default Switch` | yes | `Get-VMSwitch "Default Switch"` returns a row |
| Pre-built guest VHDX | yes | the URL form (Microsoft Eval) or a local `base_image_path:` |

ISO-to-VHDX conversion is **out of scope for v0.1.1** (template-fetch
docstring locks this — see `host/src/provisioning/template-fetch.ts`
header). Bring your own pre-built VHDX, or wait for v0.2.0.

## 2. One-time setup

Run these blocks in order. Each is idempotent — re-running is safe.

### 2.1 Install the host CLI

Either from npm (once `@signalman/host` is published — see the
[Release process](../README.md#release-process) section of the
README), or from a local clone:

```powershell
# From npm
npm install -g @signalman/host

# Or build from this repo
cd host
npm install
npm run build
# `node dist/cli.js` is the CLI entry point; alias it as `signalman`
# or install with `npm link`.
```

Verify:

```powershell
signalman --help
```

Expected (truncated):

```
Usage: signalman <verb> [options]

Verbs:
  init [--name PROJECT] [--force] [--bootstrap] [--format json]
  list [--tag T] [--pattern P] [--format json]
  ...
  vm <subcommand>   (provision, cleanup, create, install-bundle,
                     fetch-template — see ROADMAP P9 / signalman vm --help)
```

### 2.2 Generate dev certs

The provisioner needs a CA + server cert + server key on disk so it
can land them inside the guest VM at
`C:\ProgramData\Signalman\certs\`. The host-side script writes them
to `.\certs\dev\` by default; the provisioner picks them up from
`<project_root>/certs/dev/` when present.

```powershell
pwsh ./scripts/generate-dev-certs.ps1
```

Expected output (last lines):

```
=== Done ===
Name        Length
----        ------
ca.pem        ...
ca.key        ...
server.pem    ...
server.key    ...
client.pem    ...
client.key    ...
<openssl verify>: OK
<openssl verify>: OK
```

> `signalman init --bootstrap` prints the current cert/template/provision
> sequence after scaffolding. It does not run this script for you because
> cert location, base image choice, and VM creation remain explicit
> operator-owned actions.

### 2.3 Initialise the project

`signalman init` lays down `.signalman/{config.yaml, scenarios/,
templates/}` plus a no-op sample scenario. No network, no VM.

```powershell
signalman init --name my-validation-suite
```

Expected output:

```
Signalman project initialised at <cwd>
  6 file(s) created:
    + .signalman/config.yaml
    + .signalman/scenarios/.gitkeep
    + .signalman/templates/.gitkeep
    + .signalman/scenarios/sample/setup.yaml
    + .signalman/scenarios/sample/assertions.yaml
    + .signalman/scenarios/sample/workflow.md

Next: signalman list
```

`--force` overwrites existing scaffold. `--bootstrap` prints the manual
bootstrap sequence on stderr after the scaffold summary.

### 2.4 Fetch a base image

Two forms. Pick one.

**URL form (auto-download + SHA-256 verify):**

```powershell
signalman vm fetch-template windows-11-eval
```

> The shipped `windows-11-eval.yaml` carries placeholder `base_image_url`
> and `base_image_sha256` values
> (`.signalman/templates/windows-11-eval.yaml:36-40`). Until the
> Microsoft Eval VHDX URL is finalised in release prep, this command
> will fail with `Failed to GET https://example.com/...`. Use the BYO
> form below in the meantime.

Expected output on a real URL:

```
Fetching template 'windows-11-eval' from https://...
[fetch-template windows-11-eval] 5% (210.0 MB / 4096.0 MB)
[fetch-template windows-11-eval] 10% (...)
...
Template:  windows-11-eval
Status:    downloaded + verified
VHDX path: C:\Users\<you>\AppData\Local\Signalman\templates\windows-11-eval\<sha-prefix>.vhdx
Size:      <size> MB
Duration:  <ms>
```

The cache root is `%LOCALAPPDATA%\Signalman\templates\<name>\<sha-prefix>.vhdx`
on Windows (see `cachePathFor` /
`defaultCacheDir` in `host/src/provisioning/template-fetch.ts`). A
warm cache reports `cache hit (verified)`.

**BYO (corporate / pre-built VHDX):**

Drop a `base_image_path: D:\images\win11.vhdx` form into a custom
template under `.signalman/templates/`. No fetch is needed — the
operator owns the disk. `signalman vm fetch-template` exits with code
5 and a message naming `base_image_path` when the template has no
URL.

## 3. First VM provision

Stand up a VM, copy certs in, install the guest agent, and snapshot.

```powershell
signalman vm provision endpoint-1 --template windows-11-eval
```

Expected output (stderr is the 7-step trace; stdout is the result
line):

```
[provision:step:resolve_template] loading template 'windows-11-eval'
[provision:step:create_vm] creating VM 'endpoint-1' from template 'windows-11-eval'
[provision:step:boot_vm] starting VM and waiting for IP
[provision:step:stage_certs] generating dev certs and copying into VM
[provision:step:discover_msi] discovering guest MSI
[provision:step:install_msi] installing guest MSI from bundled: C:\...\dist\guest\signalman-guest.msi
[provision:step:checkpoint] taking checkpoint 'agent-installed'
VM 'endpoint-1' provisioned (checkpoint: 'agent-installed', <ms> ms)
```

Pipeline contract (from `host/src/provisioning/provision.ts:1-29`):
1. resolve_template
2. create_vm
3. boot_vm
4. stage_certs
5. discover_msi
6. install_msi
7. checkpoint

A re-run is a 2-second no-op:

```
[provision:skip] VM 'endpoint-1' already provisioned (checkpoint 'agent-installed' present)
VM 'endpoint-1' already provisioned (checkpoint: 'agent-installed', <ms> ms)
```

Flags:
- `--template T` — defaults to `win11-base`.
- `--guest-msi PATH` — explicit MSI override (skips discovery).
- `--checkpoint LABEL` — defaults to `agent-installed`.
- `--force` — tear down + redo from scratch.
- `--cleanup-on-failure` — opt in to auto-cleanup; default leaves
  the VM around for inspection (locked Q decision —
  `host/src/provisioning/provision.ts:25-28`).

Exit codes: `0` success, `3` provisioning step failure (with named
step), `4` infra error, `5` validation (e.g. unknown template).

## 4. First scenario run

The sample scenario laid down by `signalman init` is a host-only
no-op smoke. Run it to confirm the runner is wired.

```powershell
signalman run sample
```

Expected output (stderr streams events `[seq] type`; stdout is the
human summary):

```
[1] run.started
[2] step.started
[3] step.completed
[4] assertion.passed
[5] run.completed
Result: pass
Duration: <ms>ms
Assertions: 1/1 passed
```

For the JSON envelope:

```powershell
signalman run sample --format json
```

Expected (shape from `host/src/output/envelope.ts:282-297`):

```json
{
  "envelope_version": "0.1.0",
  "run_id": "<uuid>",
  "scenario_id": "sample",
  "scenario_hash": "<sha>",
  "agent_version": "0.1.1",
  "network_class": "isolated",
  "started_at": "...",
  "finished_at": "...",
  "duration_ms": <n>,
  "result": "pass",
  "exit_code": 0,
  "assertions": { "passed": 1, "failed": 0, "total": 1 },
  "events": [...],
  "errors": []
}
```

Exit codes (per design doc — same as `signalman --help`):
`0` pass, `1` assert-fail, `2` workflow-fail, `3` setup-error,
`4` infra-error, `5` validation, `64` usage.

## 5. Apply a software bundle

Install developer tools into the provisioned VM via the reference
bundle.

```powershell
signalman vm install-bundle endpoint-1 examples/bundles/dev-tools.bundle.yaml
```

The reference bundle exercises every Tier 1 source: `winget`,
`choco`, `msstore`, `direct`, `docker` — see
`examples/bundles/dev-tools.bundle.yaml` and the type system at
`host/src/provisioning/bundle-types.ts`.

**Tier 2 sources (also v0.1.1):** `scoop`, `github_release`,
`git_repo` (with `ref:` for branch/tag/SHA, optional
`submodules:` / `sparse:` paths), `powershell` (`Install-Module` from
PSGallery), `npm`, `pip`, `cargo`, `custom_script`. The
`examples/bundles/full-stack.bundle.yaml` exercises these and is the
reference for source-source dependencies. Use `requires:` when a package
needs a prerequisite (`git` before `git_repo`, `python` before `pip`,
etc.); the orchestrator topologically sorts those dependencies and runs
independent ready packages in parallel. Schema + security gates per
source: `bundle-types.ts` module docstring.

```powershell
signalman vm install-bundle endpoint-1 examples/bundles/full-stack.bundle.yaml
```

**`provision_if_missing`** (v0.1.1) — set on a `vms:` block to have
`signalman run` auto-provision the VM transparently when it's
missing on the host:

```yaml
vms:
  - name: endpoint-1
    template: win11-base
    checkpoint_restore: agent-installed
    provision_if_missing: true   # NEW v0.1.1
    guest_agent_port: 50051
```

Idempotent: a 2-second no-op when the VM + checkpoint already exist.
Hard-fails (with a remediation hint pointing at this flag) when a
missing VM is seen WITHOUT the flag set, preserving the v0.1.0
"explicit provision required" default.

Expected output (per-package summary from
`host/src/provisioning/install-bundle.ts:419-465`):

```
Bundle: dev-tools
VM:     endpoint-1
Total:  8  Installed: 6  Skipped: 1  Failed: 1
Duration: <ms>ms

  [OK]  Microsoft.VisualStudioCode (winget)  <ms>ms
  [OK]  Git.Git (winget)  <ms>ms
  [OK]  Microsoft.PowerToys (winget)  <ms>ms
  [OK]  Mozilla.Firefox (winget)  <ms>ms
  [OK]  nodejs-lts (choco)  <ms>ms
  [skip] 9NBLGGH4MSV6 (msstore)  <ms>ms
  [FAIL] NDI-tools (direct)  <ms>ms
        SHA-256 mismatch ...
  [OK]  mailhog (docker)  <ms>ms
```

The reference bundle's `direct` entry uses a placeholder all-zero
sha256 by design — installs fail with a SHA mismatch until you
substitute the real digest. Replace the URL + sha256 with a real
release before running for real (see step 7 below).

Exit code: `0` if `failed == 0`, otherwise `2` (workflow-fail).

## 6. Iteration loop

The `agent-installed` checkpoint is the rebase point. Two patterns:

**Restore-then-run.** Roll the VM back to the checkpoint, apply a
bundle / scenario, observe, snapshot a new state if useful.
Restoration is currently driven through scenario YAML
(`checkpoint_restore: agent-installed` on a `vms:` entry — see the
README's `setup.yaml` example) or the
`mcp__signalman__vm_restore` tool surface.

**Force-rebuild.** When the VM has drifted past usefulness:

```powershell
signalman vm provision endpoint-1 --force
```

`--force` runs `cleanupVM` first (stop + delete), then re-runs the
full 7-step pipeline (`host/src/provisioning/provision.ts:144-146`).
Use this when the bundle install left the VM in a weird state, or
when a template fingerprint has changed.

Tear down completely:

```powershell
signalman vm cleanup endpoint-1
```

## 7. Troubleshooting

### "Guest MSI not found"

Discovery chain (in priority order, from
`host/src/provisioning/guest-msi-discovery.ts:1-20`):

1. `--guest-msi <PATH>` explicit override.
2. `dist/guest/*.msi` bundled with the installed host package.
3. GitHub Releases matching `signalman --version`.

Hard-fails with a remediation list naming every searched location.
When running from a fresh source clone, `dist/guest/` is empty until
you build the guest MSI. Signalman will also check the matching GitHub
Release and cache `signalman-guest-*.msi` under the local app cache, so
release installs do not need an explicit `--guest-msi` path.

### "SHA-256 mismatch for <template>: expected <a>, got <b>"

The downloaded VHDX did not match the SHA in the template YAML.
Causes (from `host/src/provisioning/template-fetch.ts:382-389`):

1. The template manifest's SHA is stale.
2. The upstream file changed.
3. Man-in-the-middle tampering.

Fix: confirm the URL is the canonical Microsoft Eval / vendor source
(not a mirror), recompute the SHA from a trusted copy, and update
the template YAML. The partial download is deleted automatically —
re-run `signalman vm fetch-template` after fixing.

### Provisioning hangs at boot_vm

The pipeline waits up to 5 minutes for `state=running + ipAddress`
(`host/src/provisioning/provision.ts:491-513`). If the VM never
gets an IP:

1. Open Hyper-V Manager → Connect to the VM → check the console.
2. Confirm the `Default Switch` virtual switch is healthy
   (`Get-VMSwitch "Default Switch"`).
3. Confirm the guest's NIC obtained DHCP — Microsoft Eval images
   sometimes need first-boot OOBE completion.

### "client does not support 'direct' source"

This means the host is talking to an older guest agent that does not
implement the `installDirect` / `installDocker` RPCs. Rebuild or upgrade
the guest MSI for the VM, then rerun the bundle. As a temporary
workaround, restrict that bundle to `winget` / `choco` / `msstore`
sources.

### "direct.url ... sha256 ... 64 lowercase hex"

Compute the SHA-256 of the installer with PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\installer.msi
```

Convert to lowercase hex, paste into `sha256:` field of the bundle.
Allowlisted extensions for `direct`: `.msi`, `.exe`, `.msix`,
`.appx` (`bundle-types.ts:189`).

## 8. What's NOT covered

The Hyper-V flow above is the most-trodden path. Other backends share
the verb surface — sections 5–7 document the deltas — but a few items
remain out of scope here:

- **Per-VM identity certs.** Today ships one-CA-many-VMs (locked
  Q2(c), `provision.ts:354-365`). Per-VM certs land alongside the B2
  pin registry; see the per-user identity epic in the strategic
  roadmap.
- **ISO-to-VHDX conversion.** Operators provide pre-built VHDX
  (`template-fetch.ts:23-24`); Packer-built golden images are
  scaffolded as of WS6 wave-3 (see §"Packer scaffolding" in
  `docs/audit/capability-matrix-2026-05-wave3.md`).
- **macOS UI automation parity.** Tart provisioning works; the
  AppleScript + Accessibility API driver for UI / browser RPCs is
  not yet shipped. UI RPCs return `Status::unimplemented` on macOS
  with a canonical message. See `docs/mac-virtualization.md` for
  the trait-flip plan.
- **Multi-VM scenarios with separate networks.** Works today via
  the `vms:` block in `setup.yaml`, but bootstrap walks the
  one-VM path. See the smoke example in [README — Setup
  DSL](../README.md#setup-dsl-setupyaml).
- **`signalman init --bootstrap` side effects.** The flag prints the
  bootstrap sequence, but it intentionally does not download base
  images or create VMs. Operators still run `vm fetch-template` and
  `vm provision` explicitly with the chosen template, storage, and MSI
  inputs.

---

# Cross-platform + cloud bootstrap

The sections above walk the Hyper-V (Windows) path because that's
the most mature backend and the original target. The same `signalman`
CLI works against three other backends with deltas on prerequisites,
provisioning, and connection setup but the same scenario surface
(`signalman run <scenario>` is uniform across backends).

## 5. Linux + libvirt walkthrough

`host/src/hypervisors/libvirt.ts` wraps `virsh` (Linux's standard
libvirt CLI). Use this on a Linux developer host or a Linux CI runner.

### Prerequisites (Linux deltas)

| Item | Required | Verify |
|---|---|---|
| Linux distribution with kernel ≥ 5.10 and KVM available | yes | `kvm-ok` (Ubuntu) or `egrep -c '(vmx\|svm)' /proc/cpuinfo` (any) > 0 |
| `libvirt-daemon` + `qemu-kvm` installed and the daemon running | yes | `systemctl status libvirtd` |
| `virsh` on `PATH` | yes | `virsh --version` |
| Your user in the `libvirt` group (or root) | yes | `groups \| grep libvirt` |
| A libvirt network for guest connectivity — `default` (NAT) is fine for dev | yes | `virsh net-list --all` shows `default` as `active` |
| A pre-built guest qcow2/raw image with the Signalman guest agent installed | yes | the path in `base_image_path:` |

### Setup deltas

```bash
# Same install paths as Hyper-V — npm or build-from-source.
npm install -g @signalman/host

# Pick the libvirt backend explicitly. Selector default falls through
# to libvirt on Linux when virsh is on PATH and no override is set.
signalman init --name myproject

# Edit .signalman/config.yaml:
#   hypervisor:
#     backend: libvirt
#     libvirt:
#       uri: qemu:///system        # or qemu:///session for user-mode
#       storage_pool: default
#       network: default

# Cert generation is identical (scripts/certs/generate.sh on Linux).
bash scripts/certs/generate.sh
```

### Provisioning deltas

`signalman vm fetch-template` and `signalman vm provision` work
against libvirt with the same flags as Hyper-V; the difference is the
underlying VM creation path uses `virsh define` / `virsh start` rather
than `New-VM` / `Start-VM`.

```bash
signalman vm fetch-template \
  --name ubuntu24-base \
  --source-url file:///path/to/ubuntu24.qcow2

signalman vm provision \
  --name ci-runner-1 \
  --template ubuntu24-base \
  --memory-gb 4 --cpu-count 2
```

### Linux-specific notes

- **SYSTEM-elevation equivalent** — the guest agent's `run_as=system`
  path uses passwordless `sudo -n` on Linux. Configure
  `/etc/sudoers.d/signalman` on the guest image to allow the agent's
  service user to escalate; the agent refuses to run as root by
  default and operators audit the sudoers entry. See
  `guest/src/platform/linux.rs` header.
- **Package install** routes through whichever package manager is
  available — `apt` (Debian/Ubuntu), `dnf` (Fedora/RHEL),
  `yum` (legacy RHEL). Auto-detected on first install call.
- **No UI / browser RPCs** — `Status::unimplemented` returned with a
  canonical message. There is no portable AX equivalent on Linux;
  scenarios that need UI assertions should be authored against the
  Windows backend, or use the command-output / network-probe
  primitives the agent already implements.

## 6. macOS + Tart walkthrough

Apple Silicon (M1+) only. Tart is the only first-class macOS hypervisor.

### Prerequisites (macOS deltas)

| Item | Required | Verify |
|---|---|---|
| macOS 13 (Ventura) or later on Apple Silicon | yes | `sw_vers` |
| Tart 2.x | yes | `tart --version` |
| Homebrew (`brew`) — used by the agent's package-install path | yes | `brew --version` |
| A Tart-imported VM image with the guest agent installed | yes | `tart list` shows the image |

### Setup deltas

```bash
# Install host CLI.
npm install -g @signalman/host

# Init project — Tart auto-detected as the macOS backend.
signalman init --name myproject

# Install the guest agent as a LaunchDaemon on the Tart-imported VM
# (the script runs inside the VM after import).
bash scripts/macos/install-guest-agent.sh

# Cert generation is identical.
bash scripts/certs/generate.sh
```

### Provisioning deltas

Tart's VM lifecycle is `tart clone <source> <name>` + `tart run`.
`signalman vm provision` wraps both.

```bash
signalman vm provision \
  --name macos-runner-1 \
  --template macos-sonoma-base \
  --memory-gb 8 --cpu-count 4
```

### macOS-specific notes

- **UI / browser RPCs return `unimplemented`** on macOS today.
  AppleScript + Accessibility API driver is queued as an epic;
  `MacosPlatform::supports_ui_automation()` becomes the capability
  flip once the driver lands.
- **Package install routes through `brew`** — operators should ensure
  the agent's service user owns its `brew` prefix (avoid bootstrap-
  time permission surprises).
- **No SYSTEM-elevation equivalent** — macOS doesn't have a direct
  analog; agent commands run under the LaunchDaemon's effective user
  (typically `root` if installed via the provided script). Pin the
  service user explicitly if your scenarios assume a non-root
  identity.
- **Networking** — `Default Switch` doesn't apply; Tart uses NAT by
  default. Multi-VM scenarios with isolated networks need explicit
  `tart create network ...` setup.

See [docs/mac-virtualization.md](mac-virtualization.md) for the
full Mac strategy and outstanding work.

## 7. Cloud-VM walkthrough (AWS + Azure)

Provision an ephemeral cloud VM as a deploy target. Useful for CI
pipelines that don't have local hypervisor access, and for
short-lived smoke environments.

### Prerequisites

| Item | Required | Verify |
|---|---|---|
| AWS account with EC2:RunInstances/TerminateInstances permissions, OR Azure subscription with VM contributor role | yes | `aws sts get-caller-identity` / `az account show` |
| `SIGNALMAN_CRED_KEY` env var (base64-encoded 32-byte key) | yes | `echo $SIGNALMAN_CRED_KEY \| wc -c` ≥ 44 |
| A pre-built AMI (AWS) or gallery image (Azure) with the Signalman guest agent + your application baked in | yes | `aws ec2 describe-images --image-ids ami-...` / Azure portal |

### Walkthrough

```bash
# 1. Generate + persist the credential-encryption key. NEVER lose this;
#    it decrypts all cloud creds at rest.
export SIGNALMAN_CRED_KEY=$(openssl rand -base64 32)
echo "$SIGNALMAN_CRED_KEY" > ~/.signalman/cred.key   # operator-managed safe storage
chmod 600 ~/.signalman/cred.key

# 2. Store cloud credentials per org. Plaintext never appears on argv;
#    the verb reads from --plaintext-json which the CLI immediately
#    encrypts before any other code sees it.
signalman cloud creds set --provider aws \
  --plaintext-json '{"access_key_id":"AKIA...","secret_access_key":"..."}'

signalman cloud creds set --provider azure \
  --plaintext-json '{"subscription_id":"...","tenant_id":"...","client_id":"...","client_secret":"..."}'

# 3. Set a budget guardrail (optional but recommended).
signalman cloud budget set --monthly-cents-limit 5000 --soft-warn-pct 80

# 4. Provision an ephemeral cloud VM. Sentinel tags flow on every
#    instance (signalman-managed=true, signalman-org=<id>,
#    signalman-ttl-minutes=<n>); the reaper auto-terminates after TTL.
signalman cloud provision --provider aws \
  --region us-east-1 --instance-type t3.micro \
  --image-ref ami-0c55b159cbfafe1f0 \
  --name ci-runner-1 --ttl-minutes 60

# 5. Generate a connection descriptor (defines how the host dials the
#    cloud VM). Three modes: public_mtls (direct), aws_ssm, azure_bastion.
signalman cloud connection-descriptor \
  --provider aws --network-mode aws_ssm \
  --instance-id i-0123abc456def > target.json

# 6. Register the cloud VM as a deploy target.
signalman target add --name prod-host --kind cloud_vm_test \
  --connection "$(cat target.json)"

# 7. Run scenarios + deploy to the cloud VM exactly as you would for
#    a local VM. The deploy executor handles SSM / Bastion tunneling
#    transparently — your scenarios don't know about it.
signalman run service-backend-smoke
signalman release deploy --target prod-host --release <id>

# 8. Inspect cost + usage + reaper state.
signalman cloud usage --org-id <id>
signalman cloud reaper status

# 9. Tear down on demand (the reaper handles TTL automatically).
signalman cloud terminate --provider aws \
  --id i-0123abc456def --name ci-runner-1 --region us-east-1
```

### Cloud-specific notes

- **Network connectivity** — `public_mtls` is fastest but requires
  the cloud VM to accept inbound traffic on the guest agent port.
  `aws_ssm` and `azure_bastion` tunnel through cloud-provider native
  services; no inbound firewall holes needed but startup latency is
  higher (~5–10s for the tunnel to establish).
- **The reaper** is the safety net. Set TTLs aggressively
  (`--ttl-minutes 60` for ephemeral CI work) and trust the reaper
  to clean up if a scenario crashes mid-run. The reaper runs as a
  separate daemon — `signalman cloud reaper start` for the long-
  running form, `signalman cloud reaper run-once` for a single tick.
- **Cost guardrails** — projected spend per org is checked at
  every `provision` call; soft-warn emits an event, hard-cap
  refuses provisioning until usage falls.
- **Stack-based deploys** — for multi-resource cloud infrastructure
  (VPC + subnets + security groups + the VM itself), use
  `signalman stack apply` against an OpenTofu HCL module.

## 9. Cross-references

- [ROADMAP.md — P9: Provisioning + Bootstrap](../ROADMAP.md) — phase
  status, locked design decisions, deferred items.
- [README.md — Quick Start](../README.md#quick-start) — abbreviated
  install path for operators who don't need the full bootstrap.
- [docs/testing.md](testing.md) — gated E2E lane (P7 D4) and where
  the bootstrap path will plug in once self-hosted Hyper-V runners
  come online.
- [host/src/provisioning/provision.ts](../host/src/provisioning/provision.ts)
  — source of truth for pipeline-step semantics + idempotency.
- [host/src/provisioning/template-fetch.ts](../host/src/provisioning/template-fetch.ts)
  — cache layout + SHA verification model.
- [host/src/provisioning/install-bundle.ts](../host/src/provisioning/install-bundle.ts)
  — per-package result envelope + skip detection.
- [host/src/provisioning/bundle-types.ts](../host/src/provisioning/bundle-types.ts)
  — Tier 1 source list, schema, security gates.
- [host/src/provisioning/guest-msi-discovery.ts](../host/src/provisioning/guest-msi-discovery.ts)
  — MSI discovery chain.

When the doc and the source disagree, the source wins. Open a PR to
update this file rather than working around drift.
