import { describe, expect, it, vi } from "vitest";

import {
  browserClickWorkflow,
  browserExpectWorkflow,
  browserNavigateWorkflow,
  browserSnapshotWorkflow,
  sanitizeBrowserExpression,
  sanitizeCssSelector,
} from "../guest/browser-workflow.js";
import type { GuestAgentClient } from "../guest/client.js";

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
      pageUrl: "https://example.test/#clicked",
    }),
    browserEvaluate: vi.fn().mockResolvedValue({
      success: true,
      error: "",
      jsonValue: "true",
      pageTitle: "Clicked",
      pageUrl: "https://example.test/#clicked",
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

describe("browser workflow helpers", () => {
  it("sanitizes expressions and CSS selectors before browser RPCs", () => {
    expect(sanitizeBrowserExpression(" document.title ")).toBe(" document.title ");
    expect(sanitizeCssSelector("#continue")).toBe("#continue");
    expect(() => sanitizeBrowserExpression("")).toThrow("expression is required");
    expect(() => sanitizeBrowserExpression("document.title\0")).toThrow(
      "expression contains null byte",
    );
    expect(() => sanitizeCssSelector("button\0.bad")).toThrow("css_selector contains null byte");
  });

  it("wraps browser navigation and click RPCs with validated inputs", async () => {
    const client = makeClient();

    await expect(browserNavigateWorkflow(client, " https://example.test ")).resolves.toMatchObject({
      success: true,
      url: "https://example.test/",
      pageTitle: "Example",
    });
    await expect(
      browserClickWorkflow(client, { cssSelector: "#continue", timeoutMs: 5_000 }),
    ).resolves.toMatchObject({
      success: true,
      cssSelector: "#continue",
      pageTitle: "Clicked",
    });

    expect(client.browserNavigate).toHaveBeenCalledWith("https://example.test/", undefined);
    expect(client.browserClick).toHaveBeenCalledWith("#continue", 5_000);
  });

  it("polls browser evaluation until the expected JSON value is observed", async () => {
    const client = makeClient({
      browserEvaluate: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          error: "",
          jsonValue: "{\"ready\":false}",
          pageTitle: "Loading",
          pageUrl: "https://example.test/",
        })
        .mockResolvedValueOnce({
          success: true,
          error: "",
          jsonValue: "{\"ready\":true}",
          pageTitle: "Ready",
          pageUrl: "https://example.test/",
        }),
    } as Partial<GuestAgentClient>);

    const result = await browserExpectWorkflow(client, "window.__state", {
      expected: { ready: true },
      timeoutMs: 1_000,
      pollIntervalMs: 50,
    });

    expect(result).toMatchObject({
      success: true,
      matched: true,
      attempts: 2,
      expectedJson: "{\"ready\":true}",
      actualJson: "{\"ready\":true}",
      pageTitle: "Ready",
    });
    expect(client.browserScreenshot).not.toHaveBeenCalled();
  });

  it("captures a screenshot when a browser expectation times out", async () => {
    const client = makeClient({
      browserEvaluate: vi.fn().mockResolvedValue({
        success: true,
        error: "",
        jsonValue: "false",
        pageTitle: "Still false",
        pageUrl: "https://example.test/",
      }),
    } as Partial<GuestAgentClient>);

    const result = await browserExpectWorkflow(client, "window.__ready", {
      timeoutMs: 100,
      pollIntervalMs: 50,
      screenshotOnFailure: true,
    });

    expect(result.success).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.actualJson).toBe("false");
    expect(result.screenshot).toMatchObject({ format: "png", width: 640, height: 480 });
    expect(client.browserScreenshot).toHaveBeenCalledWith({
      format: "png",
      fullPage: false,
      timeoutMs: 100,
    });
  });

  it("combines browser screenshots with optional page-state evaluation", async () => {
    const client = makeClient();

    const result = await browserSnapshotWorkflow(client, {
      expression: "document.title",
      format: "png",
      fullPage: true,
      timeoutMs: 5_000,
    });

    expect(client.browserScreenshot).toHaveBeenCalledWith({
      format: "png",
      fullPage: true,
      timeoutMs: 5_000,
    });
    expect(client.browserEvaluate).toHaveBeenCalledWith("document.title", 5_000);
    expect(result).toMatchObject({
      format: "png",
      width: 640,
      height: 480,
      bytes: 11,
      evaluation: {
        success: true,
        expression: "document.title",
        actualJson: "true",
      },
    });
  });
});
