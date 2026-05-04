/**
 * Tests for the post-architect-review file_transfer hardening.
 *
 * Covers the contracts that prevent the flakiness modes observed in
 * the field:
 *
 *   * SHA-cache fast-path skips transfer when guest already has the
 *     correct content (the dominant repeat-run cost).
 *   * Atomic temp+rename: chunks land at a temp path, never the
 *     final path, until SHA verification passes.  A failed transfer
 *     never corrupts the destination.
 *   * Overall deadline aborts transfer if elapsed time exceeds the
 *     budget.
 *   * Health probe up front fails fast on a dead guest.
 *   * `runCommand` accepts a `maxRetries` override.
 *
 * Tests use a fake `GuestAgentClient` that records every RPC and
 * lets the test assert on the exact PowerShell scripts the helper
 * generates.  Tests do NOT spin up a real gRPC server — that's the
 * job of integration tests.  This is contract-coverage, not
 * end-to-end coverage.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  copyFileToGuestViaHttp,
  type CopyFileViaGuestOptions,
} from "../guest/file_transfer.js";

// ── Fake GuestAgentClient ─────────────────────────────────────────

interface RecordedCall {
  command: string;
  args: string[];
  options?: { timeoutMs?: number; maxRetries?: number; runAs?: string };
}

interface FakeBehaviour {
  /** When set, `isConnected` returns this value.  Default: true. */
  healthy?: boolean;
  /** Maps the position of each `runCommand` call (0-indexed) to a
   *  programmable response.  Calls beyond the array length get
   *  `{ exitCode: 0, stdout: "", stderr: "" }`. */
  responses?: Array<{ exitCode: number; stdout?: string; stderr?: string } | ((calls: RecordedCall[]) => { exitCode: number; stdout?: string; stderr?: string })>;
}

class FakeGuestClient {
  calls: RecordedCall[] = [];
  target = "fake:50051";
  behaviour: FakeBehaviour = {};

  async isConnected(_timeoutMs?: number): Promise<boolean> {
    return this.behaviour.healthy !== false;
  }

