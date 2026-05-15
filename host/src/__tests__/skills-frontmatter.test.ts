// WS6 deliverable — skills frontmatter validator.
//
// Walks every `skills/<name>/SKILL.md` in the repo, parses the YAML
// frontmatter, and asserts each carries a well-formed `name` /
// `description` / `allowed-tools`. For each entry in `allowed-tools`,
// validates it either:
//   - is a documented Claude Code built-in tool (Bash, Read, …), or
//   - matches `mcp__signalman__<TOOLNAME>` where `<TOOLNAME>` is a
//     real MCP tool the host registers (`server.tool(...)`).
//
// Why static parsing: dynamically importing server.ts to enumerate
// registered tools would boot backend discovery + grpc bindings + the
// MCP transport — too heavy for a frontmatter sanity test. Parsing
// server.ts and tools/*.ts as text gives the same set without side
// effects.
//
// If this test fails:
//   - The describe.each skill name in the failure tells you which
//     SKILL.md regressed.
//   - "MCP tool X is not registered" → either the skill names a tool
//     that doesn't exist, or the tool was renamed in server.ts/tools.
//     The fix is in the skill, not the test.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const skillsDir = path.join(repoRoot, "skills");
const serverTs = path.join(repoRoot, "host", "src", "server.ts");
const toolsDir = path.join(repoRoot, "host", "src", "tools");

// Claude Code built-in tools. Skills can grant any of these without
// further checks; the agent harness, not signalman, owns their schema.
const BUILTIN_TOOLS = new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Task",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
]);

interface DiscoveredSkill {
  dir: string;
  file: string;
  label: string;
}

function findSkillFiles(): DiscoveredSkill[] {
  if (!fs.existsSync(skillsDir)) return [];
  const out: DiscoveredSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsDir, entry.name);
    const file = path.join(dir, "SKILL.md");
    if (fs.existsSync(file)) {
      out.push({ dir, file, label: entry.name });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

interface Frontmatter {
  name: string;
  description: string;
  "allowed-tools": string;
  [k: string]: unknown;
}

function readFrontmatter(file: string): Frontmatter {
  const content = fs.readFileSync(file, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`No YAML frontmatter delimited by --- ... --- in ${file}`);
  }
  const data = YAML.parse(match[1]) as Record<string, unknown>;
  return data as Frontmatter;
}

function collectRegisteredMcpTools(): Set<string> {
  const tools = new Set<string>();

  // (1) Direct `server.tool("name", ...)` registrations in server.ts.
  const serverSrc = fs.readFileSync(serverTs, "utf8");
  for (const m of serverSrc.matchAll(/server\.tool\(\s*"([a-z_][a-z0-9_]*)"/g)) {
    tools.add(m[1]);
  }

  // (2) The for-loop over `allTools` in server.ts registers each
  //     tool from tools/* under TWO names:
  //       - canonical: `signalman_advanced_<tool.name>`
  //       - legacy alias: `<tool.name>` (deprecated, removed v0.2.0).
  //     Parse tools/*.ts statically for the `name:` field on each
  //     ToolDefinition.
  for (const entry of fs.readdirSync(toolsDir)) {
    if (!entry.endsWith(".ts")) continue;
    if (entry === "index.ts" || entry === "types.ts") continue;
    const src = fs.readFileSync(path.join(toolsDir, entry), "utf8");
    for (const m of src.matchAll(/^\s*name:\s*"([a-z_][a-z0-9_]*)"/gm)) {
      tools.add(m[1]);
      tools.add(`signalman_advanced_${m[1]}`);
    }
  }

  return tools;
}

const skills = findSkillFiles();
const mcpTools = collectRegisteredMcpTools();

describe("skills frontmatter validator", () => {
  it("discovers at least one SKILL.md under skills/", () => {
    expect(skills.length, "no SKILL.md files found under skills/").toBeGreaterThan(0);
  });

  it("MCP tool registry parsed at least one signalman_* tool", () => {
    // Sanity check: if static parsing of server.ts misses everything,
    // the per-skill `allowed-tools` checks below would silently pass.
    const signalmanScoped = [...mcpTools].filter((t) => t.startsWith("signalman_"));
    expect(
      signalmanScoped.length,
      "static parse of server.ts/tools/* found no signalman_* MCP tools",
    ).toBeGreaterThan(0);
  });

  describe.each(skills.map((s) => [s.label, s]))("%s", (_label, skill) => {
    const fm = readFrontmatter(skill.file);

    it("frontmatter has a non-empty string `name`", () => {
      expect(typeof fm.name).toBe("string");
      expect(fm.name.trim().length).toBeGreaterThan(0);
    });

    it("`name` matches the skill directory name", () => {
      expect(fm.name).toBe(skill.label);
    });

    it("frontmatter has a non-empty string `description`", () => {
      expect(typeof fm.description).toBe("string");
      expect(fm.description.trim().length).toBeGreaterThan(0);
    });

    it("description includes at least one trigger-phrase signal (`Trigger when`, `trigger`, `says`, `wants`)", () => {
      // Soft constraint: skill descriptions need natural-language
      // trigger phrasing so an agent matches on them. We accept any
      // of the common patterns the existing skills already use.
      const d = fm.description;
      const ok =
        /trigger/i.test(d) ||
        /\bsays\b/i.test(d) ||
        /\bwants\b/i.test(d);
      expect(ok, `description for ${skill.label} has no trigger-phrase signal`).toBe(true);
    });

    it("frontmatter has a non-empty `allowed-tools`", () => {
      const at = fm["allowed-tools"];
      expect(typeof at).toBe("string");
      expect((at as string).trim().length).toBeGreaterThan(0);
    });

    it("every `allowed-tools` entry resolves to a built-in tool or a registered MCP tool", () => {
      const raw = (fm["allowed-tools"] as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      expect(raw.length, "allowed-tools is empty after split").toBeGreaterThan(0);

      const problems: string[] = [];
      for (const entry of raw) {
        if (BUILTIN_TOOLS.has(entry)) continue;
        const m = entry.match(/^mcp__signalman__([a-z_][a-z0-9_]*)$/);
        if (!m) {
          problems.push(
            `"${entry}" is neither a known built-in (${[...BUILTIN_TOOLS].join("/")}) nor an mcp__signalman__<tool> reference`,
          );
          continue;
        }
        const toolName = m[1];
        if (!mcpTools.has(toolName)) {
          problems.push(
            `mcp tool "${toolName}" (from "${entry}") is not registered in host/src/server.ts or host/src/tools/`,
          );
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  });
});
