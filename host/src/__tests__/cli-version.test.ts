/**
 * End-to-end test for `signalman --version` and `signalman --help`.
 *
 * Spawns the CLI via tsx (matching the `npm run cli` script in
 * package.json) so the test exercises the actual entry point,
 * argv routing, and stdout pipe — not a mocked main(). This is the
 * exact path a bug-report-template user would hit.
 *
 * Why subprocess rather than calling main() in-process:
 *   - main() isn't exported (intentional — the CLI's API surface is
 *     verb-handler functions, not the entry shell).
 *   - Subprocess proves the build- and runtime-resolution of
 *     `host/package.json` from `host/src/version.ts` (which uses
 *     `import.meta.url`-relative resolution) — an in-process test
 *     can't catch a regression that breaks at the file-resolution
 *     layer.
 */

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { VERSION } from "../version.js";

const execFileP = promisify(execFile);

// host/ is two levels up from host/src/__tests__/ (this file)
const HOST_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const TSX_BIN = path.join(HOST_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(HOST_ROOT, "src", "cli.ts");

async function runCli(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(TSX_BIN, [CLI_ENTRY, ...argv], {
      cwd: HOST_ROOT,
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

describe("signalman --version (end-to-end)", () => {
  it("exits 0 and prints `signalman <version>` on stdout", async () => {
    const { exitCode, stdout } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`signalman ${VERSION}\n`);
  });

  it("accepts the `-V` short form", async () => {
    const { exitCode, stdout } = await runCli(["-V"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`signalman ${VERSION}\n`);
  });

  it("does not write to stderr on the happy path", async () => {
    const { stderr } = await runCli(["--version"]);
    expect(stderr).toBe("");
  });
});

describe("signalman --help mentions --version (discoverability)", () => {
  it("includes `--version` in the help output", async () => {
    const { exitCode, stdout } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--version");
  });
});
