/**
 * Factory that produces a {@link ToolRegistry} populated with the
 * Sprint 60.7.5 kernel-debug tools.
 *
 * Each tool's dispatch — parameter extraction, handler invocation,
 * JSON shaping — lives here rather than in orchestrator.ts. Adding a
 * new tool in Sprint 60.8 requires editing this file (or registering
 * a tool from the new module directly) but never editing the
 * orchestrator's `executeToolBlock`.
 *
 * Tools read their VM-specific dependencies (guest client, kd session,
 * break log) via the {@link ToolOrchestratorView} on their context.
 * That keeps tools testable against stub orchestrators.
 */

import {
  handleDriverIoctl,
  handleDriverLoad,
  handleDriverUnload,
  type DriverIoctlParams,
  type DriverLoadParams,
  type DriverUnloadParams,
} from "./driver-handlers.js";
import {
  handleKernelBreakOn,
  handleKernelExpectBugcheck,
  type KernelBreakOnParams,
  type KernelExpectBugcheckParams,
} from "./kernel-handlers.js";
import {
  handleKernelEtwStart,
  handleKernelEtwStop,
  type KernelEtwStartParams,
  type KernelEtwStopParams,
} from "./etw-handlers.js";
import {
  ToolRegistry,
  type ToolContext,
  type ToolDefinition,
} from "./tool-registry.js";

/**
 * Returns a fresh `ToolRegistry` populated with the seven kernel-debug
 * tools (5 from Sprint 60.7.5 + 2 ETW from Sprint 60.11 telemetry
 * assertions). Callers typically build one registry per orchestrator
 * instance and stash it on the orchestrator for `executeToolBlock`
 * to query.
 */
export function createKernelDebugToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of kernelDebugToolDefinitions()) {
    registry.register(def);
  }
  return registry;
}

/**
 * The raw list of tool definitions. Exported so tests (and future
 * doc-generation) can iterate them without constructing a registry.
 */
export function kernelDebugToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "driver_load",
      description: "Start a driver via `sc.exe start <service>` and report state",
      handler: driverLoadHandler,
    },
    {
      name: "driver_unload",
      description: "Stop a driver via `sc.exe stop <service>` and report state",
      handler: driverUnloadHandler,
    },
    {
      name: "driver_ioctl",
      description: "Send an IOCTL via the guest-side silo-test-harness",
      handler: driverIoctlHandler,
    },
    {
      name: "kernel_expect_bugcheck",
      description: "Assert that a bugcheck with a specific code happened",
      handler: kernelExpectBugcheckHandler,
    },
    {
      name: "kernel_break_on",
      description: "Install a kd breakpoint and capture state when it fires",
      handler: kernelBreakOnHandler,
    },
    {
      name: "kernel_etw_start",
      description:
        "Start an ETW capture session (via `logman create trace -ets`) targeting a provider GUID + keyword mask",
      handler: kernelEtwStartHandler,
    },
    {
      name: "kernel_etw_stop",
      description:
        "Stop the ETW session (via `logman stop -ets`), parse events by provider, return counts + first N events",
      handler: kernelEtwStopHandler,
    },
  ];
}

// ── Handler implementations ────────────────────────────────────────

async function driverLoadHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const guestClient = requireGuestClient(ctx);
  const p = params as unknown as DriverLoadParams;
  const result = await handleDriverLoad(
    { guestClient, vmName: ctx.vmName },
    {
      service: p.service,
      expect_status: p.expect_status,
      timeout_ms: p.timeout_ms,
    },
  );
  return JSON.stringify(result);
}

async function driverUnloadHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const guestClient = requireGuestClient(ctx);
  const p = params as unknown as DriverUnloadParams;
  const result = await handleDriverUnload(
    { guestClient, vmName: ctx.vmName },
    {
      service: p.service,
      expect_status: p.expect_status,
      timeout_ms: p.timeout_ms,
    },
  );
  return JSON.stringify(result);
}

