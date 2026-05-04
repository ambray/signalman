/**
 * REGRESSION: Sprint 60.12 Phase B — no gsudo elevation in the host CLI.
 *
 * # Field bug
 *
 * The host CLI used to auto-elevate PowerShell calls via gsudo's
 * `gsudo powershell.exe ...` shim. Under unattended runs this turned a
 * "you need elevation for Get-VM" into a 30-second hang followed by a
 * cryptic "User cancelled" message — there was no human watching the
 * screen to click "Yes" on the UAC dialog gsudo silently popped up.
 *
 * Compounding bug: even when gsudo *was* installed, its UTF-16 wrapping
 * trick (passing PowerShell a `-EncodedCommand` payload to survive
 * sudo's own shell parsing) sometimes interacted with our PowerShell
 * scripts in ways that stripped `$variable` references — causing
 * scripts to silently behave differently when run elevated vs not.
 *
 * # Fix
 *
 * `host/src/hypervisors/hyperv.ts` no longer references gsudo at all.
 * `resolvePsCommand` always returns plain `powershell.exe`. Callers
 * who genuinely need elevation either:
 *   1. Run the host CLI from an elevated shell themselves, OR
 *   2. Use the SystemBackend service (which signalman installs as a
 *      SYSTEM-running gRPC daemon) for elevated calls, OR
 *   3. Mark scenarios as `pre_started: true` and let the operator
 *      bring the VM up manually before the run.
 *
 * # Contract under test
 *
 * The hyperv source must contain no live reference to gsudo. The
 * regression here is purely static — if a future change re-introduces
 * a `gsudo` lookup or `gsudo.exe` invocation, this test fails at the
 * source-grep level before any runtime behaviour can drift back.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYPERV_TS = path.resolve(__dirname, "../hypervisors/hyperv.ts");

describe("REGRESSION: no gsudo elevation in hyperv.ts", () => {
  it("hyperv.ts source does not reference gsudo at all", () => {
    const source = fs.readFileSync(HYPERV_TS, "utf-8");
    // Strip line + block comments before scanning so the explanatory
    // doc-comment block describing *why* gsudo was removed doesn't
    // false-positive this check.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments

    expect(
      stripped,
      "hyperv.ts must not call out to gsudo — see test doc-comment for rationale",
    ).not.toMatch(/\bgsudo\b/i);
  });

  it("resolvePsCommand-style helpers do not import gsudo discovery", () => {
    const source = fs.readFileSync(HYPERV_TS, "utf-8");
    // findGsudo, _gsudoPath, GSUDO_PATHS were the previous shape's
    // helpers. Any of them re-appearing means the elevation auto-
    // promotion has crept back in.
    expect(source).not.toMatch(/\bfindGsudo\b/);
    expect(source).not.toMatch(/\b_gsudoPath\b/);
    expect(source).not.toMatch(/\bGSUDO_PATHS\b/);
  });

  it("resolvePsCommand always returns plain powershell.exe (signature-level guard)", async () => {
    // We assert on the source rather than calling the function because
    // resolvePsCommand isn't exported. This guards the contract that
    // the function literally says `cmd: "powershell.exe", prefixArgs: []`
    // — any future change that wires in a different cmd or non-empty
    // prefixArgs needs to update both the function and this test.
    const source = fs.readFileSync(HYPERV_TS, "utf-8");
    const fnMatch = source.match(
      /function\s+resolvePsCommand\s*\([^)]*\)\s*:\s*[^{]+\{([\s\S]*?)\n\}/,
    );
    expect(
      fnMatch,
      "expected to find the resolvePsCommand function body in hyperv.ts",
    ).not.toBeNull();
    const body = fnMatch![1];
    expect(body).toMatch(/return\s*\{\s*cmd:\s*"powershell\.exe"\s*,\s*prefixArgs:\s*\[\s*\]\s*\}/);
    // No conditional branches that could divert to a different cmd.
    expect(body).not.toMatch(/\bif\s*\(/);
  });
});
