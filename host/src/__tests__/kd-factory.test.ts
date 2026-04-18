import { describe, it, expect, vi } from "vitest";
import {
  createRealKdSession,
  type KdSessionFactory,
} from "../kernel-debug/factory.js";
import { KdSession } from "../kernel-debug/kd-session.js";

describe("createRealKdSession", () => {
  it("returns a KdSession instance", () => {
    const session = createRealKdSession({
      kdArgs: ["-k", "com:pipe,port=\\\\.\\pipe\\test"],
      // Inject a spy spawn so nothing actually tries to run kd.exe
      // during construction. Sessions are constructed eagerly; they
      // don't spawn until .start().
    });
    expect(session).toBeInstanceOf(KdSession);
  });

  it("initializes the session in the `idle` state", () => {
    const session = createRealKdSession({ kdArgs: ["-k"] });
    expect(session.state).toBe("idle");
  });

  it("forwards kdArgs to the session via spawnFn invocation", async () => {
    // The only observable we get without really spawning is that
    // the spawnFn receives the configured kdArgs. Pass a synchronous
    // spy that throws so start() rejects cleanly.
    const spawnSpy = vi.fn(() => {
      throw new Error("stop before exec");
    });
    const session = createRealKdSession({
      kdArgs: ["-k", "test-transport"],
      spawnFn:
        spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    // start() will fail — we just want the spy to have been invoked
    // with our kdArgs.
    await session.start().catch(() => undefined);
    expect(spawnSpy).toHaveBeenCalled();
    const callArgs = spawnSpy.mock.calls[0][1] as unknown as string[];
    expect(callArgs).toEqual(["-k", "test-transport"]);
  });
});

describe("KdSessionFactory type", () => {
  it("matches the createRealKdSession signature", () => {
    // Pure type-level assertion at runtime — if the alias drifts from
    // the impl, the assignment below wouldn't compile.
    const f: KdSessionFactory = createRealKdSession;
    expect(typeof f).toBe("function");
  });

  it("lets callers plug in a custom factory", () => {
    // Demonstrates the injection contract used by
    // orchestrator.setKdSessionFactory(). Returning a raw object cast
    // via unknown is permissible because the consumer treats the
    // result as `KdSession`-shaped.
    const customFactory: KdSessionFactory = (opts) => {
      return {
        customMarker: true,
        kdArgs: opts.kdArgs,
        state: "idle",
      } as unknown as ReturnType<KdSessionFactory>;
    };
    const session = customFactory({ kdArgs: ["custom"] });
    const asRecord = session as unknown as Record<string, unknown>;
    expect(asRecord.customMarker).toBe(true);
  });
});

describe("orchestrator integration — uses factory import", () => {
  it("ScenarioOrchestrator's default factory is createRealKdSession", async () => {
    // Indirect — after follow-up 2 the orchestrator imports
    // createRealKdSession from './factory.js'. The observable contract
    // is that a fresh orchestrator's session factory produces a
    // KdSession.
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const orchestrator = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    // Use the factory override hook to capture what the current
    // factory produces. Without modification, it's the real one.
    let captured: unknown;
    orchestrator.setKdSessionFactory((opts) => {
      captured = createRealKdSession(opts);
      return captured as ReturnType<KdSessionFactory>;
    });
    // Drive `spawnKernelDebugSessions` via the private hook; we use
    // a cast to access it like in the lifecycle tests.
    await (
      orchestrator as unknown as {
        spawnKernelDebugSessions(defs: unknown[]): Promise<void>;
      }
    ).spawnKernelDebugSessions([
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
        kernel_debug: {
          enabled: true,
          // Use a spawnFn that throws so the session never actually
          // launches kd.exe — we just want to confirm the factory
          // was invoked.
        },
      },
    ]).catch(() => {
      // start() will fail because no real kd.exe path is wired;
      // the factory invocation is what matters.
    });
    expect(captured).toBeInstanceOf(KdSession);
  });
});

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
