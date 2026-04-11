/**
 * MCP tool definitions barrel file.
 *
 * Re-exports all tool types and factory functions. Each tool module
 * exports a factory that accepts a backend resolver and returns an
 * array of ToolDefinition objects.
 */

export type { ToolDefinition, ToolResult, ToolContent } from "./types.js";

export { createVmLifecycleTools } from "./vm-lifecycle.js";
export { createVmCheckpointTools } from "./vm-checkpoint.js";
export { createVmOperationTools } from "./vm-operations.js";

import type { ToolDefinition } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { createVmLifecycleTools } from "./vm-lifecycle.js";
import { createVmCheckpointTools } from "./vm-checkpoint.js";
import { createVmOperationTools } from "./vm-operations.js";

/**
 * Creates all MCP tool definitions for the given backend resolver.
 *
 * @param getBackend - Async function that returns the active hypervisor backend.
 * @returns Flat array of all ToolDefinition objects.
 */
export function createAllTools(
  getBackend: () => Promise<HypervisorBackend>,
): ToolDefinition[] {
  return [
    ...createVmLifecycleTools(getBackend),
    ...createVmCheckpointTools(getBackend),
    ...createVmOperationTools(getBackend),
  ];
}
