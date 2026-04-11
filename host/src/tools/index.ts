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
export { createDockerTools } from "./docker-tools.js";

import type { ToolDefinition } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { createVmLifecycleTools } from "./vm-lifecycle.js";
import { createVmCheckpointTools } from "./vm-checkpoint.js";
import { createVmOperationTools } from "./vm-operations.js";
import { createDockerTools } from "./docker-tools.js";
import { DockerClient } from "../docker/client.js";

/**
 * Creates all MCP tool definitions for the given backend resolver.
 *
 * Includes VM lifecycle, checkpoint, and operation tools bound to the
 * hypervisor backend, plus Docker container orchestration tools.
 *
 * @param getBackend - Async function that returns the active hypervisor backend.
 * @param dockerOptions - Optional Docker client configuration.
 * @returns Flat array of all ToolDefinition objects.
 */
export function createAllTools(
  getBackend: () => Promise<HypervisorBackend>,
  dockerOptions?: { dockerPath?: string; composePath?: string },
): ToolDefinition[] {
  const dockerClient = new DockerClient(dockerOptions);

  return [
    ...createVmLifecycleTools(getBackend),
    ...createVmCheckpointTools(getBackend),
    ...createVmOperationTools(getBackend),
    ...createDockerTools(() => dockerClient),
  ];
}
