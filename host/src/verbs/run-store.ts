/**
 * In-memory run handle store.
 *
 * Issues `run_id`s to `signalman.run` callers and lets `signalman.status`
 * find the matching `EventQueue` to drain. Persistence (PM-resolved
 * v0.2.0 deliverable) lands with the explicit orchestrator; v0.1.0
 * loses all handles on host restart by design.
 *
 * One handle ⇄ one in-flight scenario run. Terminal handles linger in
 * the store so callers can still fetch the final envelope after the
 * scenario completes.
 */

import type { ResultEnvelope, EventQueue } from "../output/envelope.js";

/** A live or terminal run handle. */
export interface RunHandle {
  run_id: string;
  scenario_id: string;
  scenario_hash: string;
  started_at: string;
  status: "running" | "passed" | "failed" | "error";
  queue: EventQueue;
  /** Populated once the run is terminal. */
  envelope: ResultEnvelope | null;
}

const handles = new Map<string, RunHandle>();

/** Format a `run_id` per the design doc convention. */
export function newRunId(): string {
  const now = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 6);
  return `run_${now}_${rand}`;
}

/** Insert a fresh handle. */
export function registerHandle(handle: RunHandle): void {
  handles.set(handle.run_id, handle);
}

/** Look up an existing handle. */
export function getHandle(run_id: string): RunHandle | undefined {
  return handles.get(run_id);
}

/** Snapshot of all handles, most recent first. Used by `signalman.status` env mode. */
export function listHandles(): RunHandle[] {
  return Array.from(handles.values()).sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
}

/** Test-only — wipe the store between unit tests. */
export function _resetForTests(): void {
  handles.clear();
}
