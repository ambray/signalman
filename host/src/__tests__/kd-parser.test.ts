import { describe, it, expect } from "vitest";
import {
  parseLine,
  normalizeBugcheckCode,
  extractBugcheckParameters,
  splitLines,
  buildCommandWithSentinel,
  extractBugcheckName,
} from "../kernel-debug/parser.js";

describe("parseLine — command sentinel", () => {
  it("recognizes a canonical sentinel line", () => {
    const r = parseLine("SIGNALMAN-1a2b3c4d-5e6f-7890-abcd-ef0123456789-END");
    expect(r).toEqual({
      kind: "command-sentinel",
      uuid: "1a2b3c4d-5e6f-7890-abcd-ef0123456789",
    });
  });

  it("accepts trailing whitespace on sentinel line", () => {
    const r = parseLine(
      "SIGNALMAN-1a2b3c4d-5e6f-7890-abcd-ef0123456789-END   ",
    );
    expect(r.kind).toBe("command-sentinel");
  });

  it("is case-insensitive on the hex", () => {
    const r = parseLine("SIGNALMAN-AAAABBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF-END");
    expect(r.kind).toBe("command-sentinel");
  });

  it("rejects sentinel without END suffix", () => {
    const r = parseLine("SIGNALMAN-1a2b3c4d-5e6f-7890-abcd-ef0123456789");
    expect(r.kind).toBe("none");
  });

  it("rejects sentinel with invalid UUID shape", () => {
    const r = parseLine("SIGNALMAN-notauuid-END");
    expect(r.kind).toBe("none");
  });

  it("rejects sentinel text in the middle of a line", () => {
    // Deliberate: we do NOT want false positives on user log output that
    // happens to contain the sentinel string.
    const r = parseLine(
      "kd> SIGNALMAN-1a2b3c4d-5e6f-7890-abcd-ef0123456789-END",
    );
    expect(r.kind).toBe("none");
  });

  it("rejects missing SIGNALMAN- prefix", () => {
    const r = parseLine("PREFIX-1a2b3c4d-5e6f-7890-abcd-ef0123456789-END");
    expect(r.kind).toBe("none");
  });
});

describe("parseLine — bugcheck (*** Fatal System Error)", () => {
  it("parses a short bugcheck code", () => {
    const r = parseLine("*** Fatal System Error: 0xd1");
    expect(r).toEqual({ kind: "bugcheck", code: "0xd1" });
  });

  it("parses a long-form bugcheck code", () => {
    const r = parseLine("*** Fatal System Error: 0x000000D1");
    expect(r).toEqual({ kind: "bugcheck", code: "0xd1" });
  });

  it("handles leading whitespace", () => {
    const r = parseLine("   *** Fatal System Error: 0x7e");
    expect(r).toEqual({ kind: "bugcheck", code: "0x7e" });
  });

  it("parses an uppercase-A bugcheck code", () => {
    const r = parseLine("*** Fatal System Error: 0xDEAD");
    expect(r).toEqual({ kind: "bugcheck", code: "0xdead" });
  });

  it("ignores lines that look similar but aren't bugchecks", () => {
    const r = parseLine("Not a Fatal System Error: 0xd1");
    expect(r.kind).toBe("none");
  });
});

describe("parseLine — bugcheck (BUGCHECK_CODE:)", () => {
  it("parses the !analyze -v variant", () => {
    const r = parseLine("BUGCHECK_CODE:  d1");
    expect(r).toEqual({ kind: "bugcheck", code: "0xd1" });
  });

  it("handles one space after colon", () => {
    const r = parseLine("BUGCHECK_CODE: 7e");
    expect(r).toEqual({ kind: "bugcheck", code: "0x7e" });
  });

  it("handles indented analyze output", () => {
    const r = parseLine("    BUGCHECK_CODE:  deadbeef");
    expect(r).toEqual({ kind: "bugcheck", code: "0xdeadbeef" });
  });
});

