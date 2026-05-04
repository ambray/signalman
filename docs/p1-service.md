# P1: Hyper-V Control-Plane Service

The `signalman-service` daemon is the gsudo-killer. With the service
installed, agent-driven Signalman workflows perform Hyper-V management
without ever raising a UAC prompt at runtime — the elevation grant
happens once, at install time.

## Why

Today the host MCP process (running unelevated as the user) shells
out to `powershell.exe` for every Hyper-V cmdlet. On Windows, those
cmdlets refuse to run unless the caller is in Hyper-V Administrators,
so the host wraps each invocation in `gsudo`. gsudo prompts the user
on first call, then caches the elevation token for a few minutes —
fine for an interactive operator, hostile to an autonomous agent that
calls `Get-VM` 30 times in 30 seconds across multiple Node child
processes (each with its own gsudo cache).

P1 replaces the per-call elevation with an out-of-process daemon that
*is* elevated, brokers cmdlet calls behind a gRPC contract, and is
contacted over a local named pipe + mTLS-protected localhost TCP.

The service still uses PowerShell/CIM cmdlets as the Hyper-V provider
adapter. That is intentional for v0.1.x: Rust owns the privilege boundary,
transport, input validation, lifecycle semantics, and testable backend
contract, while PowerShell remains the supported Microsoft automation
surface for Hyper-V operations. Replacing those cmdlets with lower-level
WMI bindings would be a larger provider rewrite; it is not necessary to
remove runtime UAC prompts or make agent workflows service-first.

## Architecture

```
            host MCP (unelevated user)
                     │
                     │  gRPC (mTLS, localhost:17777)
                     │  -or- gRPC over \\.\pipe\signalman-service
                     ▼
          ┌─────────────────────────────┐
          │  signalman-service (Rust)   │  ← runs as LocalSystem (default)
          │  ┌───────────────────────┐  │     OR custom svc account
          │  │ ControlPlaneService   │  │     with Hyper-V Admins (S-1-5-32-578)
          │  │   (tonic gRPC server) │  │
          │  └─────────┬─────────────┘  │
          │            │                │
          │   Backend trait (Rust)      │
          │            │                │
          │  ┌─────────▼─────────────┐  │
          │  │  HyperVBackend        │  │
          │  │  + sanitize.rs (port  │  │
          │  │    of host TS sanitiz │  │
          │  │    ers; defense in    │  │
          │  │    depth)             │  │
          │  └─────────┬─────────────┘  │
          └────────────┼────────────────┘
                       │
                       │  tokio::process::Command
                       ▼
                powershell.exe (Hyper-V cmdlets)
                       │
                       ▼
                Hyper-V WMI / VM
```

The service surface mirrors `host/src/hypervisors/interface.ts`
(`HypervisorBackend`) one-for-one over the wire. Long-running
operations (`VmRunCommand`, `VmCopyFile`, `VmWaitAgent`, `VmInstall`)
use server-streaming gRPC so the client can render progress without
holding a unary RPC open for minutes.

The wire protocol is hypervisor-agnostic. v0.1.0 ships only the
Hyper-V dispatcher. libvirt (Linux) and vmrun (macOS) implementations
in v0.3.0+ will share the same `signalman.service.ControlPlane`
contract — the `backend` field on `VmHandle` is opaque to the wire
format.

## Trust model

```
                Signalman Dev CA (self-signed, ECDSA P-256)
                    │
           ┌────────┴───────┐
           │                │
   server.pem            client.pem
   server.key            client.key
   (used by              (used by host MCP
    daemon's              when calling the
    TCP listener)         service)
```

