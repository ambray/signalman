/**
 * Assertion evaluator — evaluates machine-readable assertions from
 * assertions.yaml files against scenario execution results.
 *
 * Supports assertion types:
 * - json_field: Query a JSON file/output, extract a field by path, compare
 * - file_exists: Check if a file exists on the guest VM
 * - process_running: Check if a process is running on the guest
 * - exit_code: Check last command's exit code
 * - network_reachable: Check if host:port is reachable from guest
 * - stdout_matches: Regex match on command stdout
 * - stdout_contains: Substring match on command stdout
 * - command_output: Legacy type (stdout_contains + stdout_matches via expect)
 * - screenshot_check: Screenshot-based assertion (pass-through in automated mode)
 * - process_state: Legacy process state check via JSON field
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single assertion from assertions.yaml. */
export interface Assertion {
  id: string;
  type: string;
  severity?: "critical" | "high" | "medium" | "low";
  description?: string;
  /** type-specific fields */
  [key: string]: unknown;
}

/** Result of evaluating a single assertion. */
export interface AssertionResult {
  id: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  message: string;
  severity: string;
  duration_ms: number;
}

/** Result of running a command — mirrors guest client's CommandResult. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Context provided to assertion evaluation — contains all outputs from
 * scenario execution.
 */
export interface EvaluationContext {
  /** Command outputs keyed by step id. */
  commandResults: Map<string, CommandResult>;
  /** Screenshots keyed by step id. */
  screenshots: Map<string, string>;
  /** Scenario directory for resolving relative file paths. */
  scenarioDir: string;
  /** Optional callback to check file existence on the guest VM. */
  guestFileExists?: (filePath: string) => Promise<boolean>;
  /** Optional callback to check if a process is running on the guest. */
  guestProcessRunning?: (name: string) => Promise<boolean>;
  /** Optional callback to test network reachability from the guest. */
  guestNetworkReachable?: (host: string, port: number) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// JSON path resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted JSON path against an object.
 *
 * Supports:
 * - Dot notation: `summary.pass`
 * - Array index: `results[0].test_id`
 * - Simple filter: `results[?test_id=='P1-assign-suspended'].result`
 *
 * @returns The resolved value, or undefined if the path cannot be resolved.
 */
export function resolveJsonPath(obj: unknown, jsonPath: string): unknown {
  if (obj === undefined || obj === null) return undefined;
  if (!jsonPath || jsonPath.length === 0) return obj;

  // Tokenize the path into segments
  const segments = tokenizePath(jsonPath);
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;

    if (segment.type === "key") {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[segment.value];
    } else if (segment.type === "index") {
      if (!Array.isArray(current)) return undefined;
      const idx = parseInt(segment.value, 10);
      if (isNaN(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (segment.type === "filter") {
      if (!Array.isArray(current)) return undefined;
      const { key, value } = segment;
      const match = current.find((item) => {
        if (typeof item !== "object" || item === null) return false;
        return String((item as Record<string, unknown>)[key]) === value;
      });
      current = match;
    }
  }

  return current;
}

interface PathSegmentKey {
  type: "key";
  value: string;
}

interface PathSegmentIndex {
  type: "index";
  value: string;
}

interface PathSegmentFilter {
  type: "filter";
  key: string;
  value: string;
}

type PathSegment = PathSegmentKey | PathSegmentIndex | PathSegmentFilter;

/**
 * Tokenize a JSON path string into segments.
 *
 * Examples:
 * - "summary.pass" -> [{type:"key",value:"summary"},{type:"key",value:"pass"}]
 * - "results[0].id" -> [{type:"key",value:"results"},{type:"index",value:"0"},{type:"key",value:"id"}]
 * - "results[?key=='val'].x" -> [{type:"key",value:"results"},{type:"filter",key:"key",value:"val"},{type:"key",value:"x"}]
 */
function tokenizePath(jsonPath: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let remaining = jsonPath;

  while (remaining.length > 0) {
    // Leading dot — skip
    if (remaining.startsWith(".")) {
      remaining = remaining.slice(1);
      continue;
    }

    // Filter: [?key=='value'] or [?key=="value"]
    const filterMatch = remaining.match(
      /^(\w+)?\[?\?(\w+)==['"]([^'"]*)['"]\]?/,
    );
    if (filterMatch && remaining.includes("[?")) {
      // Parse more carefully
      const filterRegex =
        /^(\w+)?\[\?(\w+)==['"]([^'"]*)['"]\]/;
      const fm = remaining.match(filterRegex);
      if (fm) {
        if (fm[1]) {
          segments.push({ type: "key", value: fm[1] });
        }
        segments.push({ type: "filter", key: fm[2], value: fm[3] });
        remaining = remaining.slice(fm[0].length);
        continue;
      }
    }

    // Array index: key[0] or just [0]
    const indexMatch = remaining.match(/^(\w+)\[(\d+)\]/);
    if (indexMatch) {
      segments.push({ type: "key", value: indexMatch[1] });
      segments.push({ type: "index", value: indexMatch[2] });
      remaining = remaining.slice(indexMatch[0].length);
      continue;
    }

    // Bare index: [0]
    const bareIndexMatch = remaining.match(/^\[(\d+)\]/);
    if (bareIndexMatch) {
      segments.push({ type: "index", value: bareIndexMatch[1] });
      remaining = remaining.slice(bareIndexMatch[0].length);
      continue;
    }

    // Key: up to the next dot or bracket
    const keyMatch = remaining.match(/^(\w+)/);
    if (keyMatch) {
      segments.push({ type: "key", value: keyMatch[1] });
      remaining = remaining.slice(keyMatch[0].length);
      continue;
    }

    // Unknown character — skip to avoid infinite loop
    remaining = remaining.slice(1);
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Compare two values using the specified comparison operator.
 *
 * @param actual - The actual value from the data.
 * @param expected - The expected value from the assertion.
 * @param comparison - The comparison operator (default "eq").
 * @returns True if the comparison passes.
 */
export function compareValues(
  actual: unknown,
  expected: unknown,
  comparison: string = "eq",
): boolean {
  switch (comparison) {
    case "eq":
      return deepEqual(actual, expected);
    case "not_eq":
      return !deepEqual(actual, expected);
    case "gt":
      return toNumber(actual) > toNumber(expected);
    case "gte":
      return toNumber(actual) >= toNumber(expected);
    case "lt":
      return toNumber(actual) < toNumber(expected);
    case "lte":
      return toNumber(actual) <= toNumber(expected);
    case "contains":
      return String(actual).includes(String(expected));
    case "includes":
      return valueIncludes(actual, expected);
    default:
      return deepEqual(actual, expected);
  }
}

function valueIncludes(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => deepEqual(item, expected));
  }
  return String(actual).includes(String(expected));
}

function toNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Compare booleans and their string representations
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  // Numeric equality (e.g., 6 == 6)
  if (typeof a === "number" && typeof b === "number") return a === b;
  // Coerce for comparison: "true" == true, "6" == 6
  if (typeof a !== typeof b) {
    return String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Assertion evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a set of assertions against scenario execution context.
 */
export class AssertionEvaluator {
  constructor(private readonly ctx: EvaluationContext) {}

  /**
   * Evaluate all assertions and return results.
   */
  async evaluateAll(assertions: Assertion[]): Promise<AssertionResult[]> {
    const results: AssertionResult[] = [];
    for (const assertion of assertions) {
      results.push(await this.evaluate(assertion));
    }
    return results;
  }

  /**
   * Evaluate a single assertion.
   */
  async evaluate(assertion: Assertion): Promise<AssertionResult> {
    const start = Date.now();
    const severity = assertion.severity ?? "medium";

    try {
      switch (assertion.type) {
        case "json_field":
          return this.evalJsonField(assertion, start, severity);
        case "file_exists":
          return await this.evalFileExists(assertion, start, severity);
        case "process_running":
          return await this.evalProcessRunning(assertion, start, severity);
        case "exit_code":
          return this.evalExitCode(assertion, start, severity);
        case "network_reachable":
          return await this.evalNetworkReachable(assertion, start, severity);
        case "stdout_matches":
          return this.evalStdoutMatches(assertion, start, severity);
        case "stdout_contains":
          return this.evalStdoutContains(assertion, start, severity);
        case "command_output":
          return this.evalCommandOutput(assertion, start, severity);
        case "screenshot_check":
          return this.evalScreenshotCheck(assertion, start, severity);
        case "process_state":
          return this.evalProcessState(assertion, start, severity);
        default:
          return this.makeResult(
            assertion.id,
            false,
            undefined,
            undefined,
            `Unknown assertion type: ${assertion.type}`,
            severity,
            start,
          );
      }
    } catch (e) {
      return this.makeResult(
        assertion.id,
        false,
        undefined,
        undefined,
        `Assertion evaluation error: ${e}`,
        severity,
        start,
      );
    }
  }

  // ── json_field ────────────────────────────────────────────────────

  private evalJsonField(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const source = assertion.source as string | undefined;
    const field = assertion.field as string | undefined;
    const expected = assertion.expected;
    const comparison = (assertion.comparison as string) ?? "eq";

    if (!source) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "json_field assertion missing 'source'", severity, start);
    }
    if (!field) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "json_field assertion missing 'field'", severity, start);
    }

    // Try to load from command output first, then from file
    let jsonData: unknown;
    const cmdResult = this.ctx.commandResults.get(source);
    if (cmdResult) {
      try {
        jsonData = JSON.parse(cmdResult.stdout);
      } catch {
        return this.makeResult(assertion.id, false, cmdResult.stdout, expected,
          `Failed to parse JSON from command output '${source}'`, severity, start);
      }
    } else {
      // Try as file path relative to scenario dir
      const filePath = path.resolve(this.ctx.scenarioDir, source);
      if (!fs.existsSync(filePath)) {
        return this.makeResult(assertion.id, false, undefined, expected,
          `Source not found: '${source}' (not in command outputs, file not found at '${filePath}')`,
          severity, start);
      }
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        jsonData = JSON.parse(content);
      } catch (e) {
        return this.makeResult(assertion.id, false, undefined, expected,
          `Failed to parse JSON file '${filePath}': ${e}`, severity, start);
      }
    }

