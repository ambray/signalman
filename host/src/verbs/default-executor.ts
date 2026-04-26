/**
 * Default `signalman.run` executor — bridges to the existing
 * `ScenarioOrchestrator` so that v0.1.0 ships running scenarios
 * unchanged from the legacy path while emitting envelope events.
 *
 * The orchestrator's surface is wide and synchronous-blocking; the
 * executor invokes it once, then translates its `ScenarioResult` into
 * envelope events emitted retrospectively. Live event streaming during
 * scenario execution is a v0.2.0 deliverable (the orchestrator needs an
 * event hook surface that doesn't exist today; adding one is out of
 * scope for the P0 PR per "no semantic changes" constraint).
 */

import type { RunExecutor, RunExecutorContext } from "./run.js";
import type { EnvelopeAssertionResult, EnvelopeEventInput } from "../output/envelope.js";

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
    const { ServiceBackend } = await import("../hypervisors/service.js");
    const { loadConfig } = await import("../config.js");

    const config = loadConfig();
    let backend;
    // Backend selection order per docs/p1-service.md: service > hyperv > vmware.
    // The service backend's isAvailable() is a fast 2s health-RPC; failure
    // falls through to direct elevation via gsudo.
    const service = new ServiceBackend({});
    const hyperv = new HyperVBackend();
    const vmware = new VmwareBackend({
      vmrunPath: config.hypervisor.vmrunPath,
      guestUser: config.hypervisor.guestCredentials?.username,
      guestPass: config.hypervisor.guestCredentials?.password,
    });
    if (config.hypervisor.backend === "vmware" && (await vmware.isAvailable())) {
      backend = vmware;
    } else if (await service.isAvailable()) {
      backend = service;
    } else if (await hyperv.isAvailable()) {
      backend = hyperv;
    } else if (await vmware.isAvailable()) {
      backend = vmware;
    } else {
      throw new Error("No hypervisor backend available.");
    }

    // Build a guest-agent client per VM defined in the scenario. The
    // orchestrator's runtime tools (vm_run_command, vm_copy_file via guest,
    // driver_*, kernel_etw_*) all look up the client by VM name; without
    // this map, every guest-side step throws "No guest client configured".
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
      // Best-effort — orchestrator surfaces the original "no guest client"
      // error if the scenario actually needs one.
    }

    const orchestrator = new ScenarioOrchestrator(backend, guestClients, config);
    const scenarioResult = await orchestrator.runScenario(ctx.scenarioDir);

    // Replay setup steps as step events (the orchestrator records them
    // synchronously into setup_results; we surface them after-the-fact
    // so consumers see them in the envelope).
    let stepIndex = 0;
    for (const step of scenarioResult.setup_results) {
      ctx.emit({ type: "step.started", step_index: stepIndex, kind: step.action, vm: step.vm });
      if (step.status === "failed") {
        ctx.emit({ type: "step.failed", step_index: stepIndex, error: step.error ?? "" });
      } else {
        ctx.emit({ type: "step.completed", step_index: stepIndex, duration_ms: step.duration_ms });
      }
      stepIndex++;
    }

    const assertionEvents: EnvelopeAssertionResult[] = [];
    for (const a of scenarioResult.assertion_results) {
      const evt: EnvelopeEventInput = a.passed
        ? { type: "assertion.passed", id: a.id }
        : { type: "assertion.failed", id: a.id, expected: undefined, actual: a.actual };
      ctx.emit(evt);
      assertionEvents.push({
        id: a.id,
        passed: a.passed,
        severity: "high",
        actual: a.actual,
        error: a.error,
      });
    }

    const total = assertionEvents.length;
    const passedCount = assertionEvents.filter((a) => a.passed).length;
    const failedCount = total - passedCount;
    const result =
      scenarioResult.status === "passed"
        ? "pass"
        : scenarioResult.status === "failed"
          ? "fail"
          : "error";

    return {
      result,
      assertions: { total, passed: passedCount, failed: failedCount, results: assertionEvents },
      errors: scenarioResult.error ? [scenarioResult.error] : [],
      breakdown: result === "fail" ? "assertion" : result === "error" ? "infra" : undefined,
    };
  };
}
