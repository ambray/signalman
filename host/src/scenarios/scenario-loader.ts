/**
 * Scenario enumeration + id resolution under `.signalman/scenarios/`.
 *
 * Per design doc §2 + resolved Question 3 (sub-directory IDs):
 *   - Every directory containing a `setup.yaml` is a scenario.
 *   - Its id is the relative path from the scenarios root, with
 *     forward-slash separators retained (so `example/v2/network-egress`
 *     stays as a slash-delimited id, never collapsed to dashes).
 *   - Nesting is rejected: a directory cannot have both a `setup.yaml`
 *     and a child directory that also has a `setup.yaml`. The recursive
 *     scan throws on collision so authors fix the layout instead of
 *     ending up with two scenarios that share a parent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Public summary of a discovered scenario. */
export interface ScenarioInfo {
  id: string;
  /** Absolute path to the scenario directory. */
  dir: string;
  /** Path relative to the scenarios root (POSIX separators). */
  relPath: string;
}

/**
 * Walk `scenariosDir` recursively and return all scenarios.
 *
 * Throws if a parent and child both contain `setup.yaml` (the
 * "ambiguous nesting" rejection from the resolved Question 3).
 *
 * Yaml-parse failures are NOT thrown here — `signalman.list` surfaces
 * them per-entry.
 */
export function listScenarios(scenariosDir: string): ScenarioInfo[] {
  if (!fs.existsSync(scenariosDir)) return [];

  const out: ScenarioInfo[] = [];
  walk(scenariosDir, scenariosDir, out);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function walk(rootDir: string, currentDir: string, out: ScenarioInfo[]): void {
  const hasSetup = fs.existsSync(path.join(currentDir, "setup.yaml"));
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const childDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(currentDir, e.name));

  if (hasSetup) {
    // Parent IS a scenario. Reject if any descendant also has setup.yaml.
    for (const child of childDirs) {
      if (anyDescendantHasSetup(child)) {
        const rel = relPosix(rootDir, currentDir);
        throw new Error(
          `Ambiguous scenario nesting: ${rel || "(scenarios root)"} contains setup.yaml and a child directory ` +
            `that also contains setup.yaml. Move the inner scenario to a sibling or remove the parent's setup.yaml.`,
        );
      }
    }
    const rel = relPosix(rootDir, currentDir);
    out.push({
      id: rel,
      dir: currentDir,
      relPath: rel,
    });
    return;
  }

  // Non-scenario directory — recurse into children.
  for (const child of childDirs) {
    walk(rootDir, child, out);
  }
}

function anyDescendantHasSetup(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "setup.yaml"))) return true;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && anyDescendantHasSetup(path.join(dir, e.name))) return true;
  }
  return false;
}

function relPosix(rootDir: string, currentDir: string): string {
  return path.relative(rootDir, currentDir).split(path.sep).join("/");
}

/** Resolve a scenario id to its directory, validating it's inside the root. */
export function resolveScenarioById(scenariosDir: string, id: string): string {
  // Reject path traversal and absolute paths up front.
  if (id.includes("..") || path.isAbsolute(id)) {
    throw new Error(`Invalid scenario id: ${id}`);
  }
  const dir = path.join(scenariosDir, ...id.split("/"));
  // Ensure resolved path is within the scenarios root.
  const resolvedDir = path.resolve(dir);
  const resolvedRoot = path.resolve(scenariosDir);
  const norm = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (!norm(resolvedDir + path.sep).startsWith(norm(resolvedRoot + path.sep))) {
    throw new Error(`Scenario id "${id}" resolves outside the scenarios root`);
  }
  return resolvedDir;
}
