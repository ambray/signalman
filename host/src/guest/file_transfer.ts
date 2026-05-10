/**
 * File transfer helper for `pre_started: true` VMs.
 *
 * # Why this exists
 *
 * signalman no longer auto-elevates via gsudo, so the Hyper-V
 * `Copy-VMFile` cmdlet (which `HypervBackend.copyFileToVM` relies on)
 * isn't available to unprivileged host-CLI runs.  When a scenario
 * marks all VMs as `pre_started: true`, the orchestrator skips
 * Hyper-V entirely and uses this helper for any
 * `vm_copy_file: host_to_guest` step.
 *
 * # Reliability contract (post-architect-review hardening)
 *
 * The earlier shape of this helper had five reliability gaps that the
 * caller paid for in scenario flakiness:
 *
 *   1. **No SHA fast-path** — every scenario re-uploaded identical
 *      11 MB binaries.  Single 11 MB transfer ≈ 770 chunks ≈ 2 min
 *      best case, 16 min worst case under retry pressure.
 *
 *   2. **Non-atomic destination** — chunks appended directly to the
 *      final guest path.  A mid-transfer failure left a corrupt
 *      partial file (root cause of the observed 2.4 MB truncation),
 *      and the next setup step (agent install / sc start) ran on
 *      that corrupt PE silently.
 *
 *   3. **No overall deadline** — `withRetry` stacks per-chunk
 *      retries with exponential backoff (4 × 60 s = 4 min per chunk
 *      on a single transient failure), turning one bad chunk into a
 *      multi-minute hang.  The transfer would keep "making progress"
 *      while no useful work happened.
 *
 *   4. **Unbounded retry on `DEADLINE_EXCEEDED`** — a timeout means
 *      the call is still in-flight on the server; retrying makes the
 *      guest do duplicate work and amplifies pressure.  We now cap
 *      retries to 1 for the file-transfer hot loop.
 *
 *   5. **No fail-fast on dead guest** — if the guest gRPC channel
 *      went bad (signalman-guest crashed, network blip), the
 *      transfer would slowly accumulate timeouts instead of failing
 *      in 5 seconds with a clear "guest unreachable" error.
 *
 * The post-review shape addresses each:
 *
 *   1. **SHA-cache fast-path**: hash the source, query the guest's
 *      file SHA via `Get-FileHash`, no-op if they match.  Repeat
 *      runs of the same scenario complete in <2 s for unchanged
 *      binaries (was 12+ min).
 *
 *   2. **Atomic temp + rename**: chunks append to
 *      `<final>.tx-<nonce>`.  After all chunks succeed and SHA
 *      verifies, `Move-Item -Force` replaces the destination.  The
 *      final path is NEVER half-written.  Failed transfers leave
 *      the temp file for forensic inspection unless explicitly
 *      cleaned up (caller policy).
 *
 *   3. **Overall deadline**: tracks elapsed time across all chunks.
 *      Aborts with a clear "transfer exceeded N min" error if the
 *      total transfer hasn't completed in `overallDeadlineMs`
 *      (default 10 min).
 *
 *   4. **Bounded retry**: each chunk's `runCommand` runs with
 *      `maxRetries: 1` (one retry on transient failure, then
 *      surface the error).
 *
 *   5. **Health probe**: a 5-second `health()` call up front fails
 *      fast with a clear error if the guest's gRPC isn't responding.
 *
 * # Wire shape (unchanged)
 *
 * Each chunk is a `RunCommand` invoking PowerShell with the
 * base64-encoded chunk inlined into the script body.  PowerShell
 * decodes the base64 and appends the bytes to the temp file via
 * `[IO.File]::Open(..., FileMode::Append)`.
 *
 * # Tradeoffs
 *
 *   * No firewall / Hyper-V Integration Services dependency.
 *   * Slower than `Copy-VMFile` for large unchanged files (mitigated
 *     by the SHA fast-path) and for cold first-time transfers.
 *   * SHA-256 is overkill for collision-defence on a single transfer,
 *     but it's the same hash the verify step uses, so we get the
 *     fast-path "for free" by reusing the existing
 *     `Get-FileHash -Algorithm SHA256` invocation.
 *
 * # Security
 *
 * Assumes the guest agent already trusts the calling host (gRPC
 * mTLS or `--allow-insecure` on a private switch).  No new
 * authorisation surface is introduced.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";

import type { GuestAgentClient } from "./client.js";

/** Chunk size for base64-over-gRPC transfer.  Constrained by the
 *  Windows `CreateProcess` command-line ceiling of 32,767 characters:
 *  the agent spawns `powershell.exe` with our base64-encoded chunk as
 *  one argv entry, and the entire command line (script + b64 arg +
 *  flags + powershell.exe path) must fit.  Base64 expands by ~1.37x,
 *  so 20 KiB raw → ~28 KiB encoded leaves ~4 KiB headroom for the
 *  PowerShell wrapper. */