describe("parseLine — module load", () => {
  it("parses canonical ModLoad line with address range", () => {
    const r = parseLine(
      "ModLoad: fffff807`b3a00000 fffff807`b3a16000   example.sys",
    );
    expect(r).toEqual({
      kind: "module-load",
      module: "example.sys",
      range: "fffff807`b3a00000-fffff807`b3a16000",
    });
  });

  it("parses ModLoad without address range", () => {
    const r = parseLine("ModLoad: example.sys");
    expect(r).toEqual({
      kind: "module-load",
      module: "example.sys",
      range: undefined,
    });
  });

  it("parses ModLoad with path", () => {
    const r = parseLine(
      "ModLoad: fffff807`00000000 fffff807`00100000   C:\\Windows\\system32\\drivers\\foo.sys",
    );
    expect(r).toEqual({
      kind: "module-load",
      module: "C:\\Windows\\system32\\drivers\\foo.sys",
      range: "fffff807`00000000-fffff807`00100000",
    });
  });

  it("does not match lines that just mention ModLoad", () => {
    const r = parseLine("Something about ModLoad: happened");
    // Our regex anchors on start-of-line "ModLoad:" so this shouldn't match.
    expect(r.kind).toBe("none");
  });
});

describe("parseLine — break instruction", () => {
  it("parses canonical break line", () => {
    const r = parseLine("Break instruction exception - code 80000003 (first chance)");
    expect(r.kind).toBe("break-instruction");
    if (r.kind === "break-instruction") {
      expect(r.detail).toContain("Break instruction exception");
    }
  });

  it("is case-insensitive", () => {
    const r = parseLine("break instruction exception - code 80000003");
    expect(r.kind).toBe("break-instruction");
  });

  it("tolerates leading whitespace", () => {
    const r = parseLine("   Break instruction exception");
    expect(r.kind).toBe("break-instruction");
  });
});

describe("parseLine — disconnect", () => {
  it("recognizes 'Debuggee is not connected'", () => {
    const r = parseLine("Debuggee is not connected");
    expect(r).toEqual({
      kind: "disconnect",
      reason: "Debuggee is not connected",
    });
  });

  it("recognizes 'Connection closed'", () => {
    const r = parseLine("Connection closed");
    expect(r).toEqual({ kind: "disconnect", reason: "Connection closed" });
  });

  it("recognizes 'The target is not connected'", () => {
    const r = parseLine("The target is not connected");
    expect(r).toEqual({
      kind: "disconnect",
      reason: "The target is not connected",
    });
  });

  it("recognizes the .reload warning as a proxy disconnect", () => {
    const r = parseLine("WARNING: .reload failed, Win32 error 0n2");
    expect(r).toEqual({
      kind: "disconnect",
      reason: "WARNING: .reload failed, Win32 error 0n2",
    });
  });
});

describe("parseLine — no match", () => {
  it("returns none for random stack-trace-looking lines", () => {
    const r = parseLine(
      "00 ffffb001`abcde000 fffff807`12345678     example!HandleIoctl+0x3a",
    );
    expect(r.kind).toBe("none");
  });

  it("returns none for empty string", () => {
    expect(parseLine("").kind).toBe("none");
  });

  it("returns none for whitespace-only lines", () => {
    expect(parseLine("    ").kind).toBe("none");
  });
});

describe("normalizeBugcheckCode", () => {
  it("normalizes 0xd1", () => {
    expect(normalizeBugcheckCode("0xd1")).toBe("0xd1");
  });

  it("normalizes 0xD1", () => {
    expect(normalizeBugcheckCode("0xD1")).toBe("0xd1");
  });

  it("normalizes without prefix", () => {
    expect(normalizeBugcheckCode("d1")).toBe("0xd1");
  });

  it("strips leading zeros", () => {
    expect(normalizeBugcheckCode("0x000000D1")).toBe("0xd1");
  });

  it("keeps at least one digit for zero", () => {
    expect(normalizeBugcheckCode("0x00000000")).toBe("0x0");
  });

  it("handles leading/trailing whitespace", () => {
    expect(normalizeBugcheckCode("   0xd1   ")).toBe("0xd1");
  });

  it("handles a long bugcheck", () => {
    expect(normalizeBugcheckCode("0xDEADBEEF")).toBe("0xdeadbeef");
  });

  it("handles the no-prefix zero case", () => {
    expect(normalizeBugcheckCode("0")).toBe("0x0");
  });
});

