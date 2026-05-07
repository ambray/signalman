import { describe, expect, it, vi } from "vitest";
import {
  buildEnsureUiSidecarScript,
  ensureUiSidecar,
} from "../guest/ui-sidecar.js";

describe("UI sidecar scheduling", () => {
  it("builds an interactive scheduled task script", () => {
    const script = buildEnsureUiSidecarScript({
      username: "test",
      bind: "127.0.0.1:50151",
      taskName: "SignalmanUiSidecar",
      runNow: true,
    });

    expect(script).toContain("$username = 'test'");
    expect(script).toContain("New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive");
    expect(script).toContain("-RunLevel Limited");
    expect(script).toContain("--ui-sidecar --ui-sidecar-bind $bind");
    expect(script).toContain("Start-ScheduledTask -TaskName $taskName");
    expect(script).toContain("Wait-SignalmanSidecarReady -Bind $bind");
    expect(script).toContain("$waitReadyMs = 5000");
    expect(script).not.toContain("Password");
  });

  it("rejects non-loopback sidecar binds", () => {
    expect(() =>
      buildEnsureUiSidecarScript({
        username: "test",
        bind: "0.0.0.0:50151",
      }),
    ).toThrow("loopback");
  });

  it("runs the script through the guest agent as SYSTEM", async () => {
    const runCommand = vi.fn().mockResolvedValue({
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
    });
    const result = await ensureUiSidecar({ runCommand } as never, {
      username: "test",
      timeoutMs: 12_000,
    });

    expect(result.state).toBe("Running");
    expect(result.ready).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-EncodedCommand", expect.any(String)]),
      { timeoutMs: 12_000, runAs: "SYSTEM", maxRetries: 1 },
    );
    const args = runCommand.mock.calls[0][1] as string[];
    const encoded = args.at(-1) ?? "";
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("Register-ScheduledTask");
    expect(decoded).toContain("SignalmanGuest");
    expect(decoded).toContain("Test-SignalmanSidecarPort");
    expect(decoded).toContain("$waitReadyMs = 5000");
  });

  it("allows readiness waiting to be disabled", () => {
    const script = buildEnsureUiSidecarScript({
      username: "test",
      runNow: false,
      waitReadyMs: 0,
    });

    expect(script).toContain("$runNow = $false");
    expect(script).toContain("$waitReadyMs = 0");
  });

  it("surfaces guest command failures", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "no service",
      durationMs: 10,
    });

    await expect(
      ensureUiSidecar({ runCommand } as never, { username: "test" }),
    ).rejects.toThrow("no service");
  });
});