const DEFAULT_CHUNK_BYTES = 20 * 1024; // 20 KiB raw → ~28 KiB base64

/** Default overall transfer deadline.  10 min is generous for a
 *  12 MB transfer on a healthy gRPC channel; if we hit this ceiling
 *  the channel is almost certainly degraded and the operator should
 *  see a clear error rather than wait through indefinite retry
 *  stacking. */
const DEFAULT_OVERALL_DEADLINE_MS = 10 * 60 * 1000;

/** Default health-probe deadline.  Short by design: if `health()`
 *  doesn't return in 5 seconds the guest is essentially gone, and
 *  we want the transfer to surface that immediately rather than
 *  burying it in chunk timeouts. */
const DEFAULT_HEALTH_PROBE_MS = 5_000;

/** Default per-chunk RPC timeout.  Generous for a 20 KiB chunk on a
 *  cold-cache guest (PowerShell start-up + base64 decode + file
 *  write); tight enough that hung chunks bail before they snowball. */
const DEFAULT_CHUNK_TIMEOUT_MS = 60_000;

export interface CopyFileViaGuestOptions {
  /** Per-chunk RPC timeout in milliseconds.  Default: 60_000. */
  timeoutMs?: number;
  /** Override the chunk size for tuning / testing.  Must be > 0 and
   *  ≤ 20 KiB (Windows command-line ceiling). */
  chunkBytes?: number;
  /** Overall transfer deadline (chunks + verify + atomic rename).
   *  Default: 600_000 (10 min).  Aborts with a clear error if the
   *  transfer hasn't completed in this window — prevents per-chunk
   *  retry stacking from hiding a degraded gRPC channel behind a
   *  multi-minute hang. */
  overallDeadlineMs?: number;
  /** Skip the SHA-cache fast-path (always re-upload).  Default
   *  `false`.  Only set this when you specifically want to bypass
   *  the cache (e.g., debugging a corrupted-write theory).  In
   *  normal scenario-loop use the fast-path is the largest single
   *  contributor to repeat-run speed: 12 min → 2 s. */
  forceTransfer?: boolean;
}

/**
 * Copy a file from the host to a guest using chunked base64 over the
 * existing guest gRPC channel.
 *
 * # Returns
 *
 * Resolves with a `TransferOutcome` describing what happened
 * ("skipped — destination already had this content" vs "transferred N
 * chunks").  Useful for scenario logs and tests.
 *
 * # Throws
 *
 *   * `hostPath` not found / not readable
 *   * Guest unreachable (5 s health-probe timeout)
 *   * `RunCommand` non-zero exit on any chunk after one retry
 *   * SHA-256 mismatch between the host source and the assembled
 *     guest temp file
 *   * Overall transfer exceeded `overallDeadlineMs`
 *
 * On any failure the temp file (`<final>.tx-<nonce>`) may be left on
 * the guest for forensics; the FINAL `guestPath` is never partially
 * written.
 */
