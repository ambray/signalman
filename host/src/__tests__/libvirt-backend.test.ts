/**
 * libvirt backend integration tests (v0.4.0-4 cross-platform Chunk 2).
 *
 * These tests build a `LibvirtBackend` whose injected exec returns
 * fixture text loaded from `host/src/__tests__/fixtures/virsh-*.txt`,
 * exercise the public methods end-to-end, and assert on the parsed
 * shape returned. Pairs with `libvirt-argv.test.ts` which covers
 * argv composition directly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LibvirtBackend, LibvirtBackendError } from "../hypervisors/libvirt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "fixtures");

const fixtures = {
  listAll: "",
  domstateRunning: "",
  domifaddr: "",
  snapshotList: "",
};

beforeAll(() => {
  fixtures.listAll = readFileSync(
    path.join(fixturesDir, "virsh-list-all.txt"),
    "utf8",
  );
  fixtures.domstateRunning = readFileSync(
    path.join(fixturesDir, "virsh-domstate-running.txt"),
    "utf8",
  );
  fixtures.domifaddr = readFileSync(
    path.join(fixturesDir, "virsh-domifaddr.txt"),
    "utf8",
  );
  fixtures.snapshotList = readFileSync(
    path.join(fixturesDir, "virsh-snapshot-list.txt"),
    "utf8",
  );
});

/**
 * Build a `LibvirtBackend` whose exec returns canned output keyed by
 * the verb (the second argv element, or first when no `-c` is set).
 *
 * Tests register a per-verb response; calls falling through use a
 * sensible default ("exit 0 with empty stdout").
 */
function makeStubBackend(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  return new LibvirtBackend({
    exec: async (args) => {
      // Find the verb. With no -c flag the verb is args[0]; with -c
      // <uri> it's args[2]. We don't bother to differentiate connect
      // flags from regular args because all our verbs are unique.
      const verb = args.find(
        (a) => a !== "-c" && !a.startsWith("qemu") && !a.startsWith("test:"),
      ) ?? args[0];
      const canned = responses[verb] ?? {};
      return {
        stdout: canned.stdout ?? "",
        stderr: canned.stderr ?? "",
        exitCode: canned.exitCode ?? 0,
      };
    },
  });
}

const HANDLE = { id: "vm-alpha", name: "vm-alpha", backend: "libvirt" } as const;

