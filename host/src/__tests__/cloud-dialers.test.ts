/**
 * WS6 wave-3 carve-out #5 — cloud dialer tests.
 *
 * Each test pins one slice of the SSM + Bastion dialer contract:
 *
 *  1. AwsSsmDialer argv: target + region + document + parameters
 *  2. AwsSsmDialer argv: profile passed through when present
 *  3. AwsSsmDialer argv: local port picked when option omitted
 *  4. AwsSsmDialer.open refuses non-`aws_ssm` descriptor kinds
 *  5. AwsSsmDialer handle.close() sends SIGTERM to the child
 *  6. AzureBastionDialer argv: name + RG + target id + ports
 *  7. AzureBastionDialer argv: resolveVmResourceId override path
 *  8. AzureBastionDialer argv: caller-supplied local port respected
 *  9. AzureBastionDialer.open refuses non-`azure_bastion` kinds
 * 10. AzureBastionDialer.open refuses missing `bastion_name`
 * 11. AzureBastionDialer handle.close() sends SIGTERM to the child
 * 12. defaultDialerFor returns AwsSsmDialer for `aws_ssm`
 * 13. defaultDialerFor returns AzureBastionDialer for `azure_bastion`
 * 14. defaultDialerFor refuses `public_mtls`
 * 15. DialerError code field is stable + readable
 * 16. waitForReady raises `tunnel_failed` when child exits early
 * 17. classifyExitFailure picks `auth_failed` from stderr text
 */

import { describe, it, expect, vi } from "vitest";

import {
  AwsSsmDialer,
  AzureBastionDialer,
  AWS_SSM_PORT_FORWARD_DOCUMENT,
  AWS_SSM_READY_MARKER,
  AZURE_BASTION_READY_MARKER,
  DialerError,
  buildAwsSsmArgs,
  buildAzureBastionArgs,
  classifyExitFailure,
  defaultDialerFor,
  resolveVmResourceId,
  waitForReady,
  type CloudConnectionDescriptor,
  type DialerChildHandle,
  type DialerExec,
} from "../cloud/dialers/index.js";

// Type aliases for variant types — kept inline to avoid importing
// from the upstream types module (the dialers' public surface only
// re-exports the union).
type AwsSsmDescriptor = Extract<CloudConnectionDescriptor, { kind: "aws_ssm" }>;
type AzureBastionDescriptor = Extract<CloudConnectionDescriptor, { kind: "azure_bastion" }>;
type PublicMtlsDescriptor = Extract<CloudConnectionDescriptor, { kind: "public_mtls" }>;

// ── Test-side fake child ───────────────────────────────────────────

interface FakeChild extends DialerChildHandle {
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
  killMock: ReturnType<typeof vi.fn>;
  killed: { signal: NodeJS.Signals | number | undefined; count: number };
}

function makeFakeChild(): FakeChild {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  let exited = false;
  const killed = { signal: undefined as NodeJS.Signals | number | undefined, count: 0 };
  const killMock = vi.fn((signal?: NodeJS.Signals | number) => {
    killed.signal = signal;
    killed.count += 1;
    return true;
  });

  return {
    kill: killMock,
    onStdout: (listener) => stdoutListeners.push(listener),
    onStderr: (listener) => stderrListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    get exited() {
      return exited;
    },
    emitStdout(chunk: string) {
      for (const fn of stdoutListeners) fn(chunk);
    },
    emitStderr(chunk: string) {
      for (const fn of stderrListeners) fn(chunk);
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null) {
      exited = true;
      for (const fn of exitListeners) fn(code, signal);
    },
    killMock,
    killed,
  };
}

function makeScriptedExec(
  child: FakeChild,
  readyMarker: string,
): {
  exec: DialerExec;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: DialerExec = (command, args) => {
    calls.push({ command, args: [...args] });
    // Schedule the ready marker on the next microtask so the
    // dialer's waitForReady has a chance to subscribe first.
    queueMicrotask(() => child.emitStdout(`${readyMarker}\n`));
    return child;
  };
  return { exec, calls };
}

// ── AwsSsmDialer ──────────────────────────────────────────────────

