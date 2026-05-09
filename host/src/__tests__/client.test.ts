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
      this.readFile = vi.fn((_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, { data: Buffer.from("hello"), truncated: false });
      });
      this.writeFile = vi.fn((req: { data?: Buffer }, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, { bytesWritten: req.data?.length ?? 0 });
      });
      this.listDirectory = vi.fn((_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, {
          entries: [
            { name: "hello.txt", size: 5, isDir: false, modifiedUnixSecs: 1 },
          ],
        });
      });
      this.uIScreenshot = vi.fn((_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, {
          imageData: Buffer.from("png"),
          format: "png",
          width: 10,
          height: 20,
          durationMs: 11,
        });
      });
      this.uIFind = vi.fn((_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, {
          durationMs: 12,
          elements: [
            {
              name: "Save",
              automationId: "save-button",
              controlType: "ControlType.Button",
              className: "Button",
              isEnabled: true,
              isVisible: true,
              x: 1,
              y: 2,
              width: 3,
              height: 4,
              value: "",
            },
          ],
        });
      });
      this.uIHealth = vi.fn((_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
        cb(null, {
          sidecarReachable: true,
          engine: "powershell-process",
          pid: 123,
          uptimeMs: 456,
          error: "",
          durationMs: 16,
        });
      });
      this.uIClick = vi.fn(
        (_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
          cb(null, { success: true, error: "", durationMs: 13 });
        },
      );
      this.uIKey = vi.fn(
        (_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
          cb(null, { success: true, error: "", durationMs: 14 });
        },
      );
      this.uIType = vi.fn(
        (_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
          cb(null, { success: true, error: "", durationMs: 15 });
        },
      );
      this.browserNavigate = vi.fn(
        (_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
          cb(null, {
            success: true,
            error: "",
            pageTitle: "Example",
            pageUrl: "https://example.test/",
          });
        },
      );
      this.browserClick = vi.fn(
        (_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
          cb(null, {
            success: true,
            error: "",
            pageTitle: "Clicked",
            pageUrl: "https://example.test/clicked",
          });
        },
      );
      this.browserScreenshot = vi.fn(
        (_req: unknown, _opts: unknown, cb: (err: null, res: object) => void) => {
          cb(null, {
            imageData: Buffer.from("browser-png"),
            format: "png",
            width: 640,
            height: 480,
          });
        },
      );
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

  it("reads, writes, and lists files through guest file RPCs", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    await expect(client.readFile("/tmp/hello.txt")).resolves.toEqual(Buffer.from("hello"));
    await expect(client.readFileChunk("/tmp/hello.txt")).resolves.toEqual({
      data: Buffer.from("hello"),
      truncated: false,
    });
    await expect(client.writeFile("/tmp/hello.txt", "hello")).resolves.toEqual({
      bytesWritten: 5,
    });
    await expect(client.listDirectory("/tmp")).resolves.toEqual([
      { name: "hello.txt", size: 5, isDir: false, modifiedUnixSecs: 1 },
    ]);
  });

  it("routes UI automation RPCs through the guest agent", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    await expect(client.uiScreenshot()).resolves.toEqual({
      imageData: Buffer.from("png"),
      format: "png",
      width: 10,
      height: 20,
      durationMs: 11,
    });
    await expect(client.uiFind("[name='Save']")).resolves.toHaveLength(1);
    await expect(client.uiFindDetailed("[name='Save']")).resolves.toMatchObject({
      durationMs: 12,
      elements: [expect.objectContaining({ name: "Save" })],
    });
    await expect(client.uiHealth()).resolves.toEqual({
      sidecarReachable: true,
      engine: "powershell-process",
      pid: 123,
      uptimeMs: 456,
      error: "",
      durationMs: 16,
    });
    await expect(client.uiClick("[name='Save']")).resolves.toEqual({
      success: true,
      error: "",
      durationMs: 13,
    });
    await expect(client.uiKey("{ENTER}", { selector: "[name='Save']" })).resolves.toEqual({
      success: true,
      error: "",
      durationMs: 14,
    });
    await expect(client.uiType("hello", { selector: "[automationId='input']" })).resolves.toEqual({
      success: true,
      error: "",
      durationMs: 15,
    });
  });

  it("routes browser automation RPCs through the guest agent", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    await expect(client.browserNavigate("https://example.test/", 5_000)).resolves.toEqual({
      success: true,
      error: "",
      pageTitle: "Example",
      pageUrl: "https://example.test/",
    });
    await expect(client.browserClick("#continue", 5_000)).resolves.toEqual({
      success: true,
      error: "",
      pageTitle: "Clicked",
      pageUrl: "https://example.test/clicked",
    });
    await expect(client.browserScreenshot({ format: "png", fullPage: true })).resolves.toEqual({
      imageData: Buffer.from("browser-png"),
      format: "png",
      width: 640,
      height: 480,
    });
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

// ── parseEndpoint tests ───────────────────────────────────────────

describe("parseEndpoint", () => {
  // Import lazily because the existing GuestAgentClient suite uses
  // vi.doMock and we want to test the real (unmocked) helper.
  it("treats bare host as host:default-port without TLS", async () => {
    const { parseEndpoint } = await import("../guest/client.js");
    expect(parseEndpoint("172.30.0.10", 50051)).toEqual({
      target: "172.30.0.10:50051",
      tls: false,
    });
  });

  it("preserves explicit host:port and reports no TLS", async () => {
    const { parseEndpoint } = await import("../guest/client.js");
    expect(parseEndpoint("vm.local:51234", 50051)).toEqual({
      target: "vm.local:51234",
      tls: false,
    });
  });

  it("flags https:// URL as TLS", async () => {
    const { parseEndpoint } = await import("../guest/client.js");
    expect(parseEndpoint("https://vm.local:50051", 9000)).toEqual({
      target: "vm.local:50051",
      tls: true,
    });
  });

  it("flags grpcs:// URL as TLS", async () => {
    const { parseEndpoint } = await import("../guest/client.js");
    expect(parseEndpoint("grpcs://vm.local:50051", 9000)).toEqual({
      target: "vm.local:50051",
      tls: true,
    });
  });

  it("treats http:// URL as plaintext", async () => {
    const { parseEndpoint } = await import("../guest/client.js");
    expect(parseEndpoint("http://vm.local:50051", 9000)).toEqual({
      target: "vm.local:50051",
      tls: false,
    });
  });

  it("falls back to default port when URL omits one", async () => {
    const { parseEndpoint } = await import("../guest/client.js");
    expect(parseEndpoint("http://vm.local", 9000)).toEqual({
      target: "vm.local:9000",
      tls: false,
    });
  });
});

// ── mTLS option handling ──────────────────────────────────────────

describe("GuestAgentClient TLS handling", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGuestAgent: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GuestAgentClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createSslSpy: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();

    mockGuestAgent = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.health = vi.fn();
      this.close = vi.fn();
    });

    createSslSpy = vi.fn().mockReturnValue("ssl-creds");

    vi.doMock("@grpc/proto-loader", () => ({
      loadSync: vi.fn().mockReturnValue({}),
    }));

    vi.doMock("@grpc/grpc-js", async () => {
      const actual = await vi.importActual<typeof grpc>("@grpc/grpc-js");
      return {
        ...actual,
        loadPackageDefinition: vi.fn().mockReturnValue({
          signalman: { guest: { GuestAgent: mockGuestAgent } },
        }),
        credentials: {
          ...actual.credentials,
          createSsl: createSslSpy,
          createInsecure: vi.fn().mockReturnValue("insecure-creds"),
        },
      };
    });

    // Mock fs.readFileSync so the test does not need real cert files.
    vi.doMock("node:fs", () => ({
      default: {
        readFileSync: vi.fn((p: string) => Buffer.from(`pem-for-${p}`)),
      },
      readFileSync: vi.fn((p: string) => Buffer.from(`pem-for-${p}`)),
    }));

    const mod = await import("../guest/client.js");
    GuestAgentClient = mod.GuestAgentClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("node:fs");
  });

  it("uses insecure credentials when no TLS configured", () => {
    new GuestAgentClient("127.0.0.1", 50051);
    expect(createSslSpy).not.toHaveBeenCalled();
  });

  it("uses Ssl credentials when caPath is provided", () => {
    new GuestAgentClient("127.0.0.1", 50051, { caPath: "/etc/signalman/ca.pem" });
    expect(createSslSpy).toHaveBeenCalledTimes(1);
    const args = createSslSpy.mock.calls[0];
    expect(args[0]).toEqual(Buffer.from("pem-for-/etc/signalman/ca.pem"));
    // No client identity supplied -> args[1] (key) and args[2] (cert) are null.
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
  });

  it("uses Ssl credentials with client identity for full mTLS", () => {
    new GuestAgentClient("127.0.0.1", 50051, {
      caPath: "/ca.pem",
      certPath: "/host.pem",
      keyPath: "/host.key",
    });
    expect(createSslSpy).toHaveBeenCalledTimes(1);
    const args = createSslSpy.mock.calls[0];
    expect(args[0]).toEqual(Buffer.from("pem-for-/ca.pem"));
    expect(args[1]).toEqual(Buffer.from("pem-for-/host.key"));
    expect(args[2]).toEqual(Buffer.from("pem-for-/host.pem"));
  });

  it("rejects partial mTLS identity (cert without key)", () => {
    expect(() => {
      new GuestAgentClient("127.0.0.1", 50051, {
        caPath: "/ca.pem",
        certPath: "/host.pem",
      });
    }).toThrow(/certPath and keyPath/);
  });

  it("rejects partial mTLS identity (key without cert)", () => {
    expect(() => {
      new GuestAgentClient("127.0.0.1", 50051, {
        caPath: "/ca.pem",
        keyPath: "/host.key",
      });
    }).toThrow(/certPath and keyPath/);
  });

  it("auto-enables TLS for https:// URLs", () => {
    new GuestAgentClient("https://vm.local:50051");
    expect(createSslSpy).toHaveBeenCalledTimes(1);
    // No tlsOptions => CA arg is null (system roots).
    expect(createSslSpy.mock.calls[0][0]).toBeNull();
  });

  it("https:// URL strips scheme from gRPC target", () => {
    new GuestAgentClient("https://172.30.0.10:50051");
    expect(mockGuestAgent).toHaveBeenCalledWith(
      "172.30.0.10:50051",
      expect.anything(),
      expect.any(Object),
    );
  });
});

