/**
 * WS6 M9 — wait for a freshly-deployed runner to heartbeat.
 *
 * After a transport bootstraps a runner on a remote host, the
 * runner's worker loop should heartbeat the control plane within
 * its normal cadence (default 30s). This module polls the
 * `runners` table until the named worker shows up with a recent
 * `last_seen_at` timestamp — or times out.
 *
 * Why this matters: bootstrap-vs-running is a real gap. A
 * successful `ssh + scp + systemctl start` can return success while
 * the systemd unit fails to start (bad config path, missing dep,
 * etc.). Heartbeat verification turns a "successful bootstrap"
 * into a "successfully running" signal end-to-end.
 *
 * The verification can be disabled via `waitTimeoutMs: 0` for the
 * `script` transport (where the operator runs the script later)
 * or for "fire and forget" semantics.
 */

import type { ControlPlane } from "../../control-plane/index.js";

export interface WaitForHeartbeatOptions {
  /** Worker name to watch for. */
  workerName: string;
  /** Org context. */
  orgId: string;
  /** Total budget. 0 disables verification. Default 60_000ms. */
  waitTimeoutMs?: number;
  /** Poll cadence. Default 2_000ms. */
  pollIntervalMs?: number;
  /**
   * Wall-clock cutoff: a heartbeat older than this is NOT acceptance.
   * Lets us distinguish "this runner registered AGES ago" from "this
   * runner just heartbeated after bootstrap." Default: bootstrap
   * start time minus 1s slack.
   */
  freshAfter?: Date;
  /** Injectable now-fn for deterministic tests. */
  now?: () => Date;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForHeartbeatResult {
  /** True when the runner heartbeated inside the budget. */
  heartbeated: boolean;
  /** Last `last_seen_at` we saw (null when the runner never registered). */
  lastSeenAt: string | null;
  /** Elapsed wall-clock until success or timeout. */
  elapsedMs: number;
  /** When false, the reason we gave up. */
  reason?: string;
}

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export async function waitForRunnerHeartbeat(
  controlPlane: ControlPlane,
  opts: WaitForHeartbeatOptions,
): Promise<WaitForHeartbeatResult> {
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (waitTimeoutMs === 0) {
    return {
      heartbeated: false,
      lastSeenAt: null,
      elapsedMs: 0,
      reason: "verification disabled (waitTimeoutMs=0)",
    };
  }

  const startedAt = now().getTime();
  const freshAfter = opts.freshAfter ?? new Date(startedAt - 1000);
  const freshAfterMs = freshAfter.getTime();
  const deadlineMs = startedAt + waitTimeoutMs;

  let lastSeen: string | null = null;

  while (now().getTime() < deadlineMs) {
    const runners = await controlPlane.runners.listForOrg(opts.orgId);
    const match = runners.find((r) => r.name === opts.workerName);
    if (match) {
      lastSeen = match.lastSeenAt;
      const seenMs = Date.parse(match.lastSeenAt);
      if (Number.isFinite(seenMs) && seenMs >= freshAfterMs) {
        return {
          heartbeated: true,
          lastSeenAt: match.lastSeenAt,
          elapsedMs: now().getTime() - startedAt,
        };
      }
    }
    await sleep(pollIntervalMs);
  }

  return {
    heartbeated: false,
    lastSeenAt: lastSeen,
    elapsedMs: now().getTime() - startedAt,
    reason: lastSeen
      ? `runner '${opts.workerName}' is registered but last_seen_at=${lastSeen} is stale (before freshAfter=${freshAfter.toISOString()})`
      : `runner '${opts.workerName}' never registered within ${waitTimeoutMs}ms`,
  };
}
