/**
 * v0.3.0-2 — vm_lineage_hash tests.
 *
 * Pure module. Tests cover the canonical-JSON contract (the public
 * promise: same inputs → same hash regardless of caller's
 * ordering), the SHA-256 step, the validation surface, and the
 * stability promise (hand-rolled "golden" hashes for fixed inputs).
 *
 * The golden hashes pin the wire shape so a refactor that
 * accidentally changes canonicalisation rules surfaces as a test
 * failure rather than a silent invalidation of every cached
 * scenario result downstream.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";

import {
  canonicalizeVmLineage,
  computeVmLineageHash,
  VmLineageError,
  type VmLineageInput,
} from "../provisioning/vm-lineage-hash.js";

// ── Canonical JSON contract ───────────────────────────────────────

describe("canonicalizeVmLineage — canonical JSON shape", () => {
  it("sorts top-level keys alphabetically", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [],
    };
    const json = canonicalizeVmLineage(input);
    // Expected order: installed, os, template_name
    expect(json).toBe(
      '{"installed":[],"os":"windows-11","template_name":"win11-base"}',
    );
  });

  it("omits template_version entirely when absent", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [],
    };
    const json = canonicalizeVmLineage(input);
    expect(json).not.toContain("template_version");
    expect(json).not.toContain("null");
  });

  it("omits template_version when empty string (treated same as absent)", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      template_version: "",
      os: "windows-11",
      installed: [],
    };
    const json = canonicalizeVmLineage(input);
    expect(json).not.toContain("template_version");
  });

  it("includes template_version when non-empty, in alphabetical position", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      template_version: "22H2.2024-04",
      os: "windows-11",
      installed: [],
    };
    const json = canonicalizeVmLineage(input);
    // Expected order: installed, os, template_name, template_version
    expect(json).toBe(
      '{"installed":[],"os":"windows-11","template_name":"win11-base","template_version":"22H2.2024-04"}',
    );
  });

  it("sorts installed[] by name ascending", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [
        { name: "zlib", version: "1.3" },
        { name: "git", version: "2.40" },
        { name: "powershell-7", version: "7.4.0" },
      ],
    };
    const json = canonicalizeVmLineage(input);
    expect(json).toBe(
      '{"installed":[' +
        '{"name":"git","version":"2.40"},' +
        '{"name":"powershell-7","version":"7.4.0"},' +
        '{"name":"zlib","version":"1.3"}' +
        '],"os":"windows-11","template_name":"win11-base"}',
    );
  });

  it("uses version as secondary sort when names tie", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [
        { name: "node", version: "20.10.0" },
        { name: "node", version: "18.19.0" },
      ],
    };
    const json = canonicalizeVmLineage(input);
    expect(json).toBe(
      '{"installed":[' +
        '{"name":"node","version":"18.19.0"},' +
        '{"name":"node","version":"20.10.0"}' +
        '],"os":"windows-11","template_name":"win11-base"}',
    );
  });

  it("does not mutate the caller's installed array", () => {
    const installed = [
      { name: "zlib", version: "1.3" },
      { name: "git", version: "2.40" },
    ];
    const snapshot = installed.map((e) => ({ ...e }));
    canonicalizeVmLineage({
      template_name: "win11-base",
      os: "windows-11",
      installed,
    });
    expect(installed).toEqual(snapshot);
  });

  it("produces no whitespace and no trailing newline", () => {
    const json = canonicalizeVmLineage({
      template_name: "win11-base",
      os: "windows-11",
      installed: [{ name: "git", version: "2.40" }],
    });
    expect(json).not.toContain(" ");
    expect(json).not.toContain("\n");
    expect(json).not.toContain("\t");
  });

  it("only includes name + version in installed entries (not extra fields)", () => {
    // Defensive: a caller might pass an entry with extra props
    // (e.g. installPath). We only canonicalize {name, version} so
    // the hash is stable against installation-path drift.
    const input = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [
        // @ts-expect-error — extra fields are a contract violation we tolerate
        { name: "git", version: "2.40", installPath: "C:\\\\Program Files\\\\Git" },
      ],
    } as VmLineageInput;
    const json = canonicalizeVmLineage(input);
    expect(json).not.toContain("installPath");
    expect(json).not.toContain("Program Files");
  });
});

// ── Hash determinism ──────────────────────────────────────────────

describe("computeVmLineageHash — determinism", () => {
  it("returns a 64-char lowercase hex string", () => {
    const hash = computeVmLineageHash({
      template_name: "win11-base",
      os: "windows-11",
      installed: [],
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a hand-rolled SHA-256 of the canonical JSON", () => {
    const input: VmLineageInput = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [{ name: "git", version: "2.40" }],
    };
    const expected = crypto
      .createHash("sha256")
      .update(canonicalizeVmLineage(input), "utf8")
      .digest("hex");
    expect(computeVmLineageHash(input)).toBe(expected);
  });

  it("produces identical hashes regardless of installed[] input order", () => {
    const a = computeVmLineageHash({
      template_name: "win11-base",
      os: "windows-11",
      installed: [
        { name: "git", version: "2.40" },
        { name: "node", version: "20.10.0" },
        { name: "powershell-7", version: "7.4.0" },
      ],
    });
    const b = computeVmLineageHash({
      template_name: "win11-base",
      os: "windows-11",
      installed: [
        { name: "powershell-7", version: "7.4.0" },
        { name: "node", version: "20.10.0" },
        { name: "git", version: "2.40" },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when any field changes", () => {
    const base: VmLineageInput = {
      template_name: "win11-base",
      os: "windows-11",
      installed: [{ name: "git", version: "2.40" }],
    };
    const h0 = computeVmLineageHash(base);
    const h1 = computeVmLineageHash({ ...base, template_name: "win10-base" });
    const h2 = computeVmLineageHash({ ...base, os: "windows-10" });
    const h3 = computeVmLineageHash({
      ...base,
      installed: [{ name: "git", version: "2.41" }],
    });
    const h4 = computeVmLineageHash({ ...base, template_version: "22H2" });

    expect(h0).not.toBe(h1);
    expect(h0).not.toBe(h2);
    expect(h0).not.toBe(h3);
    expect(h0).not.toBe(h4);
    // And they're all distinct from each other (no collisions in a
    // sample this small).
    expect(new Set([h0, h1, h2, h3, h4]).size).toBe(5);
  });

  it("adding template_version: '' produces the same hash as omitting it", () => {
    const without = computeVmLineageHash({
      template_name: "win11-base",
      os: "windows-11",
      installed: [],
    });
    const withEmpty = computeVmLineageHash({
      template_name: "win11-base",
      template_version: "",
      os: "windows-11",
      installed: [],
    });
    expect(without).toBe(withEmpty);
  });
});

// ── Golden hashes (stability promise) ─────────────────────────────

describe("computeVmLineageHash — golden hashes (frozen wire shape)", () => {
  // These hashes pin the v0.3.0-2 wire shape. Any change that
  // alters canonicalisation will fail one of these. If a future
  // version intentionally changes the shape, update the hash AND
  // bump the documented "output stability promise" in the module
  // header — every cached scenario result hashes against this
  // shape, so a silent change invalidates downstream caches.

  it("hash of minimal input is stable", () => {
    // Input: {"installed":[],"os":"windows-11","template_name":"win11-base"}
    // sha256 of that canonical JSON = (computed below)
    const expected = crypto
      .createHash("sha256")
      .update(
        '{"installed":[],"os":"windows-11","template_name":"win11-base"}',
        "utf8",
      )
      .digest("hex");
    expect(
      computeVmLineageHash({
        template_name: "win11-base",
        os: "windows-11",
        installed: [],
      }),
    ).toBe(expected);
  });

  it("hash of input with template_version + installed is stable", () => {
    const canonical =
      '{"installed":[' +
      '{"name":"git","version":"2.40"},' +
      '{"name":"powershell-7","version":"7.4.0"}' +
      '],"os":"windows-11","template_name":"win11-base","template_version":"22H2.2024-04"}';
    const expected = crypto
      .createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex");
    expect(
      computeVmLineageHash({
        template_name: "win11-base",
        template_version: "22H2.2024-04",
        os: "windows-11",
        installed: [
          { name: "powershell-7", version: "7.4.0" },
          { name: "git", version: "2.40" },
        ],
      }),
    ).toBe(expected);
  });
});

// ── Validation ────────────────────────────────────────────────────

describe("canonicalizeVmLineage — validation", () => {
  it("rejects empty template_name with empty_template_name", () => {
    expect(() =>
      canonicalizeVmLineage({
        template_name: "",
        os: "windows-11",
        installed: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "VmLineageError",
        code: "empty_template_name",
      }),
    );
  });

  it("rejects empty os with empty_os", () => {
    expect(() =>
      canonicalizeVmLineage({
        template_name: "win11-base",
        os: "",
        installed: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "VmLineageError",
        code: "empty_os",
      }),
    );
  });

  it("rejects installed entry with empty name with installed_empty_name", () => {
    expect(() =>
      canonicalizeVmLineage({
        template_name: "win11-base",
        os: "windows-11",
        installed: [{ name: "", version: "1.0" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "VmLineageError",
        code: "installed_empty_name",
      }),
    );
  });

  it("rejects installed entry with empty version with installed_empty_version", () => {
    expect(() =>
      canonicalizeVmLineage({
        template_name: "win11-base",
        os: "windows-11",
        installed: [{ name: "git", version: "" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "VmLineageError",
        code: "installed_empty_version",
      }),
    );
  });

  it("surfaces the index of the bad installed entry in the message", () => {
    try {
      canonicalizeVmLineage({
        template_name: "win11-base",
        os: "windows-11",
        installed: [
          { name: "git", version: "2.40" },
          { name: "node", version: "20" },
          { name: "", version: "1.0" }, // index 2
        ],
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VmLineageError);
      expect((err as Error).message).toContain("installed[2]");
    }
  });
});

// ── Error type ergonomics ─────────────────────────────────────────

describe("VmLineageError", () => {
  it("is an Error subclass", () => {
    const e = new VmLineageError("empty_os", "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(VmLineageError);
  });

  it("carries a stable code field", () => {
    const e = new VmLineageError("installed_empty_name", "test");
    expect(e.code).toBe("installed_empty_name");
  });

  it("name is VmLineageError so stack traces and switch-on-name work", () => {
    const e = new VmLineageError("empty_template_name", "test");
    expect(e.name).toBe("VmLineageError");
  });
});
