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
    }),
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

function toolsFor(client: GuestAgentClient) {
  const getClient = vi.fn().mockResolvedValue(client);
  const tools = new Map(createVmUiTools(getClient).map((tool) => [tool.name, tool]));
  return { getClient, tools };
}

describe("VM UI MCP tools", () => {
  it("captures a combined screenshot and UI element snapshot", async () => {
    const client = makeClient({
      uiFind: vi.fn().mockResolvedValue([
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
      ]),
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
    expect(client.uiFind).toHaveBeenCalledWith("", {
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
      element_count: 2,
      elements: [expect.objectContaining({ name: "Start" })],
      truncated: true,
    });
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

    expect(client.uiFind).toHaveBeenCalledWith("[name='Start']", {
      windowTitle: "Shell",
      findTimeoutMs: 3_000,
      timeoutMs: 10_000,
    });
    expect(JSON.parse(result.content[0].text ?? "{}").elements).toHaveLength(1);
  });

  it("waits for UI elements and marks absent elements as MCP errors", async () => {
    const client = makeClient({
      uiFind: vi
        .fn()
        .mockResolvedValueOnce([
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
        ])
        .mockResolvedValueOnce([]),
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

    expect(client.uiFind).toHaveBeenNthCalledWith(1, "[name='Start']", {
      windowTitle: "Shell",
      findTimeoutMs: 3_000,
      timeoutMs: 10_000,
    });
    expect(JSON.parse(found.content[0].text ?? "{}")).toMatchObject({
      vm: "Win11_test",
      selector: "[name='Start']",
      found: true,
      count: 1,
      error: "",
    });
    expect(found.isError).toBe(false);
    expect(JSON.parse(missing.content[0].text ?? "{}")).toMatchObject({
      found: false,
      count: 0,
      error: "UI element not found: [name='Missing']",
    });
    expect(missing.isError).toBe(true);
  });

  it("marks failed click and type operations as MCP errors", async () => {
    const client = makeClient({
      uiClick: vi.fn().mockResolvedValue({ success: false, error: "not found" }),
      uiType: vi.fn().mockResolvedValue({ success: false, error: "not focused" }),
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
    expect(click.isError).toBe(true);
    expect(type.isError).toBe(true);
  });

  it("ensures the user-session sidecar through a SYSTEM guest command", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_ui_ensure_sidecar")!.handler({
      name: "Win11_test",
      username: "test",
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
      state: "Running",
      ready: true,
    });
    const args = (client.runCommand as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const decoded = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("$waitReadyMs = 12000");
  });
});
