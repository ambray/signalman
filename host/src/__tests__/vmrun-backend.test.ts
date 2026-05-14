/**
 * vmrun backend integration tests (v0.4.0-4 cross-platform Chunk 3).
 *
 * Mirrors `libvirt-backend.test.ts`. Builds a `VmrunBackend` whose
 * injected exec returns fixture text and asserts on parsed shape +
 * error-code dispatch.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { VmrunBackend, VmrunBackendError } from "../hypervisors/vmrun.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "fixtures");

const fixtures = {
  list: "",
  listSnapshots: "",
};

beforeAll(() => {
  fixtures.list = readFileSync(
    path.join(fixturesDir, "vmrun-list.txt"),
    "utf8",
  );
  fixtures.listSnapshots = readFileSync(
    path.join(fixturesDir, "vmrun-listSnapshots.txt"),
    "utf8",
  );
});

/** Build a backend whose exec returns canned output keyed by the verb. */
function makeStubBackend(
  responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
  opts?: { guestUser?: string; guestPass?: string },
) {
  return new VmrunBackend({
    guestUser: opts?.guestUser,
    guestPass: opts?.guestPass,
    exec: async (args) => {
      // The verb is the first arg that isn't -gu/-gp + their values.
      let i = 0;
      while (i < args.length) {
        if (args[i] === "-gu" || args[i] === "-gp") {
          i += 2; // skip flag + value
          continue;
        }
        break;
      }
      const verb = args[i] ?? "";
      const canned = responses[verb] ?? {};
      return {
        stdout: canned.stdout ?? "",
        stderr: canned.stderr ?? "",
        exitCode: canned.exitCode ?? 0,
      };
    },
  });
}

const VMX_HANDLE = {
  id: "/Users/ops/VMs/alpha.vmx",
  name: "alpha",
  backend: "vmrun",
} as const;

