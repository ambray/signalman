/**
 * VM UI automation tools.
 *
 * These MCP tools route through the in-guest GuestAgent UI RPCs. The guest
 * agent proxies to a loopback sidecar that must run inside the interactive
 * user session, so service-session isolation does not block clicks/typing.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { GuestAgentClient } from "../guest/client.js";
import { navigateUrlWithUi, openUrlWithUi } from "../guest/ui-browser.js";
import type { UiSidecarRecoveryOptions } from "../guest/ui-recovery.js";
import { ensureUiSidecar } from "../guest/ui-sidecar.js";
import {
  describeUiActionTargets,
  describeUiBrowserTargets,
  describeUiElements,
} from "../guest/ui-elements.js";
import { withUiSidecarRecovery } from "../guest/ui-recovery.js";
import { sanitizeTimeout, sanitizeVmName } from "../sanitize.js";

function sanitizeRepeat(repeat: number | undefined): number {
  if (repeat == null || Number.isNaN(repeat)) return 1;
  return Math.max(1, Math.min(Math.floor(repeat), 100));
}

function uiActionJson(vm: string, result: { success: boolean; error: string; durationMs?: number }) {
  return {
    vm,
    success: result.success,
    error: result.error,
    duration_ms: result.durationMs ?? 0,
  };
}

const recoveryProperties = {
  recover_username: {
    type: "string",
    description: "Optional interactive desktop user. When set, retry once after restarting the sidecar if it is unreachable.",
  },
  recover_engine: {
    type: "string",
    enum: ["powershell-process", "powershell-helper", "native"],
    description: "Optional engine to use when recovery restarts the sidecar.",
  },
  recover_wait_ready_ms: {
    type: "number",
    description: "How long recovery waits for the sidecar loopback port.",
  },
} as const;

function recoveryOptions(params: Record<string, unknown>): UiSidecarRecoveryOptions | undefined {
  const username = params.recover_username as string | undefined;
  if (!username) return undefined;
  return {
    username,
    engine: params.recover_engine as string | undefined,
    waitReadyMs:
      params.recover_wait_ready_ms == null
        ? undefined
        : sanitizeTimeout(params.recover_wait_ready_ms as number | undefined, 300_000),
    timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
  };
}

export function createVmUiTools(
  getClient: (vmName: string) => Promise<GuestAgentClient>,
): ToolDefinition[] {
  return [
    {
      name: "vm_ui_ensure_sidecar",
      description: "Create or update the VM's interactive user-session UI sidecar scheduled task",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          username: {
            type: "string",
            description: "Windows user that owns the interactive desktop session",
          },
          bind: {
            type: "string",
            description: "Loopback bind address for the sidecar, default 127.0.0.1:50151",
          },
          engine: {
            type: "string",
            enum: ["powershell-process", "powershell-helper", "native"],
            description: "Automation engine for the sidecar, default powershell-process",
          },
          task_name: {
            type: "string",
            description: "Scheduled task name, default SignalmanUiSidecar",
          },
          run_now: {
            type: "boolean",
            description: "Start the task immediately if the user is logged in",
          },
          wait_ready_ms: {
            type: "number",
            description: "How long to wait for the sidecar loopback port after starting it",
          },
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name", "username"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const waitReadyMs =
          params.wait_ready_ms == null
            ? 5_000
            : sanitizeTimeout(params.wait_ready_ms as number | undefined, 300_000);
        const result = await ensureUiSidecar(client, {
          username: params.username as string,
          bind: (params.bind as string | undefined) ?? undefined,
          engine: (params.engine as string | undefined) ?? undefined,
          taskName: (params.task_name as string | undefined) ?? undefined,
          runNow: (params.run_now as boolean | undefined) ?? true,
          waitReadyMs,
          timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ vm: name, ...result }, null, 2) }],
        };
      },
    },
    {
      name: "vm_ui_health",
      description: "Report whether the VM's interactive user-session UI sidecar is reachable and which automation engine it is using",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await client.uiHealth(
          sanitizeTimeout(params.timeout_ms as number | undefined),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  vm: name,
                  sidecar_reachable: result.sidecarReachable,
                  engine: result.engine,
                  pid: result.pid,
                  uptime_ms: result.uptimeMs,
                  error: result.error,
                  duration_ms: result.durationMs,
                },
                null,
                2,
              ),
            },
          ],
          isError: !result.sidecarReachable,
        };
      },
    },
    {
      name: "vm_ui_snapshot",
      description: "Capture a screenshot plus visible UI Automation elements from the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          window_title: { type: "string", description: "Optional window title" },
          format: { type: "string", enum: ["png", "jpeg"], description: "Image format" },
          max_elements: {
            type: "number",
            description: "Maximum number of UI elements to include in the JSON metadata",
          },
          ...recoveryProperties,
          find_timeout_ms: { type: "number", description: "Element inventory timeout" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const timeoutMs = sanitizeTimeout(params.timeout_ms as number | undefined);
        const findTimeoutMs = sanitizeTimeout(params.find_timeout_ms as number | undefined, 5_000);
        const maxElements = Math.max(
          1,
          Math.min(Math.floor((params.max_elements as number | undefined) ?? 50), 200),
        );
        const windowTitle = (params.window_title as string | undefined) ?? "";
        const format = (params.format as string | undefined) ?? "png";
        const client = await getClient(name);
        const [screenshot, find] = await withUiSidecarRecovery(
          client,
          recoveryOptions(params),
          () =>
            Promise.all([
              client.uiScreenshot({
                windowTitle,
                format,
                timeoutMs,
              }),
              client.uiFindDetailed("", {
                windowTitle,
                findTimeoutMs,
                timeoutMs,
              }),
            ]),
        );
        const elements = find.elements;
        const descriptors = describeUiElements(elements);
        const actionTargets = describeUiActionTargets(descriptors, maxElements);
        const actionTargetCount = descriptors.filter((element) => element.actions.length > 0 && element.selector).length;
        const browserTargets = describeUiBrowserTargets(descriptors, 10);
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
                  screenshot_duration_ms: screenshot.durationMs,
                  find_duration_ms: find.durationMs,
                  element_count: elements.length,
                  elements: descriptors.slice(0, maxElements),
                  truncated: elements.length > maxElements,
                  action_target_count: actionTargetCount,
                  action_targets: actionTargets,
                  action_targets_truncated: actionTargetCount > actionTargets.length,
                  browser_target_count: browserTargets.length,
                  browser_targets: browserTargets,
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
      name: "vm_ui_screenshot",
      description: "Capture a screenshot from the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          window_title: { type: "string", description: "Optional window title" },
          format: { type: "string", enum: ["png", "jpeg"], description: "Image format" },
          ...recoveryProperties,
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const timeoutMs = sanitizeTimeout(params.timeout_ms as number | undefined);
        const client = await getClient(name);
        const screenshot = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          client.uiScreenshot({
            windowTitle: (params.window_title as string | undefined) ?? "",
            format: (params.format as string | undefined) ?? "png",
            timeoutMs,
          }),
        );
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
                  duration_ms: screenshot.durationMs,
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
          ...recoveryProperties,
          find_timeout_ms: { type: "number", description: "Element wait timeout" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "selector"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const find = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          client.uiFindDetailed(params.selector as string, {
            windowTitle: (params.window_title as string | undefined) ?? "",
            findTimeoutMs: sanitizeTimeout(params.find_timeout_ms as number | undefined, 30_000),
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        const elements = find.elements;
        const descriptors = describeUiElements(elements);
        const actionTargets = describeUiActionTargets(descriptors, 50);
        const browserTargets = describeUiBrowserTargets(descriptors, 10);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  elements: descriptors,
                  duration_ms: find.durationMs,
                  action_target_count: actionTargets.length,
                  action_targets: actionTargets,
                  browser_target_count: browserTargets.length,
                  browser_targets: browserTargets,
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
      name: "vm_ui_wait_for",
      description: "Wait for a UI Automation element and mark the tool result as an error if it is absent",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          selector: {
            type: "string",
            description: "UIA selector, e.g. [name='Save'] or [automationId='btn1']",
          },
          window_title: { type: "string", description: "Optional window title" },
          ...recoveryProperties,
          find_timeout_ms: { type: "number", description: "Element wait timeout" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "selector"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const selector = params.selector as string;
        const client = await getClient(name);
        const find = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          client.uiFindDetailed(selector, {
            windowTitle: (params.window_title as string | undefined) ?? "",
            findTimeoutMs: sanitizeTimeout(params.find_timeout_ms as number | undefined, 30_000),
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        const elements = find.elements;
        const descriptors = describeUiElements(elements);
        const actionTargets = describeUiActionTargets(descriptors, 50);
        const browserTargets = describeUiBrowserTargets(descriptors, 10);
        const found = elements.length > 0;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  vm: name,
                  selector,
                  found,
                  count: elements.length,
                  duration_ms: find.durationMs,
                  elements: descriptors,
                  action_target_count: actionTargets.length,
                  action_targets: actionTargets,
                  browser_target_count: browserTargets.length,
                  browser_targets: browserTargets,
                  error: found ? "" : `UI element not found: ${selector}`,
                },
                null,
                2,
              ),
            },
          ],
          isError: !found,
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
          ...recoveryProperties,
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name", "selector"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          client.uiClick(params.selector as string, {
            windowTitle: (params.window_title as string | undefined) ?? "",
            clickType: (params.click_type as "left" | "right" | "double" | undefined) ?? "left",
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(uiActionJson(name, result), null, 2) }],
          isError: !result.success,
        };
      },
    },
    {
      name: "vm_ui_key",
      description: "Send a keyboard chord or special key sequence to the VM's interactive user session",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          keys: {
            type: "string",
            description: "Windows SendKeys syntax, e.g. {ENTER}, {ESC}, {TAB}, ^a",
          },
          selector: {
            type: "string",
            description: "Optional UIA selector to focus before sending keys",
          },
          window_title: { type: "string", description: "Optional window title" },
          repeat: { type: "number", description: "Repeat count, default 1" },
          ...recoveryProperties,
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "keys"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          client.uiKey(params.keys as string, {
            selector: params.selector as string | undefined,
            windowTitle: params.window_title as string | undefined,
            repeat: sanitizeRepeat(params.repeat as number | undefined),
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(uiActionJson(name, result), null, 2),
            },
          ],
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
          ...recoveryProperties,
          timeout_ms: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["name", "text"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          client.uiType(params.text as string, {
            selector: (params.selector as string | undefined) ?? "",
            windowTitle: (params.window_title as string | undefined) ?? "",
            clearFirst: (params.clear_first as boolean | undefined) ?? false,
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(uiActionJson(name, result), null, 2) }],
          isError: !result.success,
        };
      },
    },
    {
      name: "vm_ui_open_url",
      description: "Open an http(s) URL in the VM's interactive user session through the Windows Run dialog",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          url: { type: "string", description: "http:// or https:// URL to open" },
          ...recoveryProperties,
          find_timeout_ms: { type: "number", description: "Run dialog edit-field wait timeout" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "url"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          openUrlWithUi(client, params.url, {
            findTimeoutMs: sanitizeTimeout(params.find_timeout_ms as number | undefined, 5_000),
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...uiActionJson(name, result), url: result.url }, null, 2),
            },
          ],
          isError: !result.success,
        };
      },
    },
    {
      name: "vm_ui_navigate_url",
      description: "Navigate an already-open browser by focusing the address bar, typing an http(s) URL, submitting it, and optionally verifying the address value",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name" },
          url: { type: "string", description: "http:// or https:// URL to navigate to" },
          address_selector: {
            type: "string",
            description: "Selector for the browser address bar action target",
          },
          address_edit_selector: {
            type: "string",
            description: "Selector for the address bar edit control used for typing",
          },
          expected_value: {
            type: "string",
            description: "Expected UI Automation value after navigation; defaults to the browser-displayed URL",
          },
          verify: {
            type: "boolean",
            description: "Whether to wait for the expected address value after submitting, default true",
          },
          ...recoveryProperties,
          find_timeout_ms: { type: "number", description: "Address value verification wait timeout" },
          timeout_ms: { type: "number", description: "RPC timeout" },
        },
        required: ["name", "url"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeVmName(params.name as string);
        const client = await getClient(name);
        const result = await withUiSidecarRecovery(client, recoveryOptions(params), () =>
          navigateUrlWithUi(client, params.url, {
            addressSelector: params.address_selector as string | undefined,
            addressEditSelector: params.address_edit_selector as string | undefined,
            expectedValue: params.expected_value as string | undefined,
            verify: params.verify as boolean | undefined,
            findTimeoutMs: sanitizeTimeout(params.find_timeout_ms as number | undefined, 5_000),
            timeoutMs: sanitizeTimeout(params.timeout_ms as number | undefined),
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...uiActionJson(name, result),
                  url: result.url,
                  expected_value: result.expectedValue,
                  observed: result.observed,
                  observed_count: result.observedCount,
                },
                null,
                2,
              ),
            },
          ],
          isError: !result.success,
        };
      },
    },
  ];
}
