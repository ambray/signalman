/**
 * `signalman.list` — enumerate scenarios under `.signalman/scenarios/`.
 *
 * Per design doc §1.1. No execution. YAML parse failures replace the
 * affected entry's body with `{id, error}`; the call still succeeds
 * so a single broken scenario doesn't hide the rest.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { resolveLayout } from "../scenarios/project-layout.js";
import { listScenarios } from "../scenarios/scenario-loader.js";
import { computeScenarioHash } from "../output/envelope.js";
import { minimatch } from "./glob.js";

export interface ListParams {
  tag?: string;
  pattern?: string;
}

export interface ListEntry {
  id: string;
  path: string;
  name?: string;
  tags?: string[];
  scenario_hash?: string;
  last_run?: {
    started_at: string;
    result: string;
    duration_ms: number;
  };
  error?: string;
}

export interface ListResult {
  scenarios: ListEntry[];
}

/**
 * List all discoverable scenarios.
 *
 * Filters: `tag` (entry's `tags[]` must contain it), `pattern` (glob
 * over the scenario id, supports `*` and `?` per minimatch
 * conventions).
 */
export function runList(params: ListParams = {}, cwd: string = process.cwd()): ListResult {
  const layout = resolveLayout(cwd);
  const scenarios = listScenarios(layout.scenariosDir);
  const entries: ListEntry[] = [];

  for (const s of scenarios) {
    const setupPath = path.join(s.dir, "setup.yaml");
    let entry: ListEntry;
    try {
      const raw = fs.readFileSync(setupPath, "utf-8");
      const parsed = YAML.parse(raw, { maxAliasCount: 100 }) as Record<string, unknown>;
      const name = typeof parsed.name === "string" ? parsed.name : undefined;
      const tags = Array.isArray(parsed.tags) ? (parsed.tags as string[]) : undefined;
      const hash = computeScenarioHash(s.dir);
      entry = {
        id: s.id,
        path: layout.legacy
          ? path.posix.join("scenarios", s.relPath)
          : path.posix.join(".signalman", "scenarios", s.relPath),
        name,
        tags,
        scenario_hash: hash,
      };
      // Optional last_run from recordings/<id>/last-run.json
      const lastRunPath = path.join(layout.recordingsDir, s.id.split("/").join(path.sep), "last-run.json");
      if (fs.existsSync(lastRunPath)) {
        try {
          const lr = JSON.parse(fs.readFileSync(lastRunPath, "utf-8")) as Record<string, unknown>;
          if (
            typeof lr.started_at === "string" &&
            typeof lr.result === "string" &&
            typeof lr.duration_ms === "number"
          ) {
            entry.last_run = {
              started_at: lr.started_at,
              result: lr.result,
              duration_ms: lr.duration_ms,
            };
          }
        } catch {
          // Ignore — last_run is best-effort metadata.
        }
      }
    } catch (err) {
      entry = { id: s.id, path: s.relPath, error: `yaml-parse: ${(err as Error).message}` };
    }

    // Filter by tag/pattern (filtering happens after parse so an entry's
    // tags can be inspected even when the parse partially succeeded).
    if (params.tag && !(entry.tags ?? []).includes(params.tag)) continue;
    if (params.pattern && !minimatch(entry.id, params.pattern)) continue;

    entries.push(entry);
  }

  return { scenarios: entries };
}
