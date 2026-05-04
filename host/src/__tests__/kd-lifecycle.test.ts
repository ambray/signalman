import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type {
  KdSession,
  KdSessionOptions,
  KdSessionState,
} from "../kernel-debug/kd-session.js";

// ─── Fake KdSession + spy factory ──────────────────────────────────
//
// These tests drive `ScenarioOrchestrator.spawnKernelDebugSessions`
// end-to-end without spawning kd.exe. The fake records the
// constructor options so tests can assert the kd CLI was built
// correctly from the kernel_debug YAML block.

class FakeKdSession extends EventEmitter {
  public readonly opts: KdSessionOptions;
  public state: KdSessionState = "idle";
  public startCalls = 0;
  public detachCalls = 0;
  public forceTerminateCalls = 0;
  public startShouldThrow: Error | null = null;

  constructor(opts: KdSessionOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startShouldThrow) throw this.startShouldThrow;
    this.state = "running";
  }
  async detach(): Promise<void> {
    this.detachCalls++;
    this.state = "disconnected";
  }
  forceTerminate(): void {
    this.forceTerminateCalls++;
    this.state = "disconnected";
  }
}

class FakeProcessExitTarget extends EventEmitter {
  override once(event: "exit", listener: () => void): this {
    super.once(event, listener);
    return this;
  }

  override off(event: "exit", listener: () => void): this {
    super.off(event, listener);
    return this;
  }
}

/**
 * Build an orchestrator with a spy kd factory that records every
 * constructed session. Tests can drive the scenario lifecycle and
 * then assert against the captured sessions.
 */
async function makeOrchestrator(): Promise<{
  orchestrator: import("../scenarios/orchestrator.js").ScenarioOrchestrator;
  sessions: FakeKdSession[];
}> {
  const { ScenarioOrchestrator } = await import(
    "../scenarios/orchestrator.js"
  );
  const sessions: FakeKdSession[] = [];
  const orchestrator = new ScenarioOrchestrator(
    stubBackend() as never,
    new Map() as never,
    {} as never,
    {},
  );
  orchestrator.setKdSessionFactory((opts) => {
    const s = new FakeKdSession(opts);
    sessions.push(s);
    return s as unknown as KdSession;
  });
  return { orchestrator, sessions };
}

// The actual private method has to be invoked via runScenario or a
// direct spy; we use a minimal type cast to get at the private
// `spawnKernelDebugSessions` for unit testing. This is deliberate —
// unit-testing the VM-definition → kd-spawn transformation without
// wiring a full scenario is the point of this test file.
function spawnKd(
  orchestrator: unknown,
  vmDefs: unknown[],
): Promise<void> {
  return (
    orchestrator as { spawnKernelDebugSessions(v: unknown[]): Promise<void> }
  ).spawnKernelDebugSessions(vmDefs);
}

// ─── Baseline — no kernel_debug, no sessions ───────────────────────

describe("spawnKernelDebugSessions — disabled path", () => {
  it("spawns nothing when no VM has kernel_debug", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      { name: "endpoint-1", template: "win11", guest_agent_port: 50051 },
    ]);
    expect(sessions.length).toBe(0);
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeUndefined();
  });

  it("spawns nothing when kernel_debug.enabled is false", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: false },
      },
    ]);
    expect(sessions.length).toBe(0);
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeUndefined();
  });

  it("spawns nothing when kernel_debug is undefined", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: undefined,
      },
    ]);
    expect(sessions.length).toBe(0);
  });
});

// ─── Enabled path — spawn + wire + arg composition ─────────────────

