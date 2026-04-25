/**
 * `.signalman/` project layout resolution.
 *
 * The v0.1.0 layout (per docs/design/p0-mcp-surface.md §2) is:
 *
 *   .signalman/
 *   ├── config.yaml
 *   ├── scenarios/
 *   │   └── <id>/{setup,assertions,workflow}.{yaml,md}
 *   ├── templates/
 *   │   └── <name>.yaml
 *   └── recordings/
 *       └── <id>/last-run.json   (v0.2.0 reserved)
 *
 * Backwards compat: when `.signalman/` doesn't exist, fall back to the
 * legacy layout (`signalman.yaml` + `scenarios/` at repo root) and emit
 * a one-time deprecation warning. The fallback is removed in v0.2.0
 * (TODO marker below).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Project root ──────────────────────────────────────────────────

/**
 * The project root is the first ancestor directory of `cwd` that
 * contains either a `.signalman/` directory or a legacy
 * `signalman.yaml`. Falls back to `cwd` if nothing matches — this
 * keeps `signalman list` working from a freshly cloned repo without
 * any config.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let cur = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(cur, ".signalman"))) return cur;
    if (fs.existsSync(path.join(cur, "signalman.yaml"))) return cur;
    // Legacy fallback marker: a top-level `scenarios/` directory.
    // Skip when we're standing inside a `.signalman/` (otherwise we'd
    // mistake `.signalman/scenarios/` for the project root marker —
    // it's a child of the real root, not the root itself).
    if (
      path.basename(cur) !== ".signalman" &&
      fs.existsSync(path.join(cur, "scenarios")) &&
      fs.statSync(path.join(cur, "scenarios")).isDirectory()
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(start); // hit filesystem root
    cur = parent;
  }
}

// ── Layout struct ─────────────────────────────────────────────────

export interface ProjectLayout {
  root: string;
  /** Where scenarios live. `.signalman/scenarios/` if present, else legacy `scenarios/`. */
  scenariosDir: string;
  /** Whether the legacy fallback path is in use. */
  legacy: boolean;
  /** Templates dir; absent means built-in templates only. */
  templatesDir: string | null;
  /** Recordings dir (v0.2.0). Always returned even if it doesn't exist yet. */
  recordingsDir: string;
  /** Config file path (`.signalman/config.yaml` or legacy `signalman.yaml`). */
  configPath: string | null;
}

let warned = false;
function warnDeprecationOnce(rootDir: string): void {
  if (warned) return;
  warned = true;
  // TODO(v0.2.0): remove the legacy fallback entirely.
  console.error(
    `[signalman] DEPRECATION: ${rootDir} uses the legacy layout (signalman.yaml + scenarios/). ` +
      `Move them to .signalman/config.yaml + .signalman/scenarios/. ` +
      `The legacy fallback is removed in v0.2.0.`,
  );
}

/** Resolve a project layout starting from a directory. */
export function resolveLayout(start: string = process.cwd()): ProjectLayout {
  const root = findProjectRoot(start);
  const dotDir = path.join(root, ".signalman");
  const dotScenarios = path.join(dotDir, "scenarios");
  const dotTemplates = path.join(dotDir, "templates");
  const dotRecordings = path.join(dotDir, "recordings");
  const dotConfig = path.join(dotDir, "config.yaml");

  if (fs.existsSync(dotDir)) {
    return {
      root,
      scenariosDir: fs.existsSync(dotScenarios) ? dotScenarios : dotScenarios,
      legacy: false,
      templatesDir: fs.existsSync(dotTemplates) ? dotTemplates : null,
      recordingsDir: dotRecordings,
      configPath: fs.existsSync(dotConfig) ? dotConfig : null,
    };
  }

  // Legacy fallback
  const legacyConfig = path.join(root, "signalman.yaml");
  const legacyScenarios = path.join(root, "scenarios");
  if (fs.existsSync(legacyConfig) || fs.existsSync(legacyScenarios)) {
    warnDeprecationOnce(root);
    return {
      root,
      scenariosDir: legacyScenarios,
      legacy: true,
      templatesDir: null,
      recordingsDir: path.join(root, "output", "recordings"),
      configPath: fs.existsSync(legacyConfig) ? legacyConfig : null,
    };
  }

  // No config at all — point at the conventional .signalman path so
  // `signalman init` writes to the right place.
  return {
    root,
    scenariosDir: dotScenarios,
    legacy: false,
    templatesDir: null,
    recordingsDir: dotRecordings,
    configPath: null,
  };
}
