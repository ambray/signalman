/**
 * v0.3.0-5 sub-task 5 — CLI surface for `signalman cloud budget`.
 *
 * System-layer coverage of the CLI verb wiring: parses argv,
 * dispatches to cmdCloudBudget, captures stdout, asserts the
 * structured output the operator (or a wrapping script) sees.
 *
 * Tests use SIGNALMAN_DATA_DIR pointing at a per-test tmpdir so
 * each case gets an isolated SQLite DB. The CLI handler honours
 * this env var via `resolveControlPlaneConfig`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cmdCloudBudget, type ParsedArgs } from "../cli.js";

function argsFor(positional: string[], opts: Record<string, string> = {}): ParsedArgs {
  return {
    positional: [...positional],
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

describe("signalman cloud budget — CLI surface", () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sigman-budget-cli-"));
    prevDataDir = process.env.SIGNALMAN_DATA_DIR;
    process.env.SIGNALMAN_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.SIGNALMAN_DATA_DIR = prevDataDir;
    else delete process.env.SIGNALMAN_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("`budget get --org X` on an unconfigured org prints 'unlimited'", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudBudget(argsFor(["get"], { org: "acme" }));
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/no budget configured/);
      expect(out).toMatch(/unlimited/);
    } finally {
      capture.restore();
    }
  });

  it("`budget set --org X --monthly-cents N` creates a row", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudBudget(
        argsFor(["set"], { org: "acme", "monthly-cents": "50000" }),
      );
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/monthly limit:\s+50000/);
      expect(out).toMatch(/soft warn pct:\s+80%/);
    } finally {
      capture.restore();
    }
  });

  it("`budget set --soft-warn-pct N` honours the override", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudBudget(
        argsFor(["set"], {
          org: "acme",
          "monthly-cents": "50000",
          "soft-warn-pct": "75",
        }),
      );
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/soft warn pct:\s+75%/);
    } finally {
      capture.restore();
    }
  });

  it("`budget get` after set surfaces the configured limit", async () => {
    // First set the budget (swallow output)
    const presetCapture = captureStdout();
    try {
      await cmdCloudBudget(
        argsFor(["set"], { org: "acme", "monthly-cents": "10000" }),
      );
    } finally {
      presetCapture.restore();
    }
    // Then read it back.
    const capture = captureStdout();
    try {
      const exit = await cmdCloudBudget(
        argsFor(["get"], { org: "acme", format: "json" }),
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.read()) as {
        orgId: string;
        budget: { monthlyCentsLimit: number } | null;
        usageCents: number;
      };
      expect(parsed.orgId).toBe("acme");
      expect(parsed.budget?.monthlyCentsLimit).toBe(10000);
      expect(parsed.usageCents).toBe(0);
    } finally {
      capture.restore();
    }
  });

  it("`budget usage --org X` on empty org prints zero", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudBudget(
        argsFor(["usage"], { org: "acme", format: "json" }),
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.read()) as {
        totalCents: number;
        rows: unknown[];
      };
      expect(parsed.totalCents).toBe(0);
      expect(parsed.rows).toEqual([]);
    } finally {
      capture.restore();
    }
  });
});
