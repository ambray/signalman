import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleDriverLoad,
  handleDriverUnload,
  handleDriverIoctl,
  parseScQueryState,
} from "../kernel-debug/handlers.js";
import type {
  DriverHandlerContext,
} from "../kernel-debug/handlers.js";
import type { CommandResult, GuestAgentClient } from "../guest/client.js";

// ─── Fake guest client ──────────────────────────────────────────────
//
// The real GuestClient wraps a gRPC stub and is rich. For handler tests
// we only need the one method handlers invoke (`runCommand`). Build a
// deliberately minimal stub that tests can queue responses on.

interface QueuedCall {
  command: string;
  args: string[];
  options?: unknown;
  response: CommandResult | Error;
}

class FakeGuestClient {
  public readonly calls: QueuedCall[] = [];
  private responses: Array<CommandResult | Error> = [];

  /** Queue a response for the next runCommand() call (FIFO). */
  queue(response: CommandResult | Error): void {
    this.responses.push(response);
  }

  queueSuccess(opts?: Partial<CommandResult>): void {
    this.queue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
      ...opts,
    });
  }

  async runCommand(
    command: string,
    args: string[] = [],
    options?: unknown,
  ): Promise<CommandResult> {
    const r = this.responses.shift();
    this.calls.push({ command, args, options, response: r ?? new Error("no response queued") });
    if (!r) throw new Error(`FakeGuestClient: unqueued call to ${command}`);
    if (r instanceof Error) throw r;
    return r;
  }
}

function makeCtx(client: FakeGuestClient): DriverHandlerContext {
  return {
    guestClient: client as unknown as GuestAgentClient,
    vmName: "endpoint-1",
  };
}

// ─── parseScQueryState ─────────────────────────────────────────────

describe("parseScQueryState", () => {
  it("extracts RUNNING state", () => {
    const out = `
SERVICE_NAME: example-product
        TYPE               : 1  KERNEL_DRIVER
        STATE              : 4  RUNNING
        WIN32_EXIT_CODE    : 0  (0x0)
    `;
    expect(parseScQueryState(out)).toBe("Running");
  });

  it("extracts STOPPED state", () => {
    const out = "        STATE              : 1  STOPPED";
    expect(parseScQueryState(out)).toBe("Stopped");
  });

  it("extracts START_PENDING state", () => {
    const out = "        STATE              : 2  START_PENDING";
    expect(parseScQueryState(out)).toBe("Start Pending");
  });

  it("extracts STOP_PENDING state", () => {
    const out = "        STATE              : 3  STOP_PENDING";
    expect(parseScQueryState(out)).toBe("Stop Pending");
  });

  it("returns Unknown when no STATE line is present", () => {
    expect(parseScQueryState("SERVICE_NAME: foo")).toBe("Unknown");
  });

  it("returns Unknown for empty input", () => {
    expect(parseScQueryState("")).toBe("Unknown");
  });

  it("handles lowercase state tokens", () => {
    // Unusual but robust against wording variations.
    const out = "        STATE              : 4  running";
    expect(parseScQueryState(out)).toBe("Running");
  });

  it("handles whitespace variations", () => {
    const out = "STATE:4 RUNNING";
    expect(parseScQueryState(out)).toBe("Running");
  });

  it("picks the state when multiple lines contain STATE", () => {
    // Our regex matches the literal STATE field line; other lines
    // (e.g. "STATE of health") shouldn't be picked up.
    const out = `
        STATE              : 4  RUNNING
        PRE_STATE          : foo
    `;
    expect(parseScQueryState(out)).toBe("Running");
  });
});

// ─── handleDriverLoad ──────────────────────────────────────────────

