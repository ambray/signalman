import { describe, expect, it, vi } from "vitest";

import type { GuestAgentClient } from "../guest/client.js";
import { createVmBrowserTools } from "../tools/vm-browser.js";

function makeClient(overrides: Partial<GuestAgentClient> = {}): GuestAgentClient {
  return {
    browserNavigate: vi.fn().mockResolvedValue({
      success: true,
      error: "",
      pageTitle: "Example",
      pageUrl: "https://example.test/",
    }),
    browserClick: vi.fn().mockResolvedValue({
      success: true,
      error: "",
      pageTitle: "Clicked",
      pageUrl: "https://example.test/clicked",
    }),
    browserEvaluate: vi.fn().mockResolvedValue({
      success: true,
      error: "",
      jsonValue: "{\"clicked\":true}",
      pageTitle: "Clicked",
      pageUrl: "https://example.test/clicked",
    }),
    browserScreenshot: vi.fn().mockResolvedValue({
      imageData: Buffer.from("browser-png"),
      format: "png",
      width: 640,
      height: 480,
    }),
    ...overrides,
  } as unknown as GuestAgentClient;
}

function toolsFor(client: GuestAgentClient) {
  const getClient = vi.fn().mockResolvedValue(client);
  const tools = new Map(createVmBrowserTools(getClient).map((tool) => [tool.name, tool]));
  return { getClient, tools };
}

describe("VM browser MCP tools", () => {
  it("navigates through the guest browser automation RPC", async () => {
    const client = makeClient();
    const { getClient, tools } = toolsFor(client);

    const result = await tools.get("vm_browser_navigate")!.handler({
      name: "Win11_test",
      url: " https://example.test ",
      timeout_ms: 5_000,
    });

    expect(getClient).toHaveBeenCalledWith("Win11_test");
    expect(client.browserNavigate).toHaveBeenCalledWith("https://example.test/", 5_000);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text!)).toEqual({
      vm: "Win11_test",
      success: true,
      error: "",
      page_title: "Example",
      page_url: "https://example.test/",
    });
  });

  it("rejects unsafe browser navigation URLs before calling the guest", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    await expect(
      tools.get("vm_browser_navigate")!.handler({
        name: "Win11_test",
        url: "javascript:alert(1)",
      }),
    ).rejects.toThrow("url must use http:// or https://");
    expect(client.browserNavigate).not.toHaveBeenCalled();
  });

  it("clicks through the guest browser automation RPC", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_browser_click")!.handler({
      name: "Win11_test",
      css_selector: "#continue",
      timeout_ms: 5_000,
    });

    expect(client.browserClick).toHaveBeenCalledWith("#continue", 5_000);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      vm: "Win11_test",
      success: true,
      page_title: "Clicked",
    });
  });

  it("evaluates browser page state through the guest browser automation RPC", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_browser_evaluate")!.handler({
      name: "Win11_test",
      expression: "({ clicked: document.body.dataset.clicked === 'true' })",
      timeout_ms: 5_000,
    });

    expect(client.browserEvaluate).toHaveBeenCalledWith(
      "({ clicked: document.body.dataset.clicked === 'true' })",
      5_000,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text!)).toEqual({
      vm: "Win11_test",
      success: true,
      error: "",
      json_value: "{\"clicked\":true}",
      page_title: "Clicked",
      page_url: "https://example.test/clicked",
    });
  });

  it("marks browser backend failures as MCP errors", async () => {
    const client = makeClient({
      browserClick: vi.fn().mockRejectedValue(new Error("12 UNIMPLEMENTED: CDP backend missing")),
    } as Partial<GuestAgentClient>);
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_browser_click")!.handler({
      name: "Win11_test",
      css_selector: "button",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text!)).toEqual({
      vm: "Win11_test",
      success: false,
      error: "12 UNIMPLEMENTED: CDP backend missing",
    });
  });

  it("captures browser screenshots as MCP image content plus metadata", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    const result = await tools.get("vm_browser_screenshot")!.handler({
      name: "Win11_test",
      format: "png",
      full_page: true,
      timeout_ms: 5_000,
    });

    expect(client.browserScreenshot).toHaveBeenCalledWith({
      format: "png",
      fullPage: true,
      timeoutMs: 5_000,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: "image",
      data: Buffer.from("browser-png").toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.parse(result.content[1].text!)).toEqual({
      vm: "Win11_test",
      format: "png",
      width: 640,
      height: 480,
    });
  });

  it("rejects unsafe CSS selectors before calling the guest", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    await expect(
      tools.get("vm_browser_click")!.handler({
        name: "Win11_test",
        css_selector: "button\0.bad",
      }),
    ).rejects.toThrow("css_selector contains null byte");
    expect(client.browserClick).not.toHaveBeenCalled();
  });

  it("rejects unsafe browser evaluate expressions before calling the guest", async () => {
    const client = makeClient();
    const { tools } = toolsFor(client);

    await expect(
      tools.get("vm_browser_evaluate")!.handler({
        name: "Win11_test",
        expression: "document.title\0",
      }),
    ).rejects.toThrow("expression contains null byte");
    expect(client.browserEvaluate).not.toHaveBeenCalled();
  });
});
