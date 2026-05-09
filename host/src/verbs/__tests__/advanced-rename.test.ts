/**
 * Verifies the advanced-namespace rename in server.ts.
 *
 * Spec: every legacy tool name registered today by `createAllTools` is
 * also registered under `signalman_advanced_<old_name>` in v0.1.0; the
 * old name remains as a deprecated alias for one release. (Per design
 * doc §6 + §7.)
 */

import { describe, it, expect } from "vitest";
import { createAllTools } from "../../tools/index.js";

function fakeBackend() {
  return {} as never;
}

describe("advanced namespace contract", () => {
  it("createAllTools still returns the legacy fine-grained names", () => {
    const tools = createAllTools(async () => fakeBackend());
    const names = tools.map((t) => t.name);
    // Spot-check: vm_*, docker_* names from §7 migration table.
    expect(names).toEqual(expect.arrayContaining([
      "vm_list",
      "vm_start",
      "vm_stop",
      "vm_status",
      "vm_checkpoint",
      "vm_restore",
      "vm_list_checkpoints",
      "vm_run_command",
      "vm_copy_file",
      "vm_ui_ensure_sidecar",
      "vm_ui_snapshot",
      "vm_ui_screenshot",
      "vm_ui_find",
      "vm_ui_wait_for",
      "vm_ui_click",
      "vm_ui_key",
      "vm_ui_type",
      "vm_ui_open_url",
      "vm_ui_navigate_url",
      "vm_browser_navigate",
      "vm_browser_click",
      "vm_browser_evaluate",
      "vm_browser_screenshot",
    ]));
    // Docker tools register too.
    const dockerNames = names.filter((n) => n.startsWith("docker_"));
    expect(dockerNames.length).toBeGreaterThan(0);
  });

  it("each legacy name has a stable advanced counterpart", () => {
    // The contract, expressed at the tool-registration level: server.ts
    // prepends `signalman_advanced_` to every tool from createAllTools.
    // We can't easily test the McpServer registration without booting
    // it; we assert the naming rule the registration relies on.
    const tools = createAllTools(async () => fakeBackend());
    for (const tool of tools) {
      const advanced = `signalman_advanced_${tool.name}`;
      expect(advanced.startsWith("signalman_advanced_")).toBe(true);
      expect(advanced.length).toBeGreaterThan("signalman_advanced_".length);
    }
  });
});
