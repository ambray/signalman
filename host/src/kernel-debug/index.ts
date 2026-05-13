/**
 * Kernel-debug integration: spawn `kd.exe`, parse its output, expose a
 * promise-based command interface + event stream to the orchestrator.
 *
 * See `kd-session.ts` and `parser.ts` for module-level design notes.
 * See `docs/milestones/sprint-60.7.5-driver-test-infrastructure.md`
 * §3 for the sprint plan this implements.
 */

export {
  KdSession,
  KdCommandTimeoutError,
  KdSessionStateError,
  DEFAULT_COMMAND_TIMEOUT_MS,
} from "./kd-session.js";

export type {
  KdSessionOptions,
  KdSessionState,
  KdSessionEvent,
  KdSessionEventMap,
} from "./kd-session.js";

export {
  parseLine,
  normalizeBugcheckCode,
  extractBugcheckParameters,
  extractBugcheckName,
  splitLines,
  buildCommandWithSentinel,
} from "./parser.js";

export type { KdSignal } from "./parser.js";

// User-mode driver handlers (sc.exe start/stop + test-harness).
export {
  handleDriverLoad,
  handleDriverUnload,
  handleDriverIoctl,
  parseScQueryState,
} from "./driver-handlers.js";
export type {
  DriverHandlerContext,
  DriverLoadParams,
  DriverLoadResult,
  DriverUnloadParams,
  DriverUnloadResult,
  DriverIoctlParams,
  DriverIoctlResult,
} from "./driver-handlers.js";

// Kernel-debug handlers (kernel_expect_bugcheck / kernel_break_on).
export {
  handleKernelExpectBugcheck,
  handleKernelBreakOn,
} from "./kernel-handlers.js";
export type {
  KernelHandlerContext,
  KernelExpectBugcheckParams,
  KernelExpectBugcheckResult,
  KernelBreakOnParams,
  KernelBreakOnResult,
} from "./kernel-handlers.js";

// Break-event log backing the kernel handlers.
export { BreakLog } from "./break-log.js";
export type { BreakLogEntry, BreakLogQuery } from "./break-log.js";

// Pluggable tool-registry + factory that populates it with the
// kernel-debug tools. Sprint 60.8 adds more tools by calling
// `registry.register(...)` from its own module rather than editing
// orchestrator.ts's switch statement.
export {
  ToolRegistry,
  ToolAlreadyRegisteredError,
  UnknownToolError,
} from "./tool-registry.js";
export type {
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolOrchestratorView,
  KernelDebugBinding,
} from "./tool-registry.js";
export {
  createKernelDebugToolRegistry,
  kernelDebugToolDefinitions,
} from "./tools.js";

// Default kd factory, split out so orchestrator doesn't import
// kd-session.ts directly (follow-up 2).
export { createRealKdSession } from "./factory.js";
export type { KdSessionFactory } from "./factory.js";
