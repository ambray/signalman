/**
 * v0.3.0-5 sub-task 4 — OpenTofu driver tests.
 *
 * Pure-module + injectable-exec tests; no real `tofu` binary is
 * ever spawned. The driver's exec callback is a `vi.fn` returning
 * canned stdout/exit codes, so the full apply / destroy / output
 * path is exercised deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  TofuDriver,
  materialiseWorkspace,
  parseChangeSummary,
  parseOutputs,
  validateStackName,
  TOFU_APPLY_TIMEOUT_MS,
  TOFU_DEFAULT_TIMEOUT_MS,
  DEFAULT_TOFU_BIN,
  type TofuExec,
  type TofuExecResult,
} from "../cloud/tofu.js";

// ── Helpers ───────────────────────────────────────────────────────

function freshProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-tofu-"));
  fs.mkdirSync(path.join(root, ".signalman"), { recursive: true });
  return root;
}

function freshModuleDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-tofu-module-"));
  fs.writeFileSync(
    path.join(dir, "main.tf"),
    `resource "null_resource" "demo" {}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "variables.tf"),
    `variable "region" { type = string }\n`,
  );
  return dir;
}

/**
 * Build a scripted exec that returns a different result per
 * tofu phase. The phases are detected by the first arg
 * (`init` / `apply` / `output` / `destroy`).
 */
function scriptedExec(scripts: Record<string, TofuExecResult>): {
  exec: TofuExec;
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const exec: TofuExec = async (args, opts) => {
    calls.push({ args: [...args], cwd: opts.cwd });
    const phase = args[0];
    const result = scripts[phase];
    if (!result) {
      throw new Error(`scripted exec had no result for phase '${phase}'`);
    }
    return result;
  };
  return { exec, calls };
}

const SUCCESS_INIT: TofuExecResult = {
  stdout: "init success",
  stderr: "",
  exitCode: 0,
};

function applySuccessStdout({
  add = 1,
  change = 0,
  remove = 0,
}: {
  add?: number;
  change?: number;
  remove?: number;
} = {}): string {
  return [
    JSON.stringify({ type: "version", version: "1.0" }),
    JSON.stringify({
      type: "change_summary",
      changes: { add, change, remove, operation: "apply" },
    }),
  ].join("\n");
}

function outputSuccessStdout(outputs: Record<string, unknown>): string {
  const wrapped: Record<string, { value: unknown; type: string }> = {};
  for (const [k, v] of Object.entries(outputs)) {
    wrapped[k] = { value: v, type: "string" };
  }
  return JSON.stringify(wrapped);
}

// ── Pure helpers ──────────────────────────────────────────────────

describe("validateStackName", () => {
  it("accepts simple lowercase names", () => {
    expect(validateStackName("smoke")).toBe("smoke");
    expect(validateStackName("aws-three-tier")).toBe("aws-three-tier");
  });

  it("accepts names with dots and underscores", () => {
    expect(validateStackName("stack_v1.2")).toBe("stack_v1.2");
  });

  it("trims surrounding whitespace", () => {
    expect(validateStackName("  smoke  ")).toBe("smoke");
  });

  it("rejects empty string", () => {
    expect(() => validateStackName("")).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
  });

  it("rejects path-traversal characters", () => {
    expect(() => validateStackName("../bad")).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
    expect(() => validateStackName("a/b")).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
    expect(() => validateStackName("a\\b")).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
  });

  it("rejects names starting with non-alphanumeric", () => {
    expect(() => validateStackName("-leading")).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
    expect(() => validateStackName(".leading")).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
  });

  it("rejects names exceeding 64 characters", () => {
    expect(() => validateStackName("a".repeat(65))).toThrowError(
      expect.objectContaining({ code: "invalid_stack_name" }),
    );
  });

  it("rejects non-string values defensively", () => {
    // @ts-expect-error — TS catches at compile, runtime guard for ad-hoc callers
    expect(() => validateStackName(null)).toThrowError();
    // @ts-expect-error — same
    expect(() => validateStackName(42)).toThrowError();
  });
});

