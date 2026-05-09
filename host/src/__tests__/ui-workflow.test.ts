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
    runCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        taskName: "SignalmanUiSidecar",
        username: "test",
        bind: "127.0.0.1:50151",
        engine: "powershell-helper",
        executable: "C:\\Program Files\\Signalman\\signalman-guest.exe",
        created: false,
        runNow: true,
        state: "Running",
        ready: true,
        waitReadyMs: 5_000,
      }),
      stderr: "",
      durationMs: 10,
    }),
    uiScreenshot: vi.fn().mockResolvedValue({
      imageData: Buffer.from("fake-png"),
      format: "png",
      width: 640,
      height: 480,
      durationMs: 11,
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    uiFindDetailed: vi.fn().mockResolvedValue({
      durationMs: 12,
      elements: [
        {
          name: "Start",
          automationId: "StartButton",
          controlType: "Button",
          boundingBox: { x: 0, y: 0, width: 48, height: 48 },
          isEnabled: true,
          isVisible: true,
        },
      ],
    }),
    uiClick: vi.fn().mockResolvedValue({ success: true, error: "", durationMs: 13 }),
    uiKey: vi.fn().mockResolvedValue({ success: true, error: "", durationMs: 14 }),
    uiType: vi.fn().mockResolvedValue({ success: true, error: "", durationMs: 15 }),
    uiHealth: vi.fn().mockResolvedValue({
      sidecarReachable: true,
      engine: "powershell-helper",
      pid: 123,
      uptimeMs: 456,
      error: "",
      durationMs: 16,
    }),
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
  it("ensures the user-session UI sidecar from workflow tool blocks", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const ensured = await orchestrator.executeToolBlock(
      "ui_ensure_sidecar",
      {
        vm: "endpoint-1",
        username: "test",
        engine: "native",
        run_now: true,
        wait_ready_ms: 15_000,
        timeout_ms: 30_000,
      },
      vmMap,
    );

    expect(client.runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-EncodedCommand", expect.any(String)]),
      { timeoutMs: 30_000, runAs: "SYSTEM", maxRetries: 1 },
    );
    expect(JSON.parse(ensured)).toMatchObject({
      task_name: "SignalmanUiSidecar",
      username: "test",
      bind: "127.0.0.1:50151",
      ready: true,
      wait_ready_ms: 5_000,
    });
    await expect(
      orchestrator.executeToolBlock("ui_ensure_sidecar", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_ensure_sidecar missing 'username'");
  });

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

    expect(client.uiFindDetailed).toHaveBeenCalledWith("[name='Start']", {
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
    expect(JSON.parse(found)).toMatchObject({
      count: 1,
      duration_ms: 12,
      action_target_count: 1,
      action_targets: [
        expect.objectContaining({
          selector: "[automationId='StartButton']",
          actions: ["click"],
        }),
      ],
      elements: [
        expect.objectContaining({
          element_id: expect.stringMatching(/^ui-001-[0-9a-f]{8}$/),
          selector: "[automationId='StartButton']",
          name: "Start",
        }),
      ],
    });
    expect(JSON.parse(clicked)).toEqual({ success: true, error: "", duration_ms: 13 });
    expect(JSON.parse(typed)).toEqual({ success: true, error: "", duration_ms: 15 });
  });

  it("sends keyboard input through UI workflow tool blocks", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const keyed = await orchestrator.executeToolBlock(
      "ui_key",
      {
        vm: "endpoint-1",
        keys: "{ESC}",
        selector: "[name='Start']",
        repeat: 2,
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.uiKey).toHaveBeenCalledWith("{ESC}", {
      selector: "[name='Start']",
      windowTitle: undefined,
      repeat: 2,
      timeoutMs: 5_000,
    });
    expect(JSON.parse(keyed)).toEqual({ success: true, error: "", duration_ms: 14 });
    await expect(
      orchestrator.executeToolBlock("ui_key", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_key missing 'keys'");
  });

  it("opens http URLs through workflow UI tool blocks", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const opened = await orchestrator.executeToolBlock(
      "ui_open_url",
      {
        vm: "endpoint-1",
        url: "http://example.test/path",
        find_timeout_ms: 2_000,
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.uiKey).toHaveBeenNthCalledWith(1, "#r", { timeoutMs: 5_000 });
    expect(client.uiFindDetailed).toHaveBeenCalledWith("[automationId='1001']", {
      windowTitle: "Run",
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(client.uiType).toHaveBeenCalledWith("http://example.test/path", {
      selector: "[automationId='1001']",
      windowTitle: "Run",
      clearFirst: true,
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(2, "{ENTER}", {
      windowTitle: "Run",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(opened)).toEqual({
      success: true,
      error: "",
      duration_ms: 55,
      url: "http://example.test/path",
    });
    await expect(
      orchestrator.executeToolBlock("ui_open_url", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_open_url missing 'url'");
  });

  it("rejects non-http workflow URLs before sending UI input", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    await expect(
      orchestrator.executeToolBlock(
        "ui_open_url",
        { vm: "endpoint-1", url: "javascript:alert(1)" },
        vmMap,
      ),
    ).rejects.toThrow("url must use http:// or https://");
    expect(client.uiKey).not.toHaveBeenCalled();
  });

  it("navigates an already-open browser through one workflow tool block", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValue({
        durationMs: 16,
        elements: [
          {
            name: "Address and search bar",
            automationId: "view_1021",
            controlType: "Edit",
            value: "example.test/next",
            isEnabled: true,
            isVisible: true,
          },
        ],
      }),
    } as Partial<GuestAgentClient>);
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const navigated = await orchestrator.executeToolBlock(
      "ui_navigate_url",
      {
        vm: "endpoint-1",
        url: "http://example.test/next",
        find_timeout_ms: 2_000,
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.uiFindDetailed).toHaveBeenNthCalledWith(1, "", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(client.uiClick).toHaveBeenCalledWith("[automationId='view_1021']", {
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(1, "^l", {
      selector: "[automationId='view_1021']",
      timeoutMs: 5_000,
    });
    expect(client.uiType).toHaveBeenCalledWith("http://example.test/next", {
      selector: "[automationId='view_1021']",
      clearFirst: true,
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(2, "{ENTER}", {
      selector: "[automationId='view_1021']",
      timeoutMs: 5_000,
    });
    expect(client.uiFindDetailed).toHaveBeenNthCalledWith(2, "[value='example.test/next']", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(JSON.parse(navigated)).toEqual({
      success: true,
      error: "",
      duration_ms: 88,
      url: "http://example.test/next",
      expected_value: "example.test/next",
      observed: true,
      observed_count: 1,
      target_selector: "[automationId='view_1021']",
      target_edit_selector: "[automationId='view_1021']",
      target_kind: "address_bar",
      target_confidence: 1,
      target_fallback: false,
    });
    await expect(
      orchestrator.executeToolBlock("ui_navigate_url", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_navigate_url missing 'url'");
  });

  it("honors explicit browser navigation selectors without discovery", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const navigated = await orchestrator.executeToolBlock(
      "ui_navigate_url",
      {
        vm: "endpoint-1",
        url: "http://example.test/manual",
        address_selector: "[name='Manual bar']",
        address_edit_selector: "[automationId='manual-edit']",
        find_timeout_ms: 2_000,
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.uiFindDetailed).toHaveBeenCalledTimes(1);
    expect(client.uiFindDetailed).toHaveBeenCalledWith("[value='example.test/manual']", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(client.uiClick).toHaveBeenCalledWith("[name='Manual bar']", {
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(1, "^l", {
      selector: "[automationId='manual-edit']",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(navigated)).toMatchObject({
      success: true,
      target_selector: "[name='Manual bar']",
      target_edit_selector: "[automationId='manual-edit']",
      target_kind: "default",
      target_confidence: 0,
      target_fallback: false,
    });
  });

  it("falls back to default browser selectors when a discovered click target is stale", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValue({
        durationMs: 16,
        elements: [
          {
            name: "Address and search bar",
            automationId: "stale-address",
            controlType: "Edit",
            value: "example.test/fallback",
            isEnabled: true,
            isVisible: true,
            x: 0,
            y: 0,
            width: 600,
            height: 30,
          },
        ],
      }),
      uiClick: vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: "stale element", durationMs: 17 })
        .mockResolvedValueOnce({ success: true, error: "", durationMs: 18 }),
    } as Partial<GuestAgentClient>);
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const navigated = await orchestrator.executeToolBlock(
      "ui_navigate_url",
      {
        vm: "endpoint-1",
        url: "http://example.test/fallback",
        find_timeout_ms: 2_000,
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.uiClick).toHaveBeenNthCalledWith(1, "[automationId='stale-address']", {
      timeoutMs: 5_000,
    });
    expect(client.uiClick).toHaveBeenNthCalledWith(2, "[name='Address and search bar']", {
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(1, "^l", {
      selector: "[automationId='view_1021']",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(navigated)).toMatchObject({
      success: true,
      target_selector: "[name='Address and search bar']",
      target_edit_selector: "[automationId='view_1021']",
      target_kind: "default",
      target_confidence: 0,
      target_fallback: true,
    });
  });

  it("recovers an unreachable sidecar for workflow UI blocks when configured", async () => {
    const client = makeClient({
      uiClick: vi
        .fn()
        .mockRejectedValueOnce(new Error("connect UI sidecar at 127.0.0.1:50151"))
        .mockResolvedValueOnce({ success: true, error: "", durationMs: 51 }),
    } as Partial<GuestAgentClient>);
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const clicked = await orchestrator.executeToolBlock(
      "ui_click",
      {
        vm: "endpoint-1",
        selector: "[name='Start']",
        sidecar_username: "test",
        sidecar_engine: "powershell-helper",
        sidecar_wait_ready_ms: 7_000,
        timeout_ms: 8_000,
      },
      vmMap,
    );

    expect(client.runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-EncodedCommand", expect.any(String)]),
      { timeoutMs: 8_000, runAs: "SYSTEM", maxRetries: 1 },
    );
    expect(client.uiClick).toHaveBeenCalledTimes(2);
    expect(JSON.parse(clicked)).toEqual({ success: true, error: "", duration_ms: 51 });
  });

  it("waits for UI elements and fails workflow blocks when absent", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValueOnce({
        durationMs: 21,
        elements: [
          {
            name: "Start",
            automationId: "StartButton",
            controlType: "Button",
            className: "Button",
            isEnabled: true,
            isVisible: true,
            x: 0,
            y: 0,
            width: 48,
            height: 48,
            value: "",
          },
        ],
      }).mockResolvedValueOnce({ durationMs: 22, elements: [] }),
    } as Partial<GuestAgentClient>);
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const found = await orchestrator.executeToolBlock(
      "ui_wait_for",
      { vm: "endpoint-1", selector: "[name='Start']", find_timeout_ms: 2_000 },
      vmMap,
    );

    expect(JSON.parse(found)).toMatchObject({
      found: true,
      count: 1,
      duration_ms: 21,
      action_target_count: 1,
      action_targets: [
        expect.objectContaining({
          selector: "[automationId='StartButton']",
          actions: ["click"],
        }),
      ],
    });
    await expect(
      orchestrator.executeToolBlock(
        "ui_wait_for",
        { vm: "endpoint-1", selector: "[name='Missing']" },
        vmMap,
      ),
    ).rejects.toThrow("UI element not found: [name='Missing']");
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

    expect(client.uiScreenshot).toHaveBeenCalledWith({
      windowTitle: undefined,
      format: "png",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(screenshot)).toMatchObject({
      format: "png",
      bytes: Buffer.from("fake-png").byteLength,
      duration_ms: 11,
      saved_path: path.resolve("output/live-ui-sidecar-smoke/desktop.png"),
    });
    await expect(
      orchestrator.executeToolBlock("ui_click", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_click missing 'selector'");
    await expect(
      orchestrator.executeToolBlock("ui_find", { vm: "endpoint-1" }, vmMap),
    ).rejects.toThrow("ui_find missing 'selector'");
  });

  it("returns UI sidecar health metadata for workflow assertions", async () => {
    const client = makeClient();
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const health = await orchestrator.executeToolBlock(
      "ui_health",
      { vm: "endpoint-1", timeout_ms: 5_000 },
      vmMap,
    );

    expect(client.uiHealth).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(health)).toEqual({
      sidecar_reachable: true,
      engine: "powershell-helper",
      pid: 123,
      uptime_ms: 456,
      error: "",
      duration_ms: 16,
    });
  });

  it("returns combined UI snapshot metadata for workflow assertions", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValue({
        durationMs: 31,
        elements: [
          {
            name: "Start",
            automationId: "StartButton",
            controlType: "Button",
            className: "Button",
            isEnabled: true,
            isVisible: true,
            x: 0,
            y: 0,
            width: 48,
            height: 48,
            value: "",
          },
          {
            name: "Search",
            automationId: "SearchBox",
            controlType: "Edit",
            className: "TextBox",
            isEnabled: true,
            isVisible: true,
            x: 50,
            y: 0,
            width: 300,
            height: 48,
            value: "",
          },
        ],
      }),
    } as Partial<GuestAgentClient>);
    const { orchestrator, vmMap } = makeOrchestrator(client);

    const snapshot = await orchestrator.executeToolBlock(
      "ui_snapshot",
      {
        vm: "endpoint-1",
        format: "png",
        output: "./output/live-ui-sidecar-smoke/snapshot.png",
        max_elements: 1,
        find_timeout_ms: 2_000,
        timeout_ms: 5_000,
      },
      vmMap,
    );

    expect(client.uiScreenshot).toHaveBeenCalledWith({
      windowTitle: undefined,
      format: "png",
      timeoutMs: 5_000,
    });
    expect(client.uiFindDetailed).toHaveBeenCalledWith("", {
      windowTitle: undefined,
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(JSON.parse(snapshot)).toMatchObject({
      format: "png",
      width: 640,
      height: 480,
      bytes: Buffer.from("fake-png").byteLength,
      screenshot_duration_ms: 11,
      find_duration_ms: 31,
      element_count: 2,
      elements: [
        expect.objectContaining({
          element_id: expect.stringMatching(/^ui-001-[0-9a-f]{8}$/),
          selector: "[automationId='StartButton']",
          name: "Start",
          bounds: expect.objectContaining({ center_x: 24, center_y: 24 }),
        }),
      ],
      truncated: true,
      action_target_count: 2,
      action_targets: [
        expect.objectContaining({
          selector: "[automationId='StartButton']",
          actions: ["click"],
        }),
      ],
      action_targets_truncated: true,
      saved_path: path.resolve("output/live-ui-sidecar-smoke/snapshot.png"),
    });
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
