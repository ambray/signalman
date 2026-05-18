// Manifest-validation test for the signalman Claude Code plugin.
//
// This file is the load-bearing coverage gate for WS7 v0.1.0 per
// `docs/design/v0.5-claude-plugin.md` §Coverage gate. The plugin is
// mostly manifest + markdown + symlinked skills, so per-file coverage
// thresholds don't apply; instead, this test asserts that the manifest
// is well-formed, every declared path resolves to a real file/skill on
// disk, MCP server invocation points at a real host build target, and
// the locked permission preset matches real MCP tool names registered
// by `host/src/server.ts`.
//
// The test grows incrementally across stories 1–5 of the WS7 detail
// design; story 6 finalises it. Each `describe` block notes which
// story populated it.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "..");
const MANIFEST_PATH = join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");

interface Manifest {
  $schema?: string;
  name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  homepage?: unknown;
  repository?: unknown;
  license?: unknown;
  keywords?: unknown;
  skills?: unknown;
  commands?: unknown;
  agents?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
  [k: string]: unknown;
}

function loadManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

// ── Story 1: scaffold ────────────────────────────────────────────────
describe("plugin manifest — Story 1 scaffold shape", () => {
  it("manifest file exists at .claude-plugin/plugin.json", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it("manifest is parseable JSON", () => {
    expect(() => loadManifest()).not.toThrow();
  });

  it("declares required identity fields (name)", () => {
    const m = loadManifest();
    expect(typeof m.name).toBe("string");
    expect(m.name).toBe("signalman");
  });

  it("declares the version + description metadata fields", () => {
    const m = loadManifest();
    expect(typeof m.version).toBe("string");
    expect(m.version).toBe("0.1.0");
    expect(typeof m.description).toBe("string");
    expect((m.description as string).length).toBeGreaterThan(20);
  });

  it("declares license as Apache-2.0", () => {
    const m = loadManifest();
    expect(m.license).toBe("Apache-2.0");
  });

  it("includes a non-empty mcpServers block with a signalman entry", () => {
    const m = loadManifest();
    expect(typeof m.mcpServers).toBe("object");
    const servers = m.mcpServers as Record<string, unknown>;
    expect(servers.signalman).toBeDefined();
  });

  it("MCP server invocation points at the host build artefact", () => {
    const m = loadManifest();
    const server = (m.mcpServers as Record<string, { command?: string; args?: string[] }>)
      .signalman;
    expect(server.command).toBe("node");
    expect(Array.isArray(server.args)).toBe(true);
    // The args path uses ${CLAUDE_PROJECT_DIR} substitution; we can't
    // verify the absolute on-disk file from inside the test (the test
    // runs from the plugin dir, not the project dir at install time).
    // Instead, assert the substitution variable is present and the
    // path tail resolves to host/dist/server.js relative to the repo
    // root we *can* observe in the test environment.
    const args = server.args ?? [];
    expect(args.length).toBeGreaterThan(0);
    const argPath = args[0];
    expect(argPath).toContain("${CLAUDE_PROJECT_DIR}");
    expect(argPath).toContain("host/dist/server.js");
  });

  it("LICENSE file exists in plugin root", () => {
    expect(existsSync(join(PLUGIN_ROOT, "LICENSE"))).toBe(true);
  });

  it("README.md exists in plugin root", () => {
    expect(existsSync(join(PLUGIN_ROOT, "README.md"))).toBe(true);
  });
});

// ── Story 2: skill index for the MVP 6 ──────────────────────────────
// Per design doc §Stories §Story 2: the manifest does NOT list each
// skill (the Claude Code plugin spec auto-discovers default
// `skills/<name>/SKILL.md`). Instead, `plugin/skills/` contains six
// symlinks to the repo-root `skills/<name>/` directories (Q3 lock).
// These tests assert all six exist and resolve to a real SKILL.md.
const MVP_SKILLS = [
  "signalman-build-from-tag",
  "signalman-deploy-to-test",
  "signalman-rollback",
  "signalman-promote-release",
  "signalman-query-audit-log",
  "signalman-register-target",
] as const;

describe("plugin skill index — Story 2", () => {
  it("plugin/skills/ directory exists", () => {
    const skillsDir = join(PLUGIN_ROOT, "skills");
    expect(existsSync(skillsDir)).toBe(true);
    expect(statSync(skillsDir).isDirectory()).toBe(true);
  });

  it("registers exactly the 6 MVP skills (no more, no less)", () => {
    const skillsDir = join(PLUGIN_ROOT, "skills");
    const entries = readdirSync(skillsDir).filter((e) => !e.startsWith("."));
    expect(entries.sort()).toEqual([...MVP_SKILLS].sort());
  });

  for (const skill of MVP_SKILLS) {
    it(`skill ${skill} resolves to a real SKILL.md`, () => {
      const skillMd = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
      expect(existsSync(skillMd)).toBe(true);
      expect(statSync(skillMd).isFile()).toBe(true);
    });

    it(`skill ${skill} has a non-trivial SKILL.md (frontmatter + body)`, () => {
      const skillMd = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
      const content = readFileSync(skillMd, "utf8");
      // Anthropic SKILL.md convention: YAML frontmatter `---` + body.
      expect(content.startsWith("---")).toBe(true);
      expect(content.length).toBeGreaterThan(100);
    });
  }

  it("the canonical repo-root skills tree contains all 6 entries", () => {
    // Defence-in-depth: the symlinks in plugin/skills/ point to
    // ../../skills/<name>. If the canonical tree drifts (e.g. a skill
    // is renamed at repo root), this assertion fails before the
    // symlink-resolution assertions above produce a misleading "skill
    // missing" diagnostic.
    for (const skill of MVP_SKILLS) {
      const canonicalPath = join(REPO_ROOT, "skills", skill, "SKILL.md");
      expect(existsSync(canonicalPath)).toBe(true);
    }
  });
});

// ── Story 3: /signalman-status slash command ────────────────────────
describe("plugin slash commands — Story 3", () => {
  it("manifest declares the commands array", () => {
    const m = loadManifest();
    expect(Array.isArray(m.commands)).toBe(true);
    expect((m.commands as unknown[]).length).toBeGreaterThan(0);
  });

  it("declares /signalman-status at ./commands/signalman-status.md", () => {
    const m = loadManifest();
    const commands = m.commands as string[];
    expect(commands).toContain("./commands/signalman-status.md");
  });

  it("the slash command file exists on disk", () => {
    const m = loadManifest();
    for (const cmd of m.commands as string[]) {
      // Strip leading "./" for join.
      const relative = cmd.replace(/^\.\//, "");
      const absolute = join(PLUGIN_ROOT, relative);
      expect(existsSync(absolute)).toBe(true);
      expect(statSync(absolute).isFile()).toBe(true);
    }
  });

  it("the /signalman-status command has YAML frontmatter with name + description", () => {
    const cmdPath = join(PLUGIN_ROOT, "commands", "signalman-status.md");
    const content = readFileSync(cmdPath, "utf8");
    expect(content.startsWith("---")).toBe(true);
    // Capture frontmatter block.
    const fmEnd = content.indexOf("\n---", 3);
    expect(fmEnd).toBeGreaterThan(0);
    const fm = content.slice(3, fmEnd);
    expect(fm).toMatch(/name:\s*signalman-status/);
    expect(fm).toMatch(/description:\s*\S/);
  });

  it("the /signalman-status body documents all 5 sub-queries (releases, promotions, probes, runners, budget)", () => {
    const cmdPath = join(PLUGIN_ROOT, "commands", "signalman-status.md");
    const body = readFileSync(cmdPath, "utf8");
    // The design doc §Story 3 mandates the 5 synthesis sub-queries.
    // Assert each MCP tool call the playbook is supposed to invoke
    // appears textually in the markdown body.
    expect(body).toMatch(/signalman_release_list/);
    expect(body).toMatch(/signalman_promotion_approvals/);
    expect(body).toMatch(/signalman_health_history/);
    expect(body).toMatch(/signalman_runner_list/);
    expect(body).toMatch(/signalman_budget_get/);
  });

  it("the /signalman-status body documents Q2 lock (day-2 SRE flavoring)", () => {
    const cmdPath = join(PLUGIN_ROOT, "commands", "signalman-status.md");
    const body = readFileSync(cmdPath, "utf8");
    // Per Q2 lock: leads with what's broken/pending/stale, not
    // what's healthy. This assertion catches accidental flavor
    // drift in future edits.
    expect(body.toLowerCase()).toMatch(/broken|pending|stale|failing/);
  });
});

// ── Stories 4–5: populated in subsequent commits ────────────────────
// (permissions, README locked-decisions)
// See docs/design/v0.5-claude-plugin.md §Stories.

// Helpers used by later stories are exported via module side-effects;
// re-import within each describe block as needed.
export { PLUGIN_ROOT, REPO_ROOT, MANIFEST_PATH, loadManifest };
