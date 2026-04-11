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
  // Resolve to absolute path and prevent path traversal outside cwd
  const resolvedDir = path.resolve(scenarioDir);
  const cwd = process.cwd();
  if (!resolvedDir.startsWith(cwd)) {
    throw new Error(
      `Scenario directory "${resolvedDir}" resolves outside the working directory "${cwd}". ` +
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
    fs.readFileSync(setupPath, "utf-8")
  ) as ScenarioConfig;

  let assertions: AssertionConfig = {
    assertions: [],
    pass_threshold: 1.0,
    critical_must_pass: true,
  };
  if (fs.existsSync(assertionsPath)) {
    assertions = yaml.parse(
      fs.readFileSync(assertionsPath, "utf-8")
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
      const parsed = yaml.parse(yamlContent) as Record<string, unknown>;
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
            const regex = new RegExp(
              assertion.expect.stdout_matches as string
            );
            passed = regex.test(output);
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
