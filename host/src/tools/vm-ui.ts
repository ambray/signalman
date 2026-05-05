/**
 * VM UI automation tools.
 *
 * These MCP tools route through the in-guest GuestAgent UI RPCs. The guest
 * agent proxies to a loopback sidecar that must run inside the interactive
 * user session, so service-session isolation does not block clicks/typing.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { GuestAgentClient } from "../guest/client.js";
import { sanitizeTimeout, sanitizeVmName } from "../sanitize.js";

export function createVmUiTools(
  getClient: (vmName: string) => Promise<GuestAgentClient>,
): ToolDefinition[] {
  return [
    {
      name: "vm_ui_screenshot",
      description: "Capture a screenshot from the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          window_title: { type: "string", description: "Optional window title" },
          format: { type: "string", enum: ["png", "jpeg"], description: "Image format" },
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const timeoutMs = sanitizeTimeout(params.timeout_ms as number | undefined);
        const client = await getClient(name);
        const screenshot = await client.uiScreenshot({
          windowTitle: (params.window_title as string | undefined) ?? "",
          format: (params.format as string | undefined) ?? "png",
          timeoutMs,
        });
        return {
          content: [
            {
              type: "image",
              data: screenshot.imageData.toString("base64"),
              mimeType: `image/${screenshot.format === "jpeg" ? "jpeg" : "png"}`,
            },
            {
              type: "text",
              text: JSON.stringify(
                {
                  vm: name,
                  format: screenshot.format,
                  width: screenshot.width,
                  height: screenshot.height,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
    {
      name: "vm_ui_find",
      description: "Find UI Automation elements in the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          selector: {
            type: "string",
            description: "UIA selector, e.g. [name='Save'] or [automationId='btn1']",
          },
          window_title: { type: "string", description: "Optional window title" },
          find_timeout_ms: { type: "number", description: "Element wait timeout" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "selector"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const elements = await client.uiFind(params.selector as string, {
          windowTitle: (params.window_title as string | undefined) ?? "",
          findTimeoutMs: sanitizeTimeout(params.find_timeout_ms as number | undefined, 30_000),
          timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ elements }, null, 2) }],
        };
      },
    },
    {
      name: "vm_ui_click",
      description: "Click a UI Automation element in the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          selector: {
            type: "string",
            description: "UIA selector, e.g. [name='Save'] or [automationId='btn1']",
          },
          window_title: { type: "string", description: "Optional window title" },
          click_type: { type: "string", enum: ["left", "right", "double"] },
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name", "selector"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await client.uiClick(params.selector as string, {
          windowTitle: (params.window_title as string | undefined) ?? "",
          clickType: (params.click_type as "left" | "right" | "double" | undefined) ?? "left",
          timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      },
    },
    {
      name: "vm_ui_type",
      description: "Type text into the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          text: { type: "string", description: "Text to type" },
          selector: { type: "string", description: "Optional target UIA selector" },
          window_title: { type: "string", description: "Optional window title" },
          clear_first: { type: "boolean", description: "Select existing text before typing" },
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name", "text"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await client.uiType(params.text as string, {
          selector: (params.selector as string | undefined) ?? "",
          windowTitle: (params.window_title as string | undefined) ?? "",
          clearFirst: (params.clear_first as boolean | undefined) ?? false,
          timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      },
    },
  ];
}
