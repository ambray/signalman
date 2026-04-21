import { describe, it, expect } from "vitest";
import {
  buildWprProfile,
  normalizeGuid,
  normalizeKeywordHex,
  parseEventJson,
  handleKernelEtwStart,
  handleKernelEtwStop,
} from "../kernel-debug/etw-handlers.js";
import type {
  EtwHandlerContext,
} from "../kernel-debug/etw-handlers.js";
import type { CommandResult, GuestAgentClient } from "../guest/client.js";

// ─── Fake guest client ──────────────────────────────────────────────

interface QueuedCall {
  command: string;
  args: string[];
  options?: unknown;
}

class FakeGuestClient {
  public readonly calls: QueuedCall[] = [];
  private responses: Array<CommandResult | Error> = [];

  queue(response: CommandResult | Error): void {
    this.responses.push(response);
  }

  queueSuccess(opts?: Partial<CommandResult>): void {
    this.queue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
      ...opts,
    });
  }

  async runCommand(
    command: string,
    args: string[] = [],
    options?: unknown,
  ): Promise<CommandResult> {
    const r = this.responses.shift();
    this.calls.push({ command, args, options });
    if (!r) throw new Error(`FakeGuestClient: unqueued call to ${command}`);
    if (r instanceof Error) throw r;
    return r;
  }
}

function makeCtx(client: FakeGuestClient): EtwHandlerContext {
  return {
    guestClient: client as unknown as GuestAgentClient,
    vmName: "endpoint-1",
  };
}

// ─── normalizeGuid ──────────────────────────────────────────────────

describe("normalizeGuid", () => {
  it("strips braces and lowercases", () => {
    expect(normalizeGuid("{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"))
      .toBe("5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10");
  });

  it("accepts bare lowercase", () => {
    expect(normalizeGuid("5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10"))
      .toBe("5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10");
  });

  it("strips internal whitespace", () => {
    expect(normalizeGuid("  {5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}  "))
      .toBe("5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10");
  });

  it("rejects no-dashes form", () => {
    expect(() => normalizeGuid("5b7e6a1c9f424d8ba8b93e5c2d7f4a10")).toThrow(/valid GUID/);
  });

  it("rejects short input", () => {
    expect(() => normalizeGuid("5b7e6a1c")).toThrow(/valid GUID/);
  });

  it("rejects non-hex chars", () => {
    expect(() => normalizeGuid("zzzz6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10")).toThrow(/valid GUID/);
  });

  it("rejects empty string", () => {
    expect(() => normalizeGuid("")).toThrow(/valid GUID/);
  });
});

// ─── normalizeKeywordHex ────────────────────────────────────────────

describe("normalizeKeywordHex", () => {
  it("accepts 0x-prefixed hex", () => {
    expect(normalizeKeywordHex("0x10")).toBe("0x10");
  });

  it("uppercases hex digits", () => {
    expect(normalizeKeywordHex("0xaabbcc")).toBe("0xAABBCC");
  });

  it("accepts bare decimal", () => {
    expect(normalizeKeywordHex("16")).toBe("0x10");
  });

  it("accepts u64-max", () => {
    expect(normalizeKeywordHex("0xFFFFFFFFFFFFFFFF"))
      .toBe("0xFFFFFFFFFFFFFFFF");
  });

  it("accepts bare hex (no 0x) when non-decimal", () => {
    expect(normalizeKeywordHex("FF")).toBe("0xFF");
  });

  it("rejects non-numeric input", () => {
    expect(() => normalizeKeywordHex("xyz")).toThrow(/u64/);
  });

  it("rejects values above u64-max", () => {
    expect(() => normalizeKeywordHex("0x10000000000000000")).toThrow(/u64/);
  });

  it("rejects negative values", () => {
    // BigInt("-1") parses fine; we need to reject at the range check.
    expect(() => normalizeKeywordHex("-1")).toThrow();
  });
});

// ─── buildWprProfile ────────────────────────────────────────────────