// ── Channel recovery (Sprint 60.12 Phase B) ──────────────────────
//
// Sub-suite covers the consecutive-failure → channel-rebuild contract.
// `runCommand` is the only RPC wrapper currently wired into the
// counter; other wrappers can opt in incrementally as we observe their
// failure patterns.

describe("GuestAgentClient channel recovery", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGuestAgent: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GuestAgentClient: any;
  let constructorCallCount: number;

  // Re-init mocks per test so every `new GuestAgentClient` increments
  // a fresh counter and we can assert on rebuild behaviour cleanly.
  beforeEach(async () => {
    constructorCallCount = 0;
    mockGuestAgent = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      constructorCallCount += 1;
      this.runCommand = vi.fn();
      this.health = vi.fn();
      this.close = vi.fn();
    });

    vi.doMock("@grpc/proto-loader", () => ({
      loadSync: vi.fn().mockReturnValue({}),
    }));
    vi.doMock("@grpc/grpc-js", async () => {
      const actual = await vi.importActual<typeof grpc>("@grpc/grpc-js");
      return {
        ...actual,
        loadPackageDefinition: vi.fn().mockReturnValue({
          signalman: { guest: { GuestAgent: mockGuestAgent } },
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

  it("consecutiveFailures defaults to 0 on a fresh client", () => {
    const client = new GuestAgentClient("127.0.0.1");
    expect(client.consecutiveFailures).toBe(0);
  });

  it("target getter exposes the host:port pair", () => {
    const client = new GuestAgentClient("172.30.0.10", 50051);
    expect(client.target).toBe("172.30.0.10:50051");
  });

  it("recoverChannel rebuilds the gRPC client and resets the counter", () => {
    const client = new GuestAgentClient("127.0.0.1");
    expect(constructorCallCount).toBe(1);
    client.recoverChannel();
    expect(constructorCallCount).toBe(2);
    expect(client.consecutiveFailures).toBe(0);
  });

  it("successful runCommand resets consecutiveFailures", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    // Stub runCommand on the underlying gRPC client to succeed.
    (client as { client: { runCommand: unknown } }).client.runCommand = (
      _req: unknown,
      _opts: unknown,
      cb: (err: null, res: object) => void,
    ) => {
      cb(null, { exitCode: 0, stdout: "", stderr: "", durationMs: 0 });
    };

    // Inject a fake failure count first.
    (client as { _consecutiveFailures: number })._consecutiveFailures = 2;
    await client.runCommand("echo");
    expect(client.consecutiveFailures).toBe(0);
  });

  it("3 consecutive UNAVAILABLE failures auto-recover the channel", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    expect(constructorCallCount).toBe(1);
    const unavailable = Object.assign(new Error("unavailable"), {
      code: grpc.status.UNAVAILABLE,
    });

    // Stub runCommand to always fail with UNAVAILABLE. Underlying gRPC
    // mock honours each invocation (no internal retry loop on the
    // mock side).
    (client as { client: { runCommand: unknown } }).client.runCommand = (
      _req: unknown,
      _opts: unknown,
      cb: (err: unknown) => void,
    ) => {
      cb(unavailable);
    };

    // maxRetries: 0 → no internal retries on each runCommand call, so
    // each call surfaces exactly one transient failure to the counter.
    for (let i = 0; i < 3; i += 1) {
      await expect(client.runCommand("x", [], { maxRetries: 0 })).rejects.toBe(
        unavailable,
      );
    }

    // 3 failures → recovery triggered → channel rebuilt → counter reset.
    expect(constructorCallCount).toBe(2);
    expect(client.consecutiveFailures).toBe(0);
  });

  it("non-transient errors don't bump the failure counter", async () => {
    const client = new GuestAgentClient("127.0.0.1");
    const notFound = Object.assign(new Error("not found"), {
      code: grpc.status.NOT_FOUND,
    });
    (client as { client: { runCommand: unknown } }).client.runCommand = (
      _req: unknown,
      _opts: unknown,
      cb: (err: unknown) => void,
    ) => {
      cb(notFound);
    };

    for (let i = 0; i < 5; i += 1) {
      await expect(client.runCommand("x", [], { maxRetries: 0 })).rejects.toBe(
        notFound,
      );
    }

    // Application-level errors are not channel poisoning — counter stays 0,
    // channel stays unchanged.
    expect(constructorCallCount).toBe(1);
    expect(client.consecutiveFailures).toBe(0);
  });

  // ── REGRESSION: gRPC channel poisoning (the 16-min hang) ──────
  //
  // Field bug:
  //   example-agent-driver-e2e Sprint 60.12 Phase B run
  //   Step-0 (`Get-Service ExampleAgent`) consistently degraded into
  //   15-second timeouts after the file-transfer phase tripped on a
  //   single bad chunk. The guest agent itself was healthy and
  //   responsive on a fresh client; only the long-lived `setupClient`
  //   was poisoned. The original failure mode was a 16-minute hang
  //   while every subsequent RPC waited on a stuck queue head.
  //
  // Contract under test:
  //   3 consecutive transient failures must rebuild the channel
  //   *automatically*, without operator intervention. After the
  //   rebuild, the next RPC starts with a fresh counter on a fresh
  //   socket — there is no carry-over from the old channel state.
  it("REGRESSION: poisoned channel auto-recovers after 3 transient failures", async () => {
    const client = new GuestAgentClient("172.30.0.10", 50051);
    expect(constructorCallCount).toBe(1);
    const poisoned = Object.assign(new Error("DEADLINE_EXCEEDED"), {
      code: grpc.status.DEADLINE_EXCEEDED,
    });

    let onRunCommand: (cb: (err: unknown, res?: object) => void) => void = (cb) =>
      cb(poisoned);
    (client as { client: { runCommand: unknown } }).client.runCommand = (
      _req: unknown,
      _opts: unknown,
      cb: (err: unknown, res?: object) => void,
    ) => {
      onRunCommand(cb);
    };

    // 3 failures back-to-back trigger the rebuild on the third.
    for (let i = 0; i < 3; i += 1) {
      await expect(client.runCommand("Get-Service ExampleAgent", [], { maxRetries: 0 })).rejects.toBe(
        poisoned,
      );
    }
    expect(constructorCallCount).toBe(2);
    expect(client.consecutiveFailures).toBe(0);

    // After the rebuild, the *new* underlying client must be wired
    // to a working stub for the next call to succeed. (recoverChannel
    // calls the gRPC constructor again, which re-runs our mock impl
    // and creates a fresh runCommand on the new instance — patch
    // that to succeed.)
    (client as { client: { runCommand: unknown } }).client.runCommand = (
      _req: unknown,
      _opts: unknown,
      cb: (err: null, res: object) => void,
    ) => cb(null, { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });

    onRunCommand = (cb) => cb(null, { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    const result = await client.runCommand("Get-Service ExampleAgent", []);
    expect(result.exitCode).toBe(0);
    // Counter stays at 0 because the call succeeded against the fresh
    // channel; no carry-over from the pre-rebuild failures.
    expect(client.consecutiveFailures).toBe(0);
  });
});
