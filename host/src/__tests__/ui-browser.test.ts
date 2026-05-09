import { describe, expect, it, vi } from "vitest";

import { navigateUrlWithUi, openUrlWithUi, sanitizeBrowserUrl } from "../guest/ui-browser.js";
import type { GuestAgentClient } from "../guest/client.js";

function makeClient(overrides: Partial<GuestAgentClient> = {}): GuestAgentClient {
  return {
    uiFindDetailed: vi.fn().mockResolvedValue({
      durationMs: 11,
      elements: [
        {
          name: "Address and search bar",
          automationId: "view_1021",
          controlType: "ControlType.Edit",
          className: "Edit",
          isEnabled: true,
          isVisible: true,
          x: 100,
          y: 50,
          width: 700,
          height: 32,
          value: "example.test/next",
        },
      ],
    }),
    uiClick: vi.fn().mockResolvedValue({ success: true, error: "", durationMs: 12 }),
    uiKey: vi.fn().mockResolvedValue({ success: true, error: "", durationMs: 13 }),
    uiType: vi.fn().mockResolvedValue({ success: true, error: "", durationMs: 14 }),
    ...overrides,
  } as unknown as GuestAgentClient;
}

describe("UI browser helpers", () => {
  it("sanitizes only credential-free http(s) URLs", () => {
    expect(sanitizeBrowserUrl(" http://example.test/path ")).toBe("http://example.test/path");
    expect(sanitizeBrowserUrl("https://example.test")).toBe("https://example.test/");
    expect(() => sanitizeBrowserUrl("")).toThrow("url is required");
    expect(() => sanitizeBrowserUrl("file:///C:/Windows/System32/calc.exe")).toThrow(
      "url must use http:// or https://",
    );
    expect(() => sanitizeBrowserUrl("javascript:alert(1)")).toThrow(
      "url must use http:// or https://",
    );
    expect(() => sanitizeBrowserUrl("https://user:secret@example.test/")).toThrow(
      "url must not include embedded credentials",
    );
  });

  it("opens URLs through the Windows Run dialog", async () => {
    const client = makeClient();

    const result = await openUrlWithUi(client, "https://example.test/path", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });

    expect(client.uiKey).toHaveBeenNthCalledWith(1, "#r", { timeoutMs: 5_000 });
    expect(client.uiFindDetailed).toHaveBeenCalledWith("[automationId='1001']", {
      windowTitle: "Run",
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(client.uiType).toHaveBeenCalledWith("https://example.test/path", {
      selector: "[automationId='1001']",
      windowTitle: "Run",
      clearFirst: true,
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(2, "{ENTER}", {
      windowTitle: "Run",
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      url: "https://example.test/path",
      success: true,
      error: "",
      durationMs: 51,
    });
  });

  it("returns a failed open result when the Run edit field is absent", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValue({ durationMs: 11, elements: [] }),
    } as Partial<GuestAgentClient>);

    const result = await openUrlWithUi(client, "http://example.test", { timeoutMs: 5_000 });

    expect(result).toEqual({
      url: "http://example.test/",
      success: false,
      error: "Run dialog edit field not found: [automationId='1001']",
      durationMs: 24,
    });
    expect(client.uiType).not.toHaveBeenCalled();
  });

  it("discovers the browser target and verifies navigation", async () => {
    const client = makeClient();

    const result = await navigateUrlWithUi(client, "http://example.test/next", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });

    expect(client.uiFindDetailed).toHaveBeenNthCalledWith(1, "", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(client.uiClick).toHaveBeenCalledWith("[automationId='view_1021']", {
      timeoutMs: 5_000,
    });
    expect(client.uiFindDetailed).toHaveBeenNthCalledWith(2, "[value='example.test/next']", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      success: true,
      observed: true,
      observedCount: 1,
      targetSelector: "[automationId='view_1021']",
      targetEditSelector: "[automationId='view_1021']",
      targetKind: "address_bar",
      targetConfidence: 1,
      targetFallback: false,
    });
  });

  it("falls back to default Edge selectors when a discovered focus target is stale", async () => {
    const client = makeClient({
      uiFindDetailed: vi.fn().mockResolvedValue({
        durationMs: 11,
        elements: [
          {
            name: "Address and search bar",
            automationId: "stale-address",
            controlType: "ControlType.Edit",
            className: "Edit",
            isEnabled: true,
            isVisible: true,
            x: 100,
            y: 50,
            width: 700,
            height: 32,
            value: "example.test/next",
          },
        ],
      }),
      uiKey: vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: "stale focus", durationMs: 13 })
        .mockResolvedValueOnce({ success: true, error: "", durationMs: 14 })
        .mockResolvedValueOnce({ success: true, error: "", durationMs: 15 }),
    } as Partial<GuestAgentClient>);

    const result = await navigateUrlWithUi(client, "http://example.test/next", {
      findTimeoutMs: 2_000,
      timeoutMs: 5_000,
    });

    expect(client.uiClick).toHaveBeenNthCalledWith(1, "[automationId='stale-address']", {
      timeoutMs: 5_000,
    });
    expect(client.uiClick).toHaveBeenNthCalledWith(2, "[name='Address and search bar']", {
      timeoutMs: 5_000,
    });
    expect(client.uiKey).toHaveBeenNthCalledWith(2, "^l", {
      selector: "[automationId='view_1021']",
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      success: true,
      targetSelector: "[name='Address and search bar']",
      targetEditSelector: "[automationId='view_1021']",
      targetKind: "default",
      targetConfidence: 0,
      targetFallback: true,
    });
  });

  it("keeps explicit navigation selector failures visible", async () => {
    const client = makeClient({
      uiClick: vi.fn().mockResolvedValue({ success: false, error: "missing", durationMs: 12 }),
    } as Partial<GuestAgentClient>);

    const result = await navigateUrlWithUi(client, "http://example.test/manual", {
      addressSelector: "[name='Manual']",
      addressEditSelector: "[automationId='manual-edit']",
      timeoutMs: 5_000,
    });

    expect(client.uiFindDetailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: "missing",
      targetSelector: "[name='Manual']",
      targetEditSelector: "[automationId='manual-edit']",
      targetFallback: false,
    });
  });

  it("can navigate without verification", async () => {
    const client = makeClient();

    const result = await navigateUrlWithUi(client, "https://example.test/path", {
      discoverTarget: false,
      verify: false,
      timeoutMs: 5_000,
    });

    expect(client.uiFindDetailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      observed: false,
      observedCount: 0,
      expectedValue: "https://example.test/path",
      targetSelector: "[name='Address and search bar']",
      targetEditSelector: "[automationId='view_1021']",
      targetFallback: false,
    });
  });
});