* **Cert generation:** `signalman-service install` regenerates the
  bundle if it doesn't already exist under
  `%ProgramData%\Signalman\certs\` (configurable via the `--cert-dir`
  flag).
* **Cert format:** ECDSA P-256, PEM, 1-year validity. The CA is
  self-signed; the server and client certs are signed by it.
* **Server SAN:** `localhost`, `127.0.0.1`, `signalman-service`. The
  host client overrides the gRPC `ssl_target_name_override` to
  `localhost` so a 127.0.0.1 connection still passes hostname
  verification.
* **Client auth:** The TCP listener requires a client cert chained to
  the CA (mTLS). Anyone who can read `client.pem` + `client.key` can
  call the daemon. v0.1.0 stores both in
  `%ProgramData%\Signalman\certs\` with default ACLs — narrow this in
  v0.2.0 (open question below).
* **Pipe auth:** Implicit — Windows ACLs on the pipe namespace gate
  access. v0.1.0 uses default ACLs (LocalSystem / Administrators);
  v0.2.0 should restrict to Hyper-V Administrators only.
* **Production code-signing:** out of scope for v0.1.0. The MSI is
  dev-signed only.

## Install

```powershell
# 1. Build (or download a release).
cargo build --release -p signalman-service

# 2. Install (requires Administrator).
.\target\release\signalman-service.exe install

# 3. Start.
.\target\release\signalman-service.exe start
```

The install step:
1. Generates the cert bundle if absent.
2. Registers the service with the SCM as `Signalman`, AutoStart.
3. Sets the binary to run from `%ProgramFiles%\Signalman\service\`
   when invoked via the MSI (CLI install uses the supplied binary
   path).

To run as a custom account instead of LocalSystem, pass
`--account "DOMAIN\svc-signalman" --password "<pw>"`. The account
must be a member of Hyper-V Administrators (`S-1-5-32-578`):

```powershell
Add-LocalGroupMember -Group "Hyper-V Administrators" `
                     -Member "DOMAIN\svc-signalman"
```

## Uninstall

```powershell
.\target\release\signalman-service.exe uninstall
```

This stops the service and deletes its SCM registration. It does NOT
delete the cert bundle by default — re-install reuses the existing
bundle unless `--force-regen` is supplied (planned for v0.2.0). To
remove certs manually:

```powershell
Remove-Item -Recurse "$env:ProgramData\Signalman\certs"
```

## Migrating existing direct/gsudo users

The host's backend selector is **service > hyperv (gsudo) > vmware >
tart** on Windows. No config change is needed: install the service,
restart the MCP/CLI process, and `[signalman] Using service hypervisor
backend` will appear in the log instead of `Using hyperv hypervisor
backend`. Scenario runs and `signalman vm ...` subcommands both use this
selector.

To force the legacy path during migration, set
`SIGNALMAN_BACKEND=hyperv` or:

```yaml
hypervisor:
  backend: hyperv
```

The service backend's `isAvailable()` check fails fast (2-second
deadline on the Health RPC) if the daemon isn't reachable, so the
fallback to direct/gsudo is automatic.

## Manual end-to-end smoke procedure

This is the human-driven smoke test. Run after every change to the
service binary, transport layer, or sanitization code.

For a local developer checkout where the SCM service points at this repo's
`target\debug\signalman-service.exe`, use the refresh helper from an
elevated PowerShell:

```powershell
.\scripts\update-dev-service.ps1
```

The helper preflight-builds the service into a temporary target directory,
then uninstalls, rebuilds, installs, and starts the LocalSystem service.
That is the preferred loop when validating source changes against a real
Hyper-V VM because the running SCM service locks the normal debug binary.

After refreshing the service, run the backend smoke from a non-elevated
PowerShell:

```powershell
.\scripts\live-service-smoke.ps1 `
  -VmName Win11_test `
  -Checkpoint base `
  -GuestUsername test `
  -GuestPassword '<guest password>'
```

The smoke wrapper writes credentials only to a temporary config file,
runs `service-backend-smoke`, removes the temp config, and verifies that
the named checkpoint still exists afterward.

1. Build a release binary:
   ```powershell
   cargo build --release -p signalman-service
   ```
2. Install:
   ```powershell
   .\target\release\signalman-service.exe install
   .\target\release\signalman-service.exe start
   ```
3. Confirm the service is running:
   ```powershell
   sc query Signalman
   ```
4. From a *non-elevated* PowerShell, run an existing scenario:
   ```powershell
   cd host
   $env:SIGNALMAN_BACKEND = "service"
   npm run cli -- run-scenario silo-validation
   ```
5. Watch for the host log line:
   ```
   [signalman] Using service hypervisor backend
   ```
