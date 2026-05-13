/**
 * `signalman.plan` — dry-run a scenario.
 *
 * Per design doc §1.3. Loads, validates, expands `${param:NAME}`
 * placeholders, and reports the resolved step plan + affected
 * resources. Does not mutate state.
 *
 * Reserved-but-not-resolved tokens (`${secret:NAME}`) surface as
 * `warnings[]` so callers know the run will require a P4-resolvable
 * keychain entry.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { resolveLayout } from "../scenarios/project-layout.js";
import { resolveScenarioById } from "../scenarios/scenario-loader.js";
import { computeScenarioHash } from "../output/envelope.js";
import { extractToolBlocks } from "../scenarios/runner.js";
import { ScenarioNotFoundError } from "./describe.js";

export interface PlanParams {
  id: string;
  parameters?: Record<string, unknown>;
}

export interface PlanStep {
  kind: string;
  vm?: string;
  [field: string]: unknown;
}

export interface PlanResult {
  id: string;
  scenario_hash: string;
  vms: Array<Record<string, unknown>>;
  steps: PlanStep[];
  affected_resources: {
    vms: string[];
    networks: string[];
    host_paths_read: string[];
    host_paths_written: string[];
  };
  warnings: string[];
}

/** Thrown when a `${param:NAME}` reference has no caller-supplied value and no default. */
export class ParameterUnresolvedError extends Error {
  constructor(public readonly name: string) {
    super(`parameter-unresolved: ${name}`);
    this.name = "ParameterUnresolvedError";
  }
}

/**
 * Substitute `${param:NAME}` and `${param:NAME:-default}` references in
 * a string against the supplied `parameters` map + the scenario's
 * declared `parameters:` block (which may itself supply defaults via
 * `${param:NAME:-default}` syntax in the value).
 *
 * `${secret:NAME}` is left as-is and the caller name is added to
 * `warnings`.
 */
export function substituteRefs(
  input: string,
  params: Record<string, unknown>,
  warnings: string[],
): string {
  return input.replace(/\$\{(param|secret):([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, kind: string, name: string, def?: string) => {
    if (kind === "secret") {
      warnings.push(`secret-reference: \${secret:${name}} requires P4 keychain support`);
      return `\${secret:${name}}`;
    }
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      return String(params[name]);
    }
    if (def !== undefined) return def;
    throw new ParameterUnresolvedError(name);
  });
}

/** Recursively walk a value and substitute parameter references in any string. */
function substituteDeep(
  value: unknown,
  params: Record<string, unknown>,
  warnings: string[],
): unknown {
  if (typeof value === "string") return substituteRefs(value, params, warnings);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, params, warnings));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, params, warnings);
    }
    return out;
  }
  return value;
}

/** Merge declared defaults from setup.yaml `parameters:` with caller-supplied overrides. */
function mergeParams(
  declared: Record<string, unknown> | undefined,
  supplied: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (declared) {
    for (const [k, v] of Object.entries(declared)) {
      // A declared value may itself use `${param:k:-default}` syntax to
      // express a default — leave it for substituteRefs to resolve.
      merged[k] = v;
    }
  }
  if (supplied) {
    for (const [k, v] of Object.entries(supplied)) merged[k] = v;
  }
  return merged;
}

export function runPlan(params: PlanParams, cwd: string = process.cwd()): PlanResult {
  const layout = resolveLayout(cwd);
  const dir = resolveScenarioById(layout.scenariosDir, params.id);
  if (!fs.existsSync(path.join(dir, "setup.yaml"))) {
    throw new ScenarioNotFoundError(params.id);
  }

  const setupRaw = fs.readFileSync(path.join(dir, "setup.yaml"), "utf-8");
  const setup = YAML.parse(setupRaw, { maxAliasCount: 100 }) as Record<string, unknown>;
  const merged = mergeParams(setup.parameters as Record<string, unknown> | undefined, params.parameters);
  const warnings: string[] = [];

  const expanded = substituteDeep(setup, merged, warnings) as Record<string, unknown>;

  const vms = (expanded.vms as Array<Record<string, unknown>>) ?? [];
  const steps: PlanStep[] = [];

  // VM provisioning steps
  for (const vm of vms) {
    if (vm.checkpoint_restore) {
      steps.push({ kind: "vm.restore", vm: vm.name as string, checkpoint: vm.checkpoint_restore as string });
    } else {
      steps.push({ kind: "vm.start", vm: vm.name as string, template: vm.template as string });
    }
  }

  // Setup steps map to `tool.<action>` planned calls
  const setupSteps = (expanded.setup as Array<Record<string, unknown>>) ?? [];
  for (const s of setupSteps) {
    const action = s.action as string;
    const kind = action ? `tool.${action}` : "tool.unknown";
    steps.push({ kind, vm: s.vm as string | undefined, params: { ...s, action: undefined } });
  }

  // Workflow tool blocks
  let workflowMd = "";
  const workflowPath = path.join(dir, "workflow.md");
  if (fs.existsSync(workflowPath)) {
    workflowMd = fs.readFileSync(workflowPath, "utf-8");
  }
  if (workflowMd) {
    const expandedWorkflow = substituteRefs(workflowMd, merged, warnings);
    const blocks = extractToolBlocks(expandedWorkflow);
    for (const b of blocks) {
      steps.push({ kind: `tool.${b.tool}`, vm: (b.params as Record<string, unknown>).vm as string | undefined, params: b.params });
    }
  }

  // Affected resources
  const vmNames = new Set<string>();
  const networks = new Set<string>();
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();
  for (const vm of vms) {
    if (vm.name) vmNames.add(vm.name as string);
    const net = vm.network as { switch?: string } | undefined;
    if (net?.switch) networks.add(net.switch);
  }
  // host paths from setup steps
  for (const s of setupSteps) {
    if (s.host_path && typeof s.host_path === "string") {
      const direction = s.direction;
      if (direction === "from_vm") writePaths.add(s.host_path as string);
      else readPaths.add(s.host_path as string);
    }
  }

  // Capabilities-declared paths (P4 reserved; surface in warnings if we
  // see references outside the declared set).
  const caps = expanded.capabilities as
    | { host_paths?: { read?: string[]; write?: string[] }; hosts?: string[]; networks?: string[] }
    | undefined;
  if (caps?.host_paths?.read) {
    for (const p of caps.host_paths.read) readPaths.add(p);
  }
  if (caps?.host_paths?.write) {
    for (const p of caps.host_paths.write) writePaths.add(p);
  }

  return {
    id: params.id,
    scenario_hash: computeScenarioHash(dir),
    vms,
    steps,
    affected_resources: {
      vms: Array.from(vmNames).sort(),
      networks: Array.from(networks).sort(),
      host_paths_read: Array.from(readPaths).sort(),
      host_paths_written: Array.from(writePaths).sort(),
    },
    warnings,
  };
}
