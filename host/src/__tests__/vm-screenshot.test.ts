// WS6 Milestone 1 — dedicated unit test for the vm_screenshot tool.
//
// `vm_screenshot` is registered in the MCP advanced-tool array and is
// referenced by the scenarios runner (it post-processes screenshot
// outputs into the result envelope). However, the current
// implementation is a placeholder returning a fixed text response —
// "requires guest agent (not yet connected)". This file pins both
// facts so a future developer wiring in the real GuestAgent-backed
// implementation gets a clear test failure prompting them to update
// the pin alongside the implementation.
//
// What's NOT tested here:
// - end-to-end screenshot capture (no real guest agent in this lane)
// - scenarios/runner.ts post-processing (covered by orchestrator tests)
//
// What IS tested here:
// - the tool is registered in the createVmOperationTools list
// - the JSON Schema shape (name required, additionalProperties:false)
// - the current stub response format includes the VM name
// - the stub does NOT call into the backend (confirms placeholder-ness)

import { describe, it, expect } from "vitest";
import { createVmOperationTools } from "../tools/vm-operations.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";

describe("vm_screenshot tool", () => {
  // A backend resolver that throws if anyone calls it. vm_screenshot's
  // current stub should never reach the backend — if it ever does
  // (because someone wired in real impl), the throw will surface and
  // remind them to update this test alongside the change.
  const failBackend = (): Promise<HypervisorBackend> => {
    throw new Error(
      "vm_screenshot must not call the backend in its current stub form; if you wired in a real implementation, update this test",
    );
  };

  const tools = createVmOperationTools(failBackend);
  const screenshot = tools.find((t) => t.name === "vm_screenshot");

  it("is registered in createVmOperationTools()", () => {
    expect(screenshot).toBeDefined();
  });

  it("declares a JSON Schema with required `name` and additionalProperties:false", () => {
    if (!screenshot) throw new Error("vm_screenshot not registered");
    expect(screenshot.inputSchema.type).toBe("object");
    expect(screenshot.inputSchema.required).toEqual(["name"]);
    expect(screenshot.inputSchema.additionalProperties).toBe(false);
    expect(screenshot.inputSchema.properties).toMatchObject({
      name: { type: "string" },
    });
  });

  it("returns the placeholder response when invoked, including the VM name in the message", async () => {
    if (!screenshot) throw new Error("vm_screenshot not registered");
    const result = await screenshot.handler({ name: "endpoint-1" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("endpoint-1");
    // Pin the "not yet connected" marker — if it goes away, that's a
    // signal the real implementation landed.
    expect(result.content[0].text).toMatch(/not yet connected/i);
  });

  it("does not reach the backend resolver in its current stub form", async () => {
    // If this throws, the failBackend resolver fired — meaning
    // someone wired in a real implementation without updating this
    // test. Update the test (and add real coverage) when that
    // happens.
    if (!screenshot) throw new Error("vm_screenshot not registered");
    await expect(
      screenshot.handler({ name: "any-vm" }),
    ).resolves.toMatchObject({
      content: [{ type: "text" }],
    });
  });
});
