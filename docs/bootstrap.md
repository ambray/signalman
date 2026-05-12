# Signalman Bootstrap

End-to-end walkthrough: fresh Windows host with Hyper-V enabled to a
green `signalman run` against a provisioned VM. v0.1.1 surface — every
command below maps to code already on `main` (commit `e1be740`).

If you only want a 30-second taste, skip to the [README Quick
Start](../README.md#quick-start). This document is the fully-traced
path with expected output for every step, written so an LLM agent can
follow it and detect divergence without reading source.

> **Voice convention**: declarative, second-person. When something is
> not yet wired, the prose says "until P9.x lands". Cross-references
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

Bootstrap deliberately scopes itself to the v0.1.1 happy path. The
items below are documented elsewhere or deferred to v0.2.0:

- **Linux / macOS provisioning.** Today only Tart has a bootstrap
  script (`scripts/macos/install-guest-agent.sh`); a first-class
  `signalman vm provision` on macOS is v0.2.0. See
  [docs/mac-virtualization.md](mac-virtualization.md).
- **Per-VM identity certs.** v0.1.1 ships one-CA-many-VMs (locked
  Q2(c), `provision.ts:354-365`). Per-VM certs land in v0.2.0
  alongside the B2 pin registry.
- **ISO-to-VHDX conversion.** Operators provide pre-built VHDX in
  v0.1.1 (`template-fetch.ts:23-24`). v0.2.0 may add an ISO build
  step.
- **Multi-VM scenarios with separate networks.** Works today via
  the `vms:` block in `setup.yaml`, but bootstrap walks the
  one-VM path. See the smoke example in [README — Setup
  DSL](../README.md#setup-dsl-setupyaml).
- **`signalman init --bootstrap` side effects.** The flag prints the
  bootstrap sequence, but it intentionally does not download base
  images or create VMs. Operators still run `vm fetch-template` and
  `vm provision` explicitly with the chosen template, storage, and MSI
  inputs.

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
