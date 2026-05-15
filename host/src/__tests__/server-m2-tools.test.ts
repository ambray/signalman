// WS6 milestone 2 — discoverability + wiring sanity for the new
// P1 MCP wrappers (release_verify, key_generate, key_fingerprint,
// api_key_*, runner_build_config / runner_persist_config,
// release_build_remote).
//
// Each tool's underlying behaviour is already covered:
//   - release_verify  → release-signing-e2e.test.ts
//   - key gen/fp      → signing.test.ts
//   - api_key_*       → http-writes.test.ts, control-plane-storage.test.ts
//   - runner persist  → runner-config.test.ts
//   - release_build_remote → remote-release-build.test.ts
//
// What this test pins is the *wiring*: server.ts text contains a
// `server.tool("<name>", ...)` registration for each new tool, and
// the tool names match the ones the skills + capability matrix
// promise. A rename in server.ts that breaks a skill's allowed-tools
// or the matrix's MCP-exposed claim fails here.
//
// Static-parse only — does not boot the McpServer (no backend
// discovery, no grpc, no MCP transport). Same approach as
// skills-frontmatter.test.ts's MCP-tool collection.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverTs = path.resolve(__dirname, "..", "server.ts");

function registeredMcpToolNames(): Set<string> {
  const src = fs.readFileSync(serverTs, "utf-8");
  const names = new Set<string>();
  for (const m of src.matchAll(/server\.tool\(\s*"([a-z_][a-z0-9_]*)"/g)) {
    names.add(m[1]);
  }
  return names;
}

const M2_TOOLS = [
  "signalman_release_verify",
  "signalman_key_generate",
  "signalman_key_fingerprint",
  "signalman_api_key_create",
  "signalman_api_key_list",
  "signalman_api_key_revoke",
  "signalman_runner_build_config",
  "signalman_runner_persist_config",
  "signalman_release_build_remote",
];

describe("WS6 M2 MCP tool registrations", () => {
  const registered = registeredMcpToolNames();

  it("registers every promised M2 tool name in server.ts", () => {
    const missing = M2_TOOLS.filter((t) => !registered.has(t));
    expect(
      missing,
      `missing server.tool() registration(s): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  for (const tool of M2_TOOLS) {
    it(`registers ${tool}`, () => {
      expect(registered.has(tool)).toBe(true);
    });
  }

  it("each M2 tool's registration carries a non-empty description", () => {
    // Static parse: the description is the second argument to
    // server.tool. We grep for the full call and assert the string
    // literal isn't empty.
    const src = fs.readFileSync(serverTs, "utf-8");
    const problems: string[] = [];
    for (const tool of M2_TOOLS) {
      // Match `server.tool("<tool>", "<description>"`. The description
      // may contain escaped quotes; tolerate them with a lazy match.
      const re = new RegExp(
        `server\\.tool\\(\\s*"${tool}"\\s*,\\s*"((?:\\\\.|[^"\\\\])*)"`,
        "s",
      );
      const m = re.exec(src);
      if (!m) {
        problems.push(`${tool}: could not locate (name, description) pair`);
        continue;
      }
      if (m[1].trim().length === 0) {
        problems.push(`${tool}: description is empty`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("does not leave a stale `resolvePemInput` definition in server.ts (it lives in server-helpers.ts now)", () => {
    // Pin: M2 commits factored resolvePemInput out to its own module.
    // If a future merge re-adds the local definition, the export from
    // server-helpers wins at module-load but the duplication is a
    // smell. This test catches the duplication.
    const src = fs.readFileSync(serverTs, "utf-8");
    const localDefs = src.match(/^async function resolvePemInput\b/gm) ?? [];
    expect(localDefs).toHaveLength(0);
    // Confirm the import from server-helpers is in place.
    expect(src).toMatch(
      /import\s*\{\s*resolvePemInput\s*\}\s*from\s*["']\.\/server-helpers\.js["']/,
    );
  });
});
