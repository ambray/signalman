/**
 * `signalman.run` — execute a scenario and stream events.
 *
 * Per design doc §1.4. Returns a `run_id` synchronously; events stream
 * via `signalman.status` long-poll. The MCP/CLI handler hands off to
 * an executor (real orchestrator in production, fake in tests) that
 * pushes events into the run's `EventQueue` as it makes progress.
 *
 * Persistence (PM-resolved Question 1) is in-memory only for v0.1.0;
 * a host restart drops in-flight handles. v0.2.0 will persist state
 * to `.signalman/recordings/<run_id>/state.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  EventQueue,
  agentVersion,
  computeScenarioHash,
  envelopeErrorFromThrown,
  exitCodeFor,
  type EnvelopeError,
  type EnvelopeEventInput,
  type EnvelopeResult,
  type ResultEnvelope,
  type ExitBreakdown,
} from "../output/envelope.js";
import { resolveLayout } from "../scenarios/project-layout.js";
import { resolveScenarioById } from "../scenarios/scenario-loader.js";
import { newRunId, registerHandle, type RunHandle } from "./run-store.js";
import { ScenarioNotFoundError } from "./describe.js";

/**
 * An executor runs the scenario for `signalman.run`. Pluggable so the
 * MCP server can wire in a real orchestrator while unit tests can
 * inject a deterministic stub. The default executor (production) runs
 * the legacy `ScenarioOrchestrator`; see `defaultRunExecutor` below.
 */
export interface RunExecutor {
  (ctx: RunExecutorContext): Promise<{
    result: EnvelopeResult;
    assertions: ResultEnvelope["assertions"];
    /**
     * Structured failure records (P3.a). Empty array on success. Each
     * entry carries a machine-readable [`EnvelopeError.code`] so agents
     * can branch on failure type without parsing message strings.
     */
    errors: EnvelopeError[];
    breakdown?: ExitBreakdown;
  }>;
}

export interface RunExecutorContext {
  scenarioId: string;
  scenarioDir: string;
  scenarioHash: string;
  parameters: Record<string, unknown>;
  network_class: "isolated" | "nat" | "internet";
  /** Push an event into the run's queue. Auto-numbered/timestamped. */
  emit(event: EnvelopeEventInput): void;
}

export interface RunParams {
  id: string;
  parameters?: Record<string, unknown>;
  network_class?: "isolated" | "nat" | "internet";
}

export interface RunIssueResult {
  run_id: string;
  scenario_id: string;
  scenario_hash: string;
  started_at: string;
  status: "running";
}

/**
 * Issue a new run handle and start the scenario asynchronously.
 *
 * The promise resolves as soon as the handle is registered — the
 * scenario itself runs in the background. Callers poll
 * `signalman.status` for events + the terminal envelope.
 */
export async function runRun(
  params: RunParams,
  executor: RunExecutor,
  cwd: string = process.cwd(),
): Promise<RunIssueResult> {
  const layout = resolveLayout(cwd);
  const dir = resolveScenarioById(layout.scenariosDir, params.id);
  if (!fs.existsSync(path.join(dir, "setup.yaml"))) {
    throw new ScenarioNotFoundError(params.id);
  }
  const scenarioHash = computeScenarioHash(dir);
  const run_id = newRunId();
  const started_at = new Date().toISOString();

  const queue = new EventQueue();
  const handle: RunHandle = {
    run_id,
    scenario_id: params.id,
    scenario_hash: scenarioHash,
    started_at,
    status: "running",
    queue,
    envelope: null,
  };
  registerHandle(handle);

  queue.push({
    type: "run.started",
    scenario_id: params.id,
    scenario_hash: scenarioHash,
  });

  // Fire-and-forget: drive the executor, build the envelope on completion.
  // We swallow errors here and surface them through the envelope; the
  // outer caller already received its run_id.
  void (async () => {
    const network_class = params.network_class ?? "isolated";
    let outcome: {
      result: EnvelopeResult;
      assertions: ResultEnvelope["assertions"];
      errors: EnvelopeError[];
      breakdown?: ExitBreakdown;
    };
    try {
      outcome = await executor({
        scenarioId: params.id,
        scenarioDir: dir,
        scenarioHash,
        parameters: params.parameters ?? {},
        network_class,
        emit: (e) => queue.push(e),
      });
    } catch (err) {
      // Executor itself threw — wrap as an INTERNAL_ERROR with infra
      // category. If the executor produced an EnvelopeError instance,
      // envelopeErrorFromThrown unwraps it without re-wrapping.
      const enveloped = envelopeErrorFromThrown(err, {
        code: "INTERNAL_ERROR",
        category: "infra",
      });
      queue.push({
        type: "log",
        level: "error",
        message: enveloped.message,
        error_code: enveloped.code,
      });
      outcome = {
        result: "error",
        assertions: { total: 0, passed: 0, failed: 0, results: [] },
        errors: [enveloped],
        breakdown: "infra",
      };
    }

    queue.push({ type: "run.finished", result: outcome.result });

    const finished_at = new Date().toISOString();
    const duration_ms = new Date(finished_at).getTime() - new Date(started_at).getTime();
    const exit_code = exitCodeFor({ result: outcome.result, breakdown: outcome.breakdown });
    const envelope: ResultEnvelope = {
      envelope_version: "0.1.0",
      run_id,
      scenario_id: params.id,
      scenario_hash: scenarioHash,
      agent_version: agentVersion(),
      network_class,
      started_at,
      finished_at,
      duration_ms,
      result: outcome.result,
      exit_code,
      assertions: outcome.assertions,
      events: queue.all(),
      errors: outcome.errors,
    };
    handle.envelope = envelope;
    handle.status =
      outcome.result === "pass" ? "passed" : outcome.result === "fail" ? "failed" : "error";
    queue.finish();

    // Best-effort: write last-run.json into recordings/<id>/.
    try {
      const dirParts = params.id.split("/");
      const recordingDir = path.join(layout.recordingsDir, ...dirParts);
      fs.mkdirSync(recordingDir, { recursive: true });
      const lastRun = {
        run_id,
        started_at,
        finished_at,
        result: outcome.result,
        duration_ms,
        scenario_hash: scenarioHash,
      };
      fs.writeFileSync(path.join(recordingDir, "last-run.json"), JSON.stringify(lastRun, null, 2));
    } catch {
      // Recording-write failures should not affect the run result.
    }
  })();

  return {
    run_id,
    scenario_id: params.id,
    scenario_hash: scenarioHash,
    started_at,
    status: "running",
  };
}