describe("AwsSsmDialer — argv construction", () => {
  it("passes target, region, document, and parameters", async () => {
    const child = makeFakeChild();
    const { exec, calls } = makeScriptedExec(child, AWS_SSM_READY_MARKER);
    const dialer = new AwsSsmDialer({ exec, localPort: 19999 });

    const descriptor: AwsSsmDescriptor = {
      kind: "aws_ssm",
      instance_id: "i-0abc123",
      region: "us-east-1",
      port: 8443,
    };
    const handle = await dialer.open(descriptor);
    expect(handle.localPort).toBe(19999);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("aws");
    expect(calls[0]!.args).toEqual([
      "ssm",
      "start-session",
      "--target",
      "i-0abc123",
      "--region",
      "us-east-1",
      "--document-name",
      AWS_SSM_PORT_FORWARD_DOCUMENT,
      "--parameters",
      "portNumber=8443,localPortNumber=19999",
    ]);
  });

  it("passes --profile through when descriptor specifies one", () => {
    const args = buildAwsSsmArgs(
      {
        instance_id: "i-prof",
        region: "eu-west-1",
        port: 50051,
        profile: "staging",
      },
      30000,
    );
    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("staging");
  });

  it("picks a free local port when option omitted", async () => {
    const child = makeFakeChild();
    const { exec, calls } = makeScriptedExec(child, AWS_SSM_READY_MARKER);
    const dialer = new AwsSsmDialer({ exec });

    const handle = await dialer.open({
      kind: "aws_ssm",
      instance_id: "i-auto",
      region: "us-west-2",
      port: 443,
    });

    expect(handle.localPort).toBeGreaterThan(0);
    expect(handle.localPort).toBeLessThan(65536);
    // The picked port should appear in the parameters arg.
    const paramsArg = calls[0]!.args[calls[0]!.args.indexOf("--parameters") + 1]!;
    expect(paramsArg).toBe(`portNumber=443,localPortNumber=${handle.localPort}`);
  });

  it("custom binary path passed to exec", async () => {
    const child = makeFakeChild();
    const { exec, calls } = makeScriptedExec(child, AWS_SSM_READY_MARKER);
    const dialer = new AwsSsmDialer({ exec, awsBin: "/opt/aws/bin/aws", localPort: 12345 });

    await dialer.open({
      kind: "aws_ssm",
      instance_id: "i-x",
      region: "us-east-1",
      port: 443,
    });
    expect(calls[0]!.command).toBe("/opt/aws/bin/aws");
  });
});

describe("AwsSsmDialer — descriptor refusal", () => {
  it("rejects non-aws_ssm descriptor kinds", async () => {
    const dialer = new AwsSsmDialer({ exec: () => makeFakeChild() });
    const bad: AzureBastionDescriptor = {
      kind: "azure_bastion",
      subscription_id: "sub",
      resource_group: "rg",
      vm_name: "vm",
      port: 443,
      bastion_name: "bn",
    };
    await expect(dialer.open(bad)).rejects.toThrow(
      expect.objectContaining({
        name: "DialerError",
        code: "unsupported_descriptor",
      }),
    );
  });
});

describe("AwsSsmDialer — close()", () => {
  it("sends SIGTERM to the subprocess and resolves on exit", async () => {
    const child = makeFakeChild();
    const { exec } = makeScriptedExec(child, AWS_SSM_READY_MARKER);
    const dialer = new AwsSsmDialer({ exec, localPort: 27000, closeGraceMs: 50 });

    const handle = await dialer.open({
      kind: "aws_ssm",
      instance_id: "i-close",
      region: "us-east-1",
      port: 443,
    });

    const closing = handle.close();
    // The close() call should have triggered a kill with SIGTERM.
    expect(child.killMock).toHaveBeenCalledWith("SIGTERM");
    // Simulate the child exiting in response to SIGTERM.
    child.emitExit(0, "SIGTERM");
    await closing;
    // A second close() resolves immediately and is idempotent.
    await handle.close();
  });
});

// ── AzureBastionDialer ────────────────────────────────────────────

