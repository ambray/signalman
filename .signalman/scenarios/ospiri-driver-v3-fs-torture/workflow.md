# Ospiri Driver v3 FS — Multi-Threaded Torture Workflow

> **Narrator**: This is the concurrent-load companion to
> `ospiri-driver-v3-fs-restrict`. Where that scenario validates the
> FS minifilter's single-threaded correctness (DENY_READ, DENY_WRITE,
> PreSetInformation, REDIRECT_WRITE EXACT, REDIRECT_WRITE PREFIX —
> all one-shot), this one proves the driver holds up when 8 worker
> threads pound the REDIRECT_WRITE + PREFIX dispatch path with 100
> writes each (800 total redirects).
>
> The target paths under stress:
>   - `OspFs_PreCreate` → classifier PREFIX match
>   - `OspCom_AllocTagged(POOL_FLAG_NON_PAGED, ..., 'OfNa')` per redirect
>   - `RtlCopyMemory` of `overlay_prefix + file_suffix`
>   - `IoReplaceFileObjectName`
>   - `OspCom_FreeTagged(..., 'OfNa')`
>   - `STATUS_REPARSE` + `IO_REPARSE` re-dispatch
>
> Assertions that prove the drive held:
>   1. Zero files escape to the source tree (every redirect fired).
>   2. Exactly 800 files land in the overlay tree (every redirect
>      completed + the FS created the file at the redirected path).
>   3. The filter unloads cleanly — no pool-tag leak bugchecks (under
>      Driver Verifier) and no stuck-IRP hangs.

## Prerequisites confirmed by setup.yaml

- `driver-ready` checkpoint restored on `endpoint-1`
- `C:\Ospiri\drv\ospiri.sys` (test-signed) deployed
- `C:\Ospiri\silo-fs-test.exe` deployed (carries the
  `redirect-write-prefix-torture` subcommand)
- `sc create ospiri type=filesys` + Instances regkey populated
- Service is STOPPED

## Step 1: Load the driver

```tool
driver_load:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

Expected: `service_state: "Running"`. If start succeeds but state
shows "Stopped", check the guest's System event log — FltRegisterFilter
may have failed.

## Step 2: Verify minifilter attached

```tool
vm_run_command:
  vm: endpoint-1
  command: fltmc.exe
  args: ["filters"]
  expect_stdout_regex: "^ospiri\\s+\\d+\\s+370000"
  timeout_ms: 15000
```

Expected: non-zero instance count at altitude 370000 (inner attach).
Timeout 15s to match the v3-restrict scenario's post-flake baseline.

## Step 3: Run the torture subcommand

`silo-fs-test redirect-write-prefix-torture` sequences:

  1. Create source + overlay directory trees under `%TEMP%\ospiri-b3b-tor-src\deep\` and `%TEMP%\ospiri-b3b-tor-ovl\deep\`
  2. Resolve NT device-form prefixes (append `\` at the end of each)
  3. InitScope + AddRule(REDIRECT_WRITE + PREFIX_PATH, src → ovl)
  4. BindProcess (self)
  5. Spawn 8 worker threads; each runs 100 iterations of:
     - `OpenOptions::new().write(true).create(true).truncate(true)`
       on `source_dir\deep\t{T}_i{I}.redirect-test`
     - Write `"MARK t{T} i{I}"` marker bytes
     - sync + close
     (All 800 CREATE IRPs go through PreCreate, match the PREFIX
      rule, hit the allocate+memcpy+IoReplaceFileObjectName+free
      sequence, return STATUS_REPARSE, get re-dispatched at the
      overlay path.)
  6. Count files in SOURCE subtree — MUST be 0
  7. Count files in OVERLAY subtree — MUST be 800
  8. UnbindProcess + DestroyScope + tree cleanup

Emits a single-line JSON report; `"passed":true` iff every step
matched expectations. Exit code 0 on pass.

A 3-minute timeout budget (180_000 ms) covers worst-case VM
scheduler contention; typical runs finish in < 5 seconds of actual
torture-binary time plus scope-IOCTL overhead.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-torture",
         "--scope-id", "1",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp",
         "--workers", "8",
         "--iterations", "100"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 180000
```

## Step 4: Unload the driver

```tool
driver_unload:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

If the driver leaked tagged pool during the 800 redirects and the
run was against a Driver-Verifier-enabled checkpoint, the unload
would trigger a `DRIVER_VERIFIER_DETECTED_VIOLATION` bugcheck here
(not a graceful stop). A clean Stopped response means:
- 'OfNa' alloc/free accounting balanced over 800 redirects
- No stuck IRPs
- FltUnregisterFilter drained cleanly

## Step 5: Confirm minifilter detached

```tool
vm_run_command:
  vm: endpoint-1
  command: fltmc.exe
  args: ["filters"]
  expect_stdout_not_regex: "^ospiri"
  timeout_ms: 15000
```

## Expected outcomes

| Step | Check                                                 | Expected                     |
| ---- | ----------------------------------------------------- | ---------------------------- |
| 1    | sc start                                              | exit 0, Running              |
| 2    | fltmc filters shows ospiri at 370000                  | match                        |
| 3    | silo-fs-test redirect-write-prefix-torture 8x100      | exit 0, `"passed":true`      |
| 4    | sc stop                                               | exit 0, Stopped              |
| 5    | ospiri absent from fltmc filters                      | no match                     |

A green run means:
  * The REDIRECT_WRITE + PREFIX hot path (allocate-memcpy-replace-
    free) is thread-safe under 8-way concurrency from a single
    bound PID.
  * Pool-tag 'OfNa' accounting is balanced (clean unload is the
    proxy assertion; Driver Verifier, when enabled on the
    checkpoint, is the hard gate).
  * The PID hash-bucket reader fast-path handles 800 classify
    calls from the same PID without breaking.
  * FltUnregisterFilter completes without hung IRPs or leaks.