describe("extractBugcheckParameters", () => {
  it("parses a canonical four-parameter tuple", () => {
    const params = extractBugcheckParameters(
      "(0xffffffff00000000,0x0000000000000002,0x0000000000000001,0xfffff807f3d9abcd)",
    );
    expect(params).toEqual([
      "0xffffffff00000000",
      "0x0000000000000002",
      "0x0000000000000001",
      "0xfffff807f3d9abcd",
    ]);
  });

  it("parses with leading whitespace", () => {
    const params = extractBugcheckParameters("   (0x1,0x2,0x3,0x4)   ");
    expect(params).toEqual(["0x1", "0x2", "0x3", "0x4"]);
  });

  it("returns undefined for a non-tuple line", () => {
    expect(extractBugcheckParameters("not a tuple")).toBeUndefined();
  });

  it("returns undefined when parens contain non-hex", () => {
    expect(extractBugcheckParameters("(foo,bar)")).toBeUndefined();
  });

  it("returns undefined when any element is non-hex", () => {
    expect(extractBugcheckParameters("(0x1,bogus,0x3,0x4)")).toBeUndefined();
  });

  it("handles spaces between elements", () => {
    const params = extractBugcheckParameters("(0x1, 0x2, 0x3, 0x4)");
    expect(params).toEqual(["0x1", "0x2", "0x3", "0x4"]);
  });

  it("accepts tuples with fewer elements", () => {
    // Bugcheck parameters are usually 4, but the parser shouldn't hard-
    // code that count — some bugchecks have fewer.
    const params = extractBugcheckParameters("(0x1,0x2)");
    expect(params).toEqual(["0x1", "0x2"]);
  });

  it("returns undefined for empty parens", () => {
    // split("") gives [''] which fails the hex test — returns undefined.
    expect(extractBugcheckParameters("()")).toBeUndefined();
  });
});

describe("splitLines", () => {
  it("splits a single complete line", () => {
    const { complete, residual } = splitLines("hello\n");
    expect(complete).toEqual(["hello"]);
    expect(residual).toBe("");
  });

  it("splits multiple complete lines", () => {
    const { complete, residual } = splitLines("a\nb\nc\n");
    expect(complete).toEqual(["a", "b", "c"]);
    expect(residual).toBe("");
  });

  it("returns the partial last line as residual", () => {
    const { complete, residual } = splitLines("a\nb\nc");
    expect(complete).toEqual(["a", "b"]);
    expect(residual).toBe("c");
  });

  it("handles CRLF line endings", () => {
    const { complete, residual } = splitLines("a\r\nb\r\n");
    expect(complete).toEqual(["a", "b"]);
    expect(residual).toBe("");
  });

  it("handles bare CR line endings", () => {
    const { complete, residual } = splitLines("a\rb\r");
    expect(complete).toEqual(["a", "b"]);
    expect(residual).toBe("");
  });

  it("prepends previous residual", () => {
    const { complete, residual } = splitLines("rest\nmore", "pre-");
    expect(complete).toEqual(["pre-rest"]);
    expect(residual).toBe("more");
  });

  it("handles empty chunk with residual", () => {
    const { complete, residual } = splitLines("", "residual-so-far");
    expect(complete).toEqual([]);
    expect(residual).toBe("residual-so-far");
  });

  it("handles empty chunk and empty residual", () => {
    const { complete, residual } = splitLines("");
    expect(complete).toEqual([]);
    expect(residual).toBe("");
  });

  it("handles mixed line endings across residual boundaries", () => {
    const first = splitLines("a\r\nb\r");
    expect(first.complete).toEqual(["a", "b"]);
    expect(first.residual).toBe("");

    const second = splitLines("\nc\n", first.residual);
    expect(second.complete).toEqual(["", "c"]);
    expect(second.residual).toBe("");
  });

  it("emits empty strings for empty lines", () => {
    const { complete } = splitLines("a\n\nb\n");
    expect(complete).toEqual(["a", "", "b"]);
  });
});

