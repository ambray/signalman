/**
 * vmrun backend argv-composition tests (v0.4.0-4 cross-platform Chunk 3).
 *
 * Mirrors `libvirt-argv.test.ts`. Tests assert on the argv the backend
 * passes to `vmrun` via the injected exec callback so nothing actually
 * spawns vmrun.
 */

import { describe, it, expect } from "vitest";

import {
  VmrunBackend,
  buildArgv,
  parseListOutput,
  parseSnapshotsOutput,
  vmNameFromVmxPath,
} from "../hypervisors/vmrun.js";

interface ExecCall {
  args: string[];
  timeoutMs: number;
}

function makeBackend(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  guestUser?: string;
  guestPass?: string;
}) {
  const calls: ExecCall[] = [];
  const backend = new VmrunBackend({
    guestUser: opts.guestUser,
    guestPass: opts.guestPass,
    exec: async (args, execOpts) => {
      calls.push({ args, timeoutMs: execOpts.timeoutMs });
      return {
        stdout: opts.stdout ?? "",
        stderr: opts.stderr ?? "",
        exitCode: opts.exitCode ?? 0,
      };
    },
  });
  return { backend, calls };
}

const VMX_HANDLE = {
  id: "/Users/ops/VMs/alpha.vmx",
  name: "alpha",
  backend: "vmrun",
} as const;

// ── Parser unit tests ─────────────────────────────────────────────

describe("parseListOutput", () => {
  it("skips the 'Total running VMs' header", () => {
    const raw =
      "Total running VMs: 2\n/Users/ops/VMs/a.vmx\n/Users/ops/VMs/b.vmx\n";
    expect(parseListOutput(raw)).toEqual([
      "/Users/ops/VMs/a.vmx",
      "/Users/ops/VMs/b.vmx",
    ]);
  });

  it("returns [] when no VMs are running", () => {
    expect(parseListOutput("Total running VMs: 0\n")).toEqual([]);
  });

  it("trims trailing whitespace and skips blank lines", () => {
    const raw =
      "Total running VMs: 1\n   /Users/ops/VMs/a.vmx   \n\n";
    expect(parseListOutput(raw)).toEqual(["/Users/ops/VMs/a.vmx"]);
  });
});

describe("parseSnapshotsOutput", () => {
  it("returns one CheckpointInfo per snapshot", () => {
    const raw = "Total snapshots: 2\nsnap-1\nsnap-2\n";
    const out = parseSnapshotsOutput(raw);
    expect(out).toHaveLength(2);
    expect(out[0].label).toBe("snap-1");
    expect(out[1].label).toBe("snap-2");
    // vmrun doesn't expose creation time — sentinel epoch.
    expect(out[0].createdAt.getTime()).toBe(0);
  });
});

describe("vmNameFromVmxPath", () => {
  it("strips the directory + .vmx suffix", () => {
    expect(vmNameFromVmxPath("/Users/ops/VMs/alpha.vmx")).toBe("alpha");
  });

  it("handles Windows-style backslashes", () => {
    expect(vmNameFromVmxPath("C:\\VMs\\beta.vmx")).toBe("beta");
  });

  it("falls back to the raw input when no .vmx suffix is present", () => {
    expect(vmNameFromVmxPath("/just/a/name")).toBe("name");
  });
});

describe("buildArgv", () => {
  it("composes a verb + extras into a flat argv", () => {
    expect(buildArgv("start", ["/vm.vmx", "nogui"])).toEqual([
      "start",
      "/vm.vmx",
      "nogui",
    ]);
  });
});

// ── Per-verb argv composition ─────────────────────────────────────