describe("buildWprProfile", () => {
  const base = {
    sessionName: "TestSession",
    providerGuid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
    keywordHex: "0x10",
    level: 5,
  };

  it("embeds the provider GUID in braces in the Name attribute", () => {
    // WPR requires `Name="{GUID}"` with curly braces for non-manifest
    // (GUID-based / TraceLogging) providers. Without braces WPR errors
    // out with 0xc5580612 "No providers in profile" at -start time.
    const xml = buildWprProfile(base);
    expect(xml).toContain(`Name="{${base.providerGuid}}"`);
  });

  it("sets NonPagedMemory=true so kernel-mode TraceLogging events get captured", () => {
    // Our driver's Example.Driver provider emits from non-paged kernel
    // contexts (DPC + ISR paths for some events). WPR's default session
    // is paged; setting NonPagedMemory=true makes it allocate non-paged
    // buffers so kernel-mode writes never hit a page fault.
    const xml = buildWprProfile(base);
    expect(xml).toContain(`NonPagedMemory="true"`);
  });

  it("embeds the keyword hex in the Keyword Value", () => {
    const xml = buildWprProfile(base);
    expect(xml).toContain(`<Keyword Value="0x10" />`);
  });

  it("embeds the level", () => {
    const xml = buildWprProfile({ ...base, level: 3 });
    expect(xml).toContain(`Level="3"`);
  });

  it("uses session name in the collector + provider + profile IDs", () => {
    const xml = buildWprProfile(base);
    expect(xml).toContain(`EC_${base.sessionName}`);
    expect(xml).toContain(`EP_${base.sessionName}`);
    expect(xml).toContain(`Id="${base.sessionName}.Verbose.File"`);
    expect(xml).toContain(`Name="${base.sessionName}"`);
  });

  it("emits LoggingMode=File and DetailLevel=Verbose", () => {
    const xml = buildWprProfile(base);
    expect(xml).toContain(`LoggingMode="File"`);
    expect(xml).toContain(`DetailLevel="Verbose"`);
  });

  it("starts with the XML declaration", () => {
    const xml = buildWprProfile(base);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
  });
});

// ─── parseEventJson ─────────────────────────────────────────────────

describe("parseEventJson", () => {
  it("returns empty array for empty input", () => {
    expect(parseEventJson("")).toEqual([]);
  });

  it("returns empty array for 'null' literal", () => {
    expect(parseEventJson("null")).toEqual([]);
  });

  it("handles single-event shape (PowerShell unwraps 1-elem pipelines)", () => {
    const input = JSON.stringify({
      name: "RuleMatched",
      opcode: 0,
      level: 4,
      keywords: "0x0000000000000010",
      time: "2026-04-20T12:00:00.0000000Z",
      props: [66, 1234, 0x12345678],
    });
    const events = parseEventJson(input);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("RuleMatched");
    expect(events[0].level).toBe(4);
    expect(events[0].keywords).toBe("0x0000000000000010");
    expect(events[0].properties).toEqual({ p0: 66, p1: 1234, p2: 0x12345678 });
  });

  it("handles array of events", () => {
    const input = JSON.stringify([
      { name: "DriverLoaded", opcode: 0, level: 4, keywords: "0x1", time: "t1", props: [] },
      { name: "RuleMatched", opcode: 0, level: 4, keywords: "0x10", time: "t2", props: [42] },
    ]);
    const events = parseEventJson(input);
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("DriverLoaded");
    expect(events[1].name).toBe("RuleMatched");
    expect(events[1].properties).toEqual({ p0: 42 });
  });

  it("trims leading and trailing whitespace", () => {
    const input = "   \n  " + JSON.stringify({ name: "X", opcode: 0, level: 4, keywords: "0x0", time: "t", props: [] }) + "\n";
    expect(parseEventJson(input)).toHaveLength(1);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseEventJson("{ not json")).toThrow(/failed to parse/);
  });

  it("defaults missing fields to sentinel values", () => {
    const input = JSON.stringify({ name: "X" });
    const events = parseEventJson(input);
    expect(events[0].name).toBe("X");
    expect(events[0].level).toBe(0);
    expect(events[0].opcode).toBe(0);
    expect(events[0].keywords).toBe("0x0");
  });

  it("filters non-object entries", () => {
    const input = JSON.stringify([null, 42, "string", { name: "X", opcode: 0, level: 4, keywords: "0x0", time: "t", props: [] }]);
    const events = parseEventJson(input);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("X");
  });
});

// ─── handleKernelEtwStart ───────────────────────────────────────────

