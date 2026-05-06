# Ospiri Driver v3 — FS Restrict Smoke Workflow

> **Narrator**: This workflow validates the OspriFs minifilter's IOCTL
> surface end-to-end against a real FltMgr-attached driver. Each step
> exercises one slice:
>
>   - Can the driver load with the minifilter actually attaching?
>     (Verified via fltmc filters showing `ospiri` in the filter list.)
>   - Does each of the 6 FS IOCTLs respond correctly?
>     (Raw-hex driver_ioctl tool blocks; no harness extension yet.)
>   - Does standard file I/O still work while the minifilter is loaded
>     but no scopes are bound? (Sanity regression: the PreCreate
>     hot path must short-circuit correctly for unbound callers.)
>   - Does the driver unload cleanly? (Minifilter detach + service stop.)
>
> The actual **DENY_READ enforcement end-to-end** (BindProcess ->
> CreateFile -> STATUS_OBJECT_NAME_NOT_FOUND) is NOT in this scenario;
> that's Phase B.1 and requires silo-test-harness to be extended with
> an FS-IOCTL module so the same process can bind itself + CreateFile
> a denied path within one invocation.

## Prerequisites confirmed by setup.yaml

- `driver-ready` checkpoint restored on `endpoint-1`
- `C:\Ospiri\drv\ospiri.sys` (test-signed) deployed
- `C:\Ospiri\silo-test-harness.exe` deployed (used for future FS-IOCTL
  extension; currently only the diagnostic subcommands are exercised)
- `sc create ospiri type=filesys` registered
- Instances regkey populated (Inner + Outer altitudes)
- Service is STOPPED

## FS IOCTL control codes

From `drv/drv/subsys/fs/fs_internal.h` (0x840-0x845 range):

| Symbol                          | Function | CTL_CODE    |
| ------------------------------- | -------- | ----------- |
| `OSP_FN_FS_INIT_SCOPE`          |  `0x840` | `0x222100`  |
| `OSP_FN_FS_ADD_RULE`            |  `0x841` | `0x222104`  |
| `OSP_FN_FS_LIST_RULES`          |  `0x842` | `0x222108`  |
| `OSP_FN_FS_DESTROY_SCOPE`       |  `0x843` | `0x22210C`  |
| `OSP_FN_FS_BIND_PROCESS`        |  `0x844` | `0x222110`  |
| `OSP_FN_FS_UNBIND_PROCESS`      |  `0x845` | `0x222114`  |

Device type is `FILE_DEVICE_UNKNOWN (0x22)`; all IOCTLs are
`METHOD_BUFFERED (0)` + `FILE_ANY_ACCESS (0)`.

## Step 1: Load the driver

```tool
driver_load:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

Expected: `service_state: "Running"`. If start succeeds but state shows
"Stopped", check the guest's System event log — FltRegisterFilter may
have failed (e.g., Instances regkey missing / malformed altitude).

## Step 2: Verify minifilter actually attached

```tool
vm_run_command:
  vm: endpoint-1
  command: fltmc.exe
  args: ["filters"]
  expect_stdout_regex: "^ospiri\\s+\\d+\\s+370000"
  timeout_ms: 15000
```

Expected: the stdout line for `ospiri` must show a non-zero instance
count at altitude 370000. Phase A attaches to every NTFS + REFS +
LANMAN volume, so on a typical box this is 2-6 instances.

**Timeout note**: raised from 5s to 15s after a B.3a run hit a
fltmc-enumeration transient at 5s despite the filter being attached
(subsequent IOCTL + unbound-I/O steps all passed). fltmc can stall
briefly on a busy VM; 15s gives headroom without masking a real
detach.

## Step 3: GET_VERSION — driver surface alive (baseline)

Smallest IOCTL round-trip to confirm the driver's dispatch surface is
responding. Re-used from v1 smoke — if this fails, the FS-specific
IOCTLs won't work either.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222800
  expect_status: STATUS_SUCCESS
  expect_output_size_min: 24
  timeout_ms: 5000
```

## Step 4: FS_INIT_SCOPE with ScopeId=1

