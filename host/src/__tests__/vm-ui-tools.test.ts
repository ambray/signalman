import { describe, expect, it, vi } from "vitest";

import { createVmUiTools } from "../tools/vm-ui.js";
import type { GuestAgentClient } from "../guest/client.js";

function makeClient(overrides: Partial<GuestAgentClient> = {}): GuestAgentClient {
  return {
    runCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        taskName: "SignalmanUiSidecar",
        username: "test",
        bind: "127.0.0.1:50151",
        engine: "powershell-helper",
        executable: "C:\\Program Files\\Signalman\\Guest\\signalman-guest.exe",
        created: true,
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
      width: 800,
      height: 600,
      durationMs: 11,
    }),
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
      engine: "powershell-process",
      pid: 123,
      uptimeMs: 456,
      error: "",
      durationMs: 16,
    }),
    ...overrides,
  } as unknown as GuestAgentClient;
}

function toolsFor(client: GuestAgentClient) {
  const getClient = vi.fn().mockResolvedValue(client);
  const tools = new Map(createVmUiTools(getClient).map((tool) => [tool.name, tool]));
  return { getClient, tools };
}

describe("VM UI MCP tools", () => {
  it("captures a combined screenshot and UI element snapshot", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValue({
        durationMs: 22,
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
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_ui_snapshot")!.handler({
      name: "Win11_test",
      window_title: "Shell",
      format: "png",
      max_elements: 1,
      find_timeout_ms: 2_000,
      timeout_ms: 12_000,
    });

    expect(client.uiScreenshot).toHaveBeenCalledWith({
      windowTitle: "Shell",
      format: "png",
      timeoutMs: 12_000,
    });
    expect(client.uiFindDetailed).toHaveBeenCalledWith("", {
      windowTitle: "Shell",
      findTimeoutMs: 2_000,
      timeoutMs: 12_000,
    });
    expect(result.content[0]).toMatchObject({
      type: "image",
      data: Buffer.from("fake-png").toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.parse(result.content[1].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      screenshot_duration_ms: 11,
      find_duration_ms: 22,
      element_count: 2,
      elements: [expect.objectContaining({ name: "Start" })],
      truncated: true,
    });
  });

  it("reports UI sidecar health and engine diagnostics", async () => {
    const client = makeClient();
    const { getClient, tools } = toolsFor(client);

    const result = await tools.get("vm_ui_health")!.handler({
      name: "Win11_test",
      timeout_ms: 7_000,
    });

    expect(getClient).toHaveBeenCalledWith("Win11_test");
    expect(client.uiHealth).toHaveBeenCalledWith(7_000);
    expect(JSON.parse(result.content[0].text ?? "{}")).toEqual({
      vm: "Win11_test",
      sidecar_reachable: true,
      engine: "powershell-process",
      pid: 123,
      uptime_ms: 456,
      error: "",
      duration_ms: 16,
    });
    expect(result.isError).toBe(false);
  });

  it("captures screenshots as MCP image content plus metadata", async () => {
    const client = makeClient();
    const { getClient, tools } = toolsFor(client);

    const result = await tools.get("vm_ui_screenshot")!.handler({
      name: "Win11_test",
      window_title: "Calculator",
      format: "png",
      timeout_ms: 12_000,
    });

    expect(getClient).toHaveBeenCalledWith("Win11_test");
    expect(client.uiScreenshot).toHaveBeenCalledWith({
      windowTitle: "Calculator",
      format: "png",
      timeoutMs: 12_000,
    });
    expect(result.content[0]).toEqual({
      type: "image",
      data: Buffer.from("fake-png").toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.parse(result.content[1].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      format: "png",
      width: 800,
      height: 600,
      duration_ms: 11,
    });
  });

  it("finds UI elements with explicit find and RPC timeouts", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_ui_find")!.handler({
      name: "Win11_test",
      selector: "[name='Start']",
      window_title: "Shell",
      find_timeout_ms: 3_000,
      timeout_ms: 10_000,
    });

    expect(client.uiFindDetailed).toHaveBeenCalledWith("[name='Start']", {
      windowTitle: "Shell",
      findTimeoutMs: 3_000,
      timeoutMs: 10_000,
    });
    expect(JSON.parse(result.content[0].text ?? "{}")).toMatchObject({
      duration_ms: 12,
      elements: [expect.objectContaining({ name: "Start" })],
    });
  });

  it("waits for UI elements and marks absent elements as MCP errors", async () => {
    const client = makeClient({
      uiFindDetailed: vi
        .fn()
        .mockResolvedValueOnce({
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
          ],
        })
        .mockResolvedValueOnce({ durationMs: 32, elements: [] }),
    } as Partial<GuestAgentClient>);
    const { tools } = toolsFor(client);

    const found = await tools.get("vm_ui_wait_for")!.handler({
      name: "Win11_test",
      selector: "[name='Start']",
      window_title: "Shell",
      find_timeout_ms: 3_000,
      timeout_ms: 10_000,
    });
    const missing = await tools.get("vm_ui_wait_for")!.handler({
      name: "Win11_test",
      selector: "[name='Missing']",
    });

    expect(client.uiFindDetailed).toHaveBeenNthCalledWith(1, "[name='Start']", {
      windowTitle: "Shell",
      findTimeoutMs: 3_000,
      timeoutMs: 10_000,
    });
    expect(JSON.parse(found.content[0].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      selector: "[name='Start']",
      found: true,
      count: 1,
      duration_ms: 31,
      error: "",
    });
    expect(found.isError).toBe(false);
    expect(JSON.parse(missing.content[0].text ?? "{}")).toMatchObject({
      found: false,
      count: 0,
      duration_ms: 32,
      error: "UI element not found: [name='Missing']",
    });
    expect(missing.isError).toBe(true);
  });

  it("marks failed click and type operations as MCP errors", async () => {
    const client = makeClient({
      uiClick: vi.fn().mockResolvedValue({ success: false, error: "not found", durationMs: 41 }),
      uiKey: vi.fn().mockResolvedValue({ success: false, error: "bad key", durationMs: 42 }),
      uiType: vi.fn().mockResolvedValue({ success: false, error: "not focused", durationMs: 43 }),
    } as Partial<GuestAgentClient>);
    const { tools } = toolsFor(client);

    const click = await tools.get("vm_ui_click")!.handler({
      name: "Win11_test",
      selector: "[name='Missing']",
      click_type: "right",
    });
    const type = await tools.get("vm_ui_type")!.handler({
      name: "Win11_test",
      text: "hello",
      selector: "[automationId='Input']",
      clear_first: true,
    });
    const key = await tools.get("vm_ui_key")!.handler({
      name: "Win11_test",
      keys: "{ESC}",
      repeat: 2,
      timeout_ms: 5_000,
    });

    expect(client.uiClick).toHaveBeenCalledWith("[name='Missing']", {
      windowTitle: "",
      clickType: "right",
      timeoutMs: 30_000,
    });
    expect(client.uiType).toHaveBeenCalledWith("hello", {
      selector: "[automationId='Input']",
      windowTitle: "",
      clearFirst: true,
      timeoutMs: 30_000,
    });
    expect(client.uiKey).toHaveBeenCalledWith("{ESC}", {
      selector: undefined,
      windowTitle: undefined,
      repeat: 2,
      timeoutMs: 5_000,
    });
    expect(click.isError).toBe(true);
    expect(key.isError).toBe(true);
    expect(JSON.parse(click.content[0].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      error: "not found",
      duration_ms: 41,
    });
    expect(JSON.parse(key.content[0].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      error: "bad key",
      duration_ms: 42,
    });
    expect(type.isError).toBe(true);
  });

  it("ensures the user-session sidecar through a SYSTEM guest command", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_ui_ensure_sidecar")!.handler({
      name: "Win11_test",
      username: "test",
      engine: "powershell-helper",
      timeout_ms: 15_000,
      wait_ready_ms: 12_000,
    });

    expect(client.runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-EncodedCommand", expect.any(String)]),
      { timeoutMs: 15_000, runAs: "SYSTEM", maxRetries: 1 },
    );
    expect(JSON.parse(result.content[0].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      taskName: "SignalmanUiSidecar",
      username: "test",
      engine: "powershell-helper",
      state: "Running",
      ready: true,
    });
    const args = (client.runCommand as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const decoded = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("$waitReadyMs = 12000");
    expect(decoded).toContain("$engine = 'powershell-helper'");
  });
});