describe("spawnKernelDebugSessions — enabled path", () => {
  it("spawns one session per enabled VM", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
      {
        name: "endpoint-2",
        template: "win11",
        guest_agent_port: 50052,
        kernel_debug: { enabled: true },
      },
      {
        name: "endpoint-3",
        template: "win11",
        guest_agent_port: 50053,
        // no kernel_debug
      },
    ]);
    expect(sessions.length).toBe(2);
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeDefined();
    expect(orchestrator.getKernelDebug("endpoint-2")).toBeDefined();
    expect(orchestrator.getKernelDebug("endpoint-3")).toBeUndefined();
  });

  it("expands {vm_name} placeholder in the pipe path", async () => {
    const { orchestrator: _, sessions } = await makeOrchestrator();
    await spawnKd(_ as unknown, [
      {
        name: "Win11x64",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: {
          enabled: true,
          pipe: "\\\\.\\pipe\\kd-{vm_name}",
        },
      },
    ]);
    expect(sessions[0].opts.kdArgs.join(" ")).toContain(
      "com:pipe,port=\\\\.\\pipe\\kd-Win11x64",
    );
  });

  it("defaults the pipe to \\\\.\\pipe\\kd-<vm>", async () => {
    const { sessions } = await makeOrchestrator().then(async ({ orchestrator, sessions }) => {
      await spawnKd(orchestrator, [
        {
          name: "Win11x64",
          template: "win11",
          guest_agent_port: 50051,
          kernel_debug: { enabled: true },
        },
      ]);
      return { sessions };
    });
    expect(sessions[0].opts.kdArgs.join(" ")).toContain(
      "\\\\.\\pipe\\kd-Win11x64",
    );
  });

  it("passes break_on_load + break_on_bugcheck to the session", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: {
          enabled: true,
          break_on_load: ["example.sys", "silo.sys"],
          break_on_bugcheck: false,
        },
      },
    ]);
    expect(sessions[0].opts.breakOnLoad).toEqual(["example.sys", "silo.sys"]);
    expect(sessions[0].opts.breakOnBugcheck).toBe(false);
  });

  it("default-undefined breakOnBugcheck lets KdSession decide", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);
    // When kernel_debug.break_on_bugcheck is omitted, we pass
    // undefined to the session (which defaults it to true internally).
    expect(sessions[0].opts.breakOnBugcheck).toBeUndefined();
  });

  it("applies custom kd_exe + symbol_path", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: {
          enabled: true,
          kd_exe: "C:\\Tools\\kd.exe",
          symbol_path: "srv*D:\\syms",
        },
      },
    ]);
    expect(sessions[0].opts.kdExe).toBe("C:\\Tools\\kd.exe");
    expect(sessions[0].opts.kdArgs.join(" ")).toContain("srv*D:\\syms");
  });

  it("calls session.start() on each spawned session", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);
    expect(sessions[0].startCalls).toBe(1);
  });

  it("registers each spawned session under its VM name", async () => {
    const { orchestrator } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);
    const binding = orchestrator.getKernelDebug("endpoint-1");
    expect(binding).toBeDefined();
    expect(binding?.session).toBeDefined();
    expect(binding?.breakLog).toBeDefined();
  });

  it("propagates KdSession.start() failures", async () => {
    const { orchestrator, sessions: _ } = await makeOrchestrator();
    // Override the factory to return a session that fails to start.
    orchestrator.setKdSessionFactory((opts) => {
      const s = new FakeKdSession(opts);
      s.startShouldThrow = new Error("pipe not opened");
      return s as unknown as KdSession;
    });
    await expect(
      spawnKd(orchestrator, [
        {
          name: "endpoint-1",
          template: "win11",
          guest_agent_port: 50051,
          kernel_debug: { enabled: true },
        },
      ]),
    ).rejects.toThrow(/pipe not opened/);
  });
});

// ─── Teardown lifecycle ────────────────────────────────────────────

