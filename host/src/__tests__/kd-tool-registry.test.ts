import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  ToolRegistry,
  ToolAlreadyRegisteredError,
  UnknownToolError,
  type ToolContext,
  type ToolDefinition,
  type ToolHandler,
  type ToolOrchestratorView,
} from "../kernel-debug/tool-registry.js";
import {
  createKernelDebugToolRegistry,
  kernelDebugToolDefinitions,
} from "../kernel-debug/tools.js";
import type { CommandResult, GuestAgentClient } from "../guest/client.js";
import type { KdSession, KdSessionState } from "../kernel-debug/kd-session.js";
import { BreakLog } from "../kernel-debug/break-log.js";

// ─── ToolRegistry core mechanics ───────────────────────────────────

describe("ToolRegistry — registration", () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("starts empty", () => {
    expect(registry.size).toBe(0);
    expect(registry.names()).toEqual([]);
    expect(registry.all()).toEqual([]);
  });

  it("registers a tool", () => {
    registry.register({
      name: "test_tool",
      handler: async () => "done",
    });
    expect(registry.size).toBe(1);
    expect(registry.has("test_tool")).toBe(true);
    expect(registry.names()).toEqual(["test_tool"]);
  });

  it("throws on duplicate registration", () => {
    const def: ToolDefinition = {
      name: "dupe",
      handler: async () => "",
    };
    registry.register(def);
    expect(() => registry.register(def)).toThrow(ToolAlreadyRegisteredError);
  });

  it("preserves registration order in names()", () => {
    registry.register({ name: "alpha", handler: async () => "" });
    registry.register({ name: "beta", handler: async () => "" });
    registry.register({ name: "gamma", handler: async () => "" });
    expect(registry.names()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("has() returns false for unregistered names", () => {
    expect(registry.has("nope")).toBe(false);
  });

  it("get() returns the definition", () => {
    const def: ToolDefinition = {
      name: "gettable",
      description: "has a description",
      handler: async () => "ok",
    };
    registry.register(def);
    expect(registry.get("gettable")).toBe(def);
  });

  it("get() returns undefined for unknown names", () => {
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("all() returns every registered definition", () => {
    const a: ToolDefinition = { name: "a", handler: async () => "" };
    const b: ToolDefinition = { name: "b", handler: async () => "" };
    registry.register(a);
    registry.register(b);
    expect(registry.all()).toEqual([a, b]);
  });

  it("registration error message names the offender", () => {
    registry.register({ name: "collide", handler: async () => "" });
    try {
      registry.register({ name: "collide", handler: async () => "" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolAlreadyRegisteredError);
      if (e instanceof ToolAlreadyRegisteredError) {
        expect(e.name).toBe("ToolAlreadyRegisteredError");
        expect(e.message).toContain("collide");
      }
    }
  });
});

describe("ToolRegistry — execute", () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
  });

  function makeCtx(): ToolContext {
    return {
      vmName: "endpoint-1",
      vmMap: new Map(),
      orchestrator: {
        getGuestClient: () => undefined,
        getKernelDebug: () => undefined,
      },
    };
  }

  it("invokes the registered handler", async () => {
    const spy = vi.fn<ToolHandler>().mockResolvedValue("ok");
    registry.register({ name: "spied", handler: spy });
    const r = await registry.execute("spied", makeCtx(), { foo: "bar" });
    expect(r).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ foo: "bar" });
  });

  it("passes the context through", async () => {
    let seenCtx: ToolContext | undefined;
    registry.register({
      name: "ctxr",
      handler: async (ctx) => {
        seenCtx = ctx;
        return "ok";
      },
    });
    const ctx = makeCtx();
    await registry.execute("ctxr", ctx, {});
    expect(seenCtx).toBe(ctx);
  });

  it("throws UnknownToolError for unregistered names", async () => {
    await expect(registry.execute("nope", makeCtx(), {})).rejects.toThrow(
      UnknownToolError,
    );
  });

  it("UnknownToolError carries the attempted name", async () => {
    try {
      await registry.execute("missing", makeCtx(), {});
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownToolError);
      if (e instanceof UnknownToolError) {
        expect(e.name).toBe("UnknownToolError");
        expect(e.message).toContain("missing");
      }
    }
  });

  it("propagates handler errors unchanged", async () => {
    registry.register({
      name: "thrower",
      handler: async () => {
        throw new Error("handler failure");
      },
    });
    await expect(registry.execute("thrower", makeCtx(), {})).rejects.toThrow(
      /handler failure/,
    );
  });

  it("handler sees the params object", async () => {
    let seenParams: Record<string, unknown> | undefined;
    registry.register({
      name: "params",
      handler: async (_c, p) => {
        seenParams = p;
        return "";
      },
    });
    await registry.execute("params", makeCtx(), { a: 1, b: "two" });
    expect(seenParams).toEqual({ a: 1, b: "two" });
  });
});

// ─── Factory: createKernelDebugToolRegistry ────────────────────────

