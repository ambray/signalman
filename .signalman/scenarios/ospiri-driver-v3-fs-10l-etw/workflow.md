# Ospiri Driver v3 — 10l ETW Diagnostic

**Purpose:** definitively identify what the overlay-dir enumeration
cache contains after a delete+recreate sequence that the production
smoke scenario's step-20 fails on (`bound_enum_shows_foo_after_recreate`
returns `[]` when it should return `[foo.txt]`).

## Background

Seven distinct driver-side fix attempts (B.3c.4c → B.3c.4i) have
failed to resolve 10l. Every attempt produced the same symptom:
`entries = []; foo.txt visible = false`. The hypothesis is that
NTFS serves a stale directory listing for the overlay parent even
after POSIX-semantics delete + FltFlushBuffers + CcCoherency flush
+ fresh peer-handle reopen.

This scenario captures the `Ospiri.Driver` TraceLogging provider's
`FsDirEnumCacheEntry` events (added in commit `991b2db`) to show
EXACTLY what filenames `FltQueryDirectoryFile` returned for the
overlay directory during the failing enum call. That answers the
question: is `foo.txt` actually in the cache (bug is in our walker),
or is `.wh.foo.txt` still there / `foo.txt` missing (stale cache
confirmed)?

## Step 1: Driver load

```tool
driver_load:
  service: ospiri
  timeout_ms: 30000
```

## Step 2: Start ETW capture

Ospiri.Driver provider, keyword `0x10` (ENFORCEMENT — where
`FsDirEnumCacheEntry` + `FsDirEnumCachePopulated` +
`FsDirEnumMergeExit` are emitted). Level 5 (Verbose) to capture
everything.

```tool
kernel_etw_start:
  provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
  keywords: "0x10"
  level: 5
  timeout_ms: 180000
```

## Step 3: Run focused 10l test

`silo-fs-test.exe redirect-write-prefix-whiteout-end-to-end`
reproduces the failing sequence: seed foo.txt, bind scope, bound
delete (creates whiteout), bound enum (should hide foo.txt, PASSES),
bound recreate (clears whiteout), bound enum (should show foo.txt,
FAILS with `[]`).

The ETW events emitted during this run:

| Event                      | Layer                          | What it tells us                                          |
| -------------------------- | ------------------------------ | --------------------------------------------------------- |
| `FsDirEnumCachePopulated`  | After PopulateOverlayCache     | Cache capacity + bytes used per populate call             |
| `FsDirEnumCacheEntry`      | Per-entry in populated cache   | Each entry's Index + NameBytes + NameHash{Low,High}       |
| `FsDirEnumMergeExit`       | At PreDirectoryControl exit    | CallerBufferUsed, OverlayCursor, SourceExhausted, etc.    |

Scope-id 8001 to avoid collisions with any prior scope state. (Scope 99
collided on the previous run despite a clean driver load — likely
persisted from an earlier unclean teardown.  High numeric IDs well
above any test-harness default are safe.)

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-whiteout-end-to-end",
         "--scope-id", "8001",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "scenario"
  timeout_ms: 180000
```

> **Note**: exit code 0 = `passed: true` — Phase B.3c.4k (stale-context
> defensive reset in PreDirectoryControl) is expected to resolve 10l. Earlier
> ETW evidence showed step-8's QueryDirectory IRP receiving a context with
> `OverlayCached=TRUE`, `OverlayCacheBytes=0`, `OverlayCache=NULL`,
> `OverlayCursor=234` — leftover post-cleanup state from step 6's context.
> B.3c.4k detects that exact degenerate combination and resets all population
> state (OverlayCached, OverlayCursor, SourceExhausted, StagedSourceBuf/Bytes/
> Cursor), forcing PopulateOverlayCache to re-query the overlay dir fresh.

## Step 4: Stop ETW session

Just stop the session — we'll parse separately with a longer timeout
because Get-WinEvent's parser cache isn't warm on a fresh-booted VM
(can take 60-120s on first invocation).

```tool
vm_run_command:
  vm: endpoint-1
  command: logman.exe
  args: ["stop", "OspiriScenarioEtw", "-ets"]
  expect_exit_code: 0
  timeout_ms: 30000
  run_as: SYSTEM
```

## Step 5: Parse ETL with extended timeout

Run `Get-WinEvent -Path <etl> -Oldest` on the guest, filter to the
Ospiri.Driver provider, extract per-event property arrays, and
return as JSON. The filename hashes in `FsDirEnumCacheEntry`
correspond to:

- `foo.txt` → hash of UTF-16 "foo.txt" (lo=10004575350705320305, hi=10595786197866861854)
- `.wh.foo.txt` → hash of UTF-16 ".wh.foo.txt" (lo=16460187417133063630, hi=586987484061116301)
- `.` → hash (lo=12638124528392833969, hi=3610022295746190682)
- `..` → hash (lo=565793323585912621, hi=5925564809812970524)

Post-run: compare per-populate event hashes against known-name
hashes to identify which entries appeared in the cache at each
read_dir invocation. Timeout 300s accommodates cold-boot Get-WinEvent
parser-cache warmup (60-120s the first time, sub-second thereafter).

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell.exe
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\Ospiri\\scripts\\parse-etl.ps1"]
  expect_exit_code: 0
  timeout_ms: 300000
  run_as: SYSTEM
```

## Step 6: Driver unload

```tool
driver_unload:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

## Expected diagnostic outcomes

The 10l test scenario is expected to FAIL (`bound_enum_shows_foo_after_recreate`
returns `[]`) — that's the bug we're diagnosing. The VALUE of
this scenario is in the ETW data collected.

### Post-run analysis keys

1. **Count of `FsDirEnumCachePopulated` events** — should be 2
   (one per read_dir: step 6 bound_enum_hides_foo_after_delete +
   step 8 bound_enum_shows_foo_after_recreate).

2. **For populate call #2 (after recreate)**, the immediately-
   following `FsDirEnumCacheEntry` events should include a hash
   matching `foo.txt` (if overlay cache is fresh) or a hash
   matching `.wh.foo.txt` (if overlay cache is stale).

3. **`FsDirEnumMergeExit` for the failing call**: `CallerBufferUsed`
   = 0 (no emit) + `OverlayCacheBytes` > 0 (cache has something)
   + `OverlayCursor` = `OverlayCacheBytes` (we iterated to end)
   would confirm Phase 1 emitted nothing from cache AND Phase 2
   hid the source entry — which means cache is stale.