describe("VmrunBackend integration", () => {
  it("listVMs parses `vmrun list` fixture output into VMHandles", async () => {
    const backend = makeStubBackend({ list: { stdout: fixtures.list } });
    const vms = await backend.listVMs();
    expect(vms.map((v) => v.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(vms.every((v) => v.backend === "vmrun")).toBe(true);
    expect(vms[0].id).toBe("/Users/ops/VMs/alpha.vmx");
  });

  it("getStatus reports running when the VM appears in the list", async () => {
    const backend = makeStubBackend({ list: { stdout: fixtures.list } });
    const status = await backend.getStatus(VMX_HANDLE);
    expect(status.state).toBe("running");
  });

  it("getStatus reports stopped when the VM is absent from the list", async () => {
    const backend = makeStubBackend({
      list: { stdout: "Total running VMs: 0\n" },
    });
    const status = await backend.getStatus(VMX_HANDLE);
    expect(status.state).toBe("stopped");
  });

  it("listCheckpoints parses every snapshot fixture row", async () => {
    const backend = makeStubBackend({
      listSnapshots: { stdout: fixtures.listSnapshots },
    });
    const snaps = await backend.listCheckpoints(VMX_HANDLE);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].label).toBe("clean-state");
    expect(snaps[1].label).toBe("post-install");
  });

  it("startVM is idempotent for an already-running VM", async () => {
    const backend = makeStubBackend({
      start: {
        stderr: "Error: The virtual machine is already powered on",
        exitCode: 1,
      },
    });
    await expect(backend.startVM(VMX_HANDLE)).resolves.toBeUndefined();
  });

  it("stopVM is idempotent for an already-stopped VM", async () => {
    const backend = makeStubBackend({
      stop: {
        stderr: "Error: The virtual machine is not powered on",
        exitCode: 1,
      },
    });
    await expect(backend.stopVM(VMX_HANDLE)).resolves.toBeUndefined();
  });

  it("surfaces vm_not_found when vmrun rejects the VMX path", async () => {
    const backend = makeStubBackend({
      start: {
        stderr: "Error: The file specified is not a valid virtual machine",
        exitCode: 1,
      },
    });
    await expect(backend.startVM(VMX_HANDLE)).rejects.toMatchObject({
      code: "vm_not_found",
    });
  });

  it("surfaces auth_failed when guest credentials are rejected", async () => {
    const backend = makeStubBackend(
      {
        runProgramInGuest: {
          stderr: "Error: Invalid user name or password for the guest OS",
          exitCode: 1,
        },
      },
      { guestUser: "ci-user", guestPass: "wrong-pass" },
    );
    // executeCommand routes through `run()` which classifies the
    // auth-failure stderr and throws VmrunBackendError(auth_failed).
    // The orchestrator catches that and surfaces it to the operator —
    // failing fast here is safer than reporting "exit 1" and letting
    // a downstream caller re-try the same broken credentials.
    await expect(
      backend.executeCommand(VMX_HANDLE, "/bin/true"),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("redacts the configured password from executeCommand stderr", async () => {
    const backend = makeStubBackend(
      {
        // Stderr that does NOT match `isAuthFailure` — exercises the
        // pass-through CommandResult branch where the password could
        // otherwise leak verbatim through the stderr field.
        runProgramInGuest: {
          stderr: "permission tweaks logged: 'super-secret' was tried",
          exitCode: 1,
        },
      },
      { guestUser: "ci", guestPass: "super-secret" },
    );
    const result = await backend.executeCommand(VMX_HANDLE, "/bin/true");
    expect(result.stderr).toContain("***REDACTED***");
    expect(result.stderr).not.toContain("super-secret");
  });

  it("surfaces vm_not_running when a guest-side op hits a stopped VM", async () => {
    const backend = makeStubBackend({
      copyFileFromHostToGuest: {
        stderr: "Error: The virtual machine is not powered on",
        exitCode: 1,
      },
    });
    await expect(
      backend.copyFileToVM(VMX_HANDLE, "/tmp/host", "/tmp/guest"),
    ).rejects.toMatchObject({ code: "vm_not_running" });
  });

  it("rejects empty commands with invalid_argument", async () => {
    const backend = makeStubBackend({});
    await expect(
      backend.executeCommand(VMX_HANDLE, "", []),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("createVM is unsupported_operation (vmrun has no programmatic create)", async () => {
    const backend = makeStubBackend({});
    await expect(
      backend.createVM({ name: "new-vm" }),
    ).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it("isAvailable returns false when vmrun is not installed", async () => {
    const backend = new VmrunBackend({
      exec: async () => {
        throw new VmrunBackendError(
          "vmrun_not_found",
          "Could not spawn 'vmrun'",
        );
      },
    });
    expect(await backend.isAvailable()).toBe(false);
  });

  it("isAvailable returns false when vmrun exits non-zero", async () => {
    const backend = makeStubBackend({
      list: { stderr: "some error", exitCode: 1 },
    });
    expect(await backend.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when `vmrun list` exits 0", async () => {
    const backend = makeStubBackend({ list: { stdout: fixtures.list } });
    expect(await backend.isAvailable()).toBe(true);
  });

  it("uses 'vmrun' as its name (registry-key invariant)", () => {
    const backend = new VmrunBackend();
    expect(backend.name).toBe("vmrun");
  });
});

describe("VmrunBackend selector registration", () => {
  it(
    "the vmrun backend appears in buildBackendList",
    async () => {
      const { buildBackendList } = await import("../hypervisors/selector.js");
      const { defaultConfig } = await import("../config.js");
      const names = buildBackendList(defaultConfig()).map((b) => b.name);
      expect(names).toContain("vmrun");
      // Both vmware and vmrun co-exist; the operator picks via
      // hypervisor.backend.
      expect(names).toContain("vmware");
    },
    // selector.ts pulls in service.ts which loads the gRPC proto;
    // 5s default sometimes loses to cold-cache disk I/O on Windows.
    30_000,
  );
});
