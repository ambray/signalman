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

The host's backend selector is **service > hyperv (gsudo) > vmware**.
No config change is needed: install the service, restart the MCP
process, and `[signalman] Using service hypervisor backend` will
appear in the log instead of `Using hyperv hypervisor backend`.

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

## Open questions / compromises

* **Pipe ACLs.** The pipe is created with default ACLs (LocalSystem
  + Administrators). For v0.2.0, narrow this to Hyper-V Admins only
  via `SECURITY_ATTRIBUTES` on `ServerOptions`.
* **Cert rotation.** v0.1.0 ships 1-year ECDSA P-256 certs. There is
  no automatic renewal. Operators must `uninstall` + reinstall to
  rotate. v0.2.0 should add `signalman-service certs renew`.
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
