import type { GuestAgentClient } from "../guest/client.js";
import { sanitizeBrowserUrl } from "../guest/ui-browser.js";
import { sanitizeTimeout, sanitizeVmName } from "../sanitize.js";
import type { ToolDefinition, ToolResult } from "./types.js";

type GuestClientResolver = (vmName: string) => Promise<GuestAgentClient>;

function sanitizeCssSelector(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("css_selector is required");
  }
  if (value.includes("\0")) {
    throw new Error("css_selector contains null byte");
  }
  if (value.length > 2_000) {
    throw new Error("css_selector is too long");
  }
  return value;
}

function sanitizeBrowserExpression(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("expression is required");
  }
  if (value.includes("\0")) {
    throw new Error("expression contains null byte");
  }
  if (value.length > 10_000) {
    throw new Error("expression is too long");
  }
  return value;
}

function browserActionJson(
  vm: string,
  result: { success: boolean; error: string; pageTitle: string; pageUrl: string },
) {
  return {
    vm,
    success: result.success,
    error: result.error,
    page_title: result.pageTitle,
    page_url: result.pageUrl,
  };
}

function browserEvaluateJson(
  vm: string,
  result: { success: boolean; error: string; jsonValue: string; pageTitle: string; pageUrl: string },
) {
  return {
    vm,
    success: result.success,
    error: result.error,
    json_value: result.jsonValue,
    page_title: result.pageTitle,
    page_url: result.pageUrl,
  };
}

function toolErrorJson(vm: string, error: unknown) {
  return {
    vm,
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Browser DOM/CDP-facing guest tools.
 *
 * These tools expose the guest Browser* RPC contract to MCP clients. Native
 * Windows sidecars can drive loopback CDP targets; other sidecar engines report
 * a crisp "CDP unavailable" failure boundary.
 */
export function createVmBrowserTools(getClient: GuestClientResolver): ToolDefinition[] {
  return [
    {
      name: "vm_browser_navigate",
      description:
        "Navigate the active browser through the guest browser automation backend. Native sidecars use loopback CDP when available.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          url: { type: "string", description: "http:// or https:// URL to navigate to" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "url"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const url = sanitizeBrowserUrl(params.url);
        const client = await getClient(name);
        try {
          const result = await client.browserNavigate(
            url,
            sanitizeTimeout(params.timeout_ms as number | undefined),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(browserActionJson(name, result), null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: JSON.stringify(toolErrorJson(name, error), null, 2) }],
            isError: true,
          };
        }
      },
    },
    {
      name: "vm_browser_click",
      description:
        "Click a CSS selector through the guest browser automation backend. Native sidecars use loopback CDP when available.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          css_selector: { type: "string", description: "CSS selector to click" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "css_selector"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const selector = sanitizeCssSelector(params.css_selector);
        const client = await getClient(name);
        try {
          const result = await client.browserClick(
            selector,
            sanitizeTimeout(params.timeout_ms as number | undefined),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(browserActionJson(name, result), null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: JSON.stringify(toolErrorJson(name, error), null, 2) }],
            isError: true,
          };
        }
      },
    },
    {
      name: "vm_browser_evaluate",
      description:
        "Evaluate a JavaScript expression in the active browser through the guest browser automation backend. Native sidecars use loopback CDP when available.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          expression: { type: "string", description: "JavaScript expression to evaluate" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "expression"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const expression = sanitizeBrowserExpression(params.expression);
        const client = await getClient(name);
        try {
          const result = await client.browserEvaluate(
            expression,
            sanitizeTimeout(params.timeout_ms as number | undefined),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(browserEvaluateJson(name, result), null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: JSON.stringify(toolErrorJson(name, error), null, 2) }],
            isError: true,
          };
        }
      },
    },
    {
      name: "vm_browser_screenshot",
      description:
        "Capture a browser screenshot through the guest browser automation backend. Native sidecars use loopback CDP when available.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          format: { type: "string", enum: ["png", "jpeg"], description: "Image format" },
          full_page: { type: "boolean", description: "Capture the full page instead of the viewport" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const format = (params.format as string | undefined) ?? "png";
        if (format !== "png" && format !== "jpeg") {
          throw new Error("format must be png or jpeg");
        }
        const client = await getClient(name);
        try {
          const screenshot = await client.browserScreenshot({
            format,
            fullPage: (params.full_page as boolean | undefined) ?? false,
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
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
        } catch (error) {
          return {
            content: [{ type: "text", text: JSON.stringify(toolErrorJson(name, error), null, 2) }],
            isError: true,
          };
        }
      },
    },
  ];
}