6. Confirm that the scenario completes WITHOUT any UAC prompts.
7. Tear down:
   ```powershell
   .\target\release\signalman-service.exe uninstall
   ```

## Post-merge fixes (2026-04-25)

The initial P1 merge passed unit tests but the first end-to-end run
against a real Hyper-V VM surfaced three integration issues. All three
are fixed and validated by an `ospiri-driver-v3-fs-10l-etw` scenario
run that takes ~9.5 min from `signalman run` to `result: pass`.

### 1. ServiceBackend not wired into the run executor

The MCP `signalman.run` verb's default executor
(`host/src/verbs/default-executor.ts`) only constructed
`HyperVBackend` and `VmwareBackend` and never tried `ServiceBackend`.
Every scenario fell through to the gsudo path even when the daemon
was installed and healthy — defeating the entire P1 contract.

Fix: import `ServiceBackend` through the shared backend selector and put
it ahead of the direct-Hyper-V branch (`service > hyperv > vmware`,
matching this doc's documented order). The CLI `signalman vm ...`
subcommands also use the same selector so provision/create/cleanup do
not bypass the daemon.

### 2. `get_status` PowerShell pipeline returns `{}` for empty IP

When the VM is in `Saved` state OR Integration Services hasn't
reported an IP yet, the PowerShell pipeline

```powershell
$ip = ($vm | Get-VMNetworkAdapter | Select-Object -ExpandProperty IPAddresses |
       Where-Object { $_ -match '\d+\.\d+\.\d+\.\d+' } | Select-Object -First 1)
```

returns `$null` or an empty `PSObject`. `ConvertTo-Json` then emits
`"IPAddress":{}` rather than `"IPAddress":null`, which the Rust
`Option<String>` deserializer rejects with
`invalid type: map, expected a string`.

Fix (`service/src/backend.rs::get_status`):
- Wrap the `$ip` capture in `[string](...)` so PS coerces null/empty
  to an empty string.
- Deserialize `IPAddress` into `serde_json::Value` and project to
  `Option<String>` only when the value is a non-empty string.
  Belt-and-braces — protects against any future PS-side regression.

### 3. Default executor never populated `guestClients`

The orchestrator looks up a `GuestAgentClient` by VM name for every
guest-side step (`vm_run_command`, `vm_copy_file` via guest, all the
`driver_*` and `kernel_etw_*` tools). The default executor passed
`new Map()` — empty. Every scenario that targeted a VM agent died
with `No guest client configured for VM '...'`.

Fix: parse the scenario's `setup.yaml` in the executor, walk
`config.vms`, and build one `GuestAgentClient` per VM keyed on the
logical name (the orchestrator does its own alias resolution against
the physical VM record). TLS material from `guestAgent.tls.*` in the
host config is forwarded so mTLS scenarios get the right channel.

## Open questions / compromises

* **Pipe ACLs.** The pipe is created with default ACLs (LocalSystem
  + Administrators). For v0.2.0, narrow this to Hyper-V Admins only
  via `SECURITY_ATTRIBUTES` on `ServerOptions`.
* **Cert rotation.** Operators can run
  `signalman-service rotate-certs` to generate a fresh service mTLS
  bundle. The previous complete bundle is preserved under
  `.rotation-backups/<unix-ms>/`; restart the service afterward so the
  TCP mTLS listener loads the new identity.
* **Client cert auth ≠ user identity.** The mTLS client cert proves
  *something running on this machine has read access to the cert
  bundle*, not *which user is calling*. For v0.1.0 this is fine
  (single-user dev workflow); multi-user hosts need per-user client
  certs.
* **MSI is hand-rolled WiX.** v0.1.0 ships `service/wix/product.wxs`
  with the minimal install/uninstall logic. cargo-wix integration is
  a separate pickup.
* **Code signing.** Dev-signed for v0.1.0. Production signing cert
  acquisition is tracked in the v0.2.0 release plan.
* **No remote brokering.** The service binds to 127.0.0.1 only.
  Remote control (multiple hosts driven by a single daemon) is a
  v0.3.0+ scope item.
