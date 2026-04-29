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
export { createVmTemplateTools } from "./vm-template.js";
export { createVmProvisioningTools } from "./vm-provisioning.js";
// P9.2 — `vm_install_bundle` requires a per-VM GuestAgentClient
// resolver, which createAllTools doesn't have on hand. Main session
// wires the tool up alongside the orchestrator so the resolver
// closure has access to the live `guestClients` map. Re-export the
// factory so the wiring can stay in one place.
export { createVmInstallBundleTool } from "./vm-install-bundle.js";

import type { ToolDefinition } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { createVmLifecycleTools } from "./vm-lifecycle.js";
import { createVmCheckpointTools } from "./vm-checkpoint.js";
import { createVmOperationTools } from "./vm-operations.js";
import { createDockerTools } from "./docker-tools.js";
import { createVmTemplateTools } from "./vm-template.js";
import { createVmProvisioningTools } from "./vm-provisioning.js";
import { createVmInstallBundleTool } from "./vm-install-bundle.js";
import { makeGuestClientResolver } from "../provisioning/guest-client-factory.js";
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

  // P9.2 — vm_install_bundle needs a per-VM GuestAgentClient resolver.
  // The factory builds one on demand from (backend, vmName) — no
  // long-lived client cache (bundle installs are infrequent; stale
  // clients across reboots would be a worse footgun than the per-call
  // IP-resolution cost).
  const getGuestClient = makeGuestClientResolver(getBackend);

  return [
    ...createVmLifecycleTools(getBackend),
    ...createVmCheckpointTools(getBackend),
    ...createVmOperationTools(getBackend),
    ...createDockerTools(() => dockerClient),
    ...createVmTemplateTools(),
    // P9.1: vm_provision + vm_cleanup. Default MCP namespace (not
    // signalman.advanced.*) per the locked Q6 decision; tool
    // descriptions carry the "Destructive" marker so LLM clients
    // gate on it.
    ...createVmProvisioningTools(getBackend),
    // P9.2: vm_install_bundle. Same default-namespace + "Modifies VM
    // state" description rule.
    createVmInstallBundleTool(getBackend, getGuestClient),
  ];
}