describe("buildCommandWithSentinel", () => {
  const uuid = "1a2b3c4d-5e6f-7890-abcd-ef0123456789";

  it("appends the sentinel command", () => {
    const { fullCommand } = buildCommandWithSentinel("kn", uuid);
    expect(fullCommand).toBe(`kn; .echo SIGNALMAN-${uuid}-END`);
  });

  it("returns the uuid unchanged", () => {
    const { sentinelUuid } = buildCommandWithSentinel("kn", uuid);
    expect(sentinelUuid).toBe(uuid);
  });

  it("strips trailing semicolons from the user command", () => {
    // A user command that already ends in `;` would produce a double
    // semicolon in the joined form. Not a bug, but ugly. Strip it.
    const { fullCommand } = buildCommandWithSentinel("kn;", uuid);
    expect(fullCommand).toBe(`kn; .echo SIGNALMAN-${uuid}-END`);
  });

  it("strips trailing whitespace from the user command", () => {
    const { fullCommand } = buildCommandWithSentinel("kn   ", uuid);
    expect(fullCommand).toBe(`kn; .echo SIGNALMAN-${uuid}-END`);
  });

  it("strips trailing whitespace and semicolon together", () => {
    const { fullCommand } = buildCommandWithSentinel("kn; ", uuid);
    expect(fullCommand).toBe(`kn; .echo SIGNALMAN-${uuid}-END`);
  });

  it("handles compound commands", () => {
    const { fullCommand } = buildCommandWithSentinel("kn; r; !thread", uuid);
    expect(fullCommand).toBe(
      `kn; r; !thread; .echo SIGNALMAN-${uuid}-END`,
    );
  });

  it("handles empty user command", () => {
    // Semantically weird but not the parser's job to reject.
    const { fullCommand } = buildCommandWithSentinel("", uuid);
    expect(fullCommand).toBe(`; .echo SIGNALMAN-${uuid}-END`);
  });
});

describe("extractBugcheckName", () => {
  it("extracts the name from a canonical BUGCHECK_CODE line", () => {
    const out = `
Some preamble
BUGCHECK_CODE:  d1 (DRIVER_IRQL_NOT_LESS_OR_EQUAL)
More output
    `;
    expect(extractBugcheckName(out)).toBe("DRIVER_IRQL_NOT_LESS_OR_EQUAL");
  });

  it("returns undefined when no symbolic name is present", () => {
    const out = "BUGCHECK_CODE:  d1\nBUGCHECK_P1: 0x1";
    expect(extractBugcheckName(out)).toBeUndefined();
  });

  it("returns undefined for output without BUGCHECK_CODE", () => {
    expect(extractBugcheckName("nothing interesting here")).toBeUndefined();
  });

  it("picks the first symbolic name when multiple BUGCHECK_CODE lines appear", () => {
    // Unusual but possible in layered !analyze output. Pick the first
    // match, since earlier lines are typically the top-level bugcheck
    // and later ones are from nested !analyze invocations.
    const out = `
BUGCHECK_CODE:  d1 (DRIVER_IRQL_NOT_LESS_OR_EQUAL)
...
BUGCHECK_CODE:  7e (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED)
    `;
    expect(extractBugcheckName(out)).toBe("DRIVER_IRQL_NOT_LESS_OR_EQUAL");
  });
});