`OSP_FS_INIT_SCOPE_IN` wire format (16 bytes, pack 8):
```
Offset  Size  Field                 Value
 0      4     StructVersion         01 00 00 00  (V2 = 1)
 4      4     StructSize            10 00 00 00  (16)
 8      4     ScopeId               01 00 00 00  (1)
12      4     Reserved              00 00 00 00
```

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222100
  input_hex: "01 00 00 00 10 00 00 00 01 00 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 5: FS_INIT_SCOPE duplicate — must reject with OBJECT_NAME_COLLISION

Second InitScope for the same ScopeId=1. `OspFsScope_Create` detects
the existing scope at the bucket and returns `STATUS_OBJECT_NAME_COLLISION`.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222100
  input_hex: "01 00 00 00 10 00 00 00 01 00 00 00 00 00 00 00"
  expect_status: STATUS_OBJECT_NAME_COLLISION
  timeout_ms: 5000
```

## Step 6: FS_ADD_RULE DENY_READ for a test path

`OSP_FS_ADD_RULE_IN` (48 bytes fixed + variable wchar payload).
Match-target: `L"\DosDevices\C:\temp\ospiri-denied.txt"` = 34 wchars
= 68 bytes of trailing payload. Layout:

```
Offset  Size  Field                  Value
 0      4     StructVersion          01 00 00 00
 4      4     StructSize             30 00 00 00  (48)
 8      4     ScopeId                01 00 00 00  (1)
12      1     Verdict                01           (DENY)
13      1     MatchKind              00           (EXACT_PATH)
14      1     RuleKind               00           (DENY_READ)
15      1     Reserved               00
16      2     PathOffset             30 00        (48)
18      2     PathWchars             22 00        (34)
20      2     OverlayOffset          00 00
22      2     OverlayWchars          00 00
24      4     Reserved1              00 00 00 00
28      8     Reserved2              00 00 00 00 00 00 00 00
36      8     Reserved3              00 00 00 00 00 00 00 00
44      4     (padding)              00 00 00 00
48+     68    Path (UTF-16)          \DosDevices\C:\temp\ospiri-denied.txt
```

TODO Phase B.1: hex-encode the UTF-16 payload above into this tool
block once the wire-format fuzz tests confirm layout.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222104
  input_hex: "01 00 00 00 30 00 00 00 01 00 00 00 01 00 00 00 30 00 22 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 5C 00 44 00 6F 00 73 00 44 00 65 00 76 00 69 00 63 00 65 00 73 00 5C 00 43 00 3A 00 5C 00 74 00 65 00 6D 00 70 00 5C 00 6F 00 73 00 70 00 69 00 72 00 69 00 2D 00 64 00 65 00 6E 00 69 00 65 00 64 00 2E 00 74 00 78 00 74 00"
  expect_status: STATUS_SUCCESS
  expect_output_size_min: 16
  timeout_ms: 5000
```

## Step 7: FS_LIST_RULES for ScopeId=1

`OSP_FS_LIST_RULES_IN` wire (16 bytes): Hdr + ScopeId + Reserved.

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x222108
  input_hex: "01 00 00 00 10 00 00 00 01 00 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  expect_output_size_min: 24
  timeout_ms: 5000
```

Expected: OutBuffer has `OSP_FS_LIST_RULES_OUT` header reporting
`RuleCount=1`, followed by the rule entry + pool payload.

## Step 8: Standard file I/O regression (unscoped)

With the driver loaded but no PID bound to any scope, OspFs_PreCreate
must short-circuit via `OspFsScope_LookupByPid` returning NULL -
FLT_PREOP_SUCCESS_NO_CALLBACK. No IRP_MJ_CREATE on this unbound
process should be denied.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell
  args:
    - "-Command"
    - "$t=\"$env:TEMP\\ospiri-smoke-$((Get-Random))\"; New-Item -ItemType Directory -Path $t -Force | Out-Null; $p = Join-Path $t 'hello.txt'; Set-Content $p 'hello'; $ok = (Get-Content $p) -eq 'hello'; Remove-Item $t -Recurse -Force; if ($ok) { Write-Host 'FIO_OK' } else { exit 1 }"
  expect_exit_code: 0
  expect_stdout: "FIO_OK"
  timeout_ms: 10000
```