describe("handleKernelEtwStart", () => {
  it("issues three guest commands in order: cleanup stop, ETL prep, logman create trace", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();               // logman stop (cleanup)
    client.queueSuccess();               // powershell ETL prep
    client.queueSuccess({ stdout: "started\n" });  // logman create trace

    const result = await handleKernelEtwStart(makeCtx(client), {
      provider_guid: "{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}",
      keywords: "0x10",
    });

    expect(client.calls).toHaveLength(3);
    // 1. Idempotent cleanup of any leftover session.
    expect(client.calls[0].command).toBe("logman.exe");
    expect(client.calls[0].args).toEqual(["stop", "ExampleScenarioEtw", "-ets"]);
    // 2. PowerShell: ensure ETL dir exists + scrub stale ETL.
    expect(client.calls[1].command).toBe("powershell.exe");
    expect(client.calls[1].args.join(" ")).toContain("Remove-Item");
    // 3. Real start. Args shape:
    //    create trace <name> -p "{GUID}" <kw_hex> <level> -ets -o <etl>
    expect(client.calls[2].command).toBe("logman.exe");
    expect(client.calls[2].args[0]).toBe("create");
    expect(client.calls[2].args[1]).toBe("trace");
    expect(client.calls[2].args[2]).toBe("ExampleScenarioEtw");
    expect(client.calls[2].args).toContain("-p");
    // GUID must arrive wrapped in curly braces — logman requires it.
    expect(client.calls[2].args).toContain("{5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10}");
    expect(client.calls[2].args).toContain("0x10");
    expect(client.calls[2].args).toContain("-ets");
    expect(client.calls[2].args).toContain("-o");

    expect(result.status).toBe(0);
    expect(result.etl_path).toMatch(/\.etl$/);
  });

  it("throws with diagnostic when ETL dir prep fails", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();                                    // cleanup stop OK
    client.queueSuccess({ exitCode: 1, stderr: "Access denied" }); // prep fails

    await expect(handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
    })).rejects.toThrow(/ETL dir prep failed.*Access denied/);
  });

  it("throws with diagnostic when logman create trace fails", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();               // cleanup stop
    client.queueSuccess();               // prep
    client.queueSuccess({ exitCode: 0xB7, stderr: "Cannot create a file when that file already exists." });

    await expect(handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
    })).rejects.toThrow(/logman create trace exited/);
  });

  it("respects custom session_name + etl_path overrides", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess();
    client.queueSuccess();

    const result = await handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
      session_name: "CustomSession",
      // profile_path is accepted but deprecated — no assertion needed,
      // just confirms the API still accepts the parameter.
      profile_path: "C:\\temp\\p.wprp",
      etl_path: "C:\\temp\\o.etl",
    });

    // Cleanup-stop passes the custom session name.
    expect(client.calls[0].args).toEqual(["stop", "CustomSession", "-ets"]);
    // create trace: session name at index 2, etl path passed via -o.
    expect(client.calls[2].args[2]).toBe("CustomSession");
    const etlIdx = client.calls[2].args.indexOf("-o");
    expect(etlIdx).toBeGreaterThan(-1);
    expect(client.calls[2].args[etlIdx + 1]).toBe("C:\\temp\\o.etl");
    expect(result.etl_path).toBe("C:\\temp\\o.etl");
  });

  it("passes the level integer in logman's positional slot (default 5)", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess();
    client.queueSuccess();

    await handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
      level: 3,
    });

    // Level is the 3rd positional arg after -p: -p {GUID} <kw> <lvl>
    const pIdx = client.calls[2].args.indexOf("-p");
    expect(client.calls[2].args[pIdx + 1]).toBe("{5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10}");
    expect(client.calls[2].args[pIdx + 2]).toBe("0x10");
    expect(client.calls[2].args[pIdx + 3]).toBe("3");
  });

  it("rejects bad provider_guid before touching the guest", async () => {
    const client = new FakeGuestClient();
    await expect(handleKernelEtwStart(makeCtx(client), {
      provider_guid: "not-a-guid",
      keywords: "0x10",
    })).rejects.toThrow(/valid GUID/);
    expect(client.calls).toHaveLength(0);
  });

  it("tolerates cleanup-stop failure and still runs prep + create trace", async () => {
    // Cold-booted guests sometimes time out the first guest-agent RPC
    // as the agent warms up. The cleanup stop is idempotent — we must
    // not let its failure block the actual session creation. If the
    // cleanup genuinely missed a leftover session, `logman create
    // trace` will surface that later as ERROR_ALREADY_EXISTS.
    const client = new FakeGuestClient();
    client.queue(new Error("1 CANCELLED: Timeout expired"));  // cleanup throws
    client.queueSuccess();                                     // prep succeeds
    client.queueSuccess({ stdout: "started\n" });              // create trace succeeds

    const result = await handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
    });

    // All 3 calls must have been attempted despite the first throwing.
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2].args[0]).toBe("create");
    expect(result.status).toBe(0);
  });

  it("splits the outer timeout budget across cleanup, prep, and create sub-commands", async () => {
    // With timeout_ms=180000 (the workflow's cold-boot-safe value),
    // cleanup + prep each get 30s, and create trace gets 120s. The
    // three sub-timeouts must sum to <= the outer budget to avoid the
    // tool-block's own timeout cancelling mid-stream.
    const client = new FakeGuestClient();
    client.queueSuccess();  // cleanup
    client.queueSuccess();  // prep
    client.queueSuccess();  // create trace

    await handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
      timeout_ms: 180_000,
    });

    const timeouts = client.calls.map((c) => (c.options as { timeoutMs: number }).timeoutMs);
    expect(timeouts[0]).toBe(30_000);   // cleanup: min(30000, 180000/6=30000)
    expect(timeouts[1]).toBe(30_000);   // prep:    min(30000, 180000/6=30000)
    expect(timeouts[2]).toBe(120_000);  // create:  max(30000, 180000*2/3=120000)
    // Sum must be <= outer budget so the tool-block timeout can't
    // pre-empt mid-stream.
    expect(timeouts[0] + timeouts[1] + timeouts[2]).toBeLessThanOrEqual(180_000);
  });

  it("clamps sub-command timeouts sensibly for small outer budgets", async () => {
    // With a tiny timeout_ms (60s for a warm-guest scenario), the
    // proportional split still gives the create-trace step a useful
    // minimum (30s floor) rather than tiny slivers.
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess();
    client.queueSuccess();

    await handleKernelEtwStart(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      keywords: "0x10",
      timeout_ms: 60_000,
    });

    const timeouts = client.calls.map((c) => (c.options as { timeoutMs: number }).timeoutMs);
    expect(timeouts[0]).toBe(10_000);  // cleanup: min(30000, 60000/6=10000)
    expect(timeouts[1]).toBe(10_000);  // prep:    min(30000, 60000/6=10000)
    expect(timeouts[2]).toBe(40_000);  // create:  max(30000, 60000*2/3=40000)
  });
});

