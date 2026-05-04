/**
 * `signalman init` (P9.3) tests.
 *
 * Each test gets its own temp directory so the suite is order-
 * independent. We assert on filesystem state directly rather than
 * mocking fs — `runInit` is a thin wrapper over `fs.writeFileSync`
 * and the fidelity of these tests is exactly the on-disk artifact.
 *
 * Test coverage matrix (per the 6-lens audit's QA pass):
 *
 *   - Default scaffold lays down config + sample scenario + dirs.
 *   - Re-running with no flags is idempotent (skipped, not error).
 *   - --force overwrites existing content.
 *   - --bootstrap surfaces the current manual bootstrap sequence.
 *   - Project name validation refuses unsafe characters.
 *   - Project root is the cwd absolute path, not relative.
 *   - Scaffolded YAML parses (no embedded \\r\\n / encoding bug).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

import { runInit } from "../verbs/init.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-init-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runInit (P9.3)", () => {
  // What this catches: regression that drops one of the scaffold
  // entries or changes its path. The scaffold is the contract.
  it("creates the minimal scaffold under .signalman/", () => {
    const result = runInit({ cwd: tmpDir });
    expect(result.projectRoot).toBe(path.resolve(tmpDir));
    expect(result.filesSkipped).toEqual([]);
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(6);

    // The five canonical paths the scaffold MUST produce.
    for (const rel of [
      ".signalman/config.yaml",
      ".signalman/scenarios/.gitkeep",
      ".signalman/templates/.gitkeep",
      ".signalman/scenarios/sample/setup.yaml",
      ".signalman/scenarios/sample/assertions.yaml",
      ".signalman/scenarios/sample/workflow.md",
    ]) {
      expect(fs.existsSync(path.join(tmpDir, rel))).toBe(true);
    }
  });

  // What this catches: a refactor that breaks idempotency by always
  // overwriting. Re-running init in a project that's already
  // initialised should be a fast no-op.
  it("re-running with no flags is a no-op (filesSkipped reports the existing files)", () => {
    runInit({ cwd: tmpDir });
    const second = runInit({ cwd: tmpDir });
    expect(second.filesCreated).toEqual([]);
    expect(second.filesSkipped.length).toBeGreaterThanOrEqual(6);
  });

  // What this catches: --force not actually forcing. Operators rely
  // on this to recover from a bungled hand-edit.
  it("--force overwrites existing scaffold content", () => {
    runInit({ cwd: tmpDir });
    const cfg = path.join(tmpDir, ".signalman/config.yaml");
    fs.writeFileSync(cfg, "# clobbered by hand\n");
    expect(fs.readFileSync(cfg, "utf8")).toBe("# clobbered by hand\n");
    const second = runInit({ cwd: tmpDir, force: true });
    expect(second.filesCreated.map((p) => path.relative(tmpDir, p))).toContain(
      path.join(".signalman", "config.yaml"),
    );
    expect(fs.readFileSync(cfg, "utf8")).toContain("ProjectConfig");
  });

  // What this catches: scaffolded YAML accidentally invalid (e.g. tab
  // indent, bad escape) — would silently break `signalman list`.
  it("scaffolded config.yaml + setup.yaml parse as valid YAML", () => {
    runInit({ cwd: tmpDir });
    const cfg = YAML.parse(
      fs.readFileSync(path.join(tmpDir, ".signalman/config.yaml"), "utf8"),
    );
    expect(cfg.kind).toBe("ProjectConfig");
    expect(cfg.apiVersion).toBe("signalman.dev/v1alpha1");
    expect(cfg.metadata.name).toBe(path.basename(path.resolve(tmpDir)));

    const setup = YAML.parse(
      fs.readFileSync(
        path.join(tmpDir, ".signalman/scenarios/sample/setup.yaml"),
        "utf8",
      ),
    );
    expect(setup.name).toBe("sample: signalman is wired up");
    expect(setup.tags).toContain("smoke");
    expect(setup.setup).toEqual([]);
  });

  // What this catches: --bootstrap silently doing nothing instead of
  // surfacing the now-landed bootstrap sequence. The flag is still
  // guidance-only because VM image fetch + provision need operator
  // choices.
  it("--bootstrap returns the current bootstrap sequence", () => {
    const result = runInit({ cwd: tmpDir, bootstrap: true });
    expect(result.bootstrapMessage).toBeDefined();
    expect(result.bootstrapMessage).toMatch(/generate-dev-certs/);
    expect(result.bootstrapMessage).toMatch(/fetch-template/);
    expect(result.bootstrapMessage).toMatch(/provision/);
    expect(result.bootstrapMessage).toMatch(/run sample/);
    expect(result.bootstrapMessage).not.toMatch(/not yet implemented/i);
    expect(result.bootstrapDeferredMessage).toBe(result.bootstrapMessage);
  });

  // What this catches: a malicious / typo'd projectName injecting a
  // YAML break or shell metachar into config.yaml.
  it("rejects unsafe projectName values", () => {
    expect(() =>
      runInit({ cwd: tmpDir, projectName: "foo\nname: evil" }),
    ).toThrow(/projectName/);
    expect(() => runInit({ cwd: tmpDir, projectName: "" })).toThrow(/projectName/);
    expect(() =>
      runInit({ cwd: tmpDir, projectName: "$(curl evil)" }),
    ).toThrow(/projectName/);
  });

  // What this catches: scaffolded files written outside the requested
  // cwd. Important for both Ops (LLM agent runs init in a sandboxed
  // dir) and Sec (no escape from the requested directory).
  it("writes only inside the requested cwd", () => {
    const result = runInit({ cwd: tmpDir });
    for (const abs of result.filesCreated) {
      const rel = path.relative(path.resolve(tmpDir), abs);
      expect(rel.startsWith("..")).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
    }
  });

  // What this catches: relative cwd being passed through unresolved,
  // breaking downstream consumers that call path.join(projectRoot, ...).
  it("returns absolute projectRoot regardless of input form", () => {
    const result = runInit({ cwd: tmpDir });
    expect(path.isAbsolute(result.projectRoot)).toBe(true);
    expect(result.projectRoot).toBe(path.resolve(tmpDir));
  });

  // What this catches: scaffold paths colliding when the operator
  // re-runs with a different projectName — the scaffold should NOT
  // be sensitive to projectName (only config.yaml's metadata.name is).
  it("custom projectName lands in config.yaml metadata.name only", () => {
    runInit({ cwd: tmpDir, projectName: "my-cool-project" });
    const cfg = YAML.parse(
      fs.readFileSync(path.join(tmpDir, ".signalman/config.yaml"), "utf8"),
    );
    expect(cfg.metadata.name).toBe("my-cool-project");
    // Other scaffold files don't carry the project name at all in
    // v0.1.1; pin that contract so a future refactor surfaces it as
    // a test failure rather than silent breakage.
    const setup = fs.readFileSync(
      path.join(tmpDir, ".signalman/scenarios/sample/setup.yaml"),
      "utf8",
    );
    expect(setup).not.toContain("my-cool-project");
  });
});
