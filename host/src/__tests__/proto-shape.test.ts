/**
 * Tests for the v1 proto-shape contract (P8 — proto freeze).
 *
 * These tests pin the platform_details oneof and convenience accessors
 * exposed in `host/src/guest/client.ts`. They do NOT exercise the gRPC
 * wire (that's P7's contract test); they validate the TypeScript
 * interface shape and the helper functions that unwrap the oneof for
 * Windows-only call sites.
 *
 * Why this matters at fleet scale: when Linux/macOS guest agents ship,
 * the same `loom.signalman.run` invocation will return ProcessInfo with
 * `platformDetails.linux` / `platformDetails.macos` instead of
 * `platformDetails.windows`. Helpers like `getWindowsProcessDetails`
 * must return `undefined` cleanly in that case so scenario authors
 * don't accidentally treat zero-defaulted Windows fields as real
 * evidence. These tests pin that contract.
 */

import { describe, it, expect } from "vitest";

import {
  getWindowsProcessDetails,
  type ProcessInfo,
} from "../guest/client.js";

describe("ProcessInfo platform_details oneof (P8)", () => {
  it("getWindowsProcessDetails returns the Windows variant when present", () => {
    const info: ProcessInfo = {
      pid: 1234,
      name: "explorer.exe",
      path: "C:\\Windows\\explorer.exe",
      commandLine: "explorer.exe",
      memoryBytes: 100_000_000,
      cpuPercent: 1.5,
      user: "Aaron",
      platformDetails: {
        windows: {
          isAppcontainer: true,
          appcontainerSid: "S-1-15-2-...",
          isLowIntegrity: false,
          isInJob: true,
        },
      },
    };
    const win = getWindowsProcessDetails(info);
    expect(win).toBeDefined();
    expect(win!.isAppcontainer).toBe(true);
    expect(win!.appcontainerSid).toBe("S-1-15-2-...");
    expect(win!.isInJob).toBe(true);
  });

  it("getWindowsProcessDetails returns undefined for a Linux-guest ProcessInfo", () => {
    // Future Linux guest agents fill platformDetails.linux instead.
    // The Windows accessor MUST return undefined so scenario authors
    // don't treat absence of Windows evidence as "not in AppContainer".
    const info: ProcessInfo = {
      pid: 1234,
      name: "bash",
      path: "/usr/bin/bash",
      commandLine: "bash",
      memoryBytes: 5_000_000,
      cpuPercent: 0.1,
      user: "aaron",
      platformDetails: {
        linux: {},
      },
    };
    expect(getWindowsProcessDetails(info)).toBeUndefined();
  });

  it("getWindowsProcessDetails returns undefined when platformDetails is absent entirely", () => {
    // Older guests / smoke tests / mocked shapes may omit the oneof.
    // The accessor must not throw or return zero-defaulted shapes.
    const info: ProcessInfo = {
      pid: 1,
      name: "init",
      path: "",
      commandLine: "",
      memoryBytes: 0,
      cpuPercent: 0,
      user: "",
    };
    expect(getWindowsProcessDetails(info)).toBeUndefined();
  });
});

describe("Forward-compat: future variants do not break Windows-only readers", () => {
  it("a ProcessInfo with linux variant + windows accessor returns undefined cleanly", () => {
    // Simulates what a multi-platform fleet looks like: 30 Windows
    // VMs and 10 Linux VMs in the same scenario. The Windows accessor
    // must short-circuit on Linux entries without throwing.
    const fleet: ProcessInfo[] = [
      {
        pid: 1,
        name: "w",
        path: "",
        commandLine: "",
        memoryBytes: 0,
        cpuPercent: 0,
        user: "",
        platformDetails: {
          windows: {
            isAppcontainer: true,
            appcontainerSid: "",
            isLowIntegrity: false,
            isInJob: false,
          },
        },
      },
      {
        pid: 2,
        name: "l",
        path: "",
        commandLine: "",
        memoryBytes: 0,
        cpuPercent: 0,
        user: "",
        platformDetails: { linux: {} },
      },
    ];
    const windowsOnly = fleet.filter(
      (p) => getWindowsProcessDetails(p)?.isAppcontainer === true,
    );
    expect(windowsOnly).toHaveLength(1);
    expect(windowsOnly[0].pid).toBe(1);
  });
});
