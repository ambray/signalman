import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => Buffer.from("")),
}));

vi.mock("node:child_process", () => childProcessMock);

function mockGetStatusPowerShell(info: {
  State: string;
  Uptime?: number;
  MemoryAssigned?: number;
  IPAddress?: string | null;
}) {
  childProcessMock.execFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, {
        stdout: JSON.stringify({
          Uptime: 12,
          MemoryAssigned: 2048,
          IPAddress: null,
          ...info,
        }),
        stderr: "",
      } as unknown as string, "");
    },
  );
}

async function loadBackend() {
  vi.resetModules();
  return await import("../hypervisors/hyperv.js");
}

beforeEach(() => {
  childProcessMock.execFile.mockReset();
  childProcessMock.execFileSync.mockReset();
  childProcessMock.execFileSync.mockReturnValue(Buffer.from(""));
});

describe("HyperVBackend.getStatus", () => {
  it("reports guestAgentReachable when the running VM health check succeeds", async () => {
    const { HyperVBackend } = await loadBackend();
    mockGetStatusPowerShell({
      State: "Running",
      IPAddress: "172.22.10.5",
    });
    const healthCheck = vi.fn().mockResolvedValue(true);

    const backend = new HyperVBackend({
      guestAgentPort: 50052,
      guestAgentTls: { caPath: "ca.pem", certPath: "client.pem", keyPath: "client.key" },
      guestAgentAuthToken: "token-1",
      guestAgentHealthTimeoutMs: 750,
      guestAgentHealthCheck: healthCheck,
    });

    const status = await backend.getStatus({
      id: "vm-1",
      name: "endpoint-1",
      backend: "hyperv",
    });

    expect(status.guestAgentReachable).toBe(true);
    expect(healthCheck).toHaveBeenCalledWith(
      "172.22.10.5",
      50052,
      { caPath: "ca.pem", certPath: "client.pem", keyPath: "client.key" },
      "token-1",
      750,
    );
  });

  it("does not probe the guest agent when the VM is stopped", async () => {
    const { HyperVBackend } = await loadBackend();
    mockGetStatusPowerShell({
      State: "Off",
      IPAddress: "172.22.10.5",
    });
    const healthCheck = vi.fn().mockResolvedValue(true);

    const backend = new HyperVBackend({ guestAgentHealthCheck: healthCheck });
    const status = await backend.getStatus({
      id: "vm-1",
      name: "endpoint-1",
      backend: "hyperv",
    });

    expect(status.state).toBe("stopped");
    expect(status.guestAgentReachable).toBe(false);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("treats health-check errors as not reachable", async () => {
    const { HyperVBackend } = await loadBackend();
    mockGetStatusPowerShell({
      State: "Running",
      IPAddress: "172.22.10.5",
    });
    const healthCheck = vi.fn().mockRejectedValue(new Error("connection refused"));

    const backend = new HyperVBackend({ guestAgentHealthCheck: healthCheck });
    const status = await backend.getStatus({
      id: "vm-1",
      name: "endpoint-1",
      backend: "hyperv",
    });

    expect(status.guestAgentReachable).toBe(false);
  });
});