describe("VmrunBackend argv composition", () => {
  it("startVM shells `vmrun start <vmx> nogui` with the lifecycle timeout", async () => {
    const { backend, calls } = makeBackend({});
    await backend.startVM(VMX_HANDLE);
    expect(calls[0].args).toEqual([
      "start",
      "/Users/ops/VMs/alpha.vmx",
      "nogui",
    ]);
    expect(calls[0].timeoutMs).toBe(5 * 60_000);
  });

  it("stopVM passes 'soft' by default and 'hard' when force=true", async () => {
    const { backend: b1, calls: c1 } = makeBackend({});
    await b1.stopVM(VMX_HANDLE);
    expect(c1[0].args).toEqual(["stop", "/Users/ops/VMs/alpha.vmx", "soft"]);

    const { backend: b2, calls: c2 } = makeBackend({});
    await b2.stopVM(VMX_HANDLE, true);
    expect(c2[0].args).toEqual(["stop", "/Users/ops/VMs/alpha.vmx", "hard"]);
  });

  it("createCheckpoint shells `snapshot <vmx> <label>`", async () => {
    const { backend, calls } = makeBackend({});
    const cp = await backend.createCheckpoint(VMX_HANDLE, "clean-state");
    expect(calls[0].args).toEqual([
      "snapshot",
      "/Users/ops/VMs/alpha.vmx",
      "clean-state",
    ]);
    expect(cp.label).toBe("clean-state");
    expect(cp.vmHandle).toBe(VMX_HANDLE);
  });

  it("restoreCheckpoint shells `revertToSnapshot <vmx> <label>`", async () => {
    const { backend, calls } = makeBackend({});
    await backend.restoreCheckpoint({
      id: "clean-state",
      label: "clean-state",
      vmHandle: VMX_HANDLE,
    });
    expect(calls[0].args).toEqual([
      "revertToSnapshot",
      "/Users/ops/VMs/alpha.vmx",
      "clean-state",
    ]);
  });

  it("listVMs shells `list` and parses VMX paths into handles", async () => {
    const { backend, calls } = makeBackend({
      stdout: "Total running VMs: 1\n/Users/ops/VMs/alpha.vmx\n",
    });
    const vms = await backend.listVMs();
    expect(calls[0].args).toEqual(["list"]);
    expect(vms).toHaveLength(1);
    expect(vms[0].id).toBe("/Users/ops/VMs/alpha.vmx");
    expect(vms[0].name).toBe("alpha");
    expect(vms[0].backend).toBe("vmrun");
  });

  it("copyFileToVM emits -gu / -gp before the copy verb (S-14 surface)", async () => {
    const { backend, calls } = makeBackend({
      guestUser: "ci-user",
      guestPass: "super-secret",
    });
    await backend.copyFileToVM(VMX_HANDLE, "/tmp/host.txt", "/tmp/guest.txt");
    expect(calls[0].args).toEqual([
      "-gu",
      "ci-user",
      "-gp",
      "super-secret",
      "copyFileFromHostToGuest",
      "/Users/ops/VMs/alpha.vmx",
      "/tmp/host.txt",
      "/tmp/guest.txt",
    ]);
  });

  it("executeCommand emits -gu / -gp + runProgramInGuest -activeWindow + cmd + args", async () => {
    const { backend, calls } = makeBackend({
      guestUser: "ci-user",
      guestPass: "super-secret",
    });
    await backend.executeCommand(VMX_HANDLE, "/bin/echo", ["hello"], 10_000);
    expect(calls[0].args).toEqual([
      "-gu",
      "ci-user",
      "-gp",
      "super-secret",
      "runProgramInGuest",
      "/Users/ops/VMs/alpha.vmx",
      "-activeWindow",
      "/bin/echo",
      "hello",
    ]);
  });

  it("isAvailable shells `list` with a short timeout", async () => {
    const { backend, calls } = makeBackend({});
    await backend.isAvailable();
    expect(calls[0].args).toEqual(["list"]);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("getVmIpAddress shells `getGuestIPAddress <vmx> -wait`", async () => {
    const { backend, calls } = makeBackend({ stdout: "10.0.0.7\n" });
    const ip = await backend.getVmIpAddress(VMX_HANDLE);
    expect(calls[0].args).toEqual([
      "getGuestIPAddress",
      "/Users/ops/VMs/alpha.vmx",
      "-wait",
    ]);
    expect(ip).toBe("10.0.0.7");
  });

  it("refuses to operate on handles without a .vmx id", async () => {
    const { backend } = makeBackend({});
    await expect(
      backend.startVM({ id: "alpha", name: "alpha", backend: "vmrun" }),
    ).rejects.toMatchObject({ code: "vmx_path_required" });
  });

  it("deleteCheckpoint shells `deleteSnapshot <vmx> <label>`", async () => {
    const { backend, calls } = makeBackend({});
    await backend.deleteCheckpoint({
      id: "snap",
      label: "snap",
      vmHandle: VMX_HANDLE,
    });
    expect(calls[0].args).toEqual([
      "deleteSnapshot",
      "/Users/ops/VMs/alpha.vmx",
      "snap",
    ]);
  });

  it("listCheckpoints shells `listSnapshots <vmx>`", async () => {
    const { backend, calls } = makeBackend({
      stdout: "Total snapshots: 1\nsnap\n",
    });
    const snaps = await backend.listCheckpoints(VMX_HANDLE);
    expect(calls[0].args).toEqual([
      "listSnapshots",
      "/Users/ops/VMs/alpha.vmx",
    ]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].label).toBe("snap");
  });
});
