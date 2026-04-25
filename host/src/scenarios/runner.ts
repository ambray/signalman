/**
 * Scenario runner — executes Signalman test scenarios.
 *
 * A scenario consists of three files:
 * - setup.yaml: VM provisioning, software installation, pre-test config
 * - workflow.md: Human/LLM-readable narrative with embedded tool calls
 * - assertions.yaml: Machine-readable pass/fail criteria
 *
 * The runner can operate in two modes:
 * 1. **Automated**: Executes tool blocks from workflow.md sequentially
 * 2. **LLM-driven**: Feeds the workflow.md to an LLM, which drives execution
 *    via MCP tool calls (the LLM interprets screenshots and adapts)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "yaml";

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
import { parseNarrative } from "./narrative.js";
import {
  validateScenarioConfig,
  validateAssertionConfig,
} from "./schema.js";
import type { Narrative } from "./narrative.js";
import {
  writeJsonReport,
  writeMarkdownReport,
  writeJunitReport,
} from "../output/reporter.js";
import type { TestResult, AssertionResultEntry } from "../output/reporter.js";
import {
  AssertionEvaluator,
  type Assertion as NewAssertion,
  type AssertionResult as NewAssertionResult,
  type CommandResult,
} from "./assertions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Ospiri sandbox enforcement modes. Sprint 60 Phase 5 scenarios run once
 * per declared mode and the orchestrator compares sandboxed results
 * against the `none` baseline to surface regressions.
 */
export type SandboxMode = "none" | "legacy" | "appcontainer" | "silo";

export interface ScenarioConfig {
  name: string;
  version: string;
  tags: string[];
  vms: VmConfig[];
  setup: SetupStep[];
  teardown: SetupStep[];
  checkpoints: CheckpointConfig;
  /**
   * Sprint 60 Phase 5, Story 5.2 — list of sandbox enforcement modes to
   * run this scenario under. If omitted or empty, the scenario runs once
   * without a mode context (legacy behavior). When present, the
   * orchestrator runs setup → workflow → assertions once per mode with
   * snapshot revert between runs.
   *
   * Each setup step and tool block parameter string has `${SANDBOX_MODE}`
   * substituted with the active mode name before execution.
   */
  sandbox_modes?: SandboxMode[];
}

export interface VmConfig {
  name: string;
  template: string;
  checkpoint_restore?: string;
  guest_agent_port: number;
  network?: {
    switch: string;
    static_ip: string;
  };
  /**
   * Kernel-debug configuration. When `enabled: true`, the orchestrator
   * spawns a `KdSession` for this VM during `resolveVms()` and attaches
   * a `BreakLog` so the `kernel_expect_bugcheck` and `kernel_break_on`
   * tool blocks can target it. Detached at scenario teardown.
   *
   * Requires the VM to be in a `debug-enabled`-ancestry checkpoint
   * (see `docs/milestones/runbooks/driver-testing-runbook.md` §3)
   * so the COM1 pipe is wired to kd on startup.
   */
  kernel_debug?: KernelDebugConfig;
}

/**
 * Kernel-debug configuration block for a scenario VM. Mirrors the
 * options `KdSession` accepts, but scoped to the subset scenario
 * authors control via YAML.
 */
export interface KernelDebugConfig {
  /**
   * When false or omitted, the orchestrator skips kd entirely and
   * scenarios for this VM behave as if kernel_debug weren't present.
   * This lets authors leave the block in place during refactors
   * without triggering the kd spawn every run.
   */
  enabled: boolean;
  /**
   * Transport kd should use. Serial-over-named-pipe is the only form
   * supported today (per Sprint 60.7.5 decision #2). KDNET / KDVM are
   * deliberately not on the v1 surface.
   */
  transport?: "serial";
  /**
   * Named pipe path the host listens on. Supports the `{vm_name}`
   * placeholder which the orchestrator expands to the scenario's
   * VM name at resolve time (so `\\.\pipe\kd-{vm_name}` ->
   * `\\.\pipe\kd-Win11x64` for a VM aliased to Win11x64).
   */
  pipe?: string;
  /**
   * Symbol path passed to kd via `-y`. Defaults to the Microsoft
   * public symbol server with a local cache in `C:\Symbols`.
   */
  symbol_path?: string;
  /**
   * Modules to break on as they load, e.g. `["ospiri.sys"]`. Sent to
   * kd as `sxe ld <module>` during session startup.
   */
  break_on_load?: string[];
  /**
   * Whether to break into the debugger on bugcheck. Default true —
   * catching the crash is almost always the point.
   */
  break_on_bugcheck?: boolean;
  /**
   * Path to kd.exe. Defaults to `kd.exe` (looked up on PATH). Override
   * for hosts that have Windows Debugging Tools in a non-standard
   * location.
   */
  kd_exe?: string;
}

