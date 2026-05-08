import { describe, expect, it, vi } from "vitest";

import { isUiSidecarUnavailable, withUiSidecarRecovery } from "../guest/ui-recovery.js";
import type { GuestAgentClient } from "../guest/client.js";

describe("UI sidecar recovery", () => {
  it("recognizes sidecar connectivity failures", () => {
    expect(isUiSidecarUnavailable(new Error("connect UI sidecar at 127.0.0.1:50151"))).toBe(true);
    expect(isUiSidecarUnavailable(new Error("14 UNAVAILABLE: connection refused"))).toBe(true);
    expect(isUiSidecarUnavailable(new Error("element not found"))).toBe(false);
  });

  it("restarts the sidecar and retries once when recovery options include a username", async () => {
    const client = {
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
    } as unknown as GuestAgentClient;
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect UI sidecar at 127.0.0.1:50151"))
      .mockResolvedValueOnce("ok");

    await expect(
      withUiSidecarRecovery(
        client,
        { username: "test", engine: "powershell-helper", waitReadyMs: 7_000, timeoutMs: 8_000 },
        operation,
      ),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(client.runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-EncodedCommand", expect.any(String)]),
      { timeoutMs: 8_000, runAs: "SYSTEM", maxRetries: 1 },
    );
    const args = (client.runCommand as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const decoded = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("$username = 'test'");
    expect(decoded).toContain("$engine = 'powershell-helper'");
    expect(decoded).toContain("$waitReadyMs = 7000");
  });

  it("does not recover non-sidecar failures or calls without a username", async () => {
    const client = { runCommand: vi.fn() } as unknown as GuestAgentClient;

    await expect(
      withUiSidecarRecovery(client, { username: "test" }, async () => {
        throw new Error("element not found");
      }),
    ).rejects.toThrow("element not found");
    await expect(
      withUiSidecarRecovery(client, undefined, async () => {
        throw new Error("connect UI sidecar at 127.0.0.1:50151");
      }),
    ).rejects.toThrow("connect UI sidecar");
    expect(client.runCommand).not.toHaveBeenCalled();
  });
});
