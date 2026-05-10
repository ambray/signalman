import type {
  BrowserActionResult,
  BrowserEvaluateResult,
  BrowserScreenshot,
  GuestAgentClient,
} from "./client.js";
import { sanitizeBrowserUrl } from "./ui-browser.js";

export interface BrowserWorkflowOptions {
  timeoutMs?: number;
}

export interface BrowserClickOptions extends BrowserWorkflowOptions {
  cssSelector: unknown;
}

export interface BrowserExpectOptions extends BrowserWorkflowOptions {
  expected?: unknown;
  pollIntervalMs?: number;
  screenshotOnFailure?: boolean;
  screenshotFormat?: "png" | "jpeg";
  fullPage?: boolean;
}

export interface BrowserSnapshotOptions extends BrowserWorkflowOptions {
  expression?: unknown;
  format?: "png" | "jpeg";
  fullPage?: boolean;
}

export interface BrowserNavigateWorkflowResult extends BrowserActionResult {
  url: string;
}

export interface BrowserClickWorkflowResult extends BrowserActionResult {
  cssSelector: string;
}

export interface BrowserExpectWorkflowResult extends BrowserEvaluateResult {
  expression: string;
  expectedJson: string | null;
  actualJson: string;
  matched: boolean;
  attempts: number;
  elapsedMs: number;
  screenshot?: BrowserScreenshot;
}

export interface BrowserSnapshotWorkflowResult {
  format: string;
  width: number;
  height: number;
  bytes: number;
  screenshot: BrowserScreenshot;
  evaluation?: BrowserEvaluateResult & {
    expression: string;
    actualJson: string;
  };
}

export function sanitizeCssSelector(value: unknown): string {
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

export function sanitizeBrowserExpression(value: unknown): string {
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

function normalizeBrowserImageFormat(value: unknown): "png" | "jpeg" {
  if (value === undefined || value === null || value === "") return "png";
  if (value === "png" || value === "jpeg") return value;
  throw new Error("format must be png or jpeg");
}

function parseJsonValue(value: string): unknown {
  if (!value) return null;
  return JSON.parse(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  return stableJson(actual) === stableJson(expected);
}

function actualPasses(actual: unknown, expected: unknown): boolean {
  if (expected !== undefined) return valuesMatch(actual, expected);
  return Boolean(actual);
}

export async function browserNavigateWorkflow(
  client: GuestAgentClient,
  value: unknown,
  options: BrowserWorkflowOptions = {},
): Promise<BrowserNavigateWorkflowResult> {
  const url = sanitizeBrowserUrl(value);
  const result = await client.browserNavigate(url, options.timeoutMs);
  return { ...result, url };
}

export async function browserClickWorkflow(
  client: GuestAgentClient,
  options: BrowserClickOptions,
): Promise<BrowserClickWorkflowResult> {
  const cssSelector = sanitizeCssSelector(options.cssSelector);
  const result = await client.browserClick(cssSelector, options.timeoutMs);
  return { ...result, cssSelector };
}

export async function browserExpectWorkflow(
  client: GuestAgentClient,
  expressionValue: unknown,
  options: BrowserExpectOptions = {},
): Promise<BrowserExpectWorkflowResult> {
  const expression = sanitizeBrowserExpression(expressionValue);
  const started = Date.now();
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 500);
  const deadline = started + timeoutMs;
  let attempts = 0;
  let last: BrowserEvaluateResult | undefined;
  let actual: unknown = null;
  let parseError = "";

  do {
    attempts += 1;
    last = await client.browserEvaluate(expression, timeoutMs);
    if (!last.success) {
      parseError = last.error;
    } else {
      try {
        actual = parseJsonValue(last.jsonValue);
        parseError = "";
        if (actualPasses(actual, options.expected)) {
          return {
            ...last,
            expression,
            expectedJson: options.expected === undefined ? null : stableJson(options.expected),
            actualJson: stableJson(actual),
            matched: true,
            attempts,
            elapsedMs: Date.now() - started,
          };
        }
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);

  const screenshot = options.screenshotOnFailure
    ? await client.browserScreenshot({
        format: normalizeBrowserImageFormat(options.screenshotFormat),
        fullPage: options.fullPage ?? false,
        timeoutMs,
      })
    : undefined;
  const fallback: BrowserEvaluateResult = last ?? {
    success: false,
    error: "browser evaluate did not run",
    jsonValue: "",
    pageTitle: "",
    pageUrl: "",
  };
  const expectedJson = options.expected === undefined ? null : stableJson(options.expected);
  const actualJson = fallback.jsonValue || stableJson(actual);
  const expectation =
    expectedJson === null ? "truthy value" : `expected JSON ${expectedJson}`;
  const error = parseError || fallback.error || `Browser expectation did not match ${expectation}`;
  return {
    ...fallback,
    success: false,
    error,
    expression,
    expectedJson,
    actualJson,
    matched: false,
    attempts,
    elapsedMs: Date.now() - started,
    screenshot,
  };
}

export async function browserSnapshotWorkflow(
  client: GuestAgentClient,
  options: BrowserSnapshotOptions = {},
): Promise<BrowserSnapshotWorkflowResult> {
  const format = normalizeBrowserImageFormat(options.format);
  const screenshot = await client.browserScreenshot({
    format,
    fullPage: options.fullPage ?? false,
    timeoutMs: options.timeoutMs,
  });
  let evaluation: BrowserSnapshotWorkflowResult["evaluation"];
  if (options.expression !== undefined && options.expression !== null) {
    const expression = sanitizeBrowserExpression(options.expression);
    const result = await client.browserEvaluate(expression, options.timeoutMs);
    evaluation = {
      ...result,
      expression,
      actualJson: result.jsonValue,
    };
  }
  return {
    format: screenshot.format,
    width: screenshot.width,
    height: screenshot.height,
    bytes: screenshot.imageData.length,
    screenshot,
    evaluation,
  };
}