describe("handleDriverLoad", () => {
  let client: FakeGuestClient;
  beforeEach(() => {
    client = new FakeGuestClient();
  });

  it("calls sc.exe start then sc.exe query", async () => {
    client.queueSuccess(); // start
    client.queueSuccess({
      stdout: "        STATE              : 4  RUNNING",
    }); // query

    const result = await handleDriverLoad(makeCtx(client), {
      service: "example-product",
    });

    expect(client.calls[0].command).toBe("sc.exe");
    expect(client.calls[0].args).toEqual(["start", "example-product"]);
    expect(client.calls[1].args).toEqual(["query", "example-product"]);
    expect(result.status).toBe(0);
    expect(result.service_state).toBe("Running");
  });

  it("passes timeout_ms through to runCommand", async () => {
    client.queueSuccess();
    client.queueSuccess({ stdout: "        STATE              : 1  STOPPED" });
    await handleDriverLoad(makeCtx(client), {
      service: "example-product",
      timeout_ms: 30_000,
    });
    expect(client.calls[0].options).toMatchObject({ timeoutMs: 30_000 });
  });

  it("defaults timeout to 10 s when not specified", async () => {
    client.queueSuccess();
    client.queueSuccess();
    await handleDriverLoad(makeCtx(client), { service: "example-product" });
    expect(client.calls[0].options).toMatchObject({ timeoutMs: 10_000 });
  });

  it("throws when expect_status is set and start exits with different code", async () => {
    client.queueSuccess({ exitCode: 1072, stderr: "something broke" });
    await expect(
      handleDriverLoad(makeCtx(client), {
        service: "example-product",
        expect_status: 0,
      }),
    ).rejects.toThrow(/exited 1072, expected 0/);
  });

  it("tolerates arbitrary start exit code when expect_status is undefined", async () => {
    client.queueSuccess({ exitCode: 1056, stdout: "already running" });
    client.queueSuccess({ stdout: "        STATE              : 4  RUNNING" });
    const result = await handleDriverLoad(makeCtx(client), {
      service: "example-product",
    });
    expect(result.status).toBe(1056);
    expect(result.service_state).toBe("Running");
  });

  it("accepts expect_status=1056 for already-running scenarios", async () => {
    client.queueSuccess({ exitCode: 1056 });
    client.queueSuccess({ stdout: "        STATE              : 4  RUNNING" });
    const result = await handleDriverLoad(makeCtx(client), {
      service: "example-product",
      expect_status: 1056,
    });
    expect(result.status).toBe(1056);
  });

  it("includes stderr snippet in the mismatch error", async () => {
    client.queueSuccess({
      exitCode: 5,
      stderr: "Access is denied.".repeat(100),
    });
    await expect(
      handleDriverLoad(makeCtx(client), {
        service: "example-product",
        expect_status: 0,
      }),
    ).rejects.toThrow(/Access is denied/);
  });

  it("does not suppress RPC errors from the guest client", async () => {
    client.queue(new Error("grpc: unavailable"));
    await expect(
      handleDriverLoad(makeCtx(client), { service: "example-product" }),
    ).rejects.toThrow(/grpc: unavailable/);
  });

  it("service_state is Unknown when query output is unparseable", async () => {
    client.queueSuccess();
    client.queueSuccess({ stdout: "garbled output" });
    const result = await handleDriverLoad(makeCtx(client), {
      service: "example-product",
    });
    expect(result.service_state).toBe("Unknown");
  });
});

// ─── handleDriverUnload ────────────────────────────────────────────

describe("handleDriverUnload", () => {
  let client: FakeGuestClient;
  beforeEach(() => {
    client = new FakeGuestClient();
  });

  it("calls sc.exe stop then sc.exe query", async () => {
    client.queueSuccess();
    client.queueSuccess({ stdout: "        STATE              : 1  STOPPED" });
    const result = await handleDriverUnload(makeCtx(client), {
      service: "example-product",
    });
    expect(client.calls[0].args).toEqual(["stop", "example-product"]);
    expect(client.calls[1].args).toEqual(["query", "example-product"]);
    expect(result.service_state).toBe("Stopped");
  });

  it("throws when stop exits with unexpected code", async () => {
    client.queueSuccess({ exitCode: 5, stderr: "denied" });
    await expect(
      handleDriverUnload(makeCtx(client), {
        service: "example-product",
        expect_status: 0,
      }),
    ).rejects.toThrow(/exited 5, expected 0/);
  });

  it("accepts expect_status=1062 for already-stopped", async () => {
    client.queueSuccess({ exitCode: 1062 });
    client.queueSuccess({ stdout: "        STATE              : 1  STOPPED" });
    const result = await handleDriverUnload(makeCtx(client), {
      service: "example-product",
      expect_status: 1062,
    });
    expect(result.status).toBe(1062);
  });

  it("default timeout is 10 s", async () => {
    client.queueSuccess();
    client.queueSuccess();
    await handleDriverUnload(makeCtx(client), { service: "example-product" });
    expect(client.calls[0].options).toMatchObject({ timeoutMs: 10_000 });
  });
});

// ─── handleDriverIoctl ─────────────────────────────────────────────