describe("parseChangeSummary", () => {
  it("returns zero counts for empty stdout", () => {
    expect(parseChangeSummary("")).toEqual({ add: 0, change: 0, destroy: 0 });
  });

  it("extracts add / change / remove from change_summary event", () => {
    const stdout = JSON.stringify({
      type: "change_summary",
      changes: { add: 3, change: 1, remove: 2 },
    });
    expect(parseChangeSummary(stdout)).toEqual({
      add: 3,
      change: 1,
      destroy: 2,
    });
  });

  it("uses the last change_summary if multiple appear", () => {
    const stdout = [
      JSON.stringify({
        type: "change_summary",
        changes: { add: 1, change: 0, remove: 0 },
      }),
      JSON.stringify({
        type: "change_summary",
        changes: { add: 5, change: 2, remove: 1 },
      }),
    ].join("\n");
    expect(parseChangeSummary(stdout)).toEqual({
      add: 5,
      change: 2,
      destroy: 1,
    });
  });

  it("ignores non-JSON lines", () => {
    const stdout = [
      "noise that is not json",
      JSON.stringify({
        type: "change_summary",
        changes: { add: 1, change: 0, remove: 0 },
      }),
      "trailing noise",
    ].join("\n");
    expect(parseChangeSummary(stdout)).toEqual({
      add: 1,
      change: 0,
      destroy: 0,
    });
  });

  it("ignores JSON events of other types", () => {
    const stdout = [
      JSON.stringify({ type: "version", version: "1.0" }),
      JSON.stringify({ type: "planned_change", change: { action: "create" } }),
    ].join("\n");
    expect(parseChangeSummary(stdout)).toEqual({
      add: 0,
      change: 0,
      destroy: 0,
    });
  });

  it("treats missing change fields as zero", () => {
    const stdout = JSON.stringify({
      type: "change_summary",
      changes: { add: 2 },
    });
    expect(parseChangeSummary(stdout)).toEqual({
      add: 2,
      change: 0,
      destroy: 0,
    });
  });
});

describe("parseOutputs", () => {
  it("returns empty object for empty stdout", () => {
    expect(parseOutputs("")).toEqual({});
    expect(parseOutputs("   ")).toEqual({});
  });

  it("flattens tofu's wrapped output format to name -> value", () => {
    const stdout = JSON.stringify({
      public_ip: { value: "203.0.113.5", type: "string" },
      instance_id: { value: "i-0abc", type: "string", sensitive: false },
    });
    expect(parseOutputs(stdout)).toEqual({
      public_ip: "203.0.113.5",
      instance_id: "i-0abc",
    });
  });

  it("handles non-string output values", () => {
    const stdout = JSON.stringify({
      count: { value: 42, type: "number" },
      tags: { value: ["a", "b"], type: "list" },
    });
    expect(parseOutputs(stdout)).toEqual({
      count: 42,
      tags: ["a", "b"],
    });
  });

  it("returns empty object for unparseable JSON", () => {
    expect(parseOutputs("not json")).toEqual({});
  });
});

