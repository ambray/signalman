/**
 * `signalman.describe` — return scenario contents without executing.
 *
 * Per design doc §1.2. Caller-supplied `id` is resolved against
 * `.signalman/scenarios/`, validated against path traversal, and
 * the parsed YAML + workflow markdown is returned alongside the
 * scenario hash and the (P4-reserved) `capabilities` block.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { resolveLayout } from "../scenarios/project-layout.js";
import { resolveScenarioById } from "../scenarios/scenario-loader.js";
import { computeScenarioHash } from "../output/envelope.js";

export interface DescribeParams {
  id: string;
}

export interface DescribeResult {
  id: string;
  scenario_hash: string;
  setup: Record<string, unknown>;
  assertions: Record<string, unknown>;
  workflow_markdown: string;
  /** P4-reserved. Echoed from setup.yaml; not enforced. */
  capabilities: { hosts?: string[]; networks?: string[]; vms?: string[] };
}

/** Error thrown by describe/plan/run when the id resolves nowhere. */
export class ScenarioNotFoundError extends Error {
  constructor(id: string) {
    super(`Scenario not found: ${id}`);
    this.name = "ScenarioNotFoundError";
  }
}

export function runDescribe(params: DescribeParams, cwd: string = process.cwd()): DescribeResult {
  const layout = resolveLayout(cwd);
  const dir = resolveScenarioById(layout.scenariosDir, params.id);

  if (!fs.existsSync(path.join(dir, "setup.yaml"))) {
    throw new ScenarioNotFoundError(params.id);
  }

  const setupRaw = fs.readFileSync(path.join(dir, "setup.yaml"), "utf-8");
  const setup = YAML.parse(setupRaw, { maxAliasCount: 100 }) as Record<string, unknown>;

  let assertions: Record<string, unknown> = {};
  const assertionsPath = path.join(dir, "assertions.yaml");
  if (fs.existsSync(assertionsPath)) {
    assertions =
      (YAML.parse(fs.readFileSync(assertionsPath, "utf-8"), {
        maxAliasCount: 100,
      }) as Record<string, unknown>) ?? {};
  }

  let workflowMd = "";
  const workflowPath = path.join(dir, "workflow.md");
  if (fs.existsSync(workflowPath)) {
    workflowMd = fs.readFileSync(workflowPath, "utf-8");
  }

  const caps = (setup.capabilities as DescribeResult["capabilities"]) ?? {};

  return {
    id: params.id,
    scenario_hash: computeScenarioHash(dir),
    setup,
    assertions,
    workflow_markdown: workflowMd,
    capabilities: caps,
  };
}
