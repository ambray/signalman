/**
 * VM lifecycle tools: list, start, stop, status.
 *
 * These tools manage the basic power-state lifecycle of virtual machines
 * through the active hypervisor backend.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { cacheVM, globalVmCache, resolveVM } from "../vm-cache.js";

/**
 * Creates VM lifecycle tool definitions bound to a backend resolver.
 *
 * @param getBackend - Async function that returns the active hypervisor backend.
 * @returns Array of ToolDefinition objects for vm_list, vm_start, vm_stop, vm_delete, vm_status.
 */
export function createVmLifecycleTools(
  getBackend: () => Promise<HypervisorBackend>,
): ToolDefinition[] {
  return [
    {
      name: "vm_list",
      description: "List all VMs and their status",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (): Promise<ToolResult> => {
        const backend = await getBackend();
        const vms = await backend.listVMs();
        const statuses = await Promise.all(
          vms.map(async (vm) => {
            cacheVM(vm);
            const status = await backend.getStatus(vm);
            return {
              name: vm.name,
              state: status.state,
              ip: status.ipAddress ?? "unknown",
              guestAgent: status.guestAgentReachable,
              uptime: status.uptimeSeconds ?? 0,
            };
          }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }],
        };
      },
    },
    {
      name: "vm_start",
      description: "Start a virtual machine",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = params.name as string;
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        await backend.startVM(handle);
        return {
          content: [{ type: "text", text: `VM '${name}' started.` }],
        };
      },
    },
    {
      name: "vm_stop",
      description: "Stop a virtual machine",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          force: {
            type: "boolean",
            description: "Force power off",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = params.name as string;
        const force = params.force as boolean | undefined;
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        await backend.stopVM(handle, force);
        return {
          content: [{ type: "text", text: `VM '${name}' stopped.` }],
        };
      },
    },
    {
      name: "vm_delete",
      description: "Delete a virtual machine (irreversible)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = params.name as string;
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        await backend.deleteVM(handle);
        // Evict the cached handle — the underlying VM is gone, so any
        // subsequent lookup must refresh from the backend rather than
        // returning a handle pointing at a deleted resource.
        globalVmCache.invalidate(name);
        return {
          content: [{ type: "text", text: `VM '${name}' deleted.` }],
        };
      },
    },
    {
      name: "vm_status",
      description: "Get VM status including guest agent health",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = params.name as string;
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        const status = await backend.getStatus(handle);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      },
    },
  ];
}