describe("materialiseWorkspace", () => {
  let projectRoot: string;
  let modulePath: string;

  beforeEach(() => {
    projectRoot = freshProjectRoot();
    modulePath = freshModuleDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modulePath, { recursive: true, force: true });
  });

  it("creates the workspace directory if missing", () => {
    const ws = path.join(projectRoot, "ws-new");
    materialiseWorkspace(ws, modulePath);
    expect(fs.existsSync(ws)).toBe(true);
  });

  it("writes a sentinel file recording the source module path", () => {
    const ws = path.join(projectRoot, "ws-sentinel");
    materialiseWorkspace(ws, modulePath);
    const sentinel = path.join(ws, ".signalman-source");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf-8")).toBe(modulePath);
  });

  it("materialises HCL files from the source module", () => {
    const ws = path.join(projectRoot, "ws-files");
    materialiseWorkspace(ws, modulePath);
    expect(fs.existsSync(path.join(ws, "main.tf"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "variables.tf"))).toBe(true);
  });

  it("skips .terraform and .tofu directories from the source", () => {
    fs.mkdirSync(path.join(modulePath, ".terraform"), { recursive: true });
    fs.writeFileSync(path.join(modulePath, ".terraform", "noise"), "x");
    fs.mkdirSync(path.join(modulePath, ".tofu"), { recursive: true });
    const ws = path.join(projectRoot, "ws-skip");
    materialiseWorkspace(ws, modulePath);
    expect(fs.existsSync(path.join(ws, ".terraform"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tofu"))).toBe(false);
  });

  it("skips terraform.tfstate* files from the source", () => {
    fs.writeFileSync(path.join(modulePath, "terraform.tfstate"), "{}");
    fs.writeFileSync(path.join(modulePath, "terraform.tfstate.backup"), "{}");
    const ws = path.join(projectRoot, "ws-state");
    materialiseWorkspace(ws, modulePath);
    expect(fs.existsSync(path.join(ws, "terraform.tfstate"))).toBe(false);
    expect(fs.existsSync(path.join(ws, "terraform.tfstate.backup"))).toBe(false);
  });
});

// ── TofuDriver — constructor ─────────────────────────────────────

describe("TofuDriver — constructor", () => {
  it("rejects a relative projectRoot", () => {
    expect(
      () => new TofuDriver({ projectRoot: "relative/path" }),
    ).toThrowError(
      expect.objectContaining({ code: "project_root_invalid" }),
    );
  });

  it("constructs cleanly with an absolute projectRoot", () => {
    const root = freshProjectRoot();
    try {
      const d = new TofuDriver({ projectRoot: root });
      expect(d).toBeInstanceOf(TofuDriver);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses SIGNALMAN_TOFU_BIN env when tofuBin option is missing", () => {
    const root = freshProjectRoot();
    const prior = process.env.SIGNALMAN_TOFU_BIN;
    process.env.SIGNALMAN_TOFU_BIN = "/opt/tofu-custom";
    try {
      const d = new TofuDriver({ projectRoot: root });
      // workspacePathFor is the only public observable that proves
      // construction completed; tofuBin isn't directly inspectable.
      // Just confirm no exception:
      expect(d.workspacePathFor("any")).toContain(".signalman");
    } finally {
      if (prior !== undefined) process.env.SIGNALMAN_TOFU_BIN = prior;
      else delete process.env.SIGNALMAN_TOFU_BIN;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── applyModule — happy path ──────────────────────────────────────

describe("TofuDriver.applyModule — happy path", () => {
  let projectRoot: string;
  let modulePath: string;

  beforeEach(() => {
    projectRoot = freshProjectRoot();
    modulePath = freshModuleDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modulePath, { recursive: true, force: true });
  });

  it("runs init + apply + output in sequence and returns the parsed outcome", async () => {
    const { exec, calls } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout({ add: 3, change: 1, remove: 0 }),
        stderr: "",
        exitCode: 0,
      },
      output: {
        stdout: outputSuccessStdout({
          public_ip: "203.0.113.7",
          instance_id: "i-cafe",
        }),
        stderr: "",
        exitCode: 0,
      },
    });

    const driver = new TofuDriver({ projectRoot, exec });
    const result = await driver.applyModule({
      stackName: "smoke",
      modulePath,
    });

    expect(result.stackName).toBe("smoke");
    expect(result.changed).toBe(true);
    expect(result.changeSummary).toEqual({ add: 3, change: 1, destroy: 0 });
    expect(result.outputs).toEqual({
      public_ip: "203.0.113.7",
      instance_id: "i-cafe",
    });
    expect(result.workspacePath).toContain(".signalman");
    expect(result.workspacePath).toContain("smoke");
    // Three phases, in order.
    expect(calls.map((c) => c.args[0])).toEqual(["init", "apply", "output"]);
  });

  it("passes -auto-approve to apply by default", async () => {
    const { exec, calls } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout(),
        stderr: "",
        exitCode: 0,
      },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    const driver = new TofuDriver({ projectRoot, exec });
    await driver.applyModule({ stackName: "default-approve", modulePath });
    const applyCall = calls.find((c) => c.args[0] === "apply");
    expect(applyCall?.args).toContain("-auto-approve");
  });

  it("omits -auto-approve when autoApprove is false", async () => {
    const { exec, calls } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout(),
        stderr: "",
        exitCode: 0,
      },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    const driver = new TofuDriver({ projectRoot, exec });
    await driver.applyModule({
      stackName: "no-approve",
      modulePath,
      autoApprove: false,
    });
    const applyCall = calls.find((c) => c.args[0] === "apply");
    expect(applyCall?.args).not.toContain("-auto-approve");
  });

  it("forwards vars as -var k=v on apply", async () => {
    const { exec, calls } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout(),
        stderr: "",
        exitCode: 0,
      },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    const driver = new TofuDriver({ projectRoot, exec });
    await driver.applyModule({
      stackName: "with-vars",
      modulePath,
      vars: { region: "us-east-1", count: 3, enabled: true },
    });
    const applyArgs = calls.find((c) => c.args[0] === "apply")!.args;
    // -var occurs three times.
    expect(applyArgs.filter((a) => a === "-var")).toHaveLength(3);
    expect(applyArgs).toContain("region=us-east-1");
    expect(applyArgs).toContain("count=3");
    expect(applyArgs).toContain("enabled=true");
  });

  it("reports changed=false when the change summary has zero deltas", async () => {
    const { exec } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout({ add: 0, change: 0, remove: 0 }),
        stderr: "",
        exitCode: 0,
      },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    const driver = new TofuDriver({ projectRoot, exec });
    const result = await driver.applyModule({
      stackName: "no-changes",
      modulePath,
    });
    expect(result.changed).toBe(false);
  });
});

