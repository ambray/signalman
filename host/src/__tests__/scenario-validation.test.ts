// IMPORTANT: this is a smoke test for scenario integrity. Failure means a scenario YAML drifted from the schema.
//
// D3 deliverable (P7 test pyramid). Walks every scenario directory under
// `.signalman/scenarios/` and `examples/` (relative to the repo root),
// runs the existing Zod validators on `setup.yaml` / `assertions.yaml`,
// and asserts that every discovered scenario parses cleanly. This is a
// cheap fence against rotted example scenarios — it does not run the
// orchestrator or any VM, it only re-parses the YAML through the
// validators that live next to the runner.
//
// If this test fails:
//   - The describe.each scenario name in the failure tells you which
//     scenario regressed.
//   - Read the message body — it surfaces the field path and Zod issue
//     for each violation (see ScenarioValidationError formatting).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  validateScenarioConfig,
  validateAssertionConfig,
} from "../scenarios/schema.js";

// ── repo-root resolution ────────────────────────────────────────────
//
// This test file lives at <repo>/host/src/__tests__/. We walk up two
// levels from the host/ directory to land at the repo root, then look
// at its `.signalman/scenarios/` and `examples/` subtrees.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

// Skip-listed top-level dirs we never want to recurse into. Keep this
// small — it's a defence against accidentally pulling in build output
// or transient worktree state during discovery.
const SKIP_DIRS = new Set(["node_modules"]);

interface DiscoveredScenario {
  /** Absolute path to the scenario directory. */
  dir: string;
  /** Repo-relative label used in test names (forward-slash normalised). */
  label: string;
  /** Whether assertions.yaml exists in the scenario directory. */
  hasAssertions: boolean;
  /** Whether workflow.md exists in the scenario directory. */
  hasWorkflow: boolean;
}

/**
 * Recursively walk a root directory and yield every directory that
 * contains a `setup.yaml` file. Directories without `setup.yaml` are
 * treated as templates / asset directories and skipped (the task spec
 * is explicit about this). `.tmp-*` and `node_modules/` are pruned.
 */
function findScenarioDirs(root: string): DiscoveredScenario[] {
  if (!fs.existsSync(root)) return [];

  const out: DiscoveredScenario[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const setupHere = entries.some(
      (e) => e.isFile() && e.name === "setup.yaml",
    );
    if (setupHere) {
      out.push({
        dir,
        label: path.relative(repoRoot, dir).replaceAll(path.sep, "/"),
        hasAssertions: entries.some(
          (e) => e.isFile() && e.name === "assertions.yaml",
        ),
        hasWorkflow: entries.some(
          (e) => e.isFile() && e.name === "workflow.md",
        ),
      });
      // Don't recurse into a scenario directory — scenarios don't
      // nest inside other scenarios.
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".tmp-")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  }

  walk(root);
  return out;
}

const signalmanScenariosRoot = path.join(repoRoot, ".signalman", "scenarios");
const examplesRoot = path.join(repoRoot, "examples");

const scenarioDirs: DiscoveredScenario[] = [
  ...findScenarioDirs(signalmanScenariosRoot),
  ...findScenarioDirs(examplesRoot),
].sort((a, b) => a.label.localeCompare(b.label));

// ── meta tests (run even when no scenarios are discovered) ──────────

describe("scenario-validation smoke — discovery", () => {
  it("found at least one scenario to validate", () => {
    // Acts as a tripwire: if both .signalman/scenarios/ and examples/
    // get refactored away (or this test's repo-root resolution breaks),
    // at least one assertion fires loudly instead of the suite passing
    // with zero coverage.
    expect(scenarioDirs.length).toBeGreaterThan(0);
  });
});

// ── per-scenario validation ─────────────────────────────────────────

describe.each(scenarioDirs)(
  "scenario $label",
  ({ dir, label, hasAssertions, hasWorkflow }) => {
    const setupPath = path.join(dir, "setup.yaml");
    const assertionsPath = path.join(dir, "assertions.yaml");
    const workflowPath = path.join(dir, "workflow.md");

    it(`validates ${label}/setup.yaml`, () => {
      const raw = fs.readFileSync(setupPath, "utf8");
      const parsed = YAML.parse(raw);
      // Must not throw — failure indicates the scenario YAML drifted
      // from the Zod schema (typo'd field, wrong type, missing required).
      expect(() => validateScenarioConfig(parsed, setupPath)).not.toThrow();
    });

    if (hasAssertions) {
      it(`validates ${label}/assertions.yaml`, () => {
        const raw = fs.readFileSync(assertionsPath, "utf8");
        const parsed = YAML.parse(raw);
        expect(() =>
          validateAssertionConfig(parsed, assertionsPath),
        ).not.toThrow();
      });
    }

    if (hasWorkflow) {
      it(`workflow.md is readable for ${label}`, () => {
        // No parse — the orchestrator parses workflow.md via
        // parseNarrative at run time, but for the smoke fence we only
        // care that the file is present and readable. ROADMAP notes
        // codex-sandbox may legitimately lack a workflow.md, so this
        // branch only fires when the file actually exists.
        const stat = fs.statSync(workflowPath);
        expect(stat.size).toBeGreaterThan(0);
      });
    }
  },
);