    const actual = resolveJsonPath(jsonData, field);
    if (actual === undefined) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `Field '${field}' not found in JSON data`, severity, start);
    }

    const passed = compareValues(actual, expected, comparison);
    const op = comparison === "eq" ? "==" : comparison;
    const msg = passed
      ? `Field '${field}' ${op} ${JSON.stringify(expected)} (actual: ${JSON.stringify(actual)})`
      : `Field '${field}': expected ${op} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;

    return this.makeResult(assertion.id, passed, actual, expected, msg, severity, start);
  }

  // ── file_exists ───────────────────────────────────────────────────

  private async evalFileExists(
    assertion: Assertion,
    start: number,
    severity: string,
  ): Promise<AssertionResult> {
    const filePath = assertion.path as string | undefined;
    const expected = assertion.expected !== false; // default true

    if (!filePath) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "file_exists assertion missing 'path'", severity, start);
    }

    let exists: boolean;
    if (this.ctx.guestFileExists) {
      exists = await this.ctx.guestFileExists(filePath);
    } else {
      // Fallback: check local filesystem
      exists = fs.existsSync(filePath);
    }

    const passed = exists === expected;
    const msg = passed
      ? `File '${filePath}' ${expected ? "exists" : "does not exist"} as expected`
      : `File '${filePath}': expected ${expected ? "to exist" : "not to exist"}, but ${exists ? "it exists" : "it does not"}`;

    return this.makeResult(assertion.id, passed, exists, expected, msg, severity, start);
  }

  // ── process_running ───────────────────────────────────────────────

  private async evalProcessRunning(
    assertion: Assertion,
    start: number,
    severity: string,
  ): Promise<AssertionResult> {
    const name = assertion.name as string | undefined;
    const expected = assertion.expected !== false;

    if (!name) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "process_running assertion missing 'name'", severity, start);
    }

    if (!this.ctx.guestProcessRunning) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "process_running assertion requires guestProcessRunning callback",
        severity, start);
    }

    const running = await this.ctx.guestProcessRunning(name);
    const passed = running === expected;
    const msg = passed
      ? `Process '${name}' is ${expected ? "running" : "not running"} as expected`
      : `Process '${name}': expected ${expected ? "running" : "not running"}, but ${running ? "it is running" : "it is not"}`;

    return this.makeResult(assertion.id, passed, running, expected, msg, severity, start);
  }

  // ── exit_code ─────────────────────────────────────────────────────

  private evalExitCode(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const expected = assertion.expected as number | undefined;
    const source = assertion.source as string | undefined;

    if (expected === undefined) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        "exit_code assertion missing 'expected'", severity, start);
    }

    // Find the last command result if no source specified
    let cmdResult: CommandResult | undefined;
    if (source) {
      cmdResult = this.ctx.commandResults.get(source);
    } else {
      // Use the last command result
      const entries = Array.from(this.ctx.commandResults.entries());
      if (entries.length > 0) {
        cmdResult = entries[entries.length - 1][1];
      }
    }

    if (!cmdResult) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `No command result found${source ? ` for source '${source}'` : ""}`,
        severity, start);
    }

    const actual = cmdResult.exitCode;
    const passed = actual === expected;
    const msg = passed
      ? `Exit code is ${expected} as expected`
      : `Exit code: expected ${expected}, got ${actual}`;

    return this.makeResult(assertion.id, passed, actual, expected, msg, severity, start);
  }

  // ── network_reachable ─────────────────────────────────────────────

  private async evalNetworkReachable(
    assertion: Assertion,
    start: number,
    severity: string,
  ): Promise<AssertionResult> {
    const host = assertion.host as string | undefined;
    const port = assertion.port as number | undefined;
    const expected = assertion.expected !== false;

    if (!host) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "network_reachable assertion missing 'host'", severity, start);
    }
    if (port === undefined) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "network_reachable assertion missing 'port'", severity, start);
    }

    if (!this.ctx.guestNetworkReachable) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "network_reachable assertion requires guestNetworkReachable callback",
        severity, start);
    }

    const reachable = await this.ctx.guestNetworkReachable(host, port);
    const passed = reachable === expected;
    const msg = passed
      ? `${host}:${port} is ${expected ? "reachable" : "not reachable"} as expected`
      : `${host}:${port}: expected ${expected ? "reachable" : "not reachable"}, but ${reachable ? "it is reachable" : "it is not"}`;

    return this.makeResult(assertion.id, passed, reachable, expected, msg, severity, start);
  }

  // ── stdout_matches ────────────────────────────────────────────────

  private evalStdoutMatches(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const pattern = assertion.pattern as string | undefined;
    const expected = assertion.expected !== false;
    const source = assertion.source as string | undefined;

    if (!pattern) {
      return this.makeResult(assertion.id, false, undefined, expected,
        "stdout_matches assertion missing 'pattern'", severity, start);
    }

    // S-04: Guard against ReDoS — reject excessively long patterns and
    // validate that the regex compiles before executing it.
    const MAX_PATTERN_LENGTH = 500;
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `Regex pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters (got ${pattern.length})`,
        severity, start);
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `Invalid regex pattern '${pattern}': ${e}`, severity, start);
    }

    const stdout = this.getStdout(source);
    if (stdout === undefined) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `No command output found${source ? ` for source '${source}'` : ""}`,
        severity, start);
    }

    // NOTE: Node.js does not support native regex execution timeouts.
    // The pattern length guard above (500 chars) mitigates the most common
    // ReDoS vectors.  For full protection, consider the `re2` package.
    let matches: boolean;
    try {
      matches = regex.test(stdout);
    } catch (e) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `Regex execution error on pattern '${pattern}': ${e}`, severity, start);
    }

    const passed = matches === expected;
    const msg = passed
      ? `stdout ${expected ? "matches" : "does not match"} /${pattern}/ as expected`
      : `stdout: expected ${expected ? "to match" : "not to match"} /${pattern}/, but it ${matches ? "matched" : "did not"}`;

    return this.makeResult(assertion.id, passed, matches, expected, msg, severity, start);
  }

  // ── stdout_contains ───────────────────────────────────────────────

  private evalStdoutContains(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const expected = assertion.expected as string | undefined;
    const source = assertion.source as string | undefined;

    if (expected === undefined) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        "stdout_contains assertion missing 'expected'", severity, start);
    }

    const stdout = this.getStdout(source);
    if (stdout === undefined) {
      return this.makeResult(assertion.id, false, undefined, expected,
        `No command output found${source ? ` for source '${source}'` : ""}`,
        severity, start);
    }

    const contains = stdout.includes(expected);
    const msg = contains
      ? `stdout contains '${expected}'`
      : `stdout does not contain '${expected}'`;

    return this.makeResult(assertion.id, contains, stdout, expected, msg, severity, start);
  }

  // ── command_output (legacy) ───────────────────────────────────────

  private evalCommandOutput(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const source = assertion.source as string | undefined;
    const expect_ = assertion.expect as Record<string, unknown> | undefined;

    if (!source) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        "command_output assertion missing 'source'", severity, start);
    }

    const cmdResult = this.ctx.commandResults.get(source);
    if (!cmdResult) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        `No output captured for source: ${source}`, severity, start);
    }

    const stdout = cmdResult.stdout;
    let passed = false;

    if (expect_?.stdout_contains) {
      passed = stdout.includes(expect_.stdout_contains as string);
    }
    if (expect_?.stdout_matches) {
      const pat = expect_.stdout_matches as string;
      if (pat.length > 500) {
        return this.makeResult(assertion.id, false, stdout, expect_,
          `Regex pattern too long (${pat.length} chars, max 500)`, severity, start);
      }
      try {
        const regex = new RegExp(pat);
        passed = regex.test(stdout);
      } catch (e) {
        return this.makeResult(assertion.id, false, stdout, expect_,
          `Invalid regex pattern '${pat}': ${e}`, severity, start);
      }
    }

    return this.makeResult(assertion.id, passed, stdout, expect_,
      passed ? "Command output matches expectation" : "Command output does not match expectation",
      severity, start);
  }

  // ── screenshot_check (legacy) ─────────────────────────────────────

  private evalScreenshotCheck(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const source = assertion.source as string | undefined;

    if (!source) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        "screenshot_check assertion missing 'source'", severity, start);
    }

    const screenshotPath = this.ctx.screenshots.get(source);
    if (!screenshotPath) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        `Screenshot not captured: ${source}`, severity, start);
    }

    // In automated mode, we trust the screenshot exists
    return this.makeResult(assertion.id, true, `Screenshot captured: ${screenshotPath}`,
      undefined, `Screenshot '${source}' captured`, severity, start);
  }

  // ── process_state (legacy) ────────────────────────────────────────

  private evalProcessState(
    assertion: Assertion,
    start: number,
    severity: string,
  ): AssertionResult {
    const source = assertion.source as string | undefined;
    const expect_ = assertion.expect as Record<string, unknown> | undefined;

    if (!source) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        "process_state assertion missing 'source'", severity, start);
    }

    const cmdResult = this.ctx.commandResults.get(source);
    if (!cmdResult) {
      return this.makeResult(assertion.id, false, undefined, undefined,
        `No output for source: ${source}`, severity, start);
    }

    let passed = false;
    if (expect_?.json_field) {
      try {
        const json = JSON.parse(cmdResult.stdout);
        const field = json[expect_.json_field as string];
        if (expect_.json_field_not_equals !== undefined) {
          passed = field !== expect_.json_field_not_equals;
        }
      } catch {
        return this.makeResult(assertion.id, false, cmdResult.stdout, expect_,
          "Failed to parse JSON output", severity, start);
      }
    }

    return this.makeResult(assertion.id, passed, cmdResult.stdout, expect_,
      passed ? "Process state matches" : "Process state does not match",
      severity, start);
  }

  // ── helpers ───────────────────────────────────────────────────────

  /**
   * Get stdout from command results. If source is provided, use that key.
   * Otherwise, use the last command result.
   */
  private getStdout(source: string | undefined): string | undefined {
    if (source) {
      const r = this.ctx.commandResults.get(source);
      return r?.stdout;
    }
    const entries = Array.from(this.ctx.commandResults.entries());
    if (entries.length === 0) return undefined;
    return entries[entries.length - 1][1].stdout;
  }

  private makeResult(
    id: string,
    passed: boolean,
    actual: unknown,
    expected: unknown,
    message: string,
    severity: string,
    start: number,
  ): AssertionResult {
    return {
      id,
      passed,
      actual,
      expected,
      message,
      severity,
      duration_ms: Date.now() - start,
    };
  }
}