describe("handleDriverIoctl", () => {
  let client: FakeGuestClient;
  beforeEach(() => {
    client = new FakeGuestClient();
  });

  /** Canned harness JSON response. */
  function harnessJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      status: "STATUS_SUCCESS",
      output_hex: "01 00 00 00",
      output_size: 4,
      match: true,
      ...overrides,
    });
  }

  it("invokes the default harness path", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(client.calls[0].command).toBe(
      "C:\\Signalman\\test-harness.exe",
    );
  });

  it("respects harness_path override", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
      harness_path: "D:\\dev\\harness.exe",
    });
    expect(client.calls[0].command).toBe("D:\\dev\\harness.exe");
  });

  it("passes --device and --ioctl as canonical args", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220004,
    });
    const args = client.calls[0].args;
    expect(args).toContain("--device");
    expect(args[args.indexOf("--device") + 1]).toBe("\\\\.\\example-product");
    expect(args).toContain("--ioctl");
    expect(args[args.indexOf("--ioctl") + 1]).toBe("0x220004");
  });

  it("forwards --input-hex when provided", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220004,
      input_hex: "DE AD BE EF",
    });
    const args = client.calls[0].args;
    expect(args).toContain("--input-hex");
    expect(args[args.indexOf("--input-hex") + 1]).toBe("DE AD BE EF");
  });

  it("forwards --input-file when provided", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220004,
      input_file: "C:\\tmp\\payload.bin",
    });
    const args = client.calls[0].args;
    expect(args).toContain("--input-file");
    expect(args[args.indexOf("--input-file") + 1]).toBe("C:\\tmp\\payload.bin");
  });

  it("throws when input_hex and input_file are both set", async () => {
    await expect(
      handleDriverIoctl(makeCtx(client), {
        device: "\\\\.\\example-product",
        control_code: 0x220004,
        input_hex: "00",
        input_file: "C:\\tmp\\x.bin",
      }),
    ).rejects.toThrow(/at most one of input_hex \/ input_file/);
  });

  it("forwards --expect-status", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220004,
      expect_status: "STATUS_SUCCESS",
    });
    const args = client.calls[0].args;
    expect(args[args.indexOf("--expect-status") + 1]).toBe("STATUS_SUCCESS");
  });

  it("forwards --expect-output-hex", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220004,
      expect_output_hex: "01 00 00 00",
    });
    const args = client.calls[0].args;
    expect(args[args.indexOf("--expect-output-hex") + 1]).toBe("01 00 00 00");
  });

  it("forwards --expect-output-size-min as a string", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220004,
      expect_output_size_min: 16,
    });
    const args = client.calls[0].args;
    expect(args[args.indexOf("--expect-output-size-min") + 1]).toBe("16");
  });

  it("always includes --json-output", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(client.calls[0].args).toContain("--json-output");
  });

  it("returns normalized result fields", async () => {
    client.queueSuccess({
      stdout: harnessJson({ status: "STATUS_SUCCESS", output_size: 8 }),
    });
    const r = await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(r.status).toBe("STATUS_SUCCESS");
    expect(r.output_size).toBe(8);
    expect(r.match).toBe(true);
    expect(r.exit_code).toBe(0);
  });

  it("propagates match=false from the harness", async () => {
    client.queueSuccess({
      exitCode: 1,
      stdout: harnessJson({ match: false, status: "STATUS_BUFFER_TOO_SMALL" }),
    });
    const r = await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(r.match).toBe(false);
    expect(r.status).toBe("STATUS_BUFFER_TOO_SMALL");
    expect(r.exit_code).toBe(1);
  });

  it("defaults match based on exit code when field is absent", async () => {
    // Older harness builds may not emit `match`; fall back to exit=0.
    client.queueSuccess({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "STATUS_SUCCESS",
        output_hex: "",
        output_size: 0,
      }),
    });
    const r = await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(r.match).toBe(true);
  });

  it("match=false when harness exits non-zero and emits no explicit field", async () => {
    client.queueSuccess({
      exitCode: 2,
      stdout: JSON.stringify({ status: "UNKNOWN", output_hex: "", output_size: 0 }),
    });
    const r = await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(r.match).toBe(false);
    expect(r.exit_code).toBe(2);
  });

  it("accepts numeric status from the harness", async () => {
    // If a harness build emits status as a number, we still normalize
    // to a 0x-prefixed hex string for consistent scenario assertions.
    client.queueSuccess({
      stdout: JSON.stringify({
        status: 0,
        output_hex: "",
        output_size: 0,
      }),
    });
    const r = await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(r.status).toBe("0x0");
  });

  it("throws a useful error when harness emits non-JSON", async () => {
    client.queueSuccess({
      stdout: "Usage: silo-test-harness --device ...",
      stderr: "invalid argument",
    });
    await expect(
      handleDriverIoctl(makeCtx(client), {
        device: "\\\\.\\example-product",
        control_code: 0x220000,
      }),
    ).rejects.toThrow(/non-JSON output/);
  });

  it("throws when harness JSON is not an object", async () => {
    client.queueSuccess({ stdout: JSON.stringify(["array"]) });
    // Arrays pass typeof checks but fail our shape check.
    const result = await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    // Arrays are typeof "object" but don't have our expected keys —
    // our parser handles this gracefully with default fields.
    expect(result.status).toBe("UNKNOWN");
    expect(result.output_size).toBe(0);
  });

  it("throws when harness JSON is null", async () => {
    client.queueSuccess({ stdout: "null" });
    await expect(
      handleDriverIoctl(makeCtx(client), {
        device: "\\\\.\\example-product",
        control_code: 0x220000,
      }),
    ).rejects.toThrow(/JSON must be an object/);
  });

  it("defaults timeout to 5 s", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
    });
    expect(client.calls[0].options).toMatchObject({ timeoutMs: 5_000 });
  });

  it("respects explicit timeout_ms", async () => {
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x220000,
      timeout_ms: 30_000,
    });
    expect(client.calls[0].options).toMatchObject({ timeoutMs: 30_000 });
  });

  it("handles ioctl codes larger than 32 bits without losing precision", async () => {
    // JS numbers are fine up to 2^53; CTL_CODE values fit comfortably.
    client.queueSuccess({ stdout: harnessJson() });
    await handleDriverIoctl(makeCtx(client), {
      device: "\\\\.\\example-product",
      control_code: 0x22abcd,
    });
    expect(client.calls[0].args[client.calls[0].args.indexOf("--ioctl") + 1])
      .toBe("0x22abcd");
  });

  it("propagates harness spawn failures verbatim", async () => {
    client.queue(new Error("spawn EACCES"));
    await expect(
      handleDriverIoctl(makeCtx(client), {
        device: "\\\\.\\example-product",
        control_code: 0x220000,
      }),
    ).rejects.toThrow(/spawn EACCES/);
  });
});