describe("teardownKernelDebugSessions", () => {
  it("calls detach() on every spawned session", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
      {
        name: "endpoint-2",
        template: "win11",
        guest_agent_port: 50052,
        kernel_debug: { enabled: true },
      },
    ]);
    expect(sessions.length).toBe(2);
    await orchestrator.teardownKernelDebugSessions();
    expect(sessions[0].detachCalls).toBe(1);
    expect(sessions[1].detachCalls).toBe(1);
    // Registry should be cleared.
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeUndefined();
    expect(orchestrator.getKernelDebug("endpoint-2")).toBeUndefined();
  });

  it("is safe to call when no sessions were spawned", async () => {
    const { orchestrator } = await makeOrchestrator();
    await expect(orchestrator.teardownKernelDebugSessions()).resolves.toBeUndefined();
  });

  it("continues tearing down remaining sessions when one errors", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
      {
        name: "endpoint-2",
        template: "win11",
        guest_agent_port: 50052,
        kernel_debug: { enabled: true },
      },
    ]);
    // First session fails to detach; second should still get called.
    const origDetach = sessions[0].detach.bind(sessions[0]);
    sessions[0].detach = async () => {
      await origDetach();
      throw new Error("detach boom");
    };
    await orchestrator.teardownKernelDebugSessions();
    expect(sessions[0].detachCalls).toBe(1);
    expect(sessions[1].detachCalls).toBe(1);
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeUndefined();
    expect(orchestrator.getKernelDebug("endpoint-2")).toBeUndefined();
  });

  it("detachKernelDebugSessions() tears down without detaching sessions", async () => {
    // The sync version only cleans break logs; session remains alive.
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);
    orchestrator.detachKernelDebugSessions();
    expect(sessions[0].detachCalls).toBe(0);
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeUndefined();
  });
});

// ─── KdSessionOptions plumbing smoke test ──────────────────────────

describe("process-exit kd cleanup", () => {
  it("force-terminates active kd sessions on process exit", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    const processTarget = new FakeProcessExitTarget();
    orchestrator.registerProcessExitCleanup(processTarget);
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);

    processTarget.emit("exit");

    expect(sessions[0].forceTerminateCalls).toBe(1);
    expect(orchestrator.getKernelDebug("endpoint-1")).toBeUndefined();
  });

  it("unregisters the process-exit hook after normal kd teardown", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    const processTarget = new FakeProcessExitTarget();
    orchestrator.registerProcessExitCleanup(processTarget);
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);

    await orchestrator.teardownKernelDebugSessions();
    processTarget.emit("exit");

    expect(sessions[0].detachCalls).toBe(1);
    expect(sessions[0].forceTerminateCalls).toBe(0);
  });
});

describe("KdSessionOptions composition", () => {
  it("kd CLI uses the com:pipe,port=...,reconnect form", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: {
          enabled: true,
          pipe: "\\\\.\\pipe\\custom",
        },
      },
    ]);
    const args = sessions[0].opts.kdArgs;
    expect(args).toContain("-k");
    const transport = args[args.indexOf("-k") + 1];
    expect(transport).toContain("com:pipe,port=\\\\.\\pipe\\custom");
    expect(transport).toContain("baud=115200");
    expect(transport).toContain("reconnect");
  });

  it("kd CLI includes -y <symbolPath>", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: {
          enabled: true,
          symbol_path: "srv*C:\\Symbols",
        },
      },
    ]);
    const args = sessions[0].opts.kdArgs;
    expect(args).toContain("-y");
    expect(args[args.indexOf("-y") + 1]).toBe("srv*C:\\Symbols");
  });
});

// ─── Round-trip: setup.yaml → spawn → tool use ─────────────────────

describe("auto-wired kernel_debug + registered tool", () => {
  it("kernel_expect_bugcheck works against an auto-wired session", async () => {
    const { orchestrator, sessions } = await makeOrchestrator();
    await spawnKd(orchestrator, [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: { enabled: true },
      },
    ]);
    // Emit a bugcheck event through the fake session so the break log
    // picks it up. Session starts in "running" after our fake start()
    // so the `reason`/`bugcheckCode` shape goes straight to BreakLog.
    sessions[0].emit("break", {
      type: "break",
      reason: "bugcheck",
      bugcheckCode: "0xdead",
    });
    // Drive a tool block via executeToolBlock so we also exercise
    // the orchestrator's registry path.
    const out = await orchestrator.executeToolBlock(
      "kernel_expect_bugcheck",
      {
        vm: "endpoint-1",
        bugcheck_code: "0xdead",
        capture_stack: false,
      },
      new Map() as never,
    );
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(true);
    expect(parsed.bugcheck_code).toBe("0xdead");
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

// Silence vi timer warnings.
vi.useRealTimers();