async function driverIoctlHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const guestClient = requireGuestClient(ctx);
  const p = params as unknown as DriverIoctlParams;
  const result = await handleDriverIoctl(
    { guestClient, vmName: ctx.vmName },
    {
      device: p.device,
      control_code: p.control_code,
      input_hex: p.input_hex,
      input_file: p.input_file,
      expect_status: p.expect_status,
      expect_output_hex: p.expect_output_hex,
      expect_output_size_min: p.expect_output_size_min,
      timeout_ms: p.timeout_ms,
      harness_path: p.harness_path,
    },
  );
  return JSON.stringify(result);
}

async function kernelExpectBugcheckHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const kd = requireKernelDebug(ctx);
  const p = params as unknown as KernelExpectBugcheckParams;
  const result = await handleKernelExpectBugcheck(
    {
      kdSession: kd.session,
      breakLog: kd.breakLog,
      vmName: ctx.vmName,
    },
    {
      bugcheck_code: p.bugcheck_code,
      within_ms: p.within_ms,
      capture_stack: p.capture_stack,
      dump_path: p.dump_path,
      capture_timeout_ms: p.capture_timeout_ms,
    },
  );
  return JSON.stringify(result);
}

async function kernelBreakOnHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const kd = requireKernelDebug(ctx);
  const p = params as unknown as KernelBreakOnParams;
  const result = await handleKernelBreakOn(
    {
      kdSession: kd.session,
      breakLog: kd.breakLog,
      vmName: ctx.vmName,
    },
    {
      symbol: p.symbol,
      capture: p.capture,
      timeout_ms: p.timeout_ms,
      resume_after: p.resume_after,
    },
  );
  return JSON.stringify(result);
}

async function kernelEtwStartHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const guestClient = requireGuestClient(ctx);
  const p = params as unknown as KernelEtwStartParams;
  const result = await handleKernelEtwStart(
    { guestClient, vmName: ctx.vmName },
    {
      provider_guid: p.provider_guid,
      keywords: p.keywords,
      level: p.level,
      session_name: p.session_name,
      profile_path: p.profile_path,
      etl_path: p.etl_path,
      timeout_ms: p.timeout_ms,
    },
  );
  return JSON.stringify(result);
}

async function kernelEtwStopHandler(
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<string> {
  const guestClient = requireGuestClient(ctx);
  const p = params as unknown as KernelEtwStopParams;
  const result = await handleKernelEtwStop(
    { guestClient, vmName: ctx.vmName },
    {
      provider_guid: p.provider_guid,
      session_name: p.session_name,
      etl_path: p.etl_path,
      max_events_returned: p.max_events_returned,
      timeout_ms: p.timeout_ms,
    },
  );
  return JSON.stringify(result);
}

// ── Lookup helpers ────────────────────────────────────────────────

/**
 * Resolve the VM's guest client or throw a consistent error. Keeps
 * the error message uniform across driver_* tools so scenario authors
 * see the same diagnostic regardless of which one tripped.
 */
function requireGuestClient(
  ctx: ToolContext,
): import("../guest/client.js").GuestAgentClient {
  const client = ctx.orchestrator.getGuestClient(ctx.vmName);
  if (!client) {
    throw new Error(
      `No guest client for VM '${ctx.vmName}' — the scenario's VMs map has no entry for this name`,
    );
  }
  return client;
}

/**
 * Resolve the VM's kernel-debug binding or throw a consistent error.
 * Emitted when a kernel_* tool is invoked on a VM whose scenario
 * didn't enable `kernel_debug`.
 */
function requireKernelDebug(
  ctx: ToolContext,
): { session: import("./kd-session.js").KdSession; breakLog: import("./break-log.js").BreakLog } {
  const kd = ctx.orchestrator.getKernelDebug(ctx.vmName);
  if (!kd) {
    throw new Error(
      `No kernel_debug session for VM '${ctx.vmName}' — enable kernel_debug in setup.yaml or call orchestrator.setKernelDebugSession()`,
    );
  }
  return kd;
}