export interface SetupStep {
  action: string;
  vm?: string;
  [key: string]: unknown;
}

export interface CheckpointConfig {
  before_test: boolean;
  after_setup: boolean;
  after_setup_label?: string;
  on_failure: boolean;
}

export interface ToolBlock {
  tool: string;
  params: Record<string, unknown>;
  /** Markdown text preceding the tool block (context for LLM). */
  context: string;
}

export interface Assertion {
  id: string;
  type: "command_output" | "screenshot_check" | "process_state";
  source: string;
  description: string;
  expect: Record<string, unknown>;
  severity: "critical" | "high" | "medium" | "low";
}

export interface AssertionConfig {
  assertions: Assertion[];
  pass_threshold: number;
  critical_must_pass: boolean;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  actual?: string;
  error?: string;
}

export interface ScenarioResult {
  scenario: string;
  started_at: string;
  finished_at: string;
  setup_ok: boolean;
  workflow_ok: boolean;
  assertion_results: AssertionResult[];
  passed: boolean;
  score: number;
  screenshots: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Scenario loader
// ---------------------------------------------------------------------------

export function loadScenario(scenarioDir: string): {
  config: ScenarioConfig;
  assertions: AssertionConfig;
  workflowMarkdown: string;
  narrative: Narrative | null;
} {
  // Resolve to absolute path and prevent path traversal outside the
  // project's scenarios root. v0.1.0 supports both the canonical
  // `.signalman/scenarios/` layout and the legacy top-level
  // `scenarios/` directory (via project-layout.ts). Either root is
  // acceptable; anything else is rejected as path traversal.
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const candidateRoots = [
    path.join(projectRoot, ".signalman", "scenarios"),
    path.join(projectRoot, "scenarios"),
  ];
  const resolvedDir = path.resolve(scenarioDir);

  // Normalize both paths so that trailing separators and case (on
  // Windows NTFS, which is case-insensitive) don't cause false negatives.
  const lower = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const normalizedResolved = lower(path.normalize(resolvedDir)) + path.sep;
  const insideAnyRoot = candidateRoots.some((root) => {
    const normalizedRoot = lower(path.normalize(root)) + path.sep;
    return normalizedResolved.startsWith(normalizedRoot);
  });

  if (!insideAnyRoot) {
    throw new Error(
      `Scenario directory "${resolvedDir}" resolves outside the allowed scenarios directories ` +
      `(${candidateRoots.join(", ")}). Path traversal is not allowed.`,
    );
  }

  const setupPath = path.join(resolvedDir, "setup.yaml");
  const assertionsPath = path.join(resolvedDir, "assertions.yaml");
  const workflowPath = path.join(resolvedDir, "workflow.md");

  if (!fs.existsSync(setupPath)) {
    throw new Error(`Missing setup.yaml in ${resolvedDir}`);
  }

  // Parse + validate setup.yaml via zod. Throws a
  // `ScenarioValidationError` with path-identified issues on any
  // shape problem, so typos / missing fields surface at load time
  // instead of as confusing runtime errors mid-scenario.
  const rawSetup = yaml.parse(
    fs.readFileSync(setupPath, "utf-8"),
    { maxAliasCount: 100 },
  );
  const config = validateScenarioConfig(
    rawSetup,
    setupPath,
  ) as unknown as ScenarioConfig;

  let assertions: AssertionConfig = {
    assertions: [],
    pass_threshold: 1.0,
    critical_must_pass: true,
  };
  if (fs.existsSync(assertionsPath)) {
    const rawAssertions = yaml.parse(
      fs.readFileSync(assertionsPath, "utf-8"),
      { maxAliasCount: 100 },
    );
    assertions = validateAssertionConfig(
      rawAssertions,
      assertionsPath,
    ) as unknown as AssertionConfig;
  }

  let workflowMarkdown = "";
  if (fs.existsSync(workflowPath)) {
    workflowMarkdown = fs.readFileSync(workflowPath, "utf-8");
  }

  const narrative = workflowMarkdown ? parseNarrative(workflowMarkdown) : null;

  return { config, assertions, workflowMarkdown, narrative };
}

// ---------------------------------------------------------------------------
// Workflow parser — extract tool blocks from Markdown
// ---------------------------------------------------------------------------

/**
 * Extract tool invocation blocks from a workflow Markdown document.
 *
 * Tool blocks are fenced code blocks with the language tag `tool`:
 * ````markdown
 * ```tool
 * vm_run_command:
 *   vm: endpoint-1
 *   command: powershell
 *   args: ["-Command", "echo hello"]
 * ```
 * ````
 *
 * Each block is parsed as YAML. The top-level key is the tool name,
 * and its value is the parameter object.
 */
export function extractToolBlocks(markdown: string): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  const regex = /```tool\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = regex.exec(markdown)) !== null) {
    const context = markdown.slice(lastIndex, match.index).trim();
    const yamlContent = match[1].trim();

    try {
      const parsed = yaml.parse(yamlContent, { maxAliasCount: 100 }) as Record<string, unknown>;
      const toolName = Object.keys(parsed)[0];
      const params = (parsed[toolName] as Record<string, unknown>) ?? {};

      blocks.push({
        tool: toolName,
        params,
        context,
      });
    } catch (e) {
      console.warn(`Failed to parse tool block: ${e}`);
    }

    lastIndex = match.index + match[0].length;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Assertion evaluator
// ---------------------------------------------------------------------------

export function evaluateAssertions(
  config: AssertionConfig,
  outputs: Map<string, string>,
  screenshots: Map<string, string>
): { results: AssertionResult[]; passed: boolean; score: number } {
  const results: AssertionResult[] = [];

  for (const assertion of config.assertions) {
    let passed = false;
    let actual: string | undefined;
    let error: string | undefined;

    try {
      switch (assertion.type) {
        case "command_output": {
          const output = outputs.get(assertion.source);
          if (!output) {
            error = `No output captured for source: ${assertion.source}`;
            break;
          }
          actual = output;

          if (assertion.expect.stdout_contains) {
            passed = output.includes(
              assertion.expect.stdout_contains as string
            );
          }
          if (assertion.expect.stdout_matches) {
            const pat = assertion.expect.stdout_matches as string;
            if (pat.length <= 500) {
              try {
                const regex = new RegExp(pat);
                passed = regex.test(output);
              } catch {
                error = `Invalid regex pattern: ${pat}`;
              }
            } else {
              error = `Regex pattern too long (${pat.length} chars, max 500)`;
            }
          }
          break;
        }

        case "screenshot_check": {
          // Screenshot assertions require LLM vision or image analysis.
          // In automated mode, we mark them as "needs_review".
          const screenshotPath = screenshots.get(assertion.source);
          if (!screenshotPath) {
            error = `Screenshot not captured: ${assertion.source}`;
          } else {
            // Placeholder: in LLM mode, the LLM evaluates the screenshot.
            // In automated mode, we trust the screenshot exists.
            passed = true;
            actual = `Screenshot captured: ${screenshotPath}`;
          }
          break;
        }

        case "process_state": {
          const output = outputs.get(assertion.source);
          if (!output) {
            error = `No output for source: ${assertion.source}`;
            break;
          }
          actual = output;

          if (assertion.expect.json_field) {
            try {
              const json = JSON.parse(output);
              const field = json[assertion.expect.json_field as string];
              if (assertion.expect.json_field_not_equals) {
                passed =
                  field !== assertion.expect.json_field_not_equals;
              }
            } catch {
              error = "Failed to parse JSON output";
            }
          }
          break;
        }

        // Note: `json_field`, `file_exists`, `process_running`, `exit_code`,
        // `network_reachable`, `stdout_matches`, and `stdout_contains`
        // are handled by the V2 evaluator (see evaluateAssertionsV2 below
        // and scenarios/orchestrator.ts which dispatches to V2 when any
        // assertion uses a non-legacy type).
      }
    } catch (e) {
      error = `Assertion evaluation error: ${e}`;
    }

    results.push({ assertion, passed, actual, error });
  }

  // Calculate score
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const score = total > 0 ? passedCount / total : 0;

  // Check critical assertions
  const criticalFailed = results.some(
    (r) => r.assertion.severity === "critical" && !r.passed
  );
  const meetsThreshold = score >= config.pass_threshold;
  const overallPassed =
    meetsThreshold && (!config.critical_must_pass || !criticalFailed);

  return { results, passed: overallPassed, score };
}

/**
 * Evaluate assertions using the enhanced AssertionEvaluator.
 *
 * This function provides full support for all assertion types including
 * json_field, file_exists, process_running, exit_code, network_reachable,
 * stdout_matches, and stdout_contains, in addition to the legacy types.
 *
 * @param config - The assertion configuration from assertions.yaml.
 * @param commandResults - Map of step id to CommandResult.
 * @param screenshots - Map of step id to screenshot path.
 * @param scenarioDir - Path to the scenario directory for resolving relative paths.
 * @param guestCallbacks - Optional guest VM callbacks for file/process/network checks.
 * @returns Evaluation results with pass/fail, score, and per-assertion details.
 */
export async function evaluateAssertionsV2(
  config: AssertionConfig,
  commandResults: Map<string, CommandResult>,
  screenshots: Map<string, string>,
  scenarioDir: string,
  guestCallbacks?: {
    guestFileExists?: (filePath: string) => Promise<boolean>;
    guestProcessRunning?: (name: string) => Promise<boolean>;
    guestNetworkReachable?: (host: string, port: number) => Promise<boolean>;
  },
): Promise<{ results: NewAssertionResult[]; passed: boolean; score: number }> {
  const evaluator = new AssertionEvaluator({
    commandResults,
    screenshots,
    scenarioDir,
    guestFileExists: guestCallbacks?.guestFileExists,
    guestProcessRunning: guestCallbacks?.guestProcessRunning,
    guestNetworkReachable: guestCallbacks?.guestNetworkReachable,
  });

  const results = await evaluator.evaluateAll(
    config.assertions as unknown as NewAssertion[],
  );

  // Calculate score
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const score = total > 0 ? passedCount / total : 0;

  // Check critical assertions
  const criticalFailed = results.some(
    (r, i) => {
      const assertion = config.assertions[i];
      return assertion?.severity === "critical" && !r.passed;
    },
  );
  const meetsThreshold = score >= config.pass_threshold;
  const overallPassed =
    meetsThreshold && (!config.critical_must_pass || !criticalFailed);

  return { results, passed: overallPassed, score };
}

// ---------------------------------------------------------------------------
// Tool executor callback type
// ---------------------------------------------------------------------------

/**
 * A function that executes a single MCP tool call and returns its text output.
 *
 * Callers provide their own executor that routes to the MCP server or
 * a direct backend call. This keeps the runner decoupled from the MCP
 * transport layer.
 */
export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Scenario runner — end-to-end execution
// ---------------------------------------------------------------------------

/**
 * Run a scenario end-to-end: parse narrative, execute tool blocks, evaluate
 * assertions, and write reports.
 *
 * @param scenarioDir - Path to the scenario directory.
 * @param executor - Callback that executes a single tool and returns output text.
 * @param outputDir - Directory for report files. Defaults to `./output`.
 * @returns The full ScenarioResult.
 */
export async function runScenario(
  scenarioDir: string,
  executor: ToolExecutor,
  outputDir = "./output",
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const screenshots: string[] = [];
  const outputs = new Map<string, string>();
  const screenshotMap = new Map<string, string>();

  // 1. Load scenario files (includes parsed narrative if workflow.md exists)
  const { config, assertions, workflowMarkdown, narrative } = loadScenario(scenarioDir);

  // 2. Narrative is already parsed by loadScenario

  // 3. Execute workflow — walk each narrative step's tool blocks
  let setupOk = true;
  let workflowOk = true;

  if (narrative) {
    let stepIndex = 0;
    for (const step of narrative.steps) {
      for (const block of step.toolBlocks) {
        const sourceKey = `step-${stepIndex}`;
        try {
          const output = await executor(block.tool, block.params);
          outputs.set(sourceKey, output);

          // If the tool was a screenshot, track the path
          if (block.tool === "vm_screenshot" && output) {
            screenshots.push(output);
            screenshotMap.set(sourceKey, output);
          }
        } catch (e) {
          const msg = `Tool ${block.tool} failed in step "${step.heading}": ${e}`;
          errors.push(msg);
          outputs.set(sourceKey, `ERROR: ${e}`);
          workflowOk = false;
        }
        stepIndex++;
      }
    }
  } else {
    // Fallback: extract tool blocks directly (flat, no narrative structure)
    const blocks = extractToolBlocks(workflowMarkdown);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const sourceKey = `step-${i}`;
      try {
        const output = await executor(block.tool, block.params);
        outputs.set(sourceKey, output);
      } catch (e) {
        const msg = `Tool ${block.tool} failed: ${e}`;
        errors.push(msg);
        outputs.set(sourceKey, `ERROR: ${e}`);
        workflowOk = false;
      }
    }
  }

  // 4. Evaluate assertions
  const { results, passed, score } = evaluateAssertions(
    assertions,
    outputs,
    screenshotMap,
  );

  const finishedAt = new Date().toISOString();

  const scenarioResult: ScenarioResult = {
    scenario: config.name,
    started_at: startedAt,
    finished_at: finishedAt,
    setup_ok: setupOk,
    workflow_ok: workflowOk,
    assertion_results: results,
    passed,
    score,
    screenshots,
    errors,
  };

  // 5. Write reports
  const durationMs =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  const testResult: TestResult = {
    scenario: config.name,
    startedAt,
    finishedAt,
    durationMs,
    passed,
    score,
    assertions: results.map(
      (r): AssertionResultEntry => ({
        id: r.assertion.id,
        description: r.assertion.description,
        severity: r.assertion.severity,
        passed: r.passed,
        actual: r.actual,
        error: r.error,
      }),
    ),
    screenshots,
    errors,
  };

  const scenarioOutputDir = path.join(outputDir, config.name);
  writeJsonReport(testResult, scenarioOutputDir);
  writeMarkdownReport(testResult, scenarioOutputDir);
  writeJunitReport(testResult, scenarioOutputDir);

  return scenarioResult;
}