// ── applyModule — error paths ────────────────────────────────────

describe("TofuDriver.applyModule — error paths", () => {
  let projectRoot: string;
  let modulePath: string;

  beforeEach(() => {
    projectRoot = freshProjectRoot();
    modulePath = freshModuleDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modulePath, { recursive: true, force: true });
  });

  it("rejects an invalid stack name", async () => {
    const { exec } = scriptedExec({ init: SUCCESS_INIT });
    const driver = new TofuDriver({ projectRoot, exec });
    await expect(
      driver.applyModule({ stackName: "../escape", modulePath }),
    ).rejects.toMatchObject({ code: "invalid_stack_name" });
  });

  it("rejects a missing module path with module_path_missing", async () => {
    const { exec } = scriptedExec({ init: SUCCESS_INIT });
    const driver = new TofuDriver({ projectRoot, exec });
    await expect(
      driver.applyModule({
        stackName: "missing-module",
        modulePath: "/nonexistent/path/to/module",
      }),
    ).rejects.toMatchObject({ code: "module_path_missing" });
  });

  it("surfaces a non-zero init exit as tofu_failed", async () => {
    const { exec } = scriptedExec({
      init: {
        stdout: "",
        stderr: "Failed to initialise providers",
        exitCode: 1,
      },
    });
    const driver = new TofuDriver({ projectRoot, exec });
    await expect(
      driver.applyModule({ stackName: "init-bad", modulePath }),
    ).rejects.toMatchObject({ code: "tofu_failed" });
  });

  it("surfaces a non-zero apply exit as tofu_failed", async () => {
    const { exec } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: "",
        stderr: "Resource already exists",
        exitCode: 1,
      },
    });
    const driver = new TofuDriver({ projectRoot, exec });
    await expect(
      driver.applyModule({ stackName: "apply-bad", modulePath }),
    ).rejects.toMatchObject({ code: "tofu_failed" });
  });

  it("surfaces ENOENT from a missing tofu binary as tofu_not_found", async () => {
    const exec: TofuExec = async () => {
      const err = new Error("ENOENT: not found") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    const driver = new TofuDriver({ projectRoot, exec });
    await expect(
      driver.applyModule({ stackName: "no-bin", modulePath }),
    ).rejects.toMatchObject({ code: "tofu_not_found" });
  });
});

// ── destroyModule ────────────────────────────────────────────────

