/**
 * `signalman.status` — environment + run-mode status.
 *
 * Per design doc §1.6. Two modes selected by param shape:
 *   - No `run_id`:       environment summary (host/backend/recent runs).
 *   - `run_id` supplied: drain events since `since_event_seq`, optionally
 *                       blocking up to `wait_ms` for the next event.
 *
 * Event drain caps at `EVENT_DRAIN_LIMIT` per call to keep envelopes
 * sane on long scenarios; callers paginate via `next_event_seq`.
 */

import { getHandle, listHandles } from "./run-store.js";
import { agentVersion, type EnvelopeEvent, type ResultEnvelope } from "../output/envelope.js";

/** Per-call event cap. Per design doc Open Question #4. */
export const EVENT_DRAIN_LIMIT = 1000;

/** Max long-poll wait. Bounds the worst-case stdio block. */
export const MAX_WAIT_MS = 30_000;

export interface StatusParams {
  run_id?: string;
  since_event_seq?: number;
  wait_ms?: number;
}

export interface RunStatusResult {
  run_id: string;
  status: "running" | "passed" | "failed" | "error" | "not-found";
  events: EnvelopeEvent[];
  next_event_seq: number;
  envelope: ResultEnvelope | null;
}

export interface EnvStatusResult {
  service_status: "ok";
  agent_version: string;
  recent_runs: Array<{
    run_id: string;
    scenario_id: string;
    status: string;
    started_at: string;
  }>;
}

export type StatusResult = RunStatusResult | EnvStatusResult;

export async function runStatus(
  params: StatusParams = {},
): Promise<StatusResult> {
  if (!params.run_id) {
    return envStatus();
  }

  const handle = getHandle(params.run_id);
  if (!handle) {
    return {
      run_id: params.run_id,
      status: "not-found",
      events: [],
      next_event_seq: 0,
      envelope: null,
    };
  }

  const since = Math.max(0, params.since_event_seq ?? 0);
  const waitMs = Math.max(0, Math.min(params.wait_ms ?? 0, MAX_WAIT_MS));

  // Long-poll: if no events past `since` are available yet, wait up
  // to waitMs for one to arrive (or for the queue to mark itself
  // terminal).
  if (waitMs > 0) {
    await handle.queue.waitForNext(since, waitMs);
  }

  const drained = handle.queue.drain(since, EVENT_DRAIN_LIMIT);
  return {
    run_id: handle.run_id,
    status: handle.status,
    events: drained.events,
    next_event_seq: drained.nextSeq,
    envelope: handle.envelope,
  };
}

function envStatus(): EnvStatusResult {
  return {
    service_status: "ok",
    agent_version: agentVersion(),
    recent_runs: listHandles()
      .slice(0, 10)
      .map((h) => ({
        run_id: h.run_id,
        scenario_id: h.scenario_id,
        status: h.status,
        started_at: h.started_at,
      })),
  };
}
