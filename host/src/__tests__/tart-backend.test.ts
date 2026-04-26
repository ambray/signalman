import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  TartBackend,
  type TartChildProcess,
  type TartCommandRunner,
} from "../hypervisors/tart.js";

function makeRunner(
  handler: (args: string[], timeoutMs: number) => { stdout?: string; stderr?: string } | Promise<{ stdout?: string; stderr?: string }>,
): TartCommandRunner {
  return async (args, timeoutMs) => {
    const result = await handler(args, timeoutMs);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

class FakeChild extends EventEmitter implements TartChildProcess {
  readonly pid = 1234;

  override once(
    event: "exit" | "error",
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((err: Error) => void),
  ): this {
    super.once(event, listener);
    return this;
  }

  unref(): void {
    /* no-op */
  }
}

describe("TartBackend", () => {
  it("lists VMs from Tart JSON output", async () => {
    const backend = new TartBackend({
      commandRunner: makeRunner((args) => {
        expect(args).toEqual(["list", "--format", "json"]);
        return {
          stdout: JSON.stringify([
            { name: "sonoma-base", running: true },
            { name: "tahoe-clean", running: false },
          ]),
        };
      }),
    });

    await expect(backend.listVMs()).resolves.toEqual([
      { id: "sonoma-base", name: "sonoma-base", backend: "tart" },
      { id: "tahoe-clean", name: "tahoe-clean", backend: "tart" },
    ]);
  });

  it("creates a VM by cloning the configured template and applying resource overrides", async () => {
    const calls: string[][] = [];
    const backend = new TartBackend({
      commandRunner: makeRunner((args) => {
        calls.push(args);
        return {};
      }),
    });

    await expect(
      backend.createVM({
        name: "sig-mac",
        template: "ghcr.io/cirruslabs/macos-sequoia-base:latest",
        cpus: 4,
        memoryMB: 8192,
        diskGB: 80,
      }),
    ).resolves.toEqual({ id: "sig-mac", name: "sig-mac", backend: "tart" });

    expect(calls).toEqual([
      ["clone", "ghcr.io/cirruslabs/macos-sequoia-base:latest", "sig-mac"],
      ["set", "sig-mac", "--cpu", "4"],
      ["set", "sig-mac", "--memory", "8192"],
      ["set", "sig-mac", "--disk-size", "80"],
    ]);
  });

  it("starts a VM with tart run and waits until list reports running", async () => {
    let listCalls = 0;
    const child = new FakeChild();
    const spawned: string[][] = [];
    const backend = new TartBackend({
      startTimeoutMs: 5_000,
      commandRunner: makeRunner((args) => {
        if (args[0] === "list") {
          listCalls += 1;
          return {
            stdout: JSON.stringify([
              { name: "sig-mac", running: listCalls >= 2 },
            ]),
          };
        }
        throw new Error(`unexpected command ${args.join(" ")}`);
      }),
      spawnRunner: (args) => {
        spawned.push(args);
        return child;
      },
    });

    await backend.startVM({ id: "sig-mac", name: "sig-mac", backend: "tart" });

    expect(spawned).toEqual([["run", "--no-graphics", "sig-mac"]]);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it("executes commands through tart exec", async () => {
    const backend = new TartBackend({
      commandRunner: makeRunner((args, timeoutMs) => {
        expect(args).toEqual(["exec", "sig-mac", "/usr/bin/uname", "-a"]);
        expect(timeoutMs).toBe(10_000);
        return { stdout: "Darwin\n" };
      }),
    });

    await expect(
      backend.executeCommand(
        { id: "sig-mac", name: "sig-mac", backend: "tart" },
        "/usr/bin/uname",
        ["-a"],
        10_000,
      ),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Darwin\n",
    });
  });

  it("emulates checkpoints with Tart clones", async () => {
    const calls: string[][] = [];
    const backend = new TartBackend({
      commandRunner: makeRunner((args) => {
        calls.push(args);
        if (args[0] === "list") {
          return { stdout: JSON.stringify([{ name: "sig-mac", running: false }]) };
        }
        return {};
      }),
    });

    const cp = await backend.createCheckpoint(
      { id: "sig-mac", name: "sig-mac", backend: "tart" },
      "clean",
    );
    await backend.restoreCheckpoint(cp);

    expect(calls).toEqual([
      ["clone", "sig-mac", "sig-mac--signalman-cp--clean"],
      ["list", "--format", "json"],
      ["delete", "sig-mac"],
      ["clone", "sig-mac--signalman-cp--clean", "sig-mac"],
    ]);
  });
});