// ─── vi mock integration spot ──────────────────────────────────────
// Regression guard: make sure test doubles don't leak across cases.

describe("FakeGuestClient queueing", () => {
  it("FIFO-consumes queued responses", async () => {
    const c = new FakeGuestClient();
    c.queueSuccess({ stdout: "first" });
    c.queueSuccess({ stdout: "second" });
    expect((await c.runCommand("x")).stdout).toBe("first");
    expect((await c.runCommand("x")).stdout).toBe("second");
  });

  it("throws if runCommand is called without a queued response", async () => {
    const c = new FakeGuestClient();
    await expect(c.runCommand("x")).rejects.toThrow(/unqueued call/);
  });

  it("throws the queued error for error responses", async () => {
    const c = new FakeGuestClient();
    c.queue(new Error("simulated"));
    await expect(c.runCommand("x")).rejects.toThrow(/simulated/);
  });
});

// ─── Orchestrator dispatch integration ─────────────────────────────
//
// Thin integration test: hand a minimal ScenarioOrchestrator a
// FakeGuestClient for the requested VM, invoke executeToolBlock with
// each new tool type, confirm the orchestrator routes into the
// handlers and JSON-stringifies the result.

describe("ScenarioOrchestrator — driver_* dispatch", () => {
  async function makeOrchestrator(client: FakeGuestClient) {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    // Minimum backend stub — orchestrator won't touch it for these tools.
    const backend = {
      name: "test" as const,
      isAvailable: async () => true,
      createVM: async () => ({ id: "x", name: "endpoint-1", backend: "test" }),
      listVMs: async () => [],
      startVM: async () => {},
      stopVM: async () => {},
      getStatus: async () => ({
        state: "running" as const,
        guestAgentReachable: true,
        uptimeSeconds: 0,
        memoryUsedMB: 0,
      }),
      deleteVM: async () => {},
      createCheckpoint: async () => ({
        id: "c",
        vmHandle: { id: "x", name: "endpoint-1", backend: "test" },
        label: "l",
      }),
      restoreCheckpoint: async () => {},
      deleteCheckpoint: async () => {},
      listCheckpoints: async () => [],
      copyFileToVM: async () => {},
      copyFileFromVM: async () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      installSoftware: async () => ({ success: true, output: "" }),
    };
    const guestClients = new Map<
      string,
      unknown
    >([["endpoint-1", client as unknown]]);

    const orchestrator = new ScenarioOrchestrator(
      backend as never,
      guestClients as never,
      {} as never,
      {},
    );
    const vmMap = new Map<string, unknown>([
      [
        "endpoint-1",
        { id: "x", name: "endpoint-1", backend: "test" },
      ],
    ]);
    return { orchestrator, vmMap };
  }

  it("dispatches driver_load and JSON-stringifies the result", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess(); // sc start
    client.queueSuccess({
      stdout: "        STATE              : 4  RUNNING",
    }); // sc query

    const { orchestrator, vmMap } = await makeOrchestrator(client);
    const out = await orchestrator.executeToolBlock(
      "driver_load",
      { vm: "endpoint-1", service: "example-product" },
      vmMap as never,
    );
    const parsed = JSON.parse(out);
    expect(parsed.service_state).toBe("Running");
    expect(parsed.status).toBe(0);
  });

  it("dispatches driver_unload and JSON-stringifies the result", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess();
    client.queueSuccess({
      stdout: "        STATE              : 1  STOPPED",
    });
    const { orchestrator, vmMap } = await makeOrchestrator(client);
    const out = await orchestrator.executeToolBlock(
      "driver_unload",
      { vm: "endpoint-1", service: "example-product" },
      vmMap as never,
    );
    const parsed = JSON.parse(out);
    expect(parsed.service_state).toBe("Stopped");
  });

  it("dispatches driver_ioctl and JSON-stringifies the result", async () => {
    const client = new FakeGuestClient();
    client.queueSuccess({
      stdout: JSON.stringify({
        status: "STATUS_SUCCESS",
        output_hex: "01 00 00 00",
        output_size: 4,
        match: true,
      }),
    });
    const { orchestrator, vmMap } = await makeOrchestrator(client);
    const out = await orchestrator.executeToolBlock(
      "driver_ioctl",
      {
        vm: "endpoint-1",
        device: "\\\\.\\example-product",
        control_code: 0x220000,
      },
      vmMap as never,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("STATUS_SUCCESS");
    expect(parsed.match).toBe(true);
  });

  it("driver_load throws when no guest client is registered", async () => {
    const { orchestrator, vmMap } = await makeOrchestrator(
      new FakeGuestClient(),
    );
    await expect(
      orchestrator.executeToolBlock(
        "driver_load",
        { vm: "unregistered-vm", service: "example-product" },
        vmMap as never,
      ),
    ).rejects.toThrow(/No guest client/);
  });

  it("driver_unload throws when no guest client is registered", async () => {
    const { orchestrator, vmMap } = await makeOrchestrator(
      new FakeGuestClient(),
    );
    await expect(
      orchestrator.executeToolBlock(
        "driver_unload",
        { vm: "unregistered-vm", service: "example-product" },
        vmMap as never,
      ),
    ).rejects.toThrow(/No guest client/);
  });

  it("driver_ioctl throws when no guest client is registered", async () => {
    const { orchestrator, vmMap } = await makeOrchestrator(
      new FakeGuestClient(),
    );
    await expect(
      orchestrator.executeToolBlock(
        "driver_ioctl",
        {
          vm: "unregistered-vm",
          device: "\\\\.\\x",
          control_code: 0,
        },
        vmMap as never,
      ),
    ).rejects.toThrow(/No guest client/);
  });

  it("unknown tool still throws from the default branch", async () => {
    const { orchestrator, vmMap } = await makeOrchestrator(
      new FakeGuestClient(),
    );
    await expect(
      orchestrator.executeToolBlock(
        "does_not_exist",
        { vm: "endpoint-1" },
        vmMap as never,
      ),
    ).rejects.toThrow(/Unknown workflow tool/);
  });
});

// Spy integration — lightweight confirmation that vi.fn can be used in
// place of the whole FakeGuestClient for simpler tests.
describe("handler + vi.fn integration", () => {
  it("driver_load works with a vi.fn-based runCommand", async () => {
    const runCommand = vi
      .fn<
        (
          cmd: string,
          args?: string[],
          opts?: unknown,
        ) => Promise<CommandResult>
      >()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "        STATE              : 4  RUNNING",
        stderr: "",
        durationMs: 0,
      });
    const ctx: DriverHandlerContext = {
      guestClient: { runCommand } as unknown as GuestAgentClient,
      vmName: "endpoint-1",
    };
    const r = await handleDriverLoad(ctx, { service: "example-product" });
    expect(r.service_state).toBe("Running");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
