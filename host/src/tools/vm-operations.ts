/**
 * VM operation tools: copy files, run commands, install software, screenshot.
 *
 * These tools perform actions inside running VMs, either through the
 * hypervisor backend (file copy, command execution) or the guest agent
 * (screenshot, software install).
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { resolveVM } from "../vm-cache.js";
import {
  sanitizeVmName,
  sanitizePath,
  sanitizeCommand,
  sanitizeUrl,
  sanitizeTimeout,
} from "../sanitize.js";

/**
 * Creates VM operation tool definitions bound to a backend resolver.
 *
 * @param getBackend - Async function that returns the active hypervisor backend.
 * @returns Array of ToolDefinition objects for vm_copy_file, vm_run_command, vm_install, vm_screenshot.
 */
export function createVmOperationTools(
  getBackend: () => Promise<HypervisorBackend>,
): ToolDefinition[] {
  return [
    {
      name: "vm_copy_file",
      description: "Copy a file from the host into the VM",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          src: { type: "string", description: "Source path on host" },
          dest: { type: "string", description: "Destination path in VM" },
        },
        required: ["name", "src", "dest"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const src = sanitizePath(params.src as string);
        const dest = sanitizePath(params.dest as string);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        await backend.copyFileToVM(handle, src, dest);
        return {
          content: [
            {
              type: "text",
              text: `Copied '${src}' to VM '${name}' at '${dest}'.`,
            },
          ],
        };
      },
    },
    {
      name: "vm_run_command",
      description: "Execute a command inside the VM",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          command: { type: "string", description: "Command to execute" },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds",
          },
        },
        required: ["name", "command"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const command = sanitizeCommand(params.command as string);
        const args = (params.args as string[] | undefined) ?? [];
        const timeoutMs = sanitizeTimeout(params.timeout_ms as number | undefined);
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);
        const result = await backend.executeCommand(
          handle,
          command,
          args,
          timeoutMs,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    },
    {
      name: "vm_install",
      description: "Install software in the VM via winget, choco, or direct download",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          package_id: {
            type: "string",
            description: "Package ID (e.g., Cursor.Cursor) or URL for direct installs",
          },
          source: {
            type: "string",
            enum: ["winget", "choco", "direct"],
            description: "Package source (default: winget)",
          },
        },
        required: ["name", "package_id"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const packageId = params.package_id as string;
        const source = (params.source as "winget" | "choco" | "direct" | undefined) ?? "winget";
        const backend = await getBackend();
        const handle = await resolveVM(backend, name);

        let command: string;
        let args: string[];

        switch (source) {
          case "winget":
            command = "winget";
            args = [
              "install",
              "--id",
              packageId,
              "--accept-source-agreements",
              "--accept-package-agreements",
              "--silent",
            ];
            break;
          case "choco":
            command = "choco";
            args = ["install", packageId, "-y"];
            break;
          case "direct": {
            // For direct installs, package_id is a URL — validate it
            const safeUrl = sanitizeUrl(packageId);
            command = "powershell";
            args = [
              "-Command",
              `Invoke-WebRequest -Uri '${safeUrl}' -OutFile $env:TEMP\\installer.exe; Start-Process $env:TEMP\\installer.exe -Wait`,
            ];
            break;
          }
        }

        const result = await backend.executeCommand(
          handle,
          command,
          args,
          300_000,
        );
        return {
          content: [
            {
              type: "text",
              text: `Install ${packageId} via ${source}: exit code ${result.exitCode}\n${result.stdout}`,
            },
          ],
        };
      },
    },
    {
      name: "vm_screenshot",
      description: "Take a screenshot of the VM display",
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
        // Screenshots require the guest agent -- placeholder until
        // GuestAgentClient is wired in.
        return {
          content: [
            {
              type: "text",
              text: `Screenshot requested for VM '${name}'. Requires guest agent (not yet connected).`,
            },
          ],
        };
      },
    },
  ];
}
