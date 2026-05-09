import type { GuestAgentClient, UiActionResult } from "./client.js";
import { describeUiBrowserTargets, describeUiElements } from "./ui-elements.js";
import type { UiBrowserTarget } from "./ui-elements.js";

export interface UiOpenUrlOptions {
  timeoutMs?: number;
  findTimeoutMs?: number;
}

export interface UiNavigateUrlOptions {
  addressSelector?: string;
  addressEditSelector?: string;
  discoverTarget?: boolean;
  expectedValue?: string;
  verify?: boolean;
  timeoutMs?: number;
  findTimeoutMs?: number;
}

export interface UiOpenUrlResult extends UiActionResult {
  url: string;
}

export interface UiNavigateUrlResult extends UiActionResult {
  url: string;
  expectedValue: string;
  observed: boolean;
  observedCount: number;
  targetSelector: string;
  targetEditSelector: string;
  targetKind: string;
  targetConfidence: number;
}

const RUN_DIALOG_EDIT_SELECTOR = "[automationId='1001']";
const RUN_DIALOG_TITLE = "Run";
const DEFAULT_BROWSER_ADDRESS_SELECTOR = "[name='Address and search bar']";
const DEFAULT_BROWSER_ADDRESS_EDIT_SELECTOR = "[automationId='view_1021']";

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

function browserDisplayedUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    return `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

function valueSelector(value: string): string {
  if (/['\]\r\n]/.test(value)) {
    throw new Error("expected browser URL value contains unsupported selector characters");
  }
  return `[value='${value}']`;
}

function emptyNavigateResult(
  url: string,
  expectedValue: string,
  targetSelector: string,
  targetEditSelector: string,
  targetKind: string,
  targetConfidence: number,
  success: boolean,
  error: string,
  durationMs: number,
): UiNavigateUrlResult {
  return {
    url,
    expectedValue,
    observed: false,
    observedCount: 0,
    targetSelector,
    targetEditSelector,
    targetKind,
    targetConfidence,
    success,
    error,
    durationMs,
  };
}

function chooseBrowserTarget(targets: UiBrowserTarget[]): UiBrowserTarget | undefined {
  return targets.find((target) => target.kind === "address_bar") ?? targets[0];
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

export async function navigateUrlWithUi(
  client: GuestAgentClient,
  value: unknown,
  options: UiNavigateUrlOptions = {},
): Promise<UiNavigateUrlResult> {
  const url = sanitizeBrowserUrl(value);
  const shouldDiscoverTarget =
    options.discoverTarget ?? (!options.addressSelector && !options.addressEditSelector);
  let addressSelector = options.addressSelector ?? DEFAULT_BROWSER_ADDRESS_SELECTOR;
  let addressEditSelector = options.addressEditSelector ?? DEFAULT_BROWSER_ADDRESS_EDIT_SELECTOR;
  let targetKind = "default";
  let targetConfidence = 0;
  const expectedValue = options.expectedValue ?? browserDisplayedUrl(url);
  const verify = options.verify ?? true;
  let durationMs = 0;

  if (shouldDiscoverTarget) {
    const discovered = await client.uiFindDetailed("", {
      findTimeoutMs: options.findTimeoutMs,
      timeoutMs: options.timeoutMs,
    });
    durationMs += discovered.durationMs;
    const target = chooseBrowserTarget(describeUiBrowserTargets(describeUiElements(discovered.elements), 10));
    if (target) {
      addressSelector = options.addressSelector ?? target.selector;
      addressEditSelector = options.addressEditSelector ?? target.edit_selector;
      targetKind = target.kind;
      targetConfidence = target.confidence;
    }
  }

  const clicked = await client.uiClick(addressSelector, { timeoutMs: options.timeoutMs });
  durationMs += clicked.durationMs;
  if (!clicked.success) {
    return emptyNavigateResult(
      url,
      expectedValue,
      addressSelector,
      addressEditSelector,
      targetKind,
      targetConfidence,
      false,
      clicked.error,
      durationMs,
    );
  }

  const focused = await client.uiKey("^l", {
    selector: addressEditSelector,
    timeoutMs: options.timeoutMs,
  });
  durationMs += focused.durationMs;
  if (!focused.success) {
    return emptyNavigateResult(
      url,
      expectedValue,
      addressSelector,
      addressEditSelector,
      targetKind,
      targetConfidence,
      false,
      focused.error,
      durationMs,
    );
  }

  const typed = await client.uiType(url, {
    selector: addressEditSelector,
    clearFirst: true,
    timeoutMs: options.timeoutMs,
  });
  durationMs += typed.durationMs;
  if (!typed.success) {
    return emptyNavigateResult(
      url,
      expectedValue,
      addressSelector,
      addressEditSelector,
      targetKind,
      targetConfidence,
      false,
      typed.error,
      durationMs,
    );
  }

  const submitted = await client.uiKey("{ENTER}", {
    selector: addressEditSelector,
    timeoutMs: options.timeoutMs,
  });
  durationMs += submitted.durationMs;
  if (!submitted.success) {
    return emptyNavigateResult(
      url,
      expectedValue,
      addressSelector,
      addressEditSelector,
      targetKind,
      targetConfidence,
      false,
      submitted.error,
      durationMs,
    );
  }

  if (!verify) {
    return {
      url,
      expectedValue,
      observed: false,
      observedCount: 0,
      targetSelector: addressSelector,
      targetEditSelector: addressEditSelector,
      targetKind,
      targetConfidence,
      success: true,
      error: "",
      durationMs,
    };
  }

  const observed = await client.uiFindDetailed(valueSelector(expectedValue), {
    findTimeoutMs: options.findTimeoutMs,
    timeoutMs: options.timeoutMs,
  });
  durationMs += observed.durationMs;
  const observedCount = observed.elements.length;
  return {
    url,
    expectedValue,
    observed: observedCount > 0,
    observedCount,
    targetSelector: addressSelector,
    targetEditSelector: addressEditSelector,
    targetKind,
    targetConfidence,
    success: observedCount > 0,
    error: observedCount > 0 ? "" : `Browser URL value not observed: ${expectedValue}`,
    durationMs,
  };
}
