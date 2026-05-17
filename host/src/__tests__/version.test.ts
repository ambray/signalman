/**
 * Tests for the shared `VERSION` source of truth.
 *
 * The helper reads `host/package.json` once at module init. The CLI
 * (`signalman --version`) and the HTTP control plane (`/v1/healthz`)
 * both consume it, so we lock the contract here: the constant exists,
 * is a non-empty string, and matches the literal `version` field in
 * `package.json` exactly. A future bump that forgets to land in
 * either `package.json` or this helper trips one of these assertions.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, versionLine } from "../version.js";

describe("VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("matches host/package.json version exactly", () => {
    const pkgPath = fileURLToPath(
      new URL("../../package.json", import.meta.url),
    );
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version: string };
    expect(VERSION).toBe(parsed.version);
  });

  it("matches the conventional semver shape (major.minor.patch[-tag])", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/);
  });
});

describe("versionLine", () => {
  it("uses the live VERSION when no argument is passed", () => {
    expect(versionLine()).toBe(`signalman ${VERSION}\n`);
  });

  it("accepts an override (for fixture-based tests)", () => {
    expect(versionLine("9.9.9")).toBe("signalman 9.9.9\n");
  });

  it("ends with exactly one trailing newline", () => {
    const line = versionLine("1.2.3");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(false);
  });

  it("emits a single line of `<name> <version>` parseable shape", () => {
    const line = versionLine("1.2.3").trimEnd();
    const parts = line.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("signalman");
    expect(parts[1]).toBe("1.2.3");
  });
});
