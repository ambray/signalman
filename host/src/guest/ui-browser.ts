import type { GuestAgentClient, UiActionResult } from "./client.js";

export interface UiOpenUrlOptions {
  timeoutMs?: number;
  findTimeoutMs?: number;
}

export interface UiOpenUrlResult extends UiActionResult {
  url: string;
}

const RUN_DIALOG_EDIT_SELECTOR = "[automationId='1001']";
const RUN_DIALOG_TITLE = "Run";

export function sanitizeBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("url must be a valid http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http:// or https://");
  }

  if (parsed.username || parsed.password) {
    throw new Error("url must not include embedded credentials");
  }

  return parsed.toString();
}

export async function openUrlWithUi(
  client: GuestAgentClient,
  value: unknown,
  options: UiOpenUrlOptions = {},
): Promise<UiOpenUrlResult> {
  const url = sanitizeBrowserUrl(value);
  let durationMs = 0;

  const openRun = await client.uiKey("#r", { timeoutMs: options.timeoutMs });
  durationMs += openRun.durationMs;
  if (!openRun.success) {
    return { url, success: false, error: openRun.error, durationMs };
  }

  const runEdit = await client.uiFindDetailed(RUN_DIALOG_EDIT_SELECTOR, {
    windowTitle: RUN_DIALOG_TITLE,
    findTimeoutMs: options.findTimeoutMs ?? 5_000,
    timeoutMs: options.timeoutMs,
  });
  durationMs += runEdit.durationMs;
  if (runEdit.elements.length === 0) {
    return {
      url,
      success: false,
      error: `Run dialog edit field not found: ${RUN_DIALOG_EDIT_SELECTOR}`,
      durationMs,
    };
  }

  const typed = await client.uiType(url, {
    selector: RUN_DIALOG_EDIT_SELECTOR,
    windowTitle: RUN_DIALOG_TITLE,
    clearFirst: true,
    timeoutMs: options.timeoutMs,
  });
  durationMs += typed.durationMs;
  if (!typed.success) {
    return { url, success: false, error: typed.error, durationMs };
  }

  const submitted = await client.uiKey("{ENTER}", {
    windowTitle: RUN_DIALOG_TITLE,
    timeoutMs: options.timeoutMs,
  });
  durationMs += submitted.durationMs;
  if (!submitted.success) {
    return { url, success: false, error: submitted.error, durationMs };
  }

  return { url, success: true, error: "", durationMs };
}