describe("TofuDriver.destroyModule", () => {
  let projectRoot: string;
  let modulePath: string;

  beforeEach(() => {
    projectRoot = freshProjectRoot();
    modulePath = freshModuleDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modulePath, { recursive: true, force: true });
  });

  it("returns idempotent no-op when the workspace doesn't exist", async () => {
    const exec: TofuExec = async () => {
      throw new Error("should not be called");
    };
    const driver = new TofuDriver({ projectRoot, exec });
    const result = await driver.destroyModule({ stackName: "never-applied" });
    expect(result.alreadyEmpty).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.changeSummary.destroy).toBe(0);
  });

  it("runs tofu destroy + parses the change summary", async () => {
    // First apply to create the workspace.
    const { exec: applyExec } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout({ add: 2 }),
        stderr: "",
        exitCode: 0,
      },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    const applyDriver = new TofuDriver({ projectRoot, exec: applyExec });
    await applyDriver.applyModule({
      stackName: "destroy-target",
      modulePath,
    });

    // Then destroy with a fresh driver/exec.
    const { exec: destroyExec, calls } = scriptedExec({
      destroy: {
        stdout: applySuccessStdout({ remove: 2 }),
        stderr: "",
        exitCode: 0,
      },
    });
    const destroyDriver = new TofuDriver({ projectRoot, exec: destroyExec });
    const result = await destroyDriver.destroyModule({
      stackName: "destroy-target",
    });
    expect(result.alreadyEmpty).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.changeSummary.destroy).toBe(2);
    expect(calls.map((c) => c.args[0])).toEqual(["destroy"]);
    expect(calls[0].args).toContain("-auto-approve");
  });

  it("surfaces destroy failures as tofu_failed", async () => {
    // Create workspace first.
    const { exec: applyExec } = scriptedExec({
      init: SUCCESS_INIT,
      apply: {
        stdout: applySuccessStdout(),
        stderr: "",
        exitCode: 0,
      },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    await new TofuDriver({ projectRoot, exec: applyExec }).applyModule({
      stackName: "destroy-fails",
      modulePath,
    });

    const { exec: destroyExec } = scriptedExec({
      destroy: { stdout: "", stderr: "Dependent resources exist", exitCode: 1 },
    });
    const destroyDriver = new TofuDriver({ projectRoot, exec: destroyExec });
    await expect(
      destroyDriver.destroyModule({ stackName: "destroy-fails" }),
    ).rejects.toMatchObject({ code: "tofu_failed" });
  });

  it("forwards vars on destroy too", async () => {
    // Workspace must exist.
    const { exec: applyExec } = scriptedExec({
      init: SUCCESS_INIT,
      apply: { stdout: applySuccessStdout(), stderr: "", exitCode: 0 },
      output: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    await new TofuDriver({ projectRoot, exec: applyExec }).applyModule({
      stackName: "vars-destroy",
      modulePath,
    });

    const { exec: destroyExec, calls } = scriptedExec({
      destroy: {
        stdout: applySuccessStdout({ remove: 1 }),
        stderr: "",
        exitCode: 0,
      },
    });
    await new TofuDriver({ projectRoot, exec: destroyExec }).destroyModule({
      stackName: "vars-destroy",
      vars: { region: "us-east-1" },
    });
    expect(calls[0].args).toContain("-var");
    expect(calls[0].args).toContain("region=us-east-1");
  });
});

// ── workspacePathFor ─────────────────────────────────────────────

describe("TofuDriver.workspacePathFor", () => {
  it("returns <projectRoot>/.signalman/tofu-workspaces/<stack>", () => {
    const root = freshProjectRoot();
    try {
      const d = new TofuDriver({ projectRoot: root });
      const ws = d.workspacePathFor("my-stack");
      expect(ws).toContain(root);
      expect(ws).toContain(".signalman");
      expect(ws).toContain("tofu-workspaces");
      expect(ws.endsWith("my-stack")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Constants ─────────────────────────────────────────────────────

describe("Public constants", () => {
  it("DEFAULT_TOFU_BIN is 'tofu'", () => {
    expect(DEFAULT_TOFU_BIN).toBe("tofu");
  });

  it("TOFU_DEFAULT_TIMEOUT_MS is 5 minutes", () => {
    expect(TOFU_DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it("TOFU_APPLY_TIMEOUT_MS is 30 minutes", () => {
    expect(TOFU_APPLY_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