describe("LibvirtBackend integration", () => {
  it("listVMs parses --all --name output into VMHandles", async () => {
    const backend = makeStubBackend({ list: { stdout: fixtures.listAll } });
    const vms = await backend.listVMs();
    expect(vms.map((v) => v.name)).toEqual([
      "vm-alpha",
      "vm-beta",
      "vm-gamma",
    ]);
    expect(vms.every((v) => v.backend === "libvirt")).toBe(true);
  });

  it("getStatus returns running + IPv4 when a lease exists", async () => {
    const backend = makeStubBackend({
      domstate: { stdout: fixtures.domstateRunning },
      domifaddr: { stdout: fixtures.domifaddr },
    });
    const status = await backend.getStatus(HANDLE);
    expect(status.state).toBe("running");
    expect(status.ipAddress).toBe("192.168.122.42");
    // guestAgentReachable stays false until the orchestrator runs the
    // gRPC health probe — that's not the backend's job.
    expect(status.guestAgentReachable).toBe(false);
  });

  it("getStatus tolerates a missing IPv4 lease without throwing", async () => {
    const backend = makeStubBackend({
      domstate: { stdout: fixtures.domstateRunning },
      domifaddr: { stderr: "no addresses", exitCode: 1 },
    });
    const status = await backend.getStatus(HANDLE);
    expect(status.state).toBe("running");
    expect(status.ipAddress).toBeUndefined();
  });

  it("listCheckpoints parses every fixture row", async () => {
    const backend = makeStubBackend({
      "snapshot-list": { stdout: fixtures.snapshotList },
    });
    const snaps = await backend.listCheckpoints(HANDLE);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].label).toBe("snap-01");
    expect(snaps[1].label).toBe("snap-02");
  });

  it("createCheckpoint returns a CheckpointHandle whose label survives sanitisation", async () => {
    const backend = makeStubBackend({});
    const cp = await backend.createCheckpoint(HANDLE, "snap-2024");
    expect(cp.label).toBe("snap-2024");
    expect(cp.vmHandle).toBe(HANDLE);
  });

  it("startVM is idempotent for an already-running domain", async () => {
    const backend = makeStubBackend({
      start: {
        stderr: "error: Failed to start domain 'vm-alpha': Domain is already active",
        exitCode: 1,
      },
    });
    // Idempotent path: no throw.
    await expect(backend.startVM(HANDLE)).resolves.toBeUndefined();
  });

  it("stopVM is idempotent for an already-stopped domain", async () => {
    const backend = makeStubBackend({
      shutdown: {
        stderr: "error: Requested operation is not valid: domain is not running",
        exitCode: 1,
      },
    });
    await expect(backend.stopVM(HANDLE)).resolves.toBeUndefined();
  });

  it("surfaces vm_not_found on virsh's lookup error", async () => {
    const backend = makeStubBackend({
      domstate: {
        stderr: "error: failed to get domain 'ghost'",
        exitCode: 1,
      },
    });
    await expect(
      backend.getStatus({ id: "ghost", name: "ghost", backend: "libvirt" }),
    ).rejects.toMatchObject({ code: "vm_not_found" });
  });

  it("surfaces connect_failed when libvirtd is down", async () => {
    const backend = makeStubBackend({
      list: {
        stderr: "error: failed to connect to the hypervisor",
        exitCode: 1,
      },
    });
    await expect(backend.listVMs()).rejects.toMatchObject({
      code: "connect_failed",
    });
  });

  it("surfaces network_unavailable when no IPv4 lease is reported", async () => {
    const backend = makeStubBackend({
      domifaddr: { stdout: "" },
    });
    await expect(backend.getVmIpAddress(HANDLE)).rejects.toMatchObject({
      code: "network_unavailable",
    });
  });

  it("createVM is unsupported_operation pending the v0.4.1 XML builder", async () => {
    const backend = makeStubBackend({});
    await expect(
      backend.createVM({ name: "vm-new" }),
    ).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it("executeCommand submits guest-exec then polls guest-exec-status until exited", async () => {
    // QGA submit returns a pid; the first poll says the guest is
    // still running; the second poll signals terminal completion
    // with base64-encoded stdout + stderr. The backend must round-trip
    // both: real exitCode from the guest, real decoded stdout/stderr.
    const out = Buffer.from("hello\n").toString("base64");
    const err = Buffer.from("warn line\n").toString("base64");
    const calls: { execute: string; pid?: number }[] = [];
    let pollCount = 0;
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const payload = JSON.parse(args[args.length - 1]) as {
          execute: string;
          arguments?: { pid?: number };
        };
        calls.push({ execute: payload.execute, pid: payload.arguments?.pid });
        if (payload.execute === "guest-exec") {
          return { stdout: '{"return":{"pid":42}}', stderr: "", exitCode: 0 };
        }
        pollCount += 1;
        if (pollCount === 1) {
          return {
            stdout: '{"return":{"exited":false}}',
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            return: {
              exited: true,
              exitcode: 7,
              "out-data": out,
              "err-data": err,
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const result = await backend.executeCommand(HANDLE, "/bin/echo", ["hi"]);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn line\n");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // First call submits, the remainder poll on the returned pid.
    expect(calls[0]).toEqual({ execute: "guest-exec", pid: undefined });
    expect(calls.slice(1).every((c) => c.execute === "guest-exec-status")).toBe(true);
    expect(calls.slice(1).every((c) => c.pid === 42)).toBe(true);
  });

  it("executeCommand maps signal-killed processes to 128+signal", async () => {
    // QGA reports either `exitcode` (normal exit) or `signal` (killed).
    // We translate signal-killed processes to the shell-convention
    // 128 + signum so callers don't need to introspect the QGA field.
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const payload = JSON.parse(args[args.length - 1]) as { execute: string };
        if (payload.execute === "guest-exec") {
          return { stdout: '{"return":{"pid":9}}', stderr: "", exitCode: 0 };
        }
        return {
          stdout: '{"return":{"exited":true,"signal":15}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const result = await backend.executeCommand(HANDLE, "/bin/sleep", ["10"]);
    expect(result.exitCode).toBe(143); // 128 + SIGTERM(15)
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("executeCommand surfaces command_failed when the submit RPC errors", async () => {
    const backend = new LibvirtBackend({
      exec: async () => ({
        stdout: "",
        stderr: "error: argument --domain is required for command 'qemu-agent-command'",
        exitCode: 1,
      }),
    });
    await expect(
      backend.executeCommand(HANDLE, "/bin/true"),
    ).rejects.toMatchObject({ code: "command_failed" });
  });

  it("executeCommand surfaces command_failed when the deadline expires before exit", async () => {
    // Guest never reports `exited: true`. Backend's poll loop must
    // give up at the caller's timeout and throw command_failed rather
    // than spin forever.
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const payload = JSON.parse(args[args.length - 1]) as { execute: string };
        if (payload.execute === "guest-exec") {
          return { stdout: '{"return":{"pid":3}}', stderr: "", exitCode: 0 };
        }
        return {
          stdout: '{"return":{"exited":false}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });
    await expect(
      backend.executeCommand(HANDLE, "/bin/sleep", ["999"], 200),
    ).rejects.toMatchObject({ code: "command_failed" });
  });

  it("executeCommand surfaces command_failed when QGA returns an unparseable submit response", async () => {
    const backend = new LibvirtBackend({
      exec: async () => ({
        stdout: '{"return":{"not-a-pid":true}}',
        stderr: "",
        exitCode: 0,
      }),
    });
    await expect(
      backend.executeCommand(HANDLE, "/bin/true"),
    ).rejects.toMatchObject({ code: "command_failed" });
  });

  it("executeCommand rejects empty commands with invalid_argument", async () => {
    const backend = makeStubBackend({});
    await expect(
      backend.executeCommand(HANDLE, "", []),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("isAvailable returns false when virsh is not installed", async () => {
    const backend = new LibvirtBackend({
      exec: async () => {
        throw new LibvirtBackendError(
          "virsh_not_found",
          "Could not spawn 'virsh'",
        );
      },
    });
    expect(await backend.isAvailable()).toBe(false);
  });

  it("isAvailable returns false when virsh exits non-zero (libvirtd down)", async () => {
    const backend = makeStubBackend({
      version: { stderr: "cannot connect to libvirt", exitCode: 1 },
    });
    expect(await backend.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when virsh version succeeds", async () => {
    const backend = makeStubBackend({
      version: { stdout: "Compiled against library: libvirt 9.0.0\n" },
    });
    expect(await backend.isAvailable()).toBe(true);
  });

  it("uses 'libvirt' as its name (registry-key invariant)", () => {
    const backend = new LibvirtBackend();
    expect(backend.name).toBe("libvirt");
  });
});

describe("LibvirtBackend selector registration", () => {
  it("the libvirt backend appears in buildBackendList", async () => {
    // Imported here rather than top-of-file because the selector
    // pulls in service.ts which loads gRPC; we want the failure mode
    // surfaced inside this test rather than aborting the whole file.
    const { buildBackendList } = await import("../hypervisors/selector.js");
    const { defaultConfig } = await import("../config.js");
    const names = buildBackendList(defaultConfig()).map((b) => b.name);
    expect(names).toContain("libvirt");
  });
});