describe("AzureBastionDialer — argv construction", () => {
  it("passes name, resource-group, target-resource-id, and ports", async () => {
    const child = makeFakeChild();
    const { exec, calls } = makeScriptedExec(child, AZURE_BASTION_READY_MARKER);
    const dialer = new AzureBastionDialer({ exec, localPort: 22222 });

    const descriptor: AzureBastionDescriptor = {
      kind: "azure_bastion",
      subscription_id: "00000000-0000-0000-0000-000000000001",
      resource_group: "rg-test",
      vm_name: "vm-test",
      port: 50051,
      bastion_name: "bastion-test",
    };
    const handle = await dialer.open(descriptor);
    expect(handle.localPort).toBe(22222);

    expect(calls[0]!.command).toBe("az");
    const args = calls[0]!.args;
    expect(args[0]).toBe("network");
    expect(args[1]).toBe("bastion");
    expect(args[2]).toBe("tunnel");
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("bastion-test");
    expect(args[args.indexOf("--resource-group") + 1]).toBe("rg-test");
    expect(args[args.indexOf("--target-resource-id") + 1]).toBe(
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-test/providers/Microsoft.Compute/virtualMachines/vm-test",
    );
    expect(args[args.indexOf("--resource-port") + 1]).toBe("50051");
    expect(args[args.indexOf("--port") + 1]).toBe("22222");
    expect(args[args.indexOf("--subscription") + 1]).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("uses explicit vm_resource_id override when set", () => {
    const id = resolveVmResourceId({
      subscription_id: "ignored",
      resource_group: "ignored",
      vm_name: "ignored",
      vm_resource_id: "/subscriptions/explicit/resourceGroups/x/providers/Microsoft.Compute/virtualMachines/y",
    });
    expect(id).toBe(
      "/subscriptions/explicit/resourceGroups/x/providers/Microsoft.Compute/virtualMachines/y",
    );

    const args = buildAzureBastionArgs(
      {
        subscription_id: "sub",
        resource_group: "rg",
        vm_name: "vm",
        port: 443,
        bastion_name: "bn",
        vm_resource_id: "/subscriptions/explicit/resourceGroups/x/providers/Microsoft.Compute/virtualMachines/y",
      },
      45000,
    );
    expect(args[args.indexOf("--target-resource-id") + 1]).toBe(
      "/subscriptions/explicit/resourceGroups/x/providers/Microsoft.Compute/virtualMachines/y",
    );
  });

  it("respects caller-supplied local port", () => {
    const args = buildAzureBastionArgs(
      {
        subscription_id: "sub",
        resource_group: "rg",
        vm_name: "vm",
        port: 8000,
        bastion_name: "bn",
      },
      31337,
    );
    expect(args[args.indexOf("--port") + 1]).toBe("31337");
    expect(args[args.indexOf("--resource-port") + 1]).toBe("8000");
  });
});

describe("AzureBastionDialer — descriptor refusal", () => {
  it("rejects non-azure_bastion descriptor kinds", async () => {
    const dialer = new AzureBastionDialer({ exec: () => makeFakeChild() });
    const bad: AwsSsmDescriptor = {
      kind: "aws_ssm",
      instance_id: "i-x",
      region: "us-east-1",
      port: 443,
    };
    await expect(dialer.open(bad)).rejects.toThrow(
      expect.objectContaining({
        name: "DialerError",
        code: "unsupported_descriptor",
      }),
    );
  });

  it("rejects descriptors missing bastion_name", async () => {
    const dialer = new AzureBastionDialer({ exec: () => makeFakeChild() });
    const incomplete = {
      kind: "azure_bastion",
      subscription_id: "sub",
      resource_group: "rg",
      vm_name: "vm",
      port: 443,
      bastion_name: "",
    } as AzureBastionDescriptor;
    await expect(dialer.open(incomplete)).rejects.toThrow(
      expect.objectContaining({
        name: "DialerError",
        code: "unsupported_descriptor",
      }),
    );
  });
});

describe("AzureBastionDialer — close()", () => {
  it("sends SIGTERM to the subprocess and resolves on exit", async () => {
    const child = makeFakeChild();
    const { exec } = makeScriptedExec(child, AZURE_BASTION_READY_MARKER);
    const dialer = new AzureBastionDialer({
      exec,
      localPort: 28000,
      closeGraceMs: 50,
    });

    const handle = await dialer.open({
      kind: "azure_bastion",
      subscription_id: "sub",
      resource_group: "rg",
      vm_name: "vm",
      port: 443,
      bastion_name: "bn",
    });

    const closing = handle.close();
    expect(child.killMock).toHaveBeenCalledWith("SIGTERM");
    child.emitExit(0, "SIGTERM");
    await closing;
  });
});

// ── defaultDialerFor ──────────────────────────────────────────────

describe("defaultDialerFor", () => {
  it("returns an AwsSsmDialer for kind=aws_ssm", () => {
    const dialer = defaultDialerFor({
      kind: "aws_ssm",
      instance_id: "i-x",
      region: "us-east-1",
      port: 443,
    });
    expect(dialer).toBeInstanceOf(AwsSsmDialer);
  });

  it("returns an AzureBastionDialer for kind=azure_bastion", () => {
    const dialer = defaultDialerFor({
      kind: "azure_bastion",
      subscription_id: "sub",
      resource_group: "rg",
      vm_name: "vm",
      port: 443,
      bastion_name: "bn",
    });
    expect(dialer).toBeInstanceOf(AzureBastionDialer);
  });

  it("refuses public_mtls (no dialer needed)", () => {
    const desc: PublicMtlsDescriptor = {
      kind: "public_mtls",
      host: "10.0.0.1",
      port: 443,
    };
    expect(() => defaultDialerFor(desc)).toThrow(
      expect.objectContaining({
        name: "DialerError",
        code: "unsupported_descriptor",
      }),
    );
  });

  it("threads per-dialer options through to the concrete constructor", () => {
    const exec: DialerExec = () => makeFakeChild();
    const d = defaultDialerFor(
      {
        kind: "aws_ssm",
        instance_id: "i-x",
        region: "us-east-1",
        port: 443,
      },
      { awsSsm: { exec, awsBin: "/custom/aws" } },
    );
    expect(d).toBeInstanceOf(AwsSsmDialer);
  });
});

// ── DialerError ───────────────────────────────────────────────────

describe("DialerError", () => {
  it("carries the stable code field plus the message", () => {
    const err = new DialerError("tunnel_failed", "ready line never appeared");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DialerError");
    expect(err.code).toBe("tunnel_failed");
    expect(err.message).toBe("ready line never appeared");
  });

  it("preserves the cause when supplied", () => {
    const underlying = new Error("ECONNREFUSED");
    const err = new DialerError("cli_not_found", "spawn failed", underlying);
    expect(err.cause).toBe(underlying);
  });
});

// ── waitForReady + classifyExitFailure ────────────────────────────

describe("waitForReady", () => {
  it("rejects with tunnel_failed when the child exits before ready", async () => {
    const child = makeFakeChild();
    const waiter = waitForReady(child, {
      readyMarker: "Waiting for connections",
      timeoutMs: 5_000,
      cliName: "aws ssm start-session",
    });
    queueMicrotask(() => {
      child.emitStderr("plugin not installed\n");
      child.emitExit(1, null);
    });
    await expect(waiter).rejects.toThrow(
      expect.objectContaining({
        name: "DialerError",
        code: "tunnel_failed",
      }),
    );
  });
});

describe("classifyExitFailure", () => {
  it("classifies AWS access-denied stderr as auth_failed", () => {
    expect(classifyExitFailure("An error occurred: AccessDenied")).toBe(
      "auth_failed",
    );
  });
  it("classifies az-login prompt as auth_failed", () => {
    expect(classifyExitFailure("Please run 'az login' to set up an account")).toBe(
      "auth_failed",
    );
  });
  it("classifies a not-found stderr as cli_not_found", () => {
    expect(classifyExitFailure("aws: command not found")).toBe("cli_not_found");
  });
  it("falls through to tunnel_failed", () => {
    expect(classifyExitFailure("network timed out")).toBe("tunnel_failed");
  });
});

// Used to silence the unused-var lint for the CloudConnectionDescriptor
// import (kept around because operators may want to type assertions in
// future test additions).
type _Pin = CloudConnectionDescriptor;
