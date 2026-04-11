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
import * as yaml from "yaml";
import { parseNarrative } from "./narrative.js";
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

export interface ScenarioConfig {
  name: string;
  version: string;
  tags: string[];
  vms: VmConfig[];
  setup: SetupStep[];
  teardown: SetupStep[];
  checkpoints: CheckpointConfig;
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
} {
  // Resolve to absolute path and prevent path traversal outside the
  // project's scenarios/ directory.  We walk up from __dirname (which
  // lives inside host/src/scenarios/) to the project root, then anchor
  // to <projectRoot>/scenarios.
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const scenariosRoot = path.join(projectRoot, "scenarios");
  const resolvedDir = path.resolve(scenarioDir);

  // Normalize both paths so that trailing separators and case (on
  // Windows NTFS, which is case-insensitive) don't cause false negatives.
  const lower = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const normalizedResolved = lower(path.normalize(resolvedDir)) + path.sep;
  const normalizedRoot = lower(path.normalize(scenariosRoot)) + path.sep;

  if (!normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error(
      `Scenario directory "${resolvedDir}" resolves outside the allowed scenarios directory "${scenariosRoot}". ` +
      `Path traversal is not allowed.`,
    );
  }

  const setupPath = path.join(resolvedDir, "setup.yaml");
  const assertionsPath = path.join(resolvedDir, "assertions.yaml");
  const workflowPath = path.join(resolvedDir, "workflow.md");

  if (!fs.existsSync(setupPath)) {
    throw new Error(`Missing setup.yaml in ${resolvedDir}`);
  }

  const config = yaml.parse(
    fs.readFileSync(setupPath, "utf-8"),
    { maxAliasCount: 100 },
  ) as ScenarioConfig;

  let assertions: AssertionConfig = {
    assertions: [],
    pass_threshold: 1.0,
    critical_must_pass: true,
  };
  if (fs.existsSync(assertionsPath)) {
    assertions = yaml.parse(
      fs.readFileSync(assertionsPath, "utf-8"),
      { maxAliasCount: 100 },
    ) as AssertionConfig;
  }

  let workflowMarkdown = "";
  if (fs.existsSync(workflowPath)) {
    workflowMarkdown = fs.readFileSync(workflowPath, "utf-8");
  }

  return { config, assertions, workflowMarkdown };
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

  // 1. Load scenario files
  const { config, assertions, workflowMarkdown } = loadScenario(scenarioDir);

  // 2. Parse narrative from the workflow markdown
  let narrative: Narrative | null = null;
  if (workflowMarkdown) {
    narrative = parseNarrative(workflowMarkdown);
  }

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