export async function copyFileToGuestViaHttp(
  client: GuestAgentClient,
  hostPath: string,
  guestPath: string,
  opts: CopyFileViaGuestOptions = {},
): Promise<TransferOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const overallDeadlineMs = opts.overallDeadlineMs ?? DEFAULT_OVERALL_DEADLINE_MS;
  const forceTransfer = opts.forceTransfer ?? false;

  if (chunkBytes <= 0 || chunkBytes > 20 * 1024) {
    throw new Error(
      `copyFileToGuestViaHttp: chunkBytes ${chunkBytes} out of range (1..20480) — ` +
      `larger chunks exceed the Windows CreateProcess command-line ceiling`,
    );
  }

  // Validate the source up front so the error doesn't come back via
  // PowerShell stderr through the guest-agent stack.
  const stat = fs.statSync(hostPath);
  if (!stat.isFile()) {
    throw new Error(
      `copyFileToGuestViaHttp: source is not a regular file: ${hostPath}`,
    );
  }
  const expectedBytes = stat.size;
  const expectedSha = await sha256OfFile(hostPath);

  // ── 1. Fail fast if the guest is unreachable ────────────────────
  //
  // health() is the cheapest possible RPC.  If it doesn't return in
  // 5 s we know the guest is gone (signalman-guest crashed, network
  // blip, VM rebooted) and the only honest answer is "we can't do
  // this" — don't burn 10 minutes of chunk timeouts to find out.
  const healthy = await client.isConnected(DEFAULT_HEALTH_PROBE_MS);
  if (!healthy) {
    throw new Error(
      `copyFileToGuestViaHttp: guest at ${client.target} is unreachable ` +
      `(health probe timed out after ${DEFAULT_HEALTH_PROBE_MS} ms)`,
    );
  }

  const safeGuestPath = escapeForPSSingleQuote(guestPath);

  // ── 2. SHA-cache fast-path ──────────────────────────────────────
  //
  // The single biggest contributor to repeat-run speed.  When the
  // scenario re-uploads an unchanged 11 MB binary, the chunked
  // transfer takes 2-12 minutes; the SHA query takes <1 s.  Only
  // skipped when the caller explicitly opts out via `forceTransfer`.
  if (!forceTransfer) {
    const guestSha = await tryGetGuestFileSha(client, safeGuestPath, timeoutMs);
    if (guestSha === expectedSha) {
      return {
        skipped: true,
        bytes: expectedBytes,
        chunks: 0,
        elapsedMs: 0,
      };
    }
  }

  // ── 3. Atomic temp-file write ───────────────────────────────────
  //
  // Chunks append to `<final>.tx-<nonce>`.  On all-chunks-success +
  // SHA-verify, an atomic `Move-Item -Force` replaces the final
  // path.  The final path is NEVER half-written.
  const nonce = crypto.randomBytes(8).toString("hex");
  const tmpGuestPath = `${guestPath}.tx-${nonce}`;
  const safeTmpGuestPath = escapeForPSSingleQuote(tmpGuestPath);

  // Ensure the parent directory exists and pre-clean any stale temp
  // (from a previous abandoned transfer with the same nonce — vanishingly
  // unlikely but cheap to guard against).
  await runOrThrow(
    client,
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // Newline-joined (not `; `-joined) so the script's PS-statement
      // separators don't trip signalman-guest's S-06 metacharacter
      // guard (which denies args containing `;`, `|`, or `&`).
      // PowerShell treats `\n` as a statement terminator equivalent
      // to `;`, so the semantics are identical.  Sticking to `\n`
      // here also avoids the host-side `-EncodedCommand` auto-rewrite
      // (see GuestAgentClient.runCommand), which would double-encode
      // the chunk body via UTF-16-LE base64 and blow past Windows'
      // 32 KiB command-line limit (ERROR_FILENAME_EXCED_RANGE / 206)
      // for the chunk-write script below.
      [
        "$ProgressPreference = 'SilentlyContinue'",
        "$ErrorActionPreference = 'Stop'",
        `$dir = Split-Path -Path '${safeTmpGuestPath}' -Parent`,
        "if ($dir) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }",
        `if (Test-Path -LiteralPath '${safeTmpGuestPath}') { Remove-Item -LiteralPath '${safeTmpGuestPath}' -Force }`,
        "exit 0",
      ].join("\n"),
    ],
    timeoutMs,
    "ensure-dir-and-clear-temp",
    1,
  );

  // ── 4. Stream chunks with overall deadline ──────────────────────
  const overallStart = Date.now();
  const fd = fs.openSync(hostPath, "r");
  let chunksWritten = 0;
  let totalChunks = 0;
  try {
    const buf = Buffer.alloc(chunkBytes);
    let offset = 0;
    let chunkIndex = 0;
    totalChunks = Math.ceil(expectedBytes / chunkBytes);
    while (offset < expectedBytes) {
      // Overall-deadline check happens at chunk boundaries — granular
      // enough that operators get a meaningful "transferred N/M of K
      // bytes before deadline" diagnostic and don't watch the
      // transfer chew through retry-amplified per-chunk hangs.
      const elapsed = Date.now() - overallStart;
      if (elapsed > overallDeadlineMs) {
        throw new Error(
          `copyFileToGuestViaHttp: overall deadline (${overallDeadlineMs} ms) ` +
          `exceeded after ${chunkIndex}/${totalChunks} chunks (${offset}/${expectedBytes} bytes); ` +
          `temp file '${tmpGuestPath}' may persist on the guest for forensics`,
        );
      }

      const want = Math.min(chunkBytes, expectedBytes - offset);
      const got = fs.readSync(fd, buf, 0, want, offset);
      if (got === 0) break;
      const slice = buf.slice(0, got);
      const b64 = slice.toString("base64");
      // Inline the b64 in the script body — PowerShell `-Command`
      // appends extra argv entries to the script as trailing
      // expressions which would emit the b64 as a literal-string
      // result and exit 1.  See architect-review note in module
      // doc-comment.
      // Newline-joined: see comment in the setup script above. The
      // base64 chunk body alone is ~28 KiB; if we used `; `-joined
      // statements the host-side -EncodedCommand rewrite would fire
      // (because of the `;`) and double-encode the chunk via
      // UTF-16-LE base64, exploding to ~75 KiB and tripping
      // Windows' 32 KiB command-line ceiling.  `\n` separators
      // are statement terminators in PowerShell and don't trip the
      // guard, so the original wire shape (one runCommand per
      // chunk, raw base64 inlined) survives.
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        "$ErrorActionPreference = 'Stop'",
        `$bytes = [Convert]::FromBase64String('${b64}')`,
        `$fs = [IO.File]::Open('${safeTmpGuestPath}', [IO.FileMode]::Append)`,
        "try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }",
        `Write-Output ('CHUNK ${chunkIndex} ' + $bytes.Length)`,
      ].join("\n");
      const t0 = Date.now();
      // maxRetries: 1 — see module doc-comment.  3 retries × 60 s
      // backoff was the largest single contributor to retry-storm
      // hangs in the prior shape.
      await runOrThrow(
        client,
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        timeoutMs,
        `chunk ${chunkIndex + 1}/${totalChunks}`,
        1,
      );
      if (process.env.SIGNALMAN_FILETX_VERBOSE) {
        const elapsedChunk = Date.now() - t0;
        console.error(
          `[file_transfer] chunk ${chunkIndex + 1}/${totalChunks} ` +
          `(${got} bytes) in ${elapsedChunk}ms`,
        );
      }
      offset += got;
      chunkIndex += 1;
      chunksWritten = chunkIndex;
    }
  } finally {
    fs.closeSync(fd);
  }

  // ── 5. Verify SHA on temp + atomic rename to final ─────────────
  const verifyOut = await runOrThrow(
    client,
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-FileHash -Path '${safeTmpGuestPath}' -Algorithm SHA256).Hash`,
    ],
    timeoutMs,
    "verify-sha256",
    1,
  );
  const tmpSha = (verifyOut.stdout ?? "").trim().toLowerCase();
  if (tmpSha !== expectedSha) {
    throw new Error(
      `copyFileToGuestViaHttp: SHA-256 mismatch on temp '${tmpGuestPath}' — ` +
      `expected ${expectedSha}, got '${tmpSha}'.  Temp file preserved on guest for forensics.`,
    );
  }

  // Atomic rename.  `Move-Item -Force` overwrites the destination
  // even if it exists.  On Windows this is a single-syscall rename
  // when source + destination are on the same volume (ours always
  // are since temp is a sibling of final).
  await runOrThrow(
    client,
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // `\n` not `;` between Move-Item and exit so signalman-guest's
      // S-06 metachar guard doesn't reject the arg.
      `Move-Item -LiteralPath '${safeTmpGuestPath}' -Destination '${safeGuestPath}' -Force\nexit 0`,
    ],
    timeoutMs,
    "atomic-rename",
    1,
  );

  return {
    skipped: false,
    bytes: expectedBytes,
    chunks: chunksWritten,
    elapsedMs: Date.now() - overallStart,
  };
}

/** Outcome of a `copyFileToGuestViaHttp` call.  Surfaced so callers
 *  (and test harnesses) can distinguish a fast-path no-op from a
 *  real transfer. */
export interface TransferOutcome {
  /** True when the SHA-cache fast-path matched and no chunks moved. */
  skipped: boolean;
  /** Bytes the destination should hold (file size on disk). */
  bytes: number;
  /** Number of chunks actually transferred (0 when skipped). */
  chunks: number;
  /** Wall-clock from health-probe to atomic-rename completion (ms).
   *  Useful for budgeting scenario timeouts. */
  elapsedMs: number;
}

// ── Internal helpers ─────────────────────────────────────────────

/** Escape a string for inclusion in a PowerShell single-quoted literal. */
function escapeForPSSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Run a `RunCommand` on the guest and throw on non-zero exit.
 *  `maxRetries` defaults to 3 (the client's standard) but
 *  file-transfer callers pass 1 to avoid retry-storm hangs. */
async function runOrThrow(
  client: GuestAgentClient,
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
  maxRetries?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await client.runCommand(command, args, { timeoutMs, maxRetries });
  if (result.exitCode !== 0) {
    throw new Error(
      `copyFileToGuestViaHttp [${label}]: exit ${result.exitCode}: ` +
      `${(result.stderr ?? "").trim() || (result.stdout ?? "").trim()}`,
    );
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Try to read the SHA-256 of a file on the guest.  Returns the
 *  lowercase hex digest if the file exists and is readable, or
 *  `null` if it doesn't exist / is unreadable.  Never throws — a
 *  cache miss should not cascade.  `maxRetries: 1` keeps the probe
 *  fast even on a flaky channel. */
async function tryGetGuestFileSha(
  client: GuestAgentClient,
  safeGuestPath: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const result = await client.runCommand(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Returns the SHA on stdout when the file exists, or empty
        // when it doesn't.  The `Test-Path` gate avoids a noisy
        // `Get-FileHash` error on a missing file (which would still
        // exit 0 but pollute stderr).
        `if (Test-Path -LiteralPath '${safeGuestPath}') { (Get-FileHash -LiteralPath '${safeGuestPath}' -Algorithm SHA256).Hash }`,
      ],
      { timeoutMs, maxRetries: 1 },
    );
    if (result.exitCode !== 0) return null;
    const hex = (result.stdout ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    return hex;
  } catch {
    return null;
  }
}

/** Compute the SHA-256 of a file on disk, streaming so we don't peak
 *  RAM at the file size for large agent binaries.  Returns the lower-
 *  case hex digest. */
function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (c: string | Buffer) => {
      hash.update(typeof c === "string" ? Buffer.from(c) : c);
    });
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}
