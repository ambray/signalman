/**
 * Warm-probe — confirm the guest agent is actually responsive to RPC.
 *
 * TCP port being reachable (what signalman's `waitForGuestAgents`
 * checks) is necessary but not sufficient. On a cold-booted Win11
 * guest, PowerShell's first invocation can take 100+ seconds while
 * JIT warms up, integration services finish registering, etc. If a
 * scenario's first real command uses PowerShell, it hits this cold
 * start and may time out.
 *
 * This probe runs a trivial PowerShell command and measures wall-
 * clock latency. Use it:
 *
 *   - Before taking a warm-state checkpoint: confirm the guest is
 *     truly ready (elapsed < 3 s) so the saved state captures that
 *     readiness.
 *   - After restoring a warm checkpoint: confirm the warm state
 *     survived the save/restore cycle (elapsed < 3 s).
 *   - When a scenario flakes: decide whether the guest was actually
 *     ready or was still warming up.
 *
 * Usage:
 *
 *   npx tsx host/scripts/warm-probe.ts [host] [port]
 *
 *   host defaults to 172.30.0.10, port to 50051.
 */
import { GuestAgentClient } from "../src/guest/client.js";

(async () => {
  const host = process.argv[2] ?? "172.30.0.10";
  const port = Number(process.argv[3] ?? 50051);

  const c = new GuestAgentClient(host, port);
  const t0 = Date.now();
  const r = await c.runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Write-Output 'warm-probe-ok'; (Get-Service -Name vmicheartbeat,vmickvpexchange,vmicshutdown,vmictimesync,vmicguestinterface,vmicvss | Where-Object Status -ne 'Running' | Measure-Object).Count",
    ],
    { timeoutMs: 180_000, runAs: "SYSTEM" },
  );
  const elapsed = Date.now() - t0;
  console.log(`elapsed_ms: ${elapsed}`);
  console.log(`exit: ${r.exitCode}`);
  console.log(`stdout: ${r.stdout.trim()}`);
  console.log(`stderr: ${r.stderr.trim()}`);

  // Heuristic: < 3000 ms = warm, 3000..30000 = marginal, >= 30000 = cold.
  if (elapsed < 3_000) {
    console.log(`verdict: WARM (${elapsed} ms) — safe to take a warm checkpoint`);
    process.exit(0);
  } else if (elapsed < 30_000) {
    console.log(`verdict: MARGINAL (${elapsed} ms) — give the guest more time before checkpointing`);
    process.exit(2);
  } else {
    console.log(`verdict: COLD (${elapsed} ms) — still JIT-warming; do not checkpoint yet`);
    process.exit(3);
  }
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