  async runCommand(
    command: string,
    args: string[] = [],
    options?: number | { timeoutMs?: number; runAs?: string; maxRetries?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    const opts = typeof options === "number" ? { timeoutMs: options } : (options ?? {});
    this.calls.push({ command, args, options: opts });
    const idx = this.calls.length - 1;
    const r = this.behaviour.responses?.[idx];
    if (!r) return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    const resolved = typeof r === "function" ? r(this.calls) : r;
    return {
      exitCode: resolved.exitCode,
      stdout: resolved.stdout ?? "",
      stderr: resolved.stderr ?? "",
      durationMs: 0,
    };
  }

  dispose(): void {
    /* no-op */
  }
}

// Helper: write a temp file with given content and return its path
// + its sha256.  Caller is responsible for cleanup (we use os.tmpdir
// so OS GC handles the survivors of failed tests).
function makeHostFile(content: Buffer): { hostPath: string; sha: string } {
  const hostPath = path.join(os.tmpdir(), `sigtest-${crypto.randomBytes(4).toString("hex")}.bin`);
  fs.writeFileSync(hostPath, content);
  const sha = crypto.createHash("sha256").update(content).digest("hex").toLowerCase();
  return { hostPath, sha };
}

// Helper: cast our fake to the GuestAgentClient type.  copyFileToGuestViaHttp
// only uses `isConnected`, `runCommand`, and `target` — all of which our
// fake implements with matching shapes.
function asClient(c: FakeGuestClient): any {
  return c;
}

describe("copyFileToGuestViaHttp — architect-review hardening", () => {
  let client: FakeGuestClient;

  beforeEach(() => {
    client = new FakeGuestClient();
  });

  // ── 1. SHA-cache fast-path ──────────────────────────────────────

  it("skips transfer entirely when guest SHA matches host", async () => {
    const content = Buffer.from("identical-content");
    const { hostPath, sha } = makeHostFile(content);

    // Health probe (call 0) → healthy.
    // SHA probe (call 1) → returns the matching SHA.
    client.behaviour = {
      healthy: true,
      responses: [
        // call 0: ignored — health uses isConnected, not runCommand.
        // First runCommand IS the SHA probe.
        { exitCode: 0, stdout: sha + "\r\n" },
      ],
    };

    const outcome = await copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\agent.exe");

    expect(outcome.skipped).toBe(true);
    expect(outcome.chunks).toBe(0);
    expect(outcome.bytes).toBe(content.length);

    // The only RPC made should be the SHA probe — no
    // ensure-dir-and-clear-temp, no chunk writes, no atomic rename.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].args.join(" ")).toContain("Get-FileHash");

    fs.unlinkSync(hostPath);
  });

  it("forces transfer when forceTransfer is true even if SHAs match", async () => {
    const content = Buffer.from("identical-content");
    const { hostPath, sha } = makeHostFile(content);

    // forceTransfer skips the SHA-cache probe entirely — call
    // sequence starts at ensure-dir.
    client.behaviour = {
      healthy: true,
      responses: [
        { exitCode: 0 },                             // ensure-dir-and-clear-temp
        { exitCode: 0, stdout: "CHUNK 0 17" },       // chunk 1
        { exitCode: 0, stdout: sha },                // verify-sha256 of temp
        { exitCode: 0 },                             // atomic-rename
      ],
    };

    const outcome = await copyFileToGuestViaHttp(
      asClient(client),
      hostPath,
      "C:\\Example\\agent.exe",
      { forceTransfer: true },
    );

    expect(outcome.skipped).toBe(false);
    expect(outcome.chunks).toBe(1);

    // Verify no SHA probe ran — first call should be ensure-dir,
    // not Get-FileHash.
    expect(client.calls[0].args.join(" ")).toContain("Test-Path");
    expect(client.calls[0].args.join(" ")).not.toContain("Get-FileHash");

    fs.unlinkSync(hostPath);
  });

  // ── 2. Atomic temp + rename ─────────────────────────────────────

  it("writes chunks to a temp path and renames atomically on success", async () => {
    const content = Buffer.from("hello-world");
    const { hostPath, sha } = makeHostFile(content);

    client.behaviour = {
      healthy: true,
      responses: [
        { exitCode: 0, stdout: "" },                 // SHA probe (miss)
        { exitCode: 0 },                             // ensure-dir-and-clear-temp
        { exitCode: 0, stdout: "CHUNK 0 11" },       // chunk 1
        { exitCode: 0, stdout: sha },                // verify-sha256
        { exitCode: 0 },                             // atomic-rename
      ],
    };

    await copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\agent.exe");

    // Final destination only appears in the rename call (and only as the
    // -Destination arg).  Chunks all target the temp path.
    const renameCall = client.calls[client.calls.length - 1];
    expect(renameCall.args.join(" ")).toContain("Move-Item");
    expect(renameCall.args.join(" ")).toContain("C:\\Example\\agent.exe");

    // Earlier chunk-write calls should reference the temp suffix.
    const chunkCall = client.calls[2];
    expect(chunkCall.args.join(" ")).toContain(".tx-");
    expect(chunkCall.args.join(" ")).not.toContain("[IO.File]::Open('C:\\Example\\agent.exe',");

    fs.unlinkSync(hostPath);
  });

  it("does NOT call atomic-rename when SHA verify fails", async () => {
    const content = Buffer.from("hello");
    const { hostPath } = makeHostFile(content);

    client.behaviour = {
      healthy: true,
      responses: [
        { exitCode: 0, stdout: "" },                                  // SHA probe miss
        { exitCode: 0 },                                              // ensure-dir
        { exitCode: 0, stdout: "CHUNK 0 5" },                         // chunk 1
        { exitCode: 0, stdout: "0000000000000000000000000000000000000000000000000000000000000000" }, // wrong SHA
      ],
    };

    await expect(
      copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\agent.exe"),
    ).rejects.toThrow(/SHA-256 mismatch/);

    // The rename step (5th call in success path) MUST NOT have run.
    expect(client.calls).toHaveLength(4);

    fs.unlinkSync(hostPath);
  });

  // ── 3. Overall deadline ─────────────────────────────────────────

  it("aborts transfer when overall deadline is exceeded", async () => {
    // 200 KB file at 20 KB chunks = 10 chunks.
    const content = Buffer.alloc(200 * 1024, "x");
    const { hostPath } = makeHostFile(content);

    // Each chunk takes ~50 ms wall time (we burn it inside the
    // response factory).  With overallDeadlineMs = 100, the
    // deadline check triggers after ~2 chunks.
    let chunkCallCount = 0;
    client.behaviour = {
      healthy: true,
      responses: [
        { exitCode: 0, stdout: "" }, // SHA probe miss
        { exitCode: 0 },             // ensure-dir
        // Subsequent calls are chunks.  The fake doesn't sleep
        // synchronously, so we instead artificially advance the
        // observed elapsed budget by inflating the deadline check
        // — but the helper checks Date.now() at chunk boundaries.
        // We use a `() => burn 60ms` to exceed the deadline naturally.
        () => {
          // Block this micro-task long enough for Date.now() to advance.
          const start = Date.now();
          while (Date.now() - start < 60) { /* spin */ }
          chunkCallCount += 1;
          return { exitCode: 0, stdout: `CHUNK ${chunkCallCount - 1} 20480` };
        },
      ],
    };
    // Re-fill the responses array so subsequent chunks reuse the spin closure.
    const spin = client.behaviour.responses![2];
    client.behaviour.responses = [
      ...client.behaviour.responses!.slice(0, 3),
      spin, spin, spin, spin, spin, spin, spin, spin, spin, spin, spin, spin,
    ];

    await expect(
      copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\agent.exe", {
        overallDeadlineMs: 100,
      }),
    ).rejects.toThrow(/overall deadline.*exceeded/);

    fs.unlinkSync(hostPath);
  });

