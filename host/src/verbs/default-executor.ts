/**
 * Default `signalman.run` executor — bridges to the existing
 * `ScenarioOrchestrator`. Since 2026-04-26 (P3.c) the orchestrator
 * pushes setup-step lifecycle and assertion events live via the
 * `emit` callback, so the executor no longer translates a
 * post-run `ScenarioResult` into a synthetic event stream — events
 * arrive in the run's `EventQueue` as they happen. The original
 * "events all dated to the same instant" anti-pattern (audit C2)
 * is resolved.
 *
 * The executor still synthesises the final `assertions` summary
 * and `result` outcome from `ScenarioResult` for the envelope
 * return value; only the per-event timing/replay was retrospective.
 */

import type { RunExecutor, RunExecutorContext } from "./run.js";
import type { EnvelopeAssertionResult } from "../output/envelope.js";
import { envelopeError } from "../output/envelope.js";

/**
 * Build a real-orchestrator-backed executor.
 *
 * Lazily imports the orchestrator + dependencies to keep CLI tools
 * (`signalman list`, `signalman describe`) fast — they shouldn't pay
 * the import cost of the gRPC client and Hyper-V backend.
 */
export function createDefaultExecutor(): RunExecutor {
  return async (ctx: RunExecutorContext) => {
    // Lazy import — see file-level comment.
    const { ScenarioOrchestrator } = await import("../scenarios/orchestrator.js");
    const { HyperVBackend } = await import("../hypervisors/hyperv.js");
    const { VmwareBackend } = await import("../hypervisors/vmware.js");
    const { loadConfig } = await import("../config.js");

    const config = loadConfig();
    let backend;
    const hyperv = new HyperVBackend();
    const vmware = new VmwareBackend({
      vmrunPath: config.hypervisor.vmrunPath,
      guestUser: config.hypervisor.guestCredentials?.username,
      guestPass: config.hypervisor.guestCredentials?.password,
    });
    if (config.hypervisor.backend === "vmware" && (await vmware.isAvailable())) {
      backend = vmware;
    } else if (await hyperv.isAvailable()) {
      backend = hyperv;
    } else if (await vmware.isAvailable()) {
      backend = vmware;
    } else {
      throw new Error("No hypervisor backend available.");
    }

    const orchestrator = new ScenarioOrchestrator(backend, new Map(), config);
    // P3.c: pass ctx.emit through to the orchestrator so step lifecycle
    // and assertion events arrive in the run's EventQueue as they
    // happen, not retrospectively after runScenario returns. The
    // synchronous translation block this used to do is gone.
    const scenarioResult = await orchestrator.runScenario(
      ctx.scenarioDir,
      ctx.emit,
    );

    // Build the per-assertion summary from the orchestrator's normalised
    // result. The events were already emitted live by the orchestrator;
    // this loop only collects the data the run.ts envelope needs in
    // its `assertions` field. No emit calls.
    const assertionEvents: EnvelopeAssertionResult[] = scenarioResult.assertion_results.map(
      (a) => ({
        id: a.id,
        passed: a.passed,
        severity: "high",
        actual: a.actual,
        error: a.error,
      }),
    );

    const total = assertionEvents.length;
    const passedCount = assertionEvents.filter((a) => a.passed).length;
    const failedCount = total - passedCount;
    const result =
      scenarioResult.status === "passed"
        ? "pass"
        : scenarioResult.status === "failed"
          ? "fail"
          : "error";

    // Translate the legacy ScenarioOrchestrator's stringly-typed `error`
    // into a structured EnvelopeError. The orchestrator does not yet
    // distinguish setup/workflow/infra failures at this level, so we
    // categorise by `result`: a "failed" status is a workflow or
    // assertion failure (the orchestrator's failed-step detection runs
    // before assertions); an "error" status is treated as infrastructure.
    // Once the orchestrator gains a richer error surface (P3.c
    // event-emission hook), this mapping can sharpen further.
    const errors = scenarioResult.error
      ? [
          envelopeError({
            code: result === "error" ? "INTERNAL_ERROR" : "WORKFLOW_TOOL_FAILED",
            message: scenarioResult.error,
            category: result === "error" ? "infra" : "workflow",
          }),
        ]
      : [];

    return {
      result,
      assertions: { total, passed: passedCount, failed: failedCount, results: assertionEvents },
      errors,
      breakdown: result === "fail" ? "assertion" : result === "error" ? "infra" : undefined,
    };
  };
}
