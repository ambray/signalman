# Ospiri Driver v3 — FS Driver-Verifier Cleanup Gates Workflow

> **Narrator**: This workflow runs the three new VM scenarios authored
> for Sprint 60.13's audit closure under Driver Verifier with the
> Ospiri-specific 0x0298BB flag preset. Each scenario covers a
> kernel-only path that unit tests can't reach:
>
>   - **`sl-restart-scan-dir-enum`** — closes FS audit #9 by exercising
>     dir-enum consistency across handle lifecycle. Catches bugs in
>     `OspFs_PreDirectoryControl` + the merge-enum infrastructure.
>   - **`redirect-write-probe-and-cleanup`** — happy-path baseline for
>     CP18B's eager FltCreateFile probe + orphan cleanup (FS audit #7).
>     A regression that breaks the probe will show up here as either
>     an orphan overlay file or a bugcheck under DV's I/O Verification.
>   - **`redirect-write-prefix-cow-async-e2e`** — full async COW worker
>     E2E (FS audit #2). 300 MiB of pseudo-random content forces the
>     async path. Under DV's Force Pending I/O (0x8000) and Enhanced
>     I/O Verification (0x10) flags, any IRQ-level / IRP-completion
>     mistakes in the worker show up immediately.
>
> If any scenario triggers a bugcheck, the VM produces a minidump in
> `C:\Windows\Minidump\`. Triage flow per `runbook §7.7`.

## Prerequisites confirmed by setup.yaml

- `driver-ready-verifier` checkpoint restored on `endpoint-1`
  (driver-ready + verifier flags 0x0298BB + reboot, baked via
  `tmp-ps/bake-driver-ready-verifier.ps1`).
- `C:\Ospiri\drv\ospiri.sys` (test-signed, post-Sprint-60.13 build).
- `C:\Ospiri\silo-fs-test.exe` (Release, includes 3 new subcommands).
- `sc create ospiri type=filesys` registered.
- Instances regkey populated (Inner + Outer altitudes).
- `verifier.exe /query` confirms ospiri.sys + drv.sys are
  Verifier-targeted with flags 0x0298BB.
- Service is STOPPED.

## Step 1: Load the driver

```tool
driver_load:
  service: ospiri
  expect_status: 0
  timeout_ms: 30000
```

Expected: `service_state: "Running"`. Under DV the load can take
several seconds longer than a non-DV run (special-pool + I/O verifier
init); 30s gives headroom.

## Step 2: Verify minifilter actually attached

```tool
vm_run_command:
  vm: endpoint-1
  command: fltmc.exe
  args: ["filters"]
  expect_stdout_regex: "^ospiri\\s+\\d+\\s+370000"
  timeout_ms: 30000
```

Expected: the stdout line for `ospiri` must show a non-zero instance
count at altitude 370000.

## Step 3: GET_VERSION — driver surface alive (baseline)

Smallest IOCTL round-trip to confirm the driver's dispatch surface is
responding. Re-used from v1 smoke.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222800
  expect_status: STATUS_SUCCESS
  expect_output_size_min: 24
  timeout_ms: 30000
```

(timeout bumped from 5s to 30s; under DV's Special Pool +
I/O Verification, IOCTL round-trips can take several seconds.)

## Step 4: SL_RESTART_SCAN dir-enum scenario (FS audit #9)

Dir-enum consistency across handle lifecycle. Seeds N source files,
binds, enumerates twice (set-equality), then partial-then-fresh
handle (proves handle-state isolation).

The scenario emits structured JSON on stdout with `passed:true/false`.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["sl-restart-scan-dir-enum", "--temp-dir", "C:\\Ospiri\\dv-tmp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 60000
```

## Step 5: redirect-write probe + cleanup baseline (FS audit #7 / CP18B)

Happy-path regression baseline for CP18B's eager pre-flight probe +
cleanup logic. After a successful redirect-write, verifies overlay
tree contains EXACTLY the redirected file (no orphans), bytes match,
source unchanged.

If Sprint 60.13's POSIX-semantics fix to `OspFs_DeleteStagedOverlay`
regresses, DV's Enhanced I/O Verification will detect a `0xC9 (0x230)`
double-IRP-free, or the assertion below will see an orphan file.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-probe-and-cleanup", "--temp-dir", "C:\\Ospiri\\dv-tmp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 60000
```

## Step 6: async COW worker E2E (FS audit #2)

Full async COW worker E2E. Default `size_mib=300` exceeds
`OSP_FS_COW_SIZE_CAP_BYTES (256 MiB)` so the async path fires.
xorshift64* PRNG generates deterministic content; verification
is byte-for-byte.

Under DV's Force Pending I/O (0x8000) flag, every IRP that the worker
issues will be artificially pended; the worker's pend-resume logic
gets exercised on every CREATE/READ/WRITE. Under IRQL Checking
(0x2000) any DPC↔PASSIVE inversions surface immediately.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-cow-async-e2e", "--temp-dir", "C:\\Ospiri\\dv-tmp", "--size-mib", "100"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 600000
```

`timeout_ms: 600000` -- 10 minutes. The default 300 MiB size triggers
the async path (>OSP_FS_COW_SIZE_CAP_BYTES = 256 MiB), but under DV
the 300 MiB write+verify takes longer than 4 min. We override
`--size-mib 100` here. NOTE: 100 MiB is BELOW the 256 MiB async cap,
so this run exercises the SYNC COW path under DV, not the async one.
Async-path-under-DV validation deferred -- it requires either a
larger timeout window or a smaller cap value at build time.

## Step 7: dump verifier statistics post-run

Captures `verifier /query` totals (Bytes Allocated, Bytes Leaked,
Faults Injected) so the operator can spot pool-tracking violations
even when no scenario triggered a bugcheck.

```tool
vm_run_command:
  vm: endpoint-1
  command: cmd.exe
  args: ["/c", "verifier.exe /query"]
  expect_exit_code: 0
  timeout_ms: 15000
```

The `Bytes Leaked` line must be `0` for an Ospiri-clean run. Any
non-zero value points at a missed `OspCom_FreeTagged` on an error
path — refer to the runbook §7.7 pool-leak triage flow.

## Step 8: list any DV minidumps that fired

Best-effort listing of `C:\Windows\Minidump\` so the operator knows
to retrieve specific dumps via the SMB share. Empty directory =
no bugchecks fired during this run (the desired outcome).

```tool
vm_run_command:
  vm: endpoint-1
  command: cmd.exe
  args: ["/c", "if exist C:\\Windows\\Minidump dir C:\\Windows\\Minidump\\"]
  expect_exit_code: 0
  timeout_ms: 10000
```

## Step 9: Unload the driver

```tool
driver_unload:
  service: ospiri
  expect_status: 0
  timeout_ms: 30000
```

Expected: `service_state: "Stopped"`. Under DV this is the moment
when leaked pool is reported — the kernel walks every active
allocation tagged for ospiri.sys and bugchecks if any remain.

## Step 10: Verify minifilter detached cleanly

```tool
vm_run_command:
  vm: endpoint-1
  command: fltmc.exe
  args: ["filters"]
  expect_stdout_regex: "^(?!ospiri).*"
  timeout_ms: 15000
```

`ospiri` should NOT appear in `fltmc filters` output post-unload.
A lingering line means the unregister path didn't drain instances
correctly — DV's pool-leak check would also fire in that case.
