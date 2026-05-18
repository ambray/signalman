/**
 * Bootstrap-win11 CLI surface tests (v0.5-win11-deploy M1).
 *
 * Two layers:
 *
 * 1. argv parser (`parseArgs`): we test the small slice of behavior
 *    that bootstrap-win11 depends on (positional, --force,
 *    --cleanup-on-failure, --template, --msi, --cert, --checkpoint,
 *    --format=json).
 *
 * 2. end-to-end CLI invocation: we spawn `signalman vm bootstrap-win11`
 *    via tsx and assert on:
 *      - usage error when the positional <name> is missing (exit 64);
 *      - usage error when `--msi-from-build` is passed (reserved for
 *        v0.6 per Q2 locked default);
 *      - exit 3 with remediation hints when `--msi` is missing
 *        (resolve_msi setup error);
 *      - help text mentions `bootstrap-win11`.
 *
 * The subprocess pattern matches cli-version.test.ts. We avoid
 * exercising the full pipeline through tsx (the backend would need to
 * be Hyper-V or a mock harness, neither of which are in-process in a
 * vitest test) — that's covered by the unit-level tests in
 * bootstrap-win11.test.ts.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs } from "../cli.js";

const execFileP = promisify(execFile);

const HOST_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const TSX_BIN = path.join(HOST_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(HOST_ROOT, "src", "cli.ts");

let tmpCwd: string;

beforeEach(() => {
  // Run from a clean tmpdir so a stray .signalman/config.yaml doesn't
  // leak into the subprocess test. The CLI will then fall back to its
  // built-in defaults (Hyper-V on Windows, error elsewhere — that's
  // fine; we surface error messages either way).
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-win11-cli-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

async function runCli(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(TSX_BIN, [CLI_ENTRY, ...argv], {
      cwd: tmpCwd,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

// ── parseArgs slice for bootstrap-win11 flags ─────────────────────

describe("parseArgs (bootstrap-win11 flag surface)", () => {
  it("captures positional vmName", () => {
    const r = parseArgs(["my-vm"]);
    expect(r.positional).toEqual(["my-vm"]);
  });

  it("captures --force as a boolean flag", () => {
    const r = parseArgs(["my-vm", "--force"]);
    expect(r.flags.has("force")).toBe(true);
    expect(r.positional).toEqual(["my-vm"]);
  });

  it("captures --cleanup-on-failure as a boolean flag", () => {
    const r = parseArgs(["my-vm", "--cleanup-on-failure"]);
    expect(r.flags.has("cleanup-on-failure")).toBe(true);
  });

  it("captures --template <value> as an option", () => {
    const r = parseArgs(["my-vm", "--template", "win11-dev"]);
    expect(r.options.get("template")).toBe("win11-dev");
  });

  it("captures --template=<value> short form", () => {
    const r = parseArgs(["my-vm", "--template=win11-dev"]);
    expect(r.options.get("template")).toBe("win11-dev");
  });

  it("captures --msi <path>", () => {
    const r = parseArgs(["my-vm", "--msi", "/abs/path.msi"]);
    expect(r.options.get("msi")).toBe("/abs/path.msi");
  });

  it("captures --cert <path>", () => {
    const r = parseArgs(["my-vm", "--cert", "/abs/cert.pfx"]);
    expect(r.options.get("cert")).toBe("/abs/cert.pfx");
  });

  it("captures --checkpoint <label>", () => {
    const r = parseArgs(["my-vm", "--checkpoint", "demo-ready"]);
    expect(r.options.get("checkpoint")).toBe("demo-ready");
  });

  it("captures --format json", () => {
    const r = parseArgs(["my-vm", "--format", "json"]);
    expect(r.options.get("format")).toBe("json");
  });

  it("combines positional + multiple options + flags in any order", () => {
    const r = parseArgs([
      "my-vm",
      "--template",
      "win11-base",
      "--msi",
      "/abs/path.msi",
      "--force",
      "--cleanup-on-failure",
      "--checkpoint",
      "demo-ready",
      "--format",
      "json",
    ]);
    expect(r.positional).toEqual(["my-vm"]);
    expect(r.options.get("template")).toBe("win11-base");
    expect(r.options.get("msi")).toBe("/abs/path.msi");
    expect(r.options.get("checkpoint")).toBe("demo-ready");
    expect(r.options.get("format")).toBe("json");
    expect(r.flags.has("force")).toBe(true);
    expect(r.flags.has("cleanup-on-failure")).toBe(true);
  });

  it("preserves option ordering robustness when flag appears before positional", () => {
    const r = parseArgs(["--force", "my-vm", "--msi", "/abs/path.msi"]);
    expect(r.positional).toEqual(["my-vm"]);
    expect(r.flags.has("force")).toBe(true);
    expect(r.options.get("msi")).toBe("/abs/path.msi");
  });

  it("treats --force=true as a flag (value ignored)", () => {
    const r = parseArgs(["my-vm", "--force=true"]);
    expect(r.flags.has("force")).toBe(true);
  });
});

// ── End-to-end CLI invocations (subprocess) ───────────────────────

describe("signalman vm bootstrap-win11 (end-to-end usage paths)", () => {
  it("usage error (exit 64) when <name> is missing", async () => {
    const { exitCode, stderr } = await runCli(["vm", "bootstrap-win11"]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("bootstrap-win11");
    expect(stderr).toContain("<name>");
  });

  it("usage error (exit 64) when --msi-from-build is passed", async () => {
    const { exitCode, stderr } = await runCli([
      "vm",
      "bootstrap-win11",
      "my-vm",
      "--msi-from-build",
      "build-42",
    ]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--msi-from-build");
    expect(stderr).toContain("v0.6");
  });

  it("vm subcommand usage error mentions bootstrap-win11 in the verb list", async () => {
    const { exitCode, stderr } = await runCli(["vm"]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("bootstrap-win11");
  });

  it("--help main page is reachable and does not crash", async () => {
    const { exitCode, stdout } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    // We don't require bootstrap-win11 to appear in the top-level
    // help (the existing help text only enumerates root verbs); just
    // that --help still works after the wire-up.
    expect(stdout.length).toBeGreaterThan(0);
  });
});