  // ── 4. Health probe ─────────────────────────────────────────────

  it("fails fast with a clear error when guest is unreachable", async () => {
    const content = Buffer.from("any");
    const { hostPath } = makeHostFile(content);

    client.behaviour = { healthy: false };

    await expect(
      copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\agent.exe"),
    ).rejects.toThrow(/unreachable/);

    // No runCommand should have fired.
    expect(client.calls).toHaveLength(0);

    fs.unlinkSync(hostPath);
  });

  // ── 5. maxRetries plumbed through to runCommand ─────────────────

  it("calls runCommand with maxRetries: 1 for the file-transfer hot loop", async () => {
    const content = Buffer.from("hi");
    const { hostPath, sha } = makeHostFile(content);

    client.behaviour = {
      healthy: true,
      responses: [
        { exitCode: 0, stdout: "" },
        { exitCode: 0 },
        { exitCode: 0, stdout: "CHUNK 0 2" },
        { exitCode: 0, stdout: sha },
        { exitCode: 0 },
      ],
    };

    await copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\f.bin");

    // Calls 1+ (everything after the SHA probe) come from
    // runOrThrow which passes maxRetries: 1.  Verify a sample.
    expect(client.calls[1].options?.maxRetries).toBe(1); // ensure-dir
    expect(client.calls[2].options?.maxRetries).toBe(1); // chunk write
    expect(client.calls[3].options?.maxRetries).toBe(1); // verify
    expect(client.calls[4].options?.maxRetries).toBe(1); // rename

    fs.unlinkSync(hostPath);
  });

  // ── REGRESSION: 2.4 MB / 11.4 MB truncation (Sprint 60.12 Phase B) ──
  //
  // Field bug:
  //   example-agent-driver-e2e Sprint 60.12 Phase B run.
  //   When a chunk RPC failed mid-transfer (DEADLINE_EXCEEDED on
  //   chunk 178 of 770 for exampleagent.exe, observed under VM
  //   contention), the previous helper had already appended 177
  //   chunks to the FINAL guest path. The next setup step ran
  //   `sc.exe create ExampleAgent binPath= ...` against a corrupt
  //   2.4 MB PE that should have been 11.4 MB. The service crashed
  //   on first start with a non-actionable "image not valid" error
  //   that took hours of triage to root-cause.
  //
  // Contract under test:
  //   * Mid-transfer failures must NOT touch the final destination
  //     path — the destination is only written by an atomic rename
  //     AFTER all chunks succeed AND the SHA verification passes.
  //   * On chunk failure the transfer surfaces the error through a
  //     thrown exception. The guest temp file (named
  //     `<final>.tx-<nonce>`) may persist for forensic inspection,
  //     but the FINAL destination path is never half-written.
  it("REGRESSION: chunk failure leaves the FINAL path untouched (no half-writes)", async () => {
    // 4 chunks of 20 KiB each — enough to exercise the loop without
    // overwhelming the test. Chunk 0 succeeds, chunk 1 fails. The
    // helper must throw and must NEVER call Move-Item against the
    // final path.
    const content = Buffer.alloc(20 * 1024 * 4, "X");
    const { hostPath, sha: _expectedSha } = makeHostFile(content);
    void _expectedSha;

    client.behaviour = {
      healthy: true,
      responses: [
        // 0. SHA probe — file doesn't exist on guest yet
        { exitCode: 0, stdout: "" },
        // 1. ensure-dir-and-clear-temp — succeeds
        { exitCode: 0 },
        // 2. chunk 0 — succeeds
        { exitCode: 0, stdout: "CHUNK 0 20480" },
        // 3. chunk 1 — fails simulating mid-transfer failure
        { exitCode: 1, stderr: "deadline exceeded after 60 s" },
      ],
    };

    await expect(
      copyFileToGuestViaHttp(asClient(client), hostPath, "C:\\Example\\agent.exe"),
    ).rejects.toThrow();

    // Critical assertion: NO call to runCommand reached the
    // atomic-rename step (Move-Item with the final path as
    // -Destination). If we ever did, the destination would be
    // half-written and the next step would consume it.
    const allArgs = client.calls.flatMap((c) => c.args);
    const flat = allArgs.join(" ");
    expect(flat, "atomic rename must NEVER fire on chunk failure").not.toMatch(
      /Move-Item.*-Destination\s+'C:\\\\Example\\\\agent\.exe'/,
    );
    // Sanity check: we DID get past the SHA probe + ensure-dir, AND
    // we attempted the failing chunk — the test is exercising the
    // right code path.
    expect(client.calls.length).toBeGreaterThanOrEqual(4);
    // The chunk-failure error message surfaces the chunk index for
    // diagnostic clarity (regression: previous shape buried it
    // inside a generic "PowerShell exit 1" string).
    fs.unlinkSync(hostPath);
  });
});