// ─── handleKernelEtwStop ────────────────────────────────────────────

describe("handleKernelEtwStop", () => {
  it("issues logman stop then Get-WinEvent parse", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();  // logman stop
    client.queueSuccess({
      stdout: JSON.stringify([
        { name: "RuleMatched", opcode: 0, level: 4, keywords: "0x10", time: "t1", props: [66, 1234] },
      ]),
    });

    const result = await handleKernelEtwStop(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
    });

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].command).toBe("logman.exe");
    expect(client.calls[0].args).toEqual(["stop", "ExampleScenarioEtw", "-ets"]);
    expect(client.calls[1].command).toBe("powershell.exe");
    // Must reference our GUID in the Where-Object filter.
    expect(client.calls[1].args.join(" ")).toContain("5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10");

    expect(result.status).toBe(0);
    expect(result.total_events).toBe(1);
    expect(result.event_counts).toEqual({ RuleMatched: 1 });
    expect(result.events[0].name).toBe("RuleMatched");
  });

  it("handles empty capture", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess({ stdout: "" });

    const result = await handleKernelEtwStop(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
    });

    expect(result.total_events).toBe(0);
    expect(result.event_counts).toEqual({});
    expect(result.events).toEqual([]);
  });

  it("truncates events list at max_events_returned", async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      name: "RuleMatched",
      opcode: 0,
      level: 4,
      keywords: "0x10",
      time: `t${i}`,
      props: [i],
    }));
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess({ stdout: JSON.stringify(events) });

    const result = await handleKernelEtwStop(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
      max_events_returned: 10,
    });

    expect(result.total_events).toBe(100);
    expect(result.events).toHaveLength(10);
    // Counts reflect the full set, not the truncated events[].
    expect(result.event_counts).toEqual({ RuleMatched: 100 });
  });

  it("throws with diagnostic when logman stop fails", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess({ exitCode: 1, stderr: "no session active" });

    await expect(handleKernelEtwStop(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
    })).rejects.toThrow(/logman stop exited.*no session active/);
  });

  it("aggregates counts across multiple event names", async () => {
    const events = [
      { name: "DriverLoaded",   opcode: 0, level: 4, keywords: "0x1",  time: "t", props: [] },
      { name: "ScopeCreated",   opcode: 0, level: 4, keywords: "0x4",  time: "t", props: [] },
      { name: "RuleMatched",    opcode: 0, level: 4, keywords: "0x10", time: "t", props: [] },
      { name: "RuleMatched",    opcode: 0, level: 4, keywords: "0x10", time: "t", props: [] },
    ];
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess({ stdout: JSON.stringify(events) });

    const result = await handleKernelEtwStop(makeCtx(client), {
      provider_guid: "5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10",
    });

    expect(result.event_counts).toEqual({
      DriverLoaded: 1,
      ScopeCreated: 1,
      RuleMatched: 2,
    });
  });
});
