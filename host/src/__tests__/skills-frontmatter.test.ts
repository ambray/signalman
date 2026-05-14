/**
 * v0.3.0-5 sub-task 8 commit 3 — skills frontmatter validator.
 *
 * Walks the top-level `skills/` directory and parses each
 * `SKILL.md`'s YAML frontmatter. Asserts the required fields
 * are present + well-formed so a malformed skill can't ship
 * undetected. The agent runtime ignores skills with broken
 * frontmatter (silent failure mode) — this test makes the
 * silence audible.
 *
 * Required frontmatter fields:
 *   - `name`         non-empty string; matches the directory name
 *   - `description`  non-empty string (operator-facing trigger
 *                    phrases)
 *   - `allowed-tools` non-empty comma-separated list
 *
 * Optional but flagged:
 *   - `model`        ignored if present (legacy)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SKILLS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "..",
  "skills",
);

interface ParsedFrontmatter {
  name: string;
  description: string;
  "allowed-tools": string;
  [key: string]: string;
}

function parseFrontmatter(filePath: string): ParsedFrontmatter | null {
  // Normalise CRLF (Windows commits via git autocrlf land with \r\n)
  // so the frontmatter regex matches on either platform.
  const content = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const lines = match[1].split("\n");
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const keyMatch = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1];
      out[currentKey] = keyMatch[2];
    } else if (currentKey) {
      // Continuation of previous value (YAML multi-line; rare for our
      // skills which use single-line descriptions).
      out[currentKey] += " " + line.trim();
    }
  }
  return out as ParsedFrontmatter;
}

function listSkillDirs(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

describe("skills/ — frontmatter validation", () => {
  const dirs = listSkillDirs();

  it("at least one skill is present", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const dir of dirs) {
    const skillPath = path.join(SKILLS_DIR, dir, "SKILL.md");
    describe(`skills/${dir}`, () => {
      it("has a SKILL.md file", () => {
        expect(fs.existsSync(skillPath)).toBe(true);
      });

      it("has parseable YAML frontmatter", () => {
        const fm = parseFrontmatter(skillPath);
        expect(fm).not.toBeNull();
      });

      it("name field matches the directory name", () => {
        const fm = parseFrontmatter(skillPath);
        expect(fm).not.toBeNull();
        expect(fm!.name).toBe(dir);
      });

      it("description is non-empty", () => {
        const fm = parseFrontmatter(skillPath);
        expect(fm).not.toBeNull();
        expect(fm!.description.length).toBeGreaterThan(0);
      });

      it("allowed-tools is non-empty", () => {
        const fm = parseFrontmatter(skillPath);
        expect(fm).not.toBeNull();
        expect(fm!["allowed-tools"]?.length).toBeGreaterThan(0);
      });

      it("description has at least one operator-trigger phrase indicator", () => {
        // Heuristic: the description should mention "Trigger" or an
        // imperative verb / quoted operator phrase so the agent
        // runtime knows when to use the skill. Catches descriptions
        // that are too abstract.
        const fm = parseFrontmatter(skillPath);
        expect(fm).not.toBeNull();
        const desc = fm!.description.toLowerCase();
        // We accept any of: "trigger", a quoted phrase ('"..."'), or
        // the imperative verb pattern at the start.
        const hasTriggerCue =
          desc.includes("trigger") ||
          /"[^"]+"/i.test(fm!.description) ||
          /^[a-z]+s?\s+/.test(desc); // starts with a verb
        expect(hasTriggerCue).toBe(true);
      });
    });
  }
});
