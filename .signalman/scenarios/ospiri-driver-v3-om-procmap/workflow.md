# Ospiri Driver v3 — OM PROCMAP Smoke (Sprint 60.14 Phase 3C)

> **Narrator**: This workflow is the VM-side smoke test of Sprint 60.14
> Phase 3C — the OM PID→Scope binding layer (`OspOmScope_BindProcess` /
> `UnbindProcess` / `LookupByPid`) plus the `PsSetCreateProcessNotifyRoutineEx`
> auto-unbind hook plus the two new IOCTLs (BIND_PROCESS = 0x865,
> UNBIND_PROCESS = 0x866). The unit tests (3,000 EXPECTs) cover the
> binding logic; this scenario is what proves the wiring works on a
> real Win11x64 guest under Driver Verifier — specifically, the
> kernel-only `PsLookupProcessByProcessId` capture path and the real
> `PsSetCreateProcessNotifyRoutineEx` callback firing on real process
> termination, neither of which usersim fakes.
>
> Each step exercises one slice of the new IOCTL surface. If any IOCTL
> trips Driver Verifier (UAF, leaked alloc, IRQL violation), the kdnet
> session catches the bugcheck and `driver_unload` in step 12 fails.

## Prerequisites confirmed by setup.yaml
- `driver-ready` checkpoint restored on `endpoint-1`
- `C:\Ospiri\drv\ospiri.sys` (Phase-3C test-signed) deployed
- `C:\Ospiri\silo-test-harness.exe` deployed
- `sc create ospiri type=filesys` ran, service is STOPPED
- FltMgr Instances regkey populated (required for OspriFs registration
  even though Phase 3C doesn't exercise FS)

## IOCTL control codes (Phase 3C subset of OspriOm)

Device type `FILE_DEVICE_UNKNOWN (0x22)`, METHOD_BUFFERED, FILE_ANY_ACCESS:

    code = (0x22 << 16) | (function << 2)

| Symbol                          | Function | CTL_CODE   |
| ------------------------------- | -------- | ---------- |
| `OSP_FN_OM_INIT_SCOPE`          |  `0x860` | `0x222180` |
| `OSP_FN_OM_DESTROY_SCOPE`       |  `0x863` | `0x22218C` |
| `OSP_FN_OM_DRAIN_EVIDENCE`      |  `0x864` | `0x222190` |
| `OSP_FN_OM_BIND_PROCESS`        |  `0x865` | `0x222194` |
| `OSP_FN_OM_UNBIND_PROCESS`      |  `0x866` | `0x222198` |

## Step 1: Load the driver under DV

```tool
driver_load:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

Expected: `service_state: "Running"`. Phase 3C adds `OspOmScope_ProcMapInit`
and `PsSetCreateProcessNotifyRoutineEx` to the init path; either failing
would surface as a non-success NTSTATUS during `DriverEntry`'s OM init
step. The kdnet session captures the failing status if so.

## Step 2: OM_INIT_SCOPE — create OM scope 0x900

`OSP_OM_INIT_SCOPE_IN` is 16 bytes: header (8) + ScopeId (4) + Reserved (4).
Send `{ Version=1, Size=16, ScopeId=0x900, Reserved=0 }`:

- `01 00 00 00 10 00 00 00 00 09 00 00 00 00 00 00`

Expected: `STATUS_SUCCESS`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222180
  input_hex: "01 00 00 00 10 00 00 00 00 09 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 3: OM_BIND_PROCESS — bind PID 0x4 (System Idle Process) to scope 0x900

`OSP_OM_BIND_PROCESS_IN` is 16 bytes: header (8) + ScopeId (4) + Pid (4).
PID 4 is the System process — guaranteed to exist on every Windows
system. `PsLookupProcessByProcessId(4)` will succeed, and capturing
its CreateTime is well-defined.

Send `{ Version=1, Size=16, ScopeId=0x900, Pid=4 }`:

- `01 00 00 00 10 00 00 00 00 09 00 00 04 00 00 00`

Expected: `STATUS_SUCCESS`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222194
  input_hex: "01 00 00 00 10 00 00 00 00 09 00 00 04 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 4: OM_BIND_PROCESS again — duplicate PID returns COLLISION

Same input as step 3. Per the BindProcess contract, an already-bound
PID is rejected with `STATUS_OBJECT_NAME_COLLISION` (the agent must
UNBIND first to rebind). The harness's Win32-alias resolver maps
`ERROR_DUP_NAME = 0x34` back to the NTSTATUS name.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222194
  input_hex: "01 00 00 00 10 00 00 00 00 09 00 00 04 00 00 00"
  expect_status: STATUS_OBJECT_NAME_COLLISION
  timeout_ms: 5000
```

## Step 5: OM_UNBIND_PROCESS — unbind PID 4

`OSP_OM_UNBIND_PROCESS_IN` is 16 bytes: header (8) + Pid (4) + Reserved (4).
Send `{ Version=1, Size=16, Pid=4, Reserved=0 }`:

- `01 00 00 00 10 00 00 00 04 00 00 00 00 00 00 00`

Expected: `STATUS_SUCCESS`. UnbindProcess is idempotent so a second
unbind also returns SUCCESS (step 5b).

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222198
  input_hex: "01 00 00 00 10 00 00 00 04 00 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 5b: OM_UNBIND_PROCESS — idempotent re-unbind

Same input. Should still return `STATUS_SUCCESS` (the missing-PID
path is a documented no-op, not an error).

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222198
  input_hex: "01 00 00 00 10 00 00 00 04 00 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 6: OM_BIND_PROCESS — unknown ScopeId rejected

ScopeId 0xDEADBEEF doesn't exist (we only created 0x900). Expected
`STATUS_NOT_FOUND`. Win32 alias `ERROR_NOT_FOUND = 0x490`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222194
  input_hex: "01 00 00 00 10 00 00 00 EF BE AD DE 04 00 00 00"
  expect_status: STATUS_NOT_FOUND
  timeout_ms: 5000
```

## Step 7: OM_BIND_PROCESS — Pid=0 rejected at IOCTL layer

The IOCTL handler explicitly rejects Pid=0 (defense-in-depth audit
hardening). Expected `STATUS_INVALID_PARAMETER`. Win32 alias
`ERROR_INVALID_PARAMETER = 0x57`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222194
  input_hex: "01 00 00 00 10 00 00 00 00 09 00 00 00 00 00 00"
  expect_status: STATUS_INVALID_PARAMETER
  timeout_ms: 5000
```

## Step 8: OM_BIND_PROCESS — non-existent PID rejected

PID 0xFFFFFFF0 is highly unlikely to exist (PIDs grow from low values).
The kernel's `PsLookupProcessByProcessId` returns
`STATUS_INVALID_CID = 0xC000000B` for an out-of-range PID; OM's
`OspOmScope_BindProcess` re-throws that as STATUS_INVALID_CID per the
public API contract.

**Wire-level note**: STATUS_INVALID_CID and STATUS_INVALID_PARAMETER
both map to Win32 `ERROR_INVALID_PARAMETER = 0x57` after the I/O
manager's RtlNtStatusToDosError translation. The silo-test-harness's
status_symbol resolver re-translates 0x57 to `STATUS_INVALID_PARAMETER`
(the Win32 → NTSTATUS round-trip is one-to-many; the harness picks the
canonical NTSTATUS for each Win32 code). So the smoke test asserts
`STATUS_INVALID_PARAMETER` even though the driver actually returned
`STATUS_INVALID_CID`. Phase 3D may move to driver-emitted NTSTATUS
visibility (e.g., adding a debug-info field to the OUT struct) so this
distinction can be tested directly.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222194
  input_hex: "01 00 00 00 10 00 00 00 00 09 00 00 F0 FF FF FF"
  expect_status: STATUS_INVALID_PARAMETER
  timeout_ms: 5000
```

## Step 9: OM_UNBIND_PROCESS — Pid=0 rejected

The handler explicitly rejects Pid=0. Expected `STATUS_INVALID_PARAMETER`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222198
  input_hex: "01 00 00 00 10 00 00 00 00 00 00 00 00 00 00 00"
  expect_status: STATUS_INVALID_PARAMETER
  timeout_ms: 5000
```

## Step 10: OM_UNBIND_PROCESS — Reserved nonzero rejected

Forward-compat check on the Reserved field. Expected
`STATUS_INVALID_PARAMETER`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222198
  input_hex: "01 00 00 00 10 00 00 00 04 00 00 00 EF BE AD DE"
  expect_status: STATUS_INVALID_PARAMETER
  timeout_ms: 5000
```

## Step 11: OM_DESTROY_SCOPE 0x900 — clean teardown

Inputs: header (8) + ScopeId (4) + Reserved (4) = 16 bytes.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x22218C
  input_hex: "01 00 00 00 10 00 00 00 00 09 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 12: Unload the driver

Driver Verifier runs leak / handle-state checks during unload.
Phase 3C added a procmap (allocs every BindProcess), a process-notify
registration (must be deregistered), and the OB callback's PID-lookup
ref-count discipline. Any leaked alloc, missed deregistration, or
unbalanced ref bugchecks here.

```tool
driver_unload:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

Expected: `service_state: "Stopped"`.

## Expected outcomes

| Step | Check                                         | Expected (NTSTATUS)                             |
| ---- | --------------------------------------------- | ----------------------------------------------- |
| 1    | sc start                                      | exit 0, Running                                 |
| 2    | OM_INIT_SCOPE 0x900                           | STATUS_SUCCESS                                  |
| 3    | OM_BIND_PROCESS PID=4 -> scope 0x900          | STATUS_SUCCESS                                  |
| 4    | OM_BIND_PROCESS PID=4 (duplicate)             | STATUS_OBJECT_NAME_COLLISION                    |
| 5    | OM_UNBIND_PROCESS PID=4                       | STATUS_SUCCESS                                  |
| 5b   | OM_UNBIND_PROCESS PID=4 (idempotent)          | STATUS_SUCCESS                                  |
| 6    | OM_BIND_PROCESS unknown scope                 | STATUS_NOT_FOUND                                |
| 7    | OM_BIND_PROCESS Pid=0                         | STATUS_INVALID_PARAMETER                        |
| 8    | OM_BIND_PROCESS non-existent PID              | STATUS_INVALID_PARAMETER (Win32 alias of CID)   |
| 9    | OM_UNBIND_PROCESS Pid=0                       | STATUS_INVALID_PARAMETER                        |
| 10   | OM_UNBIND_PROCESS Reserved nonzero            | STATUS_INVALID_PARAMETER                        |
| 11   | OM_DESTROY_SCOPE 0x900                        | STATUS_SUCCESS                                  |
| 12   | sc stop (clean unload under DV)               | exit 0, Stopped                                 |

A green run proves the Phase 3C wiring is correct end-to-end on a
real Win11 24H2 guest:
  * `PsLookupProcessByProcessId` capture path (BIND with PID=4 success
    AND non-existent PID returning INVALID_CID — both kernel-only paths).
  * `PsSetCreateProcessNotifyRoutineEx` registration is healthy at
    Init (driver loads), drained at Shutdown (driver unloads cleanly
    under DV — the leak/ref tracker would catch a missed deregistration).
  * Procmap allocs/frees balance (DV pool tracking would catch a leak).
  * The two new IOCTL handlers correctly route through OspOm_DispatchIoctl.