## Step 9: FS_DESTROY_SCOPE ScopeId=1

`OSP_FS_DESTROY_SCOPE_IN` (16 bytes).

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x22210C
  input_hex: "01 00 00 00 10 00 00 00 01 00 00 00 00 00 00 00"
  expect_status: STATUS_SUCCESS
  timeout_ms: 5000
```

## Step 10: FS_DESTROY_SCOPE again — must reject with NOT_FOUND

```tool
driver_ioctl:
  device: "\\\\.\\ospiri"
  control_code: 0x22210C
  input_hex: "01 00 00 00 10 00 00 00 01 00 00 00 00 00 00 00"
  expect_status: STATUS_NOT_FOUND
  timeout_ms: 5000
```

## Step 10b: End-to-end DENY_READ enforcement via silo-fs-test

This is the critical Phase B.0 gate: prove that a process bound to a
scope with a DENY_READ rule cannot `CreateFile` a path matching the
rule. The raw-hex IOCTL steps above validate the surface; this step
validates the actual `OspFs_PreCreate` → `OspFsClassify_EvaluateScope` →
`STATUS_OBJECT_NAME_NOT_FOUND` → user-mode `ERROR_FILE_NOT_FOUND` chain.

The `silo-fs-test` binary (Sprint 60.9 Phase B.0, in
`drv/test-harness/src/bin/silo-fs-test.rs`) sequences:

  1. Create test file `C:\Users\aaron\AppData\Local\Temp\<x>.ospiri-denied`
  2. IOCTL FS_INIT_SCOPE (scope_id=1, fresh because step 10 destroyed it)
  3. IOCTL FS_ADD_RULE with VERDICT_DENY + MATCH_EXTENSION +
     RULE_KIND_DENY_READ on `.ospiri-denied` suffix
  4. IOCTL FS_BIND_PROCESS (self PID)
  5. `File::open` the test file — MUST fail with `ERROR_FILE_NOT_FOUND (2)`
  6. IOCTL FS_UNBIND_PROCESS
  7. `File::open` again — MUST succeed (scope released, file still exists)
  8. IOCTL FS_DESTROY_SCOPE
  9. Delete test file

Emits a single-line JSON report; `"passed":true` iff every step matched
expectations. Exit code 0 on pass, 1 on any step failure.

The MATCH_EXTENSION rule avoids needing to translate Win32 paths
(`C:\...`) to NT device-form (`\Device\HarddiskVolumeN\...`) which
`FltGetFileNameInformation(FLT_FILE_NAME_OPENED)` returns — extension
suffix-matching works regardless of volume mapping.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["deny-read-end-to-end", "--scope-id", "1", "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 15000
```

## Step 10c: End-to-end DENY_WRITE enforcement via silo-fs-test

Phase B.2 gate: prove that a scope with a DENY_WRITE rule blocks
write-intent CREATEs + post-open rename/delete, while leaving reads
unaffected. The driver paths exercised are:

  * `OspFs_PreCreate` with write-intent `DesiredAccess` (FILE_WRITE_DATA,
    FILE_APPEND_DATA, DELETE) -> `STATUS_ACCESS_DENIED`
  * `OspFs_PreSetInformation` with `FileRenameInformation` ->
    `STATUS_ACCESS_DENIED` (the rename disposition can evade the
    CREATE-time gate if the file was opened with read-only access)

