import { describe, expect, it, vi } from "vitest";
import path from "node:path";

import { ScenarioOrchestrator, type VmDefinition } from "../scenarios/orchestrator.js";
import type { GuestAgentClient } from "../guest/client.js";
import type { HypervisorBackend, VMHandle, VMStatus } from "../hypervisors/interface.js";
import type { SignalmanConfig } from "../config.js";

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

function makeBackend(): HypervisorBackend {
  return {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
    createVM: vi.fn(),
    startVM: vi.fn(),
    stopVM: vi.fn(),
    pauseVM: vi.fn(),
    resumeVM: vi.fn(),
    deleteVM: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({
      handle: makeHandle("endpoint-1"),
      state: "running",
      guestAgentReachable: true,
    } as VMStatus),
    getVmIpAddress: vi.fn().mockResolvedValue("172.23.14.201"),
    listVMs: vi.fn().mockResolvedValue([makeHandle("endpoint-1")]),
    createCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    copyFileToVM: vi.fn(),
    copyFileFromVM: vi.fn(),
    executeCommand: vi.fn(),
  };
}

function makeClient(overrides: Partial<GuestAgentClient> = {}): GuestAgentClient {
  return {
    uiScreenshot: vi.fn().mockResolvedValue({
      imageData: Buffer.from("fake-png"),
      format: "png",
      width: 640,
      height: 480,
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    uiFind: vi.fn().mockResolvedValue([
      {
        name: "Start",
        automationId: "StartButton",
        controlType: "Button",
        boundingBox: { x: 0, y: 0, width: 48, height: 48 },
        isEnabled: true,
        isVisible: true,
      },
    ]),
    uiClick: vi.fn().mockResolvedValue({ success: true, error: "" }),
    uiType: vi.fn().mockResolvedValue({ success: true, error: "" }),
    ...overrides,
  } as unknown as GuestAgentClient;
}

function makeOrchestrator(client: GuestAgentClient) {
  const backend = makeBackend();
  const config = {
    hypervisor: { backend: "service" },
    guestAgent: {
      defaultPort: 50051,
      authToken: "test-token",
      tls: { enabled: false },
    },
    scenarios: {
      dir: ".signalman/scenarios",
      outputDir: "output",
      screenshotDir: "output/screenshots",
    },
  } as unknown as SignalmanConfig;
  const orchestrator = new ScenarioOrchestrator(
    backend,
    new Map<string, GuestAgentClient>([["endpoint-1", client]]),
    config,
  );
  const vmMap = new Map<string, VMHandle>([["endpoint-1", makeHandle("endpoint-1")]]);
  return { orchestrator, vmMap };
}

describe("workflow UI tool blocks", () => {
  it("routes ui_find, ui_click, and ui_type to the VM guest client", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const found = await orchestrator.executeToolBlock(
      "ui_find",
      { vm: "endpoint-1", selector: "[name='Start']", find_timeout_ms: 2_000 },
      vmMap,
    );
    const clicked = await orchestrator.executeToolBlock(
      "ui_click",
      { vm: "endpoint-1", selector: "[name='Start']", click_type: "left" },
      vmMap,
    );
    const typed = await orchestrator.executeToolBlock(
      "ui_type",
      { vm: "endpoint-1", text: "hello", selector: "[automationId='Input']", clear_first: true },
      vmMap,
    );

    expect(client.uiFind).toHaveBeenCalledWith("[name='Start']", {
      windowTitle: undefined,
      findTimeoutMs: 2_000,
      timeoutMs: undefined,
    });
    expect(client.uiClick).toHaveBeenCalledWith("[name='Start']", {
      windowTitle: undefined,
      clickType: "left",
      timeoutMs: undefined,
    });
    expect(client.uiType).toHaveBeenCalledWith("hello", {
      selector: "[automationId='Input']",
      windowTitle: undefined,
      clearFirst: true,
      timeoutMs: undefined,
    });
    expect(JSON.parse(found)).toMatchObject({ count: 1 });
    expect(JSON.parse(clicked)).toEqual({ success: true, error: "" });
    expect(JSON.parse(typed)).toEqual({ success: true, error: "" });
  });

  it("returns screenshot metadata and rejects missing UI selectors", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const screenshot = await orchestrator.executeToolBlock(
      "ui_screenshot",
      {
        vm: "endpoint-1",
        format: "png",
        output: "./output/live-ui-sidecar-smoke/desktop.png",
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.screenshot).toHaveBeenCalledWith(undefined, "png", 5_000);
    expect(JSON.parse(screenshot)).toMatchObject({
      format: "png",
      bytes: Buffer.from("fake-png").byteLength,
      saved_path: path.resolve("output/live-ui-sidecar-smoke/desktop.png"),
    });
    await expect(
      orchestrator.executeToolBlock("ui_click", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_click missing 'selector'");
    await expect(
      orchestrator.executeToolBlock("ui_find", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_find missing 'selector'");
  });

  it("creates a guest client for pre-started Hyper-V/service VMs via backend IP discovery", async () => {
    const client = makeClient({
      isConnected: vi.fn().mockResolvedValue(true),
    } as Partial<GuestAgentClient>);
    const backend = makeBackend();
    const created: Array<{ vmName: string; handle: VMHandle; def: VmDefinition }> = [];

    class TestOrchestrator extends ScenarioOrchestrator {
      override async ensureGuestClient(
        vmName: string,
        handle: VMHandle,
        def?: VmDefinition,
      ): Promise<GuestAgentClient> {
        created.push({ vmName, handle, def: def! });
        return client;
      }
    }

    const orchestrator = new TestOrchestrator(
      backend,
      new Map<string, GuestAgentClient>(),
      {
        hypervisor: { backend: "service" },
        guestAgent: { defaultPort: 50051, authToken: "test-token", tls: { enabled: false } },
      } as unknown as SignalmanConfig,
    );
    const vmMap = new Map<string, VMHandle>([
      ["endpoint-1", { id: "pre-started", name: "Win11_test", backend: "service" }],
    ]);

    await orchestrator.waitForGuestAgents(vmMap, [
      {
        name: "endpoint-1",
        template: "win11-test",
        pre_started: true,
        guest_agent_port: 50051,
      } as VmDefinition,
    ]);

    expect(created).toEqual([
      {
        vmName: "endpoint-1",
        handle: { id: "pre-started", name: "Win11_test", backend: "service" },
        def: expect.objectContaining({ pre_started: true }),
      },
    ]);
    expect(client.isConnected).toHaveBeenCalledWith(5_000);
  });
});
