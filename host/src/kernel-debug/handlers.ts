/**
 * Backward-compatibility shim.
 *
 * The original `handlers.ts` grew past ~600 LoC when Phase 1e landed
 * the kernel handlers alongside the driver handlers. Per the Phase 1
 * audit, the two sets have different dependency shapes
 * (`GuestAgentClient` vs `KdSession + BreakLog`) so they now live in
 * `./driver-handlers.ts` and `./kernel-handlers.ts` respectively.
 *
 * This file re-exports the public surface so existing importers —
 * chiefly the `src/__tests__/*` tests — keep working without a
 * mechanical import sweep. New code should import directly from
 * `./driver-handlers.js` / `./kernel-handlers.js` (or the barrel at
 * `./index.js`) instead of this shim.
 */

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