describe("createKernelDebugToolRegistry", () => {
  it("registers exactly five tools", () => {
    const r = createKernelDebugToolRegistry();
    expect(r.size).toBe(5);
  });

  it("registers the expected names", () => {
    const names = createKernelDebugToolRegistry().names();
    expect(names).toEqual([
      "driver_load",
      "driver_unload",
      "driver_ioctl",
      "kernel_expect_bugcheck",
      "kernel_break_on",
    ]);
  });

  it("every tool has a description", () => {
    const r = createKernelDebugToolRegistry();
    for (const def of r.all()) {
      expect(def.description).toBeTruthy();
    }
  });

  it("kernelDebugToolDefinitions matches what the factory registers", () => {
    const defs = kernelDebugToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(
      createKernelDebugToolRegistry().names(),
    );
  });

  it("calling the factory twice produces independent registries", () => {
    const a = createKernelDebugToolRegistry();
    const b = createKernelDebugToolRegistry();
    expect(a).not.toBe(b);
    // Register a tool on `a`; it shouldn't leak to `b`.
    a.register({ name: "only_on_a", handler: async () => "" });
    expect(a.has("only_on_a")).toBe(true);
    expect(b.has("only_on_a")).toBe(false);
  });
});

// ─── Factory tools — routing + dependency lookups ──────────────────
//
// These tests drive each registered tool through the registry,
// verifying that it looks up its dependencies via the
// ToolOrchestratorView (not by reaching into the orchestrator
// directly). Uses minimal stubs for guest client + kd session.

class FakeGuestClient {
  public calls: Array<{ cmd: string; args: string[] }> = [];
  public response: CommandResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
  };
  async runCommand(cmd: string, args: string[] = []): Promise<CommandResult> {
    this.calls.push({ cmd, args });
    return this.response;
  }
}

class FakeKdSession extends EventEmitter {
  public state: KdSessionState = "running";
  async run(_cmd: string, _timeoutMs?: number): Promise<string> {
    return "";
  }
  async captureStack(): Promise<string> {
    return "";
  }
  async captureAllStacks(): Promise<string> {
    return "";
  }
  async captureAnalyze(): Promise<string> {
    return "";
  }
  async saveDump(): Promise<void> {}
  resume(): void {}
  async detach(): Promise<void> {}
  emitBreak(
    reason: "bugcheck" | "break-instruction" | "module-load" | "manual",
    bugcheckCode?: string,
  ): void {
    this.emit("break", { type: "break", reason, bugcheckCode });
  }
}

/**
 * Build a ToolOrchestratorView that returns fixed deps for
 * `endpoint-1` and undefined for any other VM name.
 */
function makeView(opts: {
  guestClient?: FakeGuestClient;
  session?: FakeKdSession;
  breakLog?: BreakLog;
}): ToolOrchestratorView {
  return {
    getGuestClient: (vm) =>
      vm === "endpoint-1" ? (opts.guestClient as unknown as GuestAgentClient) : undefined,
    getKernelDebug: (vm) =>
      vm === "endpoint-1" && opts.session && opts.breakLog
        ? { session: opts.session as unknown as KdSession, breakLog: opts.breakLog }
        : undefined,
  };
}

function makeCtx(view: ToolOrchestratorView, vmName = "endpoint-1"): ToolContext {
  return { vmName, vmMap: new Map(), orchestrator: view };
}

