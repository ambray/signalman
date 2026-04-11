/**
 * VM checkpoint tools: create, restore, list checkpoints.
 *
 * Checkpoint (snapshot) management allows saving and restoring VM state
 * for deterministic test scenarios and rollback after destructive tests.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { resolveVM } from "../vm-cache.js";
import { sanitizeVmName, sanitizeLabel } from "../sanitize.js";

/**
 * Creates VM checkpoint tool definitions bound to a backend resolver.
 *
 * @param getBackend - Async function that returns the active hypervisor backend.
 * @returns Array of ToolDefinition objects for vm_checkpoint, vm_restore, vm_list_checkpoints.
 */
export function createVmCheckpointTools(
  getBackend: () => Promise<HypervisorBackend>,
): ToolDefinition[] {
  return [
    {
      name: "vm_checkpoint",
      description: "Create a named checkpoint (snapshot)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          label: { type: "string", description: "Checkpoint label" },
        },
        required: ["name", "label"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        // Defense-in-depth: sanitize at tool handler level before backend
        const name = sanitizeVmName(params.name as string);
        const label = sanitizeLabel(params.label as string);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        const cp = await backend.createCheckpoint(handle, label);
        return {
          content: [
            {
              type: "text",
              text: `Checkpoint '${label}' created for VM '${name}' (id: ${cp.id}).`,
            },
          ],
        };
      },
    },
    {
      name: "vm_restore",
      description: "Restore a VM to a checkpoint",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          label: {
            type: "string",
            description: "Checkpoint label to restore",
          },
        },
        required: ["name", "label"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        // Defense-in-depth: sanitize at tool handler level before backend
        const name = sanitizeVmName(params.name as string);
        const label = sanitizeLabel(params.label as string);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        const cp = { id: "", vmHandle: handle, label };
        await backend.restoreCheckpoint(cp);
        return {
          content: [
            {
              type: "text",
              text: `VM '${name}' restored to checkpoint '${label}'.`,
            },
          ],
        };
      },
    },
    {
      name: "vm_list_checkpoints",
      description: "List all checkpoints for a VM",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        // Defense-in-depth: sanitize at tool handler level before backend
        const name = sanitizeVmName(params.name as string);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        const checkpoints = await backend.listCheckpoints(handle);
        return {
          content: [
            { type: "text", text: JSON.stringify(checkpoints, null, 2) },
          ],
        };
      },
    },
  ];
}
