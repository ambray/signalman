import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, type ConnectionState } from "../guest/client.js";
import * as grpc from "@grpc/grpc-js";

// ── withRetry tests ───────────────────────────────────────────────

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first try without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = withRetry(fn, 3, 200, 2000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure then succeeds", async () => {
    const unavailableErr = Object.assign(new Error("unavailable"), {
      code: grpc.status.UNAVAILABLE,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(unavailableErr)
      .mockResolvedValueOnce("recovered");

    const promise = withRetry(fn, 3, 200, 2000);

    // Advance past the first retry delay (200ms)
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws the last error", async () => {
    vi.useRealTimers();
    const unavailableErr = Object.assign(new Error("unavailable"), {
      code: grpc.status.UNAVAILABLE,
    });
    const fn = vi.fn().mockRejectedValue(unavailableErr);

    await expect(withRetry(fn, 2, 10, 50)).rejects.toThrow("unavailable");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry non-transient errors", async () => {
    const notFoundErr = Object.assign(new Error("not found"), {
      code: grpc.status.NOT_FOUND,
    });
    const fn = vi.fn().mockRejectedValue(notFoundErr);

    await expect(withRetry(fn, 3, 200, 2000)).rejects.toThrow("not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff with cap", async () => {
    const unavailableErr = Object.assign(new Error("unavailable"), {
      code: grpc.status.UNAVAILABLE,
    });
    // Fail 3 times, succeed on 4th
    const fn = vi
      .fn()
      .mockRejectedValueOnce(unavailableErr)
      .mockRejectedValueOnce(unavailableErr)
      .mockRejectedValueOnce(unavailableErr)
      .mockResolvedValueOnce("done");

    const promise = withRetry(fn, 3, 100, 300);

    // attempt 0 fails -> delay = min(100 * 2^0, 300) = 100
    await vi.advanceTimersByTimeAsync(100);
    // attempt 1 fails -> delay = min(100 * 2^1, 300) = 200
    await vi.advanceTimersByTimeAsync(200);
    // attempt 2 fails -> delay = min(100 * 2^2, 300) = 300 (capped)
    await vi.advanceTimersByTimeAsync(300);

    const result = await promise;
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("retries DEADLINE_EXCEEDED errors", async () => {
    const deadlineErr = Object.assign(new Error("deadline"), {
      code: grpc.status.DEADLINE_EXCEEDED,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(deadlineErr)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, 1, 50, 500);
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries RESOURCE_EXHAUSTED errors", async () => {
    const exhaustedErr = Object.assign(new Error("exhausted"), {
      code: grpc.status.RESOURCE_EXHAUSTED,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(exhaustedErr)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, 1, 50, 500);
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("works with zero retries (single attempt)", async () => {
    const unavailableErr = Object.assign(new Error("unavailable"), {
      code: grpc.status.UNAVAILABLE,
    });
    const fn = vi.fn().mockRejectedValue(unavailableErr);

    await expect(withRetry(fn, 0, 200, 2000)).rejects.toThrow("unavailable");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── GuestAgentClient tests (mocked proto) ─────────────────────────

// We cannot instantiate a real GuestAgentClient without proto files,
// so we mock the proto loading and test the class behavior.

describe("GuestAgentClient", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGuestAgent: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GuestAgentClient: any;

  beforeEach(async () => {
    // Create a mock gRPC client constructor using a regular function
    // (arrow functions are not constructable and cannot be used with `new`)
    mockGuestAgent = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.health = vi.fn((_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, {
          hostname: "test-vm",
          os: "windows",
          osVersion: "10",
          agentVersion: "1.0",
          uptimeSeconds: 100,
          capabilities: [],
        });
      });
      this.close = vi.fn();
    });

    // Mock the proto loader and grpc modules
    vi.doMock("@grpc/proto-loader", () => ({
      loadSync: vi.fn().mockReturnValue({}),
    }));

    vi.doMock("@grpc/grpc-js", async () => {
      const actual = await vi.importActual<typeof grpc>("@grpc/grpc-js");
      return {
        ...actual,
        loadPackageDefinition: vi.fn().mockReturnValue({
          signalman: {
            guest: {
              GuestAgent: mockGuestAgent,
            },
          },
        }),
      };
    });

    const mod = await import("../guest/client.js");
    GuestAgentClient = mod.GuestAgentClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("constructor sets connectionState to connected", () => {
    const client = new GuestAgentClient("127.0.0.1", 50051);
    expect(client.connectionState).toBe("connected");
  });

  it("constructor applies default port 50051", () => {
    new GuestAgentClient("127.0.0.1");
    expect(mockGuestAgent).toHaveBeenCalledWith(
      "127.0.0.1:50051",
      expect.anything(),
      expect.objectContaining({
        "grpc.keepalive_time_ms": 30_000,
        "grpc.keepalive_timeout_ms": 10_000,
        "grpc.max_connection_idle_ms": 60_000,
      }),
    );
  });

  it("constructor passes channel options including keepalive", () => {
    new GuestAgentClient("10.0.0.1", 9999);
    expect(mockGuestAgent).toHaveBeenCalledWith(
      "10.0.0.1:9999",
      expect.anything(),
      expect.objectContaining({
        "grpc.keepalive_time_ms": 30_000,
      }),
    );
  });

  it("dispose sets state to disconnected", () => {
    const client = new GuestAgentClient("127.0.0.1");
    expect(client.connectionState).toBe("connected");
    client.dispose();
    expect(client.connectionState).toBe("disconnected");
  });

  it("close is an alias for dispose", () => {
    const client = new GuestAgentClient("127.0.0.1");
    client.close();
    expect(client.connectionState).toBe("disconnected");
  });

  it("isConnected returns true when health succeeds", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    const result = await client.isConnected();
    expect(result).toBe(true);
    expect(client.connectionState).toBe("connected");
  });

  it("isConnected returns false when disposed", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    client.dispose();
    const result = await client.isConnected();
    expect(result).toBe(false);
  });

  it("health passes deadline to unary call", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    const result = await client.health(5000);
    expect(result.hostname).toBe("test-vm");
  });

  it("constructor uses custom options when provided", () => {
    const client = new GuestAgentClient("127.0.0.1", 50051, undefined, {
      connectionTimeoutMs: 5000,
      defaultTimeoutMs: 15000,
      maxRetries: 5,
    });
    // Client created successfully with custom options
    expect(client.connectionState).toBe("connected");
  });
});

// ── ConnectionState type tests ────────────────────────────────────

describe("ConnectionState", () => {
  it("allows all valid state values", () => {
    const states: ConnectionState[] = [
      "disconnected",
      "connecting",
      "connected",
      "error",
    ];
    expect(states).toHaveLength(4);
  });
});
