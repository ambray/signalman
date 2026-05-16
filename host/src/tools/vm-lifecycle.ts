/**
 * VM lifecycle tools: list, start, stop, status.
 *
 * These tools manage the basic power-state lifecycle of virtual machines
 * through the active hypervisor backend.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { HypervisorBackend, VMConfig } from "../hypervisors/interface.js";
import { cacheVM, globalVmCache, resolveVM } from "../vm-cache.js";
import { sanitizeVmName, sanitizeLabel } from "../sanitize.js";

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
    {
      name: "vm_create",
      description:
        "Create a new VM from a backend-specific config (Modifies host state). " +
        "On libvirt, `template` must be an absolute path to an existing qcow2; " +
        "the new disk is a sparse copy-on-write child created via qemu-img. " +
        "On hyper-v, a new empty disk is created.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          template: {
            type: "string",
            description: "Template path or image name (backend-specific)",
          },
          cpus: { type: "number", description: "vCPU count (default 2)" },
          memoryMB: {
            type: "number",
            description: "Memory in MiB (default 2048)",
          },
          diskGB: { type: "number", description: "Disk size in GB" },
          switchName: {
            type: "string",
            description: "Virtual switch / network name (default 'default')",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const config: VMConfig = {
          name,
          template: params.template as string | undefined,
          cpus: params.cpus as number | undefined,
          memoryMB: params.memoryMB as number | undefined,
          diskGB: params.diskGB as number | undefined,
          network: params.switchName
            ? { switchName: sanitizeLabel(params.switchName as string) }
            : undefined,
        };
        const backend = await getBackend();
        const handle = await backend.createVM(config);
        cacheVM(handle);
        return {
          content: [
            {
              type: "text",
              text: `VM '${name}' created (id: ${handle.id}, backend: ${handle.backend}).`,
            },
          ],
        };
      },
    },
    {
      name: "vm_pause",
      description: "Pause a running VM",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        await backend.pauseVM(handle);
        return {
          content: [{ type: "text", text: `VM '${name}' paused.` }],
        };
      },
    },
    {
      name: "vm_resume",
      description: "Resume a paused VM",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        await backend.resumeVM(handle);
        return {
          content: [{ type: "text", text: `VM '${name}' resumed.` }],
        };
      },
    },
    {
      name: "vm_wait_heartbeat",
      description:
        "Wait for the guest agent to respond. Returns reachable=true on first " +
        "successful probe or false when timeoutMs expires. Not all backends " +
        "implement this — surfaces a clear error when unsupported.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          timeoutMs: {
            type: "number",
            description: "Wait timeout in milliseconds (default 120000)",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const timeoutMs = (params.timeoutMs as number | undefined) ?? 120_000;
        const backend = await getBackend();
        if (!backend.waitForHeartbeat) {
          throw new Error(
            `Backend '${backend.name}' does not implement waitForHeartbeat. ` +
              `Use vm_status in a poll loop instead.`,
          );
        }
        const handle = await resolveVM(backend, name);
        const reachable = await backend.waitForHeartbeat(handle, timeoutMs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ name, reachable, timeoutMs }, null, 2),
            },
          ],
        };
      },
    },
    {
      name: "vm_set_memory",
      description:
        "Set the configured memory allocation in MiB (Modifies VM state). " +
        "Backend may persist to next-boot config rather than live-resize. " +
        "Not all backends implement this.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          memoryMB: {
            type: "number",
            description: "Memory in MiB (32-1048576)",
          },
        },
        required: ["name", "memoryMB"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const memoryMB = params.memoryMB as number;
        const backend = await getBackend();
        if (!backend.setVmMemory) {
          throw new Error(
            `Backend '${backend.name}' does not implement setVmMemory.`,
          );
        }
        const handle = await resolveVM(backend, name);
        await backend.setVmMemory(handle, memoryMB);
        return {
          content: [
            { type: "text", text: `VM '${name}' memory set to ${memoryMB} MiB.` },
          ],
        };
      },
    },
    {
      name: "vm_set_processor",
      description:
        "Set the configured vCPU count (Modifies VM state). " +
        "Backend may persist to next-boot config rather than live-resize. " +
        "Not all backends implement this.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          count: {
            type: "number",
            description: "vCPU count (1-240)",
          },
        },
        required: ["name", "count"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const count = params.count as number;
        const backend = await getBackend();
        if (!backend.setVmProcessor) {
          throw new Error(
            `Backend '${backend.name}' does not implement setVmProcessor.`,
          );
        }
        const handle = await resolveVM(backend, name);
        await backend.setVmProcessor(handle, count);
        return {
          content: [
            { type: "text", text: `VM '${name}' vCPU count set to ${count}.` },
          ],
        };
      },
    },
  ];
}
