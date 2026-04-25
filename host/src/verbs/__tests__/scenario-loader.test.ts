import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listScenarios, resolveScenarioById } from "../../scenarios/scenario-loader.js";
import { resolveLayout, findProjectRoot } from "../../scenarios/project-layout.js";

function makeRoot(scenarios: Record<string, Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-loader-test-"));
  fs.mkdirSync(path.join(root, ".signalman", "scenarios"), { recursive: true });
  for (const [id, files] of Object.entries(scenarios)) {
    const dir = path.join(root, ".signalman", "scenarios", ...id.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }
  return root;
}

describe("listScenarios", () => {
  it("retains slash-delimited sub-directory ids", () => {
    const root = makeRoot({
      "a/b/c": { "setup.yaml": "name: x\nversion: '1'\nvms: [{name: x, template: t, guest_agent_port: 50051}]\n" },
      "z": { "setup.yaml": "name: y\nversion: '1'\nvms: [{name: y, template: t, guest_agent_port: 50051}]\n" },
    });
    const scenariosDir = path.join(root, ".signalman", "scenarios");
    const found = listScenarios(scenariosDir);
    expect(found.map((s) => s.id).sort()).toEqual(["a/b/c", "z"]);
  });

  it("rejects ambiguous nesting (parent + child both have setup.yaml)", () => {
    const root = makeRoot({
      "a": { "setup.yaml": "name: parent\nversion: '1'\nvms: [{name: x, template: t, guest_agent_port: 50051}]\n" },
      "a/b": { "setup.yaml": "name: child\nversion: '1'\nvms: [{name: x, template: t, guest_agent_port: 50051}]\n" },
    });
    const scenariosDir = path.join(root, ".signalman", "scenarios");
    expect(() => listScenarios(scenariosDir)).toThrow(/Ambiguous scenario nesting/);
  });

  it("returns empty list when scenarios dir doesn't exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-sc-"));
    expect(listScenarios(path.join(root, ".signalman", "scenarios"))).toEqual([]);
  });
});

describe("resolveScenarioById", () => {
  it("resolves a/b/c into the matching directory", () => {
    const root = makeRoot({
      "a/b/c": { "setup.yaml": "name: x\nversion: '1'\nvms: [{name: x, template: t, guest_agent_port: 50051}]\n" },
    });
    const scenariosDir = path.join(root, ".signalman", "scenarios");
    const dir = resolveScenarioById(scenariosDir, "a/b/c");
    expect(dir).toBe(path.resolve(scenariosDir, "a", "b", "c"));
  });

  it("rejects path traversal", () => {
    expect(() => resolveScenarioById("/tmp/sc", "../../etc")).toThrow(/Invalid scenario id/);
  });
});

describe("resolveLayout", () => {
  it("finds .signalman/ when present", () => {
    const root = makeRoot({});
    const layout = resolveLayout(root);
    expect(layout.legacy).toBe(false);
    expect(layout.scenariosDir).toBe(path.join(root, ".signalman", "scenarios"));
  });

  it("falls back to legacy layout when only signalman.yaml + scenarios/ exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
    fs.writeFileSync(path.join(root, "signalman.yaml"), "hypervisor: { backend: hyperv }\n");
    fs.mkdirSync(path.join(root, "scenarios", "smoke"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scenarios", "smoke", "setup.yaml"),
      "name: x\nversion: '1'\nvms: [{name: x, template: t, guest_agent_port: 50051}]\n",
    );
    const layout = resolveLayout(root);
    expect(layout.legacy).toBe(true);
    expect(layout.scenariosDir).toBe(path.join(root, "scenarios"));
  });
});

describe("findProjectRoot", () => {
  it("walks upward to find .signalman/", () => {
    const root = makeRoot({ "smoke": { "setup.yaml": "name: x\nversion: '1'\nvms: [{name: x, template: t, guest_agent_port: 50051}]\n" } });
    const deep = path.join(root, ".signalman", "scenarios", "smoke");
    expect(findProjectRoot(deep)).toBe(root);
  });
});
