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
 * the import cost of the gRPC client and hypervisor backends.
 */
export function createDefaultExecutor(): RunExecutor {
  return async (ctx: RunExecutorContext) => {
    // Lazy import — see file-level comment.
    const { ScenarioOrchestrator } = await import("../scenarios/orchestrator.js");
    const { loadConfig } = await import("../config.js");
    const { selectBackend } = await import("../hypervisors/selector.js");

    const config = loadConfig();
    // selectBackend() (host/src/hypervisors/selector.ts) handles the
    // service > hyperv > vmware > tart cascade and honours
    // `config.hypervisor.backend` as the explicit operator preference.
    // ServiceBackend's isAvailable() is a fast 2s health-RPC; failure
    // falls through to direct-elevation backends.
    const backend = await selectBackend(config);

    // Build a guest-agent client per VM defined in the scenario. The
    // orchestrator's runtime tools (vm_run_command, vm_copy_file via
    // guest, driver_*, kernel_etw_*) all look up the client by VM name;
    // without this map, every guest-side step throws "No guest client
    // configured for VM '<name>'".
    //
    // Originally landed as `67ee631` on `fix/p1-service-integration`
    // (2026-04-25). Cherry-picked onto main 2026-04-29 as part of the
    // service-binary refresh — the running daemon depended on this
    // wiring being present in the host process.
    const { GuestAgentClient } = await import("../guest/client.js");
    const { loadScenario } = await import("../scenarios/runner.js");
    const guestClients = new Map<string, InstanceType<typeof GuestAgentClient>>();
    try {
      const { config: scenarioCfg } = loadScenario(ctx.scenarioDir);
      const tlsCfg = config.guestAgent?.tls?.enabled
        ? {
            caPath: config.guestAgent.tls.caPath,
            certPath: config.guestAgent.tls.certPath,
            keyPath: config.guestAgent.tls.keyPath,
          }
        : undefined;
      for (const vm of scenarioCfg.vms ?? []) {
        const ip = vm.network?.static_ip;
        if (!ip) continue; // skip VMs with no addressable agent (e.g. docker-only)
        const port = vm.guest_agent_port ?? config.guestAgent?.defaultPort ?? 50051;
        guestClients.set(vm.name, new GuestAgentClient(ip, port, tlsCfg));
      }
    } catch {
      // Best-effort — orchestrator surfaces the original "no guest
      // client" error if the scenario actually needs one.
    }

    // Phase 3 §C1 follow-up (2026-05-06): wire `scenarios.outputDir`
    // through to the orchestrator so workflow.md tool-block stdout
    // gets persisted to `<outputDir>/<scenarioName>/workflow-outputs.json`.
    // Without this, scenarios with `assertions: []` and inline
    // workflow.md `expect_*` parameters silently fail with no
    // diagnostic artifact — `result: fail` and zero events explain
    // nothing. Mirrors the artifact the legacy CLI's `test` verb
    // produced.
    const orchestrator = new ScenarioOrchestrator(backend, guestClients, config, {
      outputDir: config.scenarios?.outputDir,
      registerProcessExitCleanup: true,
    });
    // P3.c: pass ctx.emit through to the orchestrator so step lifecycle
    // and assertion events arrive in the run's EventQueue as they
    // happen, not retrospectively after runScenario returns. The
    // synchronous translation block this used to do is gone.
    // P3.d: thread the trace context (traceId, runId) through so every
    // gRPC call the orchestrator makes carries `signalman-trace-id`,
    // `signalman-run-id`, and (per-call) `signalman-vm-name` metadata.
    const scenarioResult = await orchestrator.runScenario(
      ctx.scenarioDir,
      ctx.emit,
      { traceId: ctx.traceId, runId: ctx.runId },
      ctx.parameters,
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
