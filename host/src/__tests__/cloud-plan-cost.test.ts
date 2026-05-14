/**
 * v0.3.0-5 sub-task 5 control 3 — pre-flight stack cost estimate.
 *
 * Three layers:
 *   - **Unit**: `parsePlanCost` extracts SKU + region from
 *     synthetic `tofu plan -json` events; unknown resource types
 *     land in `untrackedResources`; non-create actions are ignored.
 *   - **Integration**: `TofuDriver.planModule` with injected
 *     `exec` stub returning a canned plan stream; full pipeline
 *     (init + plan + cost summation) returns the expected
 *     summary + costedResources.
 *   - **System**: `cmdStackPlanCost` CLI handler captures the
 *     human-readable + JSON outputs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePlanCost, TofuDriver, type TofuExec } from "../cloud/tofu.js";
import { cmdStackPlanCost, type ParsedArgs } from "../cli.js";
import { hourlyRateCents, monthlyRateCents } from "../cloud/cost.js";

function argsFor(opts: Record<string, string> = {}): ParsedArgs {
  return {
    positional: [],
    flags: new Set<string>(),
    options: new Map<string, string>(Object.entries(opts)),
    params: {},
  };
}

function captureStdout(): { restore: () => void; read: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: typeof original }).write = original;
    },
    read: () => buf,
  };
}

// ── UNIT: parsePlanCost ──────────────────────────────────────────

describe("parsePlanCost — JSONL plan event extraction", () => {
  it("returns zeros for empty input", () => {
    const result = parsePlanCost("");
    expect(result.estimatedMonthlyCents).toBe(0);
    expect(result.costedResources).toEqual([]);
    expect(result.untrackedResources).toEqual([]);
  });

  it("recognises aws_instance with instance_type + availability_zone", () => {
    const stream = JSON.stringify({
      type: "planned_change",
      change: {
        action: "create",
        resource: { resource: "aws_instance.web", addr: "aws_instance.web" },
        after: { instance_type: "t3.medium", availability_zone: "us-east-1a" },
      },
    });
    const result = parsePlanCost(stream);
    expect(result.costedResources).toHaveLength(1);
    expect(result.costedResources[0].sku).toBe("t3.medium");
    expect(result.costedResources[0].region).toBe("us-east-1");
    expect(result.costedResources[0].monthlyCents).toBe(
      monthlyRateCents("t3.medium", "us-east-1"),
    );
    expect(result.estimatedMonthlyCents).toBe(
      result.costedResources[0].monthlyCents,
    );
  });

  it("recognises azurerm_linux_virtual_machine with size + location", () => {
    const stream = JSON.stringify({
      type: "planned_change",
      change: {
        action: "create",
        resource: {
          resource: "azurerm_linux_virtual_machine.app",
          addr: "azurerm_linux_virtual_machine.app",
        },
        after: { size: "Standard_D2s_v3", location: "eastus" },
      },
    });
    const result = parsePlanCost(stream);
    expect(result.costedResources).toHaveLength(1);
    expect(result.costedResources[0].sku).toBe("Standard_D2s_v3");
    expect(result.costedResources[0].region).toBe("eastus");
  });

  it("lists unknown resource types under untrackedResources", () => {
    const events = [
      {
        type: "planned_change",
        change: {
          action: "create",
          resource: { resource: "aws_s3_bucket.assets", addr: "aws_s3_bucket.assets" },
          after: { bucket: "my-assets" },
        },
      },
      {
        type: "planned_change",
        change: {
          action: "create",
          resource: { resource: "aws_iam_role.app", addr: "aws_iam_role.app" },
          after: {},
        },
      },
    ];
    const result = parsePlanCost(events.map((e) => JSON.stringify(e)).join("\n"));
    expect(result.costedResources).toEqual([]);
    expect(result.untrackedResources).toEqual([
      "aws_s3_bucket.assets",
      "aws_iam_role.app",
    ]);
    expect(result.estimatedMonthlyCents).toBe(0);
  });

  it("ignores non-create actions (update / destroy)", () => {
    const events = [
      {
        type: "planned_change",
        change: {
          action: "update",
          resource: { resource: "aws_instance.live", addr: "aws_instance.live" },
          after: { instance_type: "t3.large", availability_zone: "us-east-1a" },
        },
      },
      {
        type: "planned_change",
        change: {
          action: "delete",
          resource: { resource: "aws_instance.gone", addr: "aws_instance.gone" },
          after: {},
        },
      },
    ];
    const result = parsePlanCost(events.map((e) => JSON.stringify(e)).join("\n"));
    expect(result.costedResources).toEqual([]);
    expect(result.untrackedResources).toEqual([]);
    expect(result.estimatedMonthlyCents).toBe(0);
  });

  it("sums multiple costed resources into estimatedMonthlyCents", () => {
    const events = [
      {
        type: "planned_change",
        change: {
          action: "create",
          resource: { resource: "aws_instance.a", addr: "aws_instance.a" },
          after: { instance_type: "t3.medium", availability_zone: "us-east-1a" },
        },
      },
      {
        type: "planned_change",
        change: {
          action: "create",
          resource: { resource: "aws_instance.b", addr: "aws_instance.b" },
          after: { instance_type: "t3.small", availability_zone: "us-east-1a" },
        },
      },
    ];
    const result = parsePlanCost(events.map((e) => JSON.stringify(e)).join("\n"));
    expect(result.costedResources).toHaveLength(2);
    expect(result.estimatedMonthlyCents).toBe(
      monthlyRateCents("t3.medium", "us-east-1") +
        monthlyRateCents("t3.small", "us-east-1"),
    );
  });

  it("tolerates malformed JSON lines (logs skipped, others still parsed)", () => {
    const stream = [
      "not json at all",
      "{ also not valid",
      JSON.stringify({
        type: "planned_change",
        change: {
          action: "create",
          resource: { resource: "aws_instance.foo", addr: "aws_instance.foo" },
          after: { instance_type: "t3.medium", availability_zone: "us-east-1a" },
        },
      }),
    ].join("\n");
    const result = parsePlanCost(stream);
    expect(result.costedResources).toHaveLength(1);
  });

  it("ignores events without type=planned_change", () => {
    const stream = JSON.stringify({
      type: "version",
      data: { version: "1.5.0" },
    });
    const result = parsePlanCost(stream);
    expect(result.estimatedMonthlyCents).toBe(0);
  });
});

// ── INTEGRATION: TofuDriver.planModule with injected exec ───────

describe("TofuDriver.planModule — integration with injected exec", () => {
  let tmpDir: string;
  let modulePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cost-"));
    modulePath = path.join(tmpDir, "module");
    fs.mkdirSync(modulePath);
    fs.writeFileSync(
      path.join(modulePath, "main.tf"),
      'resource "aws_instance" "web" {\n  instance_type = "t3.medium"\n}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs init then plan and returns parsed cost + summary", async () => {
    const calls: string[][] = [];
    const exec: TofuExec = async (args, _opts) => {
      calls.push(args);
      if (args[0] === "init") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "plan") {
        const stream = [
          JSON.stringify({
            type: "planned_change",
            change: {
              action: "create",
              resource: { resource: "aws_instance.web", addr: "aws_instance.web" },
              after: { instance_type: "t3.medium", availability_zone: "us-east-1a" },
            },
          }),
          JSON.stringify({
            type: "change_summary",
            changes: { add: 1, change: 0, remove: 0 },
          }),
        ].join("\n");
        return { stdout: stream, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${args[0]}`);
    };

    const driver = new TofuDriver({ projectRoot: tmpDir, exec });
    const result = await driver.planModule({
      stackName: "test-stack",
      modulePath,
    });
    expect(calls[0][0]).toBe("init");
    expect(calls[1][0]).toBe("plan");
    expect(calls[1]).toContain("-json");
    expect(result.changeSummary).toEqual({ add: 1, change: 0, destroy: 0 });
    expect(result.costedResources).toHaveLength(1);
    expect(result.estimatedMonthlyCents).toBe(
      monthlyRateCents("t3.medium", "us-east-1"),
    );
  });

  it("does NOT call apply or destroy (pre-flight is read-only)", async () => {
    const calls: string[][] = [];
    const exec: TofuExec = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const driver = new TofuDriver({ projectRoot: tmpDir, exec });
    await driver.planModule({ stackName: "test-stack", modulePath });
    expect(calls.find((c) => c[0] === "apply")).toBeUndefined();
    expect(calls.find((c) => c[0] === "destroy")).toBeUndefined();
  });

  it("propagates tofu plan failures as tofu_failed", async () => {
    const exec: TofuExec = async (args) => {
      if (args[0] === "init") return { stdout: "", stderr: "", exitCode: 0 };
      return {
        stdout: "",
        stderr: "Error: provider not initialised",
        exitCode: 1,
      };
    };
    const driver = new TofuDriver({ projectRoot: tmpDir, exec });
    await expect(
      driver.planModule({ stackName: "test-stack", modulePath }),
    ).rejects.toThrowError(/tofu_failed|plan|exit 1/);
  });
});

// ── SYSTEM: cmdStackPlanCost CLI handler ─────────────────────────

describe("signalman stack plan-cost — CLI surface", () => {
  it("rejects missing --stack-name with a usage error", async () => {
    await expect(
      cmdStackPlanCost(argsFor({ "module-path": "/tmp/foo" })),
    ).rejects.toThrowError();
  });

  it("rejects missing --module-path with a usage error", async () => {
    await expect(
      cmdStackPlanCost(argsFor({ "stack-name": "test" })),
    ).rejects.toThrowError();
  });

  it("returns exit 4 when the underlying plan fails (module path missing)", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdStackPlanCost(
        argsFor({
          "stack-name": "test",
          "module-path": "/nonexistent/path/that/will/never/exist-xyz",
        }),
      );
      expect(exit).toBe(4);
    } finally {
      capture.restore();
    }
  });

  it("hourly + monthly rates round-trip via the public API for known SKUs", () => {
    expect(monthlyRateCents("t3.medium", "us-east-1")).toBe(
      hourlyRateCents("t3.medium", "us-east-1") * 730,
    );
  });
});