describe("kernel-debug tools — dependency lookup", () => {
  it("driver_load uses the guest client from the view", async () => {
    const client = new FakeGuestClient();
    const view = makeView({ guestClient: client });
    const registry = createKernelDebugToolRegistry();
    // Queue two responses: sc start + sc query.
    client.response = {
      exitCode: 0,
      stdout: "        STATE              : 4  RUNNING",
      stderr: "",
      durationMs: 1,
    };
    const out = await registry.execute("driver_load", makeCtx(view), {
      service: "example",
    });
    const parsed = JSON.parse(out);
    // Service state comes from the fake's stdout parsed by handler.
    expect(parsed.service_state).toBe("Running");
    expect(client.calls[0].cmd).toBe("sc.exe");
    expect(client.calls[0].args).toEqual(["start", "example"]);
  });

  it("driver_unload uses the guest client", async () => {
    const client = new FakeGuestClient();
    client.response = {
      exitCode: 0,
      stdout: "        STATE              : 1  STOPPED",
      stderr: "",
      durationMs: 1,
    };
    const view = makeView({ guestClient: client });
    const registry = createKernelDebugToolRegistry();
    const out = await registry.execute("driver_unload", makeCtx(view), {
      service: "example",
    });
    expect(JSON.parse(out).service_state).toBe("Stopped");
  });

  it("driver_ioctl uses the guest client + json-parses harness output", async () => {
    const client = new FakeGuestClient();
    client.response = {
      exitCode: 0,
      stdout: JSON.stringify({
        status: "STATUS_SUCCESS",
        output_hex: "01 02",
        output_size: 2,
        match: true,
      }),
      stderr: "",
      durationMs: 1,
    };
    const view = makeView({ guestClient: client });
    const registry = createKernelDebugToolRegistry();
    const out = await registry.execute("driver_ioctl", makeCtx(view), {
      device: "\\\\.\\example",
      control_code: 0x220000,
    });
    expect(JSON.parse(out).status).toBe("STATUS_SUCCESS");
  });

  it("driver_load throws when no guest client is registered", async () => {
    const view = makeView({}); // no client registered for endpoint-1
    const registry = createKernelDebugToolRegistry();
    await expect(
      registry.execute("driver_load", makeCtx(view), { service: "x" }),
    ).rejects.toThrow(/No guest client/);
  });

  it("driver_load throws with the same message for a missing VM", async () => {
    const view = makeView({ guestClient: new FakeGuestClient() });
    const registry = createKernelDebugToolRegistry();
    await expect(
      registry.execute(
        "driver_load",
        makeCtx(view, "missing-vm"),
        { service: "x" },
      ),
    ).rejects.toThrow(/No guest client/);
  });

  it("kernel_expect_bugcheck uses the kd session + break log", async () => {
    const session = new FakeKdSession();
    const breakLog = new BreakLog(session as unknown as KdSession);
    session.emitBreak("bugcheck", "0xd1");
    const view = makeView({ session, breakLog });
    const registry = createKernelDebugToolRegistry();
    const out = await registry.execute(
      "kernel_expect_bugcheck",
      makeCtx(view),
      { bugcheck_code: "0xd1", capture_stack: false },
    );
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(true);
    expect(parsed.bugcheck_code).toBe("0xd1");
  });

  it("kernel_expect_bugcheck throws when no kernel_debug is registered", async () => {
    const view = makeView({}); // no kd session
    const registry = createKernelDebugToolRegistry();
    await expect(
      registry.execute("kernel_expect_bugcheck", makeCtx(view), {
        bugcheck_code: "0xd1",
      }),
    ).rejects.toThrow(/No kernel_debug session/);
  });

  it("kernel_break_on uses the kd session", async () => {
    const session = new FakeKdSession();
    const breakLog = new BreakLog(session as unknown as KdSession);
    const view = makeView({ session, breakLog });
    const registry = createKernelDebugToolRegistry();
    setTimeout(() => session.emitBreak("break-instruction"), 10);
    const out = await registry.execute("kernel_break_on", makeCtx(view), {
      symbol: "x!y",
      timeout_ms: 1_000,
    });
    expect(JSON.parse(out).matched).toBe(true);
  });

  it("kernel_break_on throws when no kernel_debug is registered", async () => {
    const view = makeView({});
    const registry = createKernelDebugToolRegistry();
    await expect(
      registry.execute("kernel_break_on", makeCtx(view), {
        symbol: "x!y",
        timeout_ms: 100,
      }),
    ).rejects.toThrow(/No kernel_debug session/);
  });
});

// ─── Orchestrator integration — registry is populated at construct-time ─

describe("ScenarioOrchestrator — tool registry integration", () => {
  it("exposes the kernel-debug registry via .tools", async () => {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const orchestrator = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    expect(orchestrator.tools.size).toBe(5);
    expect(orchestrator.tools.has("driver_load")).toBe(true);
    expect(orchestrator.tools.has("kernel_break_on")).toBe(true);
  });

  it("getGuestClient returns undefined for a missing VM", async () => {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const o = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    expect(o.getGuestClient("nope")).toBeUndefined();
  });

  it("getKernelDebug returns undefined when no session is wired", async () => {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const o = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    expect(o.getKernelDebug("nope")).toBeUndefined();
  });

  it("executeToolBlock routes an unknown tool to the Unknown-workflow error", async () => {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const o = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    await expect(
      o.executeToolBlock(
        "no_such_tool",
        { vm: "endpoint-1" },
        new Map() as never,
      ),
    ).rejects.toThrow(/Unknown workflow tool/);
  });

  it("scenario authors can register new tools at runtime", async () => {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const o = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    o.tools.register({
      name: "custom_tool",
      handler: async () => JSON.stringify({ custom: true }),
    });
    const out = await o.executeToolBlock(
      "custom_tool",
      { vm: "endpoint-1" },
      new Map() as never,
    );
    expect(JSON.parse(out).custom).toBe(true);
  });
});

// ─── helpers ───────────────────────────────────────────────────────

function stubBackend(): unknown {
  return {
    name: "test" as const,
    isAvailable: async () => true,
    createVM: async () => ({ id: "x", name: "endpoint-1", backend: "test" }),
    listVMs: async () => [],
    startVM: async () => {},
    stopVM: async () => {},
    getStatus: async () => ({
      state: "running" as const,
      guestAgentReachable: true,
      uptimeSeconds: 0,
      memoryUsedMB: 0,
    }),
    deleteVM: async () => {},
    createCheckpoint: async () => ({
      id: "c",
      vmHandle: { id: "x", name: "endpoint-1", backend: "test" },
      label: "l",
    }),
    restoreCheckpoint: async () => {},
    deleteCheckpoint: async () => {},
    listCheckpoints: async () => [],
    copyFileToVM: async () => {},
    copyFileFromVM: async () => {},
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    installSoftware: async () => ({ success: true, output: "" }),
  };
}
