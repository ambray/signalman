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

export {
  handleDriverLoad,
  handleDriverUnload,
  handleDriverIoctl,
  handleKernelExpectBugcheck,
  handleKernelBreakOn,
  parseScQueryState,
} from "./handlers.js";

export type {
  DriverHandlerContext,
  DriverLoadParams,
  DriverLoadResult,
  DriverUnloadParams,
  DriverUnloadResult,
  DriverIoctlParams,
  DriverIoctlResult,
  KernelHandlerContext,
  KernelExpectBugcheckParams,
  KernelExpectBugcheckResult,
  KernelBreakOnParams,
  KernelBreakOnResult,
} from "./handlers.js";

export { BreakLog } from "./break-log.js";
export type { BreakLogEntry, BreakLogQuery } from "./break-log.js";