The harness sequences (scope_id=2 so we don't collide with step 10b):

  1. Create `.ospiri-write-denied` test file unbound
  2. InitScope + AddRule(DENY_WRITE + MATCH_EXTENSION)
  3. BindProcess (self)
  4. read-only `File::open` — MUST succeed (read_allowed)
  5. write-mode `OpenOptions::write(true)` — MUST fail ACCESS_DENIED (write_denied)
  6. `std::fs::rename` to `.renamed` — MUST fail ACCESS_DENIED (rename_denied)
  7. `std::fs::remove_file` — MUST fail ACCESS_DENIED (delete_denied)
  8. UnbindProcess
  9. write-mode open post-unbind — MUST succeed (write_allowed)
 10. DestroyScope + cleanup

All 10 step assertions must match; scenario asserts `"passed":true`.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["deny-write-end-to-end", "--scope-id", "2", "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 20000
```

## Step 10d: PreSetInformation FileDispositionInformation branch (Phase B.2.2 MED-3)

Step 10c's delete step reaches the driver via `DeleteFileW`, which
internally uses `NtCreateFile(DELETE | FILE_DELETE_ON_CLOSE)` — so it
exercises the `OspFs_PreCreate` DELETE-bit gate, not the
`OspFs_PreSetInformation` FileDispositionInformation branch. To
validate that branch specifically, the `silo-fs-test
deny-write-setinfo-delete-end-to-end` subcommand opens a handle with
DELETE access BEFORE binding (so PreCreate forwards unmolested) and
then issues `SetFileInformationByHandle(FileDispositionInfo,
DeleteFile=TRUE)` after binding. The SET_INFORMATION IRP fires under
the bound PID; PreSetInformation's disposition branch catches it.

Also validates the Phase B.2 design invariant that pre-bind handles
don't escape SET_INFORMATION enforcement — the hook resolves the
caller's CURRENT PID at IRP dispatch, not the handle's open-time PID.

Uses scope_id=3 to avoid collision with earlier steps.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["deny-write-setinfo-delete-end-to-end", "--scope-id", "3", "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 20000
```

## Step 10e: End-to-end REDIRECT_WRITE enforcement via silo-fs-test (Phase B.3a)

Phase B.3a gate: prove that a scope with a REDIRECT_WRITE rule transparently
rewrites a source path to an overlay path via `IoReplaceFileObjectName +
STATUS_REPARSE`, so writes land at the overlay while the source file stays
untouched on disk. The driver path exercised is:

  * `OspFs_PreCreate` matches the write-intent CREATE against the
    REDIRECT_WRITE rule, calls `IoReplaceFileObjectName(FileObject,
    overlay)`, sets `Data->IoStatus.Status = STATUS_REPARSE` +
    `Information = IO_REPARSE`, returns `FLT_PREOP_COMPLETE`. The I/O
    manager re-issues IRP_MJ_CREATE against the overlay name; the
    returned handle is bound to the overlay file.

Unlike DENY_READ / DENY_WRITE the rule must carry a TWO-path payload
(source + overlay), both in NT device-form. The harness resolves both
files' device-form paths at runtime via
`GetFinalPathNameByHandleW(VOLUME_NAME_NT)` so rule match-strings align
with `FltGetFileNameInformation(FLT_FILE_NAME_OPENED)` output.

The harness sequences (scope_id=4 to avoid collision with 10b/10c/10d):

  1. Create SOURCE file with marker "ORIGINAL-SOURCE-CONTENT"
  2. Create OVERLAY file with marker "ORIGINAL-OVERLAY-CONTENT"
  3. Resolve both Win32 paths to NT device-form
  4. InitScope + AddRule(REDIRECT_WRITE + EXACT_PATH, source -> overlay)
  5. BindProcess (self)
  6. Open SOURCE for write + write "REDIRECTED-WRITE-MARKER" + close
  7. Verify SOURCE file content is UNCHANGED on disk (still "ORIGINAL-SOURCE-CONTENT")
  8. Verify OVERLAY file content is "REDIRECTED-WRITE-MARKER" (redirect landed)
  9. UnbindProcess + DestroyScope + cleanup

All 8 step assertions must match; scenario asserts `"passed":true`.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-exact-end-to-end", "--scope-id", "4", "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 20000
```

## Step 10f: End-to-end REDIRECT_WRITE + PREFIX enforcement via silo-fs-test (Phase B.3b)

Phase B.3b gate: prove that a scope with a REDIRECT_WRITE rule whose
MatchKind is `PREFIX_PATH` transparently rewrites writes to ANY file
under the source-prefix subtree, preserving the suffix. The driver
paths exercised extend B.3a's dispatch:

  * `OspFs_PreCreate` matches the write-intent CREATE against a
    PREFIX rule, then:
    1. Reads the rule's source-prefix length (`PathLen`)
    2. Computes suffix = FilePath[sourcePrefixLen..]
    3. Allocates a temp non-paged NX buffer (pool tag `OfNa`)
    4. memcpy's overlay_prefix + suffix into it
    5. Calls `IoReplaceFileObjectName(FileObject, assembledBuf, bytes)`
    6. Frees the temp buffer
    7. Completes the IRP with `STATUS_REPARSE` + `Information = IO_REPARSE`

Unlike the EXACT_PATH redirect that targets a single file, this
rewrites an entire subtree. A rule on
`\Device\HarddiskVolume3\...\ospiri-b3b-src\` → `\Device\HarddiskVolume3\...\ospiri-b3b-ovl\`
redirects a write at `...\ospiri-b3b-src\deep\file.redirect-test` to
`...\ospiri-b3b-ovl\deep\file.redirect-test`.

The harness creates BOTH subtrees pre-flight (source side so the
user-space path "exists", overlay side so the FS can actually land
the file-create IRP when the redirect resolves to
`.\deep\file.redirect-test` in that tree). It then:

  1. Creates source + overlay tree + subdir in both
  2. Resolves NT device-form prefixes (appends trailing `\` so the
     rule matches at a path-component boundary)
  3. InitScope + AddRule(REDIRECT_WRITE + PREFIX_PATH, src -> ovl)
  4. BindProcess (self)
  5. Write to `source_dir\deep\file.redirect-test` (CREATE_ALWAYS)
  6. Verify source file is ABSENT on disk (redirect fired at CREATE)
  7. Verify overlay file at the deeper path has the written marker
     (proves both the rewrite AND suffix preservation)
  8. UnbindProcess + DestroyScope + tree cleanup

All 10 step assertions must match; scenario asserts `"passed":true`.
Uses scope_id=5 to avoid collision with 10b/10c/10d/10e.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-end-to-end", "--scope-id", "5", "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  # B.3b.1 → 60s: refcount acquire/release added spinlock CS on
  #   every PreCreate.
  # B.3c.1a → 120s: sync COW adds ~10 extra FltCreateFile calls
  #   per write (2 probes + ~8-deep parent-dir walk). Each FltCreateFile
  #   hits the full filter stack (Defender, bindflt, etc.) adding
  #   measurable seconds under VM contention. B.3c.1b (async COW via
  #   FltCompletePendedPreOperation) moves the work off PreCreate and
  #   removes this bottleneck. Until then, the timeout compensates.
  timeout_ms: 120000
```

## Step 10g: End-to-end REDIRECT_WRITE + PREFIX + COW (Phase B.3c.1a)

Phase B.3c.1a gate: proves the sync copy-on-write path works end-to-end.

Flow (executed by the `redirect-write-prefix-cow-end-to-end` subcommand):

  1. Seed a SOURCE file with a known marker ("COW-ORIGINAL-SOURCE-CONTENT")
  2. Create OVERLAY subdir (parent exists, leaf does not)
  3. Resolve NT paths → install REDIRECT_WRITE+PREFIX rule
  4. BindProcess (self)
  5. Open source path in APPEND mode + write "COW-APPENDED-AFTER-BIND".
     The driver fires `OspFs_PrepareCowForRedirect`:
       - probes overlay: STATUS_OBJECT_NAME_NOT_FOUND
       - probes source: STATUS_SUCCESS
       - EnsureOverlayParentDirs (already there, no-op)
       - CopyFileContents: source → overlay (27 bytes chunked via FltRead/FltWrite)
       - returns STATUS_SUCCESS
     PreCreate then does IoReplaceFileObjectName + STATUS_REPARSE.
     I/O mgr re-dispatches against overlay; the open succeeds at
     overlay with APPEND position past the copied content, so the
     caller's write lands AFTER the source bytes.
  6. Close handle
  7. Verify SOURCE file on disk is UNCHANGED (still 27 bytes of original marker)
  8. Verify OVERLAY file has SOURCE_MARKER + APPEND_MARKER (27 + 23 = 50 bytes)
     — proves COW populated the overlay with source content, AND the
     subsequent write appended on top.
  9. UnbindProcess + DestroyScope + cleanup

Uses scope_id=6 to avoid collision with earlier steps.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-cow-end-to-end",
         "--scope-id", "6",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  # B.3c.1a → 120s: see Step 10f's rationale (sync COW adds many
  # FltCreateFile calls per write that hit the full filter stack).
  # B.3c.1b (async COW) will bring this back to ~5s range.
  timeout_ms: 120000
```

## Step 10h: End-to-end REDIRECT_WRITE + PREFIX + COW torture (Phase B.3c.1a)

Concurrent companion to Step 10g. Seeds 32 source files (4 KiB each)
with unique content markers, installs a REDIRECT_WRITE+PREFIX rule,
binds self, spawns 8 workers that stripe-assign-touch disjoint file
subsets and append a per-worker marker to each. Every write triggers
COW. Post-join verification:

  * concurrent_cow_writes: zero I/O failures across all 32 writes
  * all_source_files_unchanged: byte-for-byte identical to pre-seeded
  * all_overlay_files_cow_plus_append: every overlay file contains
    exactly the source marker + the assigning worker's append marker
    (full byte-level comparison, not just size)

Stress vectors: concurrent OspFs_PrepareCowForRedirect invocations on
the same bound scope; OspFs_CopyFileContents chunked loop under
source-handle contention; IoSetTopLevelIrp sentinel per-thread; 'OfNa'
pool-tag alloc/free balance across N concurrent copies (clean driver
unload proves no leak).

Uses scope_id=7 (next after 10g's scope_id=6).

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-cow-torture",
         "--scope-id", "7",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp",
         "--file-count", "32",
         "--source-bytes", "4096",
         "--workers", "8"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  # Sync COW torture with 32 writes × ~10 FltCreateFile roundtrips
  # each = 320+ nested opens. Under B.3c.1a's sync model this can
  # take >2 minutes on a contended VM. B.3c.1b (async COW) will
  # drop this significantly by moving the copies off PreCreate.
  timeout_ms: 240000
```

## Step 10i: End-to-end REDIRECT_WRITE + PREFIX + READ-through (Phase B.3c.2)

Validates the read-through overlay semantic: reads of a source path
covered by a REDIRECT_WRITE+PREFIX rule see the overlay if it
exists, and pass through to the source if it doesn't. The scenario
exercises BOTH halves:

  * **Cold read** (overlay missing) — bound process opens source for
    read. Driver's Step 4a.2 (Phase B.3c.2) classifier matches
    REDIRECT_WRITE on READ intent, probes overlay, finds
    `STATUS_OBJECT_NAME_NOT_FOUND`, passes through. Caller reads
    source content unchanged.

  * **Warm read** (overlay populated) — bound process writes to
    source (triggers async COW), which populates the overlay. A
    subsequent read of the source path now returns overlay content
    via `STATUS_REPARSE` — the post-write state is visible without
    the caller explicitly targeting the overlay.

Post-flow verification (post-unbind so the filter doesn't interfere):
on-disk source file still has JUST its original marker (COW
preserved the pre-write content); overlay file has
SOURCE_MARKER + APPEND_MARKER. This proves the driver neither
corrupted the source nor silently discarded the append.

Uses scope_id=8 (next after 10h's scope_id=7).

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-read-through-end-to-end",
         "--scope-id", "8",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  # Single COW + 2 reads + 1 write. Under async COW (B.3c.1b) the
  # hot path stays off PreCreate; 60s is plenty of margin for the
  # read-through probe + redirect flow even under VM contention.
  timeout_ms: 60000
```

## Step 10j: End-to-end REDIRECT_WRITE + PREFIX + DIR-ENUM merge (Phase B.3c.3a.2)

Validates the basic directory-enumeration merge:

  * Source directory contains `{ A, B (4 bytes) }`.
  * Overlay directory contains `{ B (1024 bytes), C }`.
  * Bound process enumerates the source directory.
  * Expected merged listing: `{ A, B, C }` with B.size == 1024
    (overlay wins the B collision).
  * Post-unbind enumeration returns `{ A, B }` with B.size == 4
    (proves merge is scope-gated, not a universal transform).

Driver flow: PreCreate Step 4a.3 allocates `OSP_FS_DIRENUM_PENDING`
and returns `FLT_PREOP_SUCCESS_WITH_CALLBACK`. PostCreate opens the
overlay directory via `FltCreateFile(FILE_DIRECTORY_FILE)` and
attaches an `OSP_FS_DIRENUM_CTX` stream-handle context.
PreDirectoryControl detects the context, swallows the IRP, does two
internal `FltQueryDirectoryFile` calls (source via the caller's
FileObject; overlay via the stream-context's OverlayFileObject),
merges with overlay-wins collisions, and completes the IRP with
STATUS_SUCCESS.

Uses scope_id=9 (next after 10i's scope_id=8).

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-dir-enum-merge-basic",
         "--scope-id", "9",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  # Enum merge: 2 FltQueryDirectoryFile calls + 4-entry merge +
  # 2 user-mode read_dir calls. Fast operation; 60s is ample.
  timeout_ms: 60000
```

## Step 10k: End-to-end REDIRECT_WRITE + PREFIX + DIR-ENUM torture (Phase B.3c.3b)

Large-directory merge exercising multi-batch pagination:

  * Source directory: 500 unique (S_NNNN.txt) + 50 collision
    (X_NNNN.txt) = 550 source entries.
  * Overlay directory: 100 unique (O_NNNN.txt) + 50 collision
    (X_NNNN.txt) = 150 overlay entries. Collision X_* files in
    overlay are 30 bytes (contain the literal "OVERLAY_NNNN"
    with padding), while source's X_* are 6 bytes ("SOURCE").
  * Bound process enumerates the source directory. Expected:
    550 - 50 = 500 source-unique + 50 collision + 100 overlay-unique
    = **650 unique merged entries**. For every X_NNNN entry, size
    must be >= 30 bytes (overlay wins; source's 6-byte version is
    hidden).
  * Post-unbind: source-only view = 550 entries; every X_NNNN entry
    has size 6 (source wins when filter doesn't apply).

Driver flow exercised:
  * `OspFs_PopulateOverlayCache` grows the overlay-entry buffer via
    doubling allocation (16 KiB initial → 32 → 64 KiB to
    accommodate 150 overlay entries) on the first QueryDirectory.
  * Source-side streaming: multiple `FltQueryDirectoryFile` calls
    WITHOUT `SL_RESTART_SCAN` across successive QueryDirectory IRPs
    drain the 500 source-unique entries through Rust's internal
    `read_dir` buffer pagination.
  * Collision detection: X_NNNN entries in source are skipped in
    favor of the cached overlay entries, even when the source
    entry appears in batch N+1 and the cache was loaded at call 0.

Uses scope_id=10. Bumped timeout to 120s because seeding 700 files
+ enumerating them + post-unbind enum can take several seconds on
a contended VM.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-dir-enum-merge-torture",
         "--scope-id", "10",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp",
         "--source-unique-count", "500",
         "--collision-count", "50",
         "--overlay-unique-count", "100"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 120000
```

## Step 10l: End-to-end REDIRECT_WRITE + PREFIX + WHITEOUT (Phase B.3c.4)

Validates the whiteout delete-recreate lifecycle for bound processes
under a REDIRECT_WRITE+PREFIX scope:

  1. Seed source foo.txt with SOURCE_MARKER, overlay empty.
  2. Bind process.
  3. Bound `remove_file(source/foo.txt)` — driver flow:
     * CREATE w/ DELETE → COW to overlay → STATUS_REPARSE.
     * SetInformation(FileDisposition) — PreSetInformation
       detects overlay-namespace + delete, creates
       `overlay\.wh.foo.txt` marker.
     * FS deletes overlay/foo.txt on close.
  4. Bound enum of source: foo.txt NOT visible (dir-enum Phase 1
     hides `.wh.*` entries; Phase 2 hides source entries shadowed
     by a matching whiteout marker in overlay).
  5. Bound re-create `foo.txt` with RECREATED_MARKER → COW worker's
     clear-on-recreate deletes the marker → overlay has new file.
  6. Bound enum: foo.txt visible.
  7. Bound read: returns RECREATED_MARKER (via read-through).
  8. Unbind.
  9. Unbound source read: still SOURCE_MARKER (source untouched
     throughout — the whole point of the sandbox semantic).

Uses scope_id=11. 60s timeout — all operations are fast.

```tool
vm_run_command:
  vm: endpoint-1
  command: "C:\\Ospiri\\silo-fs-test.exe"
  args: ["redirect-write-prefix-whiteout-end-to-end",
         "--scope-id", "11",
         "--temp-dir", "C:\\Users\\aaron\\AppData\\Local\\Temp"]
  expect_exit_code: 0
  expect_stdout_regex: "\"passed\":true"
  timeout_ms: 60000
```

## Step 11: Unload the driver

```tool
driver_unload:
  service: ospiri
  expect_status: 0
  timeout_ms: 15000
```

Post-unload, FltUnregisterFilter drains in-flight callbacks; the
Instances regkey stays populated so the next scenario run skips the
reg-add steps.

## Step 12: Confirm minifilter detached

```tool
vm_run_command:
  vm: endpoint-1
  command: fltmc.exe
  args: ["filters"]
  expect_stdout_not_regex: "^ospiri"
  timeout_ms: 5000
```

Expected: `ospiri` is no longer in the filter list.

## Expected outcomes

| Step | Check                                                        | Expected                      |
| ---- | ------------------------------------------------------------ | ----------------------------- |
| 1    | sc start                                                     | exit 0, Running               |
| 2    | fltmc filters shows ospiri at 370000                         | match                         |
| 3    | GET_VERSION baseline                                         | STATUS_SUCCESS, 24B           |
| 4    | FS_INIT_SCOPE ScopeId=1                                      | STATUS_SUCCESS                |
| 5    | FS_INIT_SCOPE duplicate ScopeId                              | STATUS_OBJECT_NAME_COLLISION  |
| 6    | FS_ADD_RULE DENY_READ                                        | STATUS_SUCCESS                |
| 7    | FS_LIST_RULES returns 1 rule                                 | STATUS_SUCCESS                |
| 8    | Unscoped-process file I/O                                    | exit 0, FIO_OK                |
| 9    | FS_DESTROY_SCOPE                                             | STATUS_SUCCESS                |
| 10   | FS_DESTROY_SCOPE missing                                     | STATUS_NOT_FOUND              |
| 10b  | silo-fs-test end-to-end DENY_READ enforcement                | exit 0, `"passed":true`       |
| 10c  | silo-fs-test end-to-end DENY_WRITE enforcement               | exit 0, `"passed":true`       |
| 10d  | silo-fs-test PreSetInformation FileDispositionInfo enforcement | exit 0, `"passed":true`       |
| 10e  | silo-fs-test end-to-end REDIRECT_WRITE (EXACT) enforcement   | exit 0, `"passed":true`       |
| 10f  | silo-fs-test end-to-end REDIRECT_WRITE (PREFIX) enforcement  | exit 0, `"passed":true`       |
| 11   | sc stop                                                      | exit 0, Stopped               |
| 12   | ospiri absent from fltmc filters                             | no match                      |

A green run means:
  * The FS minifilter registers with FltMgr (step 2)
  * The 6 FS IOCTLs respond correctly (steps 4-7, 9-10)
  * Standard unbound file I/O is unaffected (step 8)
  * **DENY_READ enforcement actually denies reads from a bound PID**
    (step 10b) — Phase B.0 gate
  * **DENY_WRITE enforcement blocks CREATE-time + SET_INFORMATION
    rename/delete from a bound PID; reads still work** (step 10c) —
    Phase B.2 gate
  * **REDIRECT_WRITE + EXACT_PATH transparently rewrites a
    source-path write to the overlay path; source stays
    untouched** (step 10e) — Phase B.3a gate
  * **REDIRECT_WRITE + PREFIX_PATH rewrites an entire subtree
    with suffix preservation; source side never sees the file**
    (step 10f) — Phase B.3b gate
  * Unload is clean + complete (steps 11-12)
