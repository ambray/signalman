/**
 * libvirt backend integration tests (v0.4.0-4 cross-platform Chunk 2).
 *
 * These tests build a `LibvirtBackend` whose injected exec returns
 * fixture text loaded from `host/src/__tests__/fixtures/virsh-*.txt`,
 * exercise the public methods end-to-end, and assert on the parsed
 * shape returned. Pairs with `libvirt-argv.test.ts` which covers
 * argv composition directly.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  LibvirtBackend,
  LibvirtBackendError,
  QGA_FILE_CHUNK_BYTES,
} from "../hypervisors/libvirt.js";

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

  it("getStatus returns running + IPv4 + reachable QGA + memoryUsedMB when guest-ping + dominfo both succeed", async () => {
    // Use a custom exec instead of makeStubBackend: the verb-dispatch
    // helper folds all qemu-* args away when finding the verb, so it
    // can't distinguish qemu-agent-command from a regular virsh verb.
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const verb = args[0];
        if (verb === "domstate") {
          return { stdout: fixtures.domstateRunning, stderr: "", exitCode: 0 };
        }
        if (verb === "domifaddr") {
          return { stdout: fixtures.domifaddr, stderr: "", exitCode: 0 };
        }
        if (verb === "qemu-agent-command") {
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        }
        if (verb === "dominfo") {
          return {
            stdout:
              "Id:             1\nName:           vm-alpha\nState:          running\n" +
              "Max memory:     4194304 KiB\nUsed memory:    2097152 KiB\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const status = await backend.getStatus(HANDLE);
    expect(status.state).toBe("running");
    expect(status.ipAddress).toBe("192.168.122.42");
    expect(status.guestAgentReachable).toBe(true);
    expect(status.memoryUsedMB).toBe(2048);
    // uptimeSeconds intentionally undefined on libvirt — see getStatus
    // comment. virsh doesn't expose wall-clock uptime.
    expect(status.uptimeSeconds).toBeUndefined();
  });

  it("getStatus leaves memoryUsedMB undefined when dominfo fails", async () => {
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const verb = args[0];
        if (verb === "domstate") {
          return { stdout: fixtures.domstateRunning, stderr: "", exitCode: 0 };
        }
        if (verb === "domifaddr") {
          return { stdout: fixtures.domifaddr, stderr: "", exitCode: 0 };
        }
        if (verb === "qemu-agent-command") {
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        }
        if (verb === "dominfo") {
          return { stdout: "", stderr: "error: dominfo failed", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const status = await backend.getStatus(HANDLE);
    expect(status.state).toBe("running");
    expect(status.memoryUsedMB).toBeUndefined();
  });

  it("getStatus reports guestAgentReachable=false when guest-ping errors", async () => {
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const verb = args[0];
        if (verb === "domstate") {
          return { stdout: fixtures.domstateRunning, stderr: "", exitCode: 0 };
        }
        if (verb === "domifaddr") {
          return { stdout: fixtures.domifaddr, stderr: "", exitCode: 0 };
        }
        if (verb === "qemu-agent-command") {
          return {
            stdout: "",
            stderr: "error: Guest agent is not responding",
            exitCode: 1,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const status = await backend.getStatus(HANDLE);
    expect(status.state).toBe("running");
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

  it("getVmIpAddress falls back from lease to agent when lease has no IPv4", async () => {
    // The default makeStubBackend keys responses by verb — both calls
    // hit the `domifaddr` verb. Use a custom exec that distinguishes
    // by the `--source` flag value so we can hand the agent path a
    // valid lease while the lease path returns empty.
    const calls: string[] = [];
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const source = args[args.indexOf("--source") + 1];
        calls.push(source);
        if (source === "lease") {
          return { stdout: "Name   MAC   Protocol   Address\n----\n", stderr: "", exitCode: 0 };
        }
        if (source === "agent") {
          return {
            stdout:
              " Name       MAC address          Protocol     Address\n" +
              "-------------------------------------------------------------------------------\n" +
              " ens3       52:54:00:aa:bb:cc    ipv4         10.0.0.99/24\n",
            stderr: "",
            exitCode: 0,
          };
        }
        // arp branch wouldn't be hit in the success case
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const ip = await backend.getVmIpAddress(HANDLE);
    expect(ip).toBe("10.0.0.99");
    expect(calls).toEqual(["lease", "agent"]);
  });

  it("getVmIpAddress throws network_unavailable when all three sources fail", async () => {
    const calls: string[] = [];
    const backend = new LibvirtBackend({
      exec: async (args) => {
        const source = args[args.indexOf("--source") + 1];
        calls.push(source);
        return { stdout: "", stderr: "no addresses", exitCode: 1 };
      },
    });
    await expect(backend.getVmIpAddress(HANDLE)).rejects.toMatchObject({
      code: "network_unavailable",
    });
    expect(calls).toEqual(["lease", "agent", "arp"]);
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

  describe("createVM", () => {
    const POOL_XML =
      "<pool type='dir'>\n" +
      "  <name>default</name>\n" +
      "  <target><path>/var/lib/libvirt/images</path></target>\n" +
      "</pool>";
    type VirshCall = { args: string[] };

    /**
     * Build a backend whose `exec` dispatches on the virsh verb.
     * vol-path is special-cased to synthesize a pool-aware path so
     * assertions on the resolved disk location don't need a fixture.
     */
    function buildCreateBackend(opts: {
      virshResponses?: Partial<
        Record<string, { stdout?: string; stderr?: string; exitCode?: number }>
      >;
      storagePool?: string;
      synthesizedPoolPath?: string;
    }) {
      const virshCalls: VirshCall[] = [];
      const poolPath = opts.synthesizedPoolPath ?? "/var/lib/libvirt/images";
      const backend = new LibvirtBackend({
        storagePool: opts.storagePool,
        exec: async (args) => {
          virshCalls.push({ args });
          const verb = args[0];
          // vol-path lookup: synthesize the path libvirt would have
          // returned (pool path + volume name) unless the test
          // explicitly overrides the response.
          if (verb === "vol-path" && !opts.virshResponses?.["vol-path"]) {
            const volName = args[args.length - 1];
            return {
              stdout: `${poolPath}/${volName}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          const r = opts.virshResponses?.[verb];
          return {
            stdout: r?.stdout ?? "",
            stderr: r?.stderr ?? "",
            exitCode: r?.exitCode ?? 0,
          };
        },
      });
      return { backend, virshCalls };
    }

    it("validates the pool, creates a libvirt-managed volume via vol-create-as, then defines the domain", async () => {
      const { backend, virshCalls } = buildCreateBackend({
        virshResponses: {
          "pool-dumpxml": { stdout: POOL_XML },
        },
      });
      const handle = await backend.createVM({
        name: "vm-new",
        template: "/var/lib/libvirt/templates/ubuntu-noble.qcow2",
        memoryMB: 4096,
        cpus: 4,
        diskGB: 10,
      });
      expect(handle).toEqual({
        id: "vm-new",
        name: "vm-new",
        backend: "libvirt",
      });
      // Sequence: pool-dumpxml → vol-create-as → vol-path → define
      expect(virshCalls[0].args).toEqual(["pool-dumpxml", "default"]);
      const volCreate = virshCalls.find((c) => c.args[0] === "vol-create-as");
      expect(volCreate).toBeDefined();
      expect(volCreate!.args).toEqual([
        "vol-create-as",
        "default",
        "vm-new.qcow2",
        "10G",
        "--format",
        "qcow2",
        "--backing-vol",
        "/var/lib/libvirt/templates/ubuntu-noble.qcow2",
        "--backing-vol-format",
        "qcow2",
      ]);
      const volPath = virshCalls.find((c) => c.args[0] === "vol-path");
      expect(volPath).toBeDefined();
      expect(volPath!.args).toEqual([
        "vol-path",
        "--pool",
        "default",
        "vm-new.qcow2",
      ]);
      const defineCall = virshCalls.find((c) => c.args[0] === "define");
      expect(defineCall).toBeDefined();
      expect(defineCall!.args.length).toBe(2);
      expect(path.isAbsolute(defineCall!.args[1])).toBe(true);
    });

    it("defaults diskGB when the caller omits it", async () => {
      const { backend, virshCalls } = buildCreateBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL_XML } },
      });
      await backend.createVM({
        name: "vm-x",
        template: "/abs/tpl.qcow2",
      });
      const volCreate = virshCalls.find((c) => c.args[0] === "vol-create-as");
      expect(volCreate).toBeDefined();
      // DEFAULT_DISK_GB sized capacity arg, format `${N}G`.
      const capacityArg = volCreate!.args[3];
      expect(capacityArg).toMatch(/^\d+G$/);
    });

    it("rejects when config.template is missing", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL_XML } },
      });
      await expect(
        backend.createVM({ name: "vm-new" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("rejects a template path that isn't absolute", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL_XML } },
      });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "relative/path.qcow2",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("rejects out-of-range memory, cpus, or diskGB with invalid_argument", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL_XML } },
      });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
          memoryMB: 0,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
          cpus: 999,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
          diskGB: 0,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("surfaces invalid_argument with a copy-pasteable repair hint when the pool is missing", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: {
          "pool-dumpxml": {
            stderr: "error: failed to get pool 'default'",
            exitCode: 1,
          },
        },
      });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
        }),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("virsh pool-define-as default"),
      });
    });

    it("surfaces command_failed when vol-create-as fails", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: {
          "pool-dumpxml": { stdout: POOL_XML },
          "vol-create-as": {
            stderr:
              "error: Failed to create vol vm-new.qcow2: backing image not found",
            exitCode: 1,
          },
        },
      });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
        }),
      ).rejects.toMatchObject({ code: "command_failed" });
    });

    it("surfaces command_failed when vol-path returns empty", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: {
          "pool-dumpxml": { stdout: POOL_XML },
          "vol-path": { stdout: "", exitCode: 0 },
        },
      });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
        }),
      ).rejects.toMatchObject({ code: "command_failed" });
    });

    it("surfaces command_failed when virsh define fails", async () => {
      const { backend } = buildCreateBackend({
        virshResponses: {
          "pool-dumpxml": { stdout: POOL_XML },
          define: {
            stderr: "error: Failed to define domain from /tmp/foo.xml",
            exitCode: 1,
          },
        },
      });
      await expect(
        backend.createVM({
          name: "vm-new",
          template: "/abs/tpl.qcow2",
        }),
      ).rejects.toMatchObject({ code: "command_failed" });
    });

    it("honors a custom storagePool option", async () => {
      const { backend, virshCalls } = buildCreateBackend({
        storagePool: "ssd-pool",
        synthesizedPoolPath: "/mnt/ssd/images",
        virshResponses: {
          "pool-dumpxml": {
            stdout:
              "<pool><target><path>/mnt/ssd/images</path></target></pool>",
          },
        },
      });
      await backend.createVM({ name: "vm-x", template: "/abs/tpl.qcow2" });
      const volCreate = virshCalls.find((c) => c.args[0] === "vol-create-as");
      expect(volCreate!.args[1]).toBe("ssd-pool");
      // vol-path synthesized to /mnt/ssd/images/vm-x.qcow2 by the stub.
      const defineCall = virshCalls.find((c) => c.args[0] === "define");
      expect(defineCall).toBeDefined();
    });

    // ── osProfile resolution ────────────────────────────────────

    /**
     * Build a backend that captures the XML written to the
     * tempfile before `virsh define` runs. We snapshot the file
     * inside the exec callback (synchronously async — fs.readFile)
     * so the cleanup-on-finally doesn't race the read.
     */
    function buildXmlCapturingBackend(opts: {
      storagePool?: string;
      virshResponses?: Partial<
        Record<string, { stdout?: string; stderr?: string; exitCode?: number }>
      >;
    }) {
      let capturedXml = "";
      const virshCalls: VirshCall[] = [];
      const backend = new LibvirtBackend({
        storagePool: opts.storagePool,
        exec: async (args) => {
          virshCalls.push({ args });
          const verb = args[0];
          if (verb === "define") {
            // Synchronously read the XML file before returning
            // success — the cleanup finally only fires after we
            // resolve, so we're safe.
            try {
              capturedXml = await fsp.readFile(args[1], "utf8");
            } catch {
              // ignore
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          if (verb === "vol-path" && !opts.virshResponses?.["vol-path"]) {
            const volName = args[args.length - 1];
            return {
              stdout: `/var/lib/libvirt/images/${volName}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          const r = opts.virshResponses?.[verb];
          return {
            stdout: r?.stdout ?? "",
            stderr: r?.stderr ?? "",
            exitCode: r?.exitCode ?? 0,
          };
        },
      });
      return {
        backend,
        virshCalls,
        getXml: () => capturedXml,
      };
    }

    it("defaults osProfile to 'linux' for backwards compat", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend, getXml } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await backend.createVM({
        name: "vm-default",
        template: "/abs/tpl.qcow2",
      });
      const xml = getXml();
      // linux baseline: BIOS (no firmware='efi'), virtio, no TPM,
      // no SMM, UTC clock, no tablet input.
      expect(xml).not.toContain("firmware='efi'");
      expect(xml).toContain("<target dev='vda' bus='virtio'/>");
      expect(xml).toContain("<clock offset='utc'/>");
      expect(xml).not.toContain("<tpm");
      expect(xml).not.toContain("<input type='tablet'");
    });

    it("osProfile 'windows-11' renders UEFI + Secure Boot + TPM 2.0 + SMM", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend, getXml } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await backend.createVM({
        name: "win11",
        template: "/abs/win11-tpl.qcow2",
        osProfile: "windows-11",
      });
      const xml = getXml();
      expect(xml).toContain("<os firmware='efi'>");
      expect(xml).toContain("<feature enabled='yes' name='secure-boot'/>");
      expect(xml).toContain("<feature enabled='yes' name='enrolled-keys'/>");
      expect(xml).toContain("<smm state='on'/>");
      expect(xml).toContain("<tpm model='tpm-crb'>");
      expect(xml).toContain("<backend type='emulator' version='2.0'/>");
      expect(xml).toContain("<clock offset='localtime'>");
      expect(xml).toContain("<input type='tablet' bus='usb'/>");
    });

    it("osProfile 'windows-11' refuses operator override that disables Secure Boot", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "win11",
          template: "/abs/win11-tpl.qcow2",
          osProfile: "windows-11",
          secureBoot: false,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("osProfile 'windows-11' refuses operator override that disables TPM", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "win11",
          template: "/abs/win11-tpl.qcow2",
          osProfile: "windows-11",
          tpm: "none",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("osProfile 'windows-11' refuses operator override to BIOS firmware", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "win11",
          template: "/abs/win11-tpl.qcow2",
          osProfile: "windows-11",
          firmware: "bios",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("osProfile 'windows-10' allows operator to opt into TPM + Secure Boot", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend, getXml } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await backend.createVM({
        name: "win10-secure",
        template: "/abs/win10-tpl.qcow2",
        osProfile: "windows-10",
        secureBoot: true,
        tpm: "tpm-2.0",
      });
      const xml = getXml();
      expect(xml).toContain("<feature enabled='yes' name='secure-boot'/>");
      expect(xml).toContain("<smm state='on'/>");
      expect(xml).toContain("<tpm model='tpm-crb'>");
    });

    it("osProfile 'windows-10' supports operator-overridden SATA disk + e1000e NIC for the no-virtio-driver path", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend, getXml } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await backend.createVM({
        name: "win10-bare",
        template: "/abs/win10-tpl.qcow2",
        osProfile: "windows-10",
        diskBus: "sata",
        nicModel: "e1000e",
      });
      const xml = getXml();
      expect(xml).toContain("<target dev='sda' bus='sata'/>");
      expect(xml).toContain("<model type='e1000e'/>");
    });

    it("rejects osProfile 'macos' with a 'use Tart' message", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "macos-vm",
          template: "/abs/tpl.qcow2",
          // @ts-expect-error — macos is intentionally outside the union type
          osProfile: "macos",
        }),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("Tart"),
      });
    });

    it("rejects unknown osProfile values", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "vm-x",
          template: "/abs/tpl.qcow2",
          // @ts-expect-error — bogus value
          osProfile: "freebsd",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("refuses secureBoot override when firmware='bios'", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "vm-bad",
          template: "/abs/tpl.qcow2",
          osProfile: "linux",
          // linux default is BIOS; secureBoot=true conflicts.
          secureBoot: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("refuses tpm override when firmware='bios'", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "vm-bad",
          template: "/abs/tpl.qcow2",
          osProfile: "linux",
          tpm: "tpm-2.0",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });

    it("extraCdroms: emits the CDROM disks in the produced XML", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend, getXml } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await backend.createVM({
        name: "win-vm",
        template: "/abs/win11.qcow2",
        osProfile: "windows-11",
        extraCdroms: ["/iso/virtio-win.iso", "/iso/win11.iso"],
      });
      const xml = getXml();
      expect(xml).toContain("<source file='/iso/virtio-win.iso'/>");
      expect(xml).toContain("<source file='/iso/win11.iso'/>");
      expect((xml.match(/device='cdrom'/g) ?? []).length).toBe(2);
    });

    it("extraCdroms: rejects relative paths with invalid_argument", async () => {
      const POOL =
        "<pool><target><path>/var/lib/libvirt/images</path></target></pool>";
      const { backend } = buildXmlCapturingBackend({
        virshResponses: { "pool-dumpxml": { stdout: POOL } },
      });
      await expect(
        backend.createVM({
          name: "vm-bad",
          template: "/abs/tpl.qcow2",
          extraCdroms: ["relative/path.iso"],
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    });
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

  // ── QGA file transfer ──────────────────────────────────────────

  describe("copyFileToVM", () => {
    const tmpFiles: string[] = [];
    afterEach(async () => {
      while (tmpFiles.length > 0) {
        const f = tmpFiles.pop()!;
        await fsp.unlink(f).catch(() => undefined);
      }
    });
    async function makeHostFile(contents: Buffer | string): Promise<string> {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "libvirt-m2-"));
      const file = path.join(dir, "src");
      await fsp.writeFile(file, contents);
      tmpFiles.push(file);
      return file;
    }

    it("opens with mode=w, writes the host file in chunks, then closes", async () => {
      const contents = Buffer.from("hello QGA world\n", "utf8");
      const hostFile = await makeHostFile(contents);
      const sequence: { execute: string; payload: object }[] = [];
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as {
            execute: string;
            arguments?: Record<string, unknown>;
          };
          sequence.push({ execute: payload.execute, payload: payload.arguments ?? {} });
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":17}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-write") {
            return {
              stdout: '{"return":{"count":16,"eof":false}}',
              stderr: "",
              exitCode: 0,
            };
          }
          // guest-file-close
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await backend.copyFileToVM(HANDLE, hostFile, "/tmp/dst");
      expect(sequence.map((s) => s.execute)).toEqual([
        "guest-file-open",
        "guest-file-write",
        "guest-file-close",
      ]);
      const openArgs = sequence[0].payload as { path: string; mode: string };
      expect(openArgs).toEqual({ path: "/tmp/dst", mode: "w" });
      const writeArgs = sequence[1].payload as { handle: number; "buf-b64": string };
      expect(writeArgs.handle).toBe(17);
      expect(Buffer.from(writeArgs["buf-b64"], "base64").toString("utf8")).toBe(
        "hello QGA world\n",
      );
      const closeArgs = sequence[2].payload as { handle: number };
      expect(closeArgs.handle).toBe(17);
    });

    it("opens + closes even when the host file is empty (no write call)", async () => {
      const hostFile = await makeHostFile("");
      const verbs: string[] = [];
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          verbs.push(payload.execute);
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":9}', stderr: "", exitCode: 0 };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await backend.copyFileToVM(HANDLE, hostFile, "/tmp/empty");
      expect(verbs).toEqual(["guest-file-open", "guest-file-close"]);
    });

    it("chunks files larger than QGA_FILE_CHUNK_BYTES into multiple writes", async () => {
      // 2.5 chunks worth of data — ensures the loop terminates only
      // when fs.read reports 0 bytes, not after a fixed chunk count.
      const bytes = Math.floor(QGA_FILE_CHUNK_BYTES * 2.5);
      const buf = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i += 1) buf[i] = i % 256;
      const hostFile = await makeHostFile(buf);
      const writeChunks: Buffer[] = [];
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as {
            execute: string;
            arguments?: { "buf-b64"?: string };
          };
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":1}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-write") {
            writeChunks.push(
              Buffer.from(payload.arguments!["buf-b64"]!, "base64"),
            );
            return {
              stdout: '{"return":{"count":1,"eof":false}}',
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await backend.copyFileToVM(HANDLE, hostFile, "/tmp/big");
      expect(writeChunks.length).toBe(3);
      expect(writeChunks[0].length).toBe(QGA_FILE_CHUNK_BYTES);
      expect(writeChunks[1].length).toBe(QGA_FILE_CHUNK_BYTES);
      expect(writeChunks[2].length).toBe(bytes - 2 * QGA_FILE_CHUNK_BYTES);
      const combined = Buffer.concat(writeChunks);
      expect(combined.length).toBe(bytes);
      expect(combined.equals(buf)).toBe(true);
    });

    it("still closes the guest handle when a chunk write fails midway", async () => {
      const hostFile = await makeHostFile(Buffer.alloc(QGA_FILE_CHUNK_BYTES * 2));
      const verbs: string[] = [];
      let writeCount = 0;
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          verbs.push(payload.execute);
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":5}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-write") {
            writeCount += 1;
            if (writeCount === 1) {
              return {
                stdout: '{"return":{"count":1,"eof":false}}',
                stderr: "",
                exitCode: 0,
              };
            }
            return {
              stdout: "",
              stderr: "guest-file-write: disk full",
              exitCode: 1,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await expect(
        backend.copyFileToVM(HANDLE, hostFile, "/tmp/dst"),
      ).rejects.toMatchObject({ code: "copy_failed" });
      // Even on failure, the close is attempted — the guest must not
      // leak file handles when the host gives up partway through.
      expect(verbs).toContain("guest-file-close");
    });

    it("surfaces copy_failed when guest-file-open returns a non-numeric handle", async () => {
      const hostFile = await makeHostFile("x");
      const backend = new LibvirtBackend({
        exec: async () => ({
          stdout: '{"return":"not-a-number"}',
          stderr: "",
          exitCode: 0,
        }),
      });
      await expect(
        backend.copyFileToVM(HANDLE, hostFile, "/tmp/dst"),
      ).rejects.toMatchObject({ code: "copy_failed" });
    });

    it("invokes progress callback with (bytesTransferred, totalBytes) at start + after each chunk", async () => {
      // 2.5 chunks worth of data → 4 callback events expected:
      // (0, total), (chunk1, total), (chunk1+chunk2, total),
      // (chunk1+chunk2+remainder, total).
      const bytes = Math.floor(QGA_FILE_CHUNK_BYTES * 2.5);
      const hostFile = await makeHostFile(Buffer.alloc(bytes));
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":11}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-write") {
            return {
              stdout: '{"return":{"count":1,"eof":false}}',
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      const events: Array<[number, number]> = [];
      await backend.copyFileToVM(HANDLE, hostFile, "/tmp/dst", (bt, tb) => {
        events.push([bt, tb]);
      });
      expect(events[0]).toEqual([0, bytes]);
      expect(events[events.length - 1]).toEqual([bytes, bytes]);
      // Strictly monotonic; bytesTransferred never exceeds totalBytes.
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i][0]).toBeGreaterThanOrEqual(events[i - 1][0]);
        expect(events[i][0]).toBeLessThanOrEqual(events[i][1]);
        expect(events[i][1]).toBe(bytes);
      }
    });
  });

  describe("copyFileFromVM", () => {
    const tmpDirs: string[] = [];
    afterEach(async () => {
      while (tmpDirs.length > 0) {
        const d = tmpDirs.pop()!;
        await fsp.rm(d, { recursive: true, force: true });
      }
    });
    async function makeHostTarget(): Promise<string> {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "libvirt-m2-"));
      tmpDirs.push(dir);
      return path.join(dir, "dst");
    }

    it("reads guest file in chunks until eof and writes to the host", async () => {
      const target = await makeHostTarget();
      const part1 = Buffer.from("foo");
      const part2 = Buffer.from("bar");
      let readCount = 0;
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":3}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-read") {
            readCount += 1;
            const chunk = readCount === 1 ? part1 : part2;
            const eof = readCount >= 2;
            return {
              stdout: JSON.stringify({
                return: {
                  count: chunk.length,
                  "buf-b64": chunk.toString("base64"),
                  eof,
                },
              }),
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await backend.copyFileFromVM(HANDLE, "/guest/src", target);
      const written = await fsp.readFile(target);
      expect(written.equals(Buffer.concat([part1, part2]))).toBe(true);
    });

    it("handles eof on the first read (empty guest file)", async () => {
      const target = await makeHostTarget();
      const verbs: string[] = [];
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          verbs.push(payload.execute);
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":42}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-read") {
            return {
              stdout: '{"return":{"count":0,"eof":true}}',
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await backend.copyFileFromVM(HANDLE, "/guest/empty", target);
      expect(verbs).toEqual([
        "guest-file-open",
        "guest-file-read",
        "guest-file-close",
      ]);
      const written = await fsp.readFile(target);
      expect(written.length).toBe(0);
    });

    it("still closes the guest handle when a read fails midway", async () => {
      const target = await makeHostTarget();
      const verbs: string[] = [];
      let reads = 0;
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          verbs.push(payload.execute);
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":7}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-read") {
            reads += 1;
            if (reads === 1) {
              return {
                stdout:
                  '{"return":{"count":3,"buf-b64":"Zm9v","eof":false}}',
                stderr: "",
                exitCode: 0,
              };
            }
            return {
              stdout: "",
              stderr: "guest-file-read: I/O error",
              exitCode: 1,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      await expect(
        backend.copyFileFromVM(HANDLE, "/guest/src", target),
      ).rejects.toMatchObject({ code: "copy_failed" });
      expect(verbs).toContain("guest-file-close");
    });

    it("invokes progress callback with bytesTransferred as both args (total unknown)", async () => {
      // Guest sends two non-trivial chunks then EOF. Expect 3 events:
      // (0, 0), (chunk1, chunk1), (chunk1+chunk2, chunk1+chunk2).
      const target = await makeHostTarget();
      const part1 = Buffer.from("hello");
      const part2 = Buffer.from("world!");
      let reads = 0;
      const backend = new LibvirtBackend({
        exec: async (args) => {
          const payload = JSON.parse(args[args.length - 1]) as { execute: string };
          if (payload.execute === "guest-file-open") {
            return { stdout: '{"return":17}', stderr: "", exitCode: 0 };
          }
          if (payload.execute === "guest-file-read") {
            reads += 1;
            const chunk = reads === 1 ? part1 : part2;
            const eof = reads >= 2;
            return {
              stdout: JSON.stringify({
                return: {
                  count: chunk.length,
                  "buf-b64": chunk.toString("base64"),
                  eof,
                },
              }),
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
        },
      });
      const events: Array<[number, number]> = [];
      await backend.copyFileFromVM(HANDLE, "/guest/src", target, (bt, tb) => {
        events.push([bt, tb]);
      });
      expect(events[0]).toEqual([0, 0]);
      // After each chunk, bytesTransferred grows; total mirrors it
      // since guest-side total is unknown.
      expect(events[events.length - 1][0]).toBe(part1.length + part2.length);
      expect(events[events.length - 1][0]).toBe(events[events.length - 1][1]);
    });
  });

  // ── waitForHeartbeat / setVmMemory / setVmProcessor ─────────────

  describe("waitForHeartbeat", () => {
    it("returns true on the first successful guest-ping", async () => {
      let pings = 0;
      const backend = new LibvirtBackend({
        exec: async (args) => {
          if (args[0] === "qemu-agent-command") {
            pings += 1;
            return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      expect(await backend.waitForHeartbeat(HANDLE, 1_000)).toBe(true);
      expect(pings).toBe(1);
    });

    it("returns true after several failed pings once the agent comes up", async () => {
      let pings = 0;
      const backend = new LibvirtBackend({
        exec: async (args) => {
          if (args[0] === "qemu-agent-command") {
            pings += 1;
            if (pings < 3) {
              return {
                stdout: "",
                stderr: "Guest agent is not responding",
                exitCode: 1,
              };
            }
            return { stdout: '{"return":{}}', stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      expect(await backend.waitForHeartbeat(HANDLE, 5_000)).toBe(true);
      expect(pings).toBe(3);
    });

    it("returns false when the deadline expires", async () => {
      const backend = new LibvirtBackend({
        exec: async (args) => {
          if (args[0] === "qemu-agent-command") {
            return {
              stdout: "",
              stderr: "Guest agent is not responding",
              exitCode: 1,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      // 0ms deadline guarantees a single probe + return false.
      expect(await backend.waitForHeartbeat(HANDLE, 0)).toBe(false);
    });
  });

  describe("setVmMemory", () => {
    it("issues setmaxmem then setmem with --config and KiB units", async () => {
      const calls: string[][] = [];
      const backend = new LibvirtBackend({
        exec: async (args) => {
          calls.push(args);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      await backend.setVmMemory(HANDLE, 4096);
      expect(calls[0]).toEqual([
        "setmaxmem",
        "vm-alpha",
        "4194304K",
        "--config",
      ]);
      expect(calls[1]).toEqual([
        "setmem",
        "vm-alpha",
        "4194304K",
        "--config",
      ]);
    });

    it("rejects out-of-range memory values with invalid_argument", async () => {
      const backend = new LibvirtBackend({
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      });
      await expect(backend.setVmMemory(HANDLE, 0)).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(backend.setVmMemory(HANDLE, 1_048_577)).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(backend.setVmMemory(HANDLE, 1024.5)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    });

    it("surfaces command_failed when setmaxmem returns non-zero", async () => {
      const backend = new LibvirtBackend({
        exec: async (args) => {
          if (args[0] === "setmaxmem") {
            return {
              stdout: "",
              stderr: "error: maximum memory must be at least 32MiB",
              exitCode: 1,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      await expect(backend.setVmMemory(HANDLE, 2048)).rejects.toMatchObject({
        code: "command_failed",
      });
    });
  });

  describe("setVmProcessor", () => {
    it("issues setvcpus --maximum --config then setvcpus --config", async () => {
      const calls: string[][] = [];
      const backend = new LibvirtBackend({
        exec: async (args) => {
          calls.push(args);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      await backend.setVmProcessor(HANDLE, 4);
      expect(calls[0]).toEqual([
        "setvcpus",
        "vm-alpha",
        "4",
        "--maximum",
        "--config",
      ]);
      expect(calls[1]).toEqual([
        "setvcpus",
        "vm-alpha",
        "4",
        "--config",
      ]);
    });

    it("rejects out-of-range vCPU counts with invalid_argument", async () => {
      const backend = new LibvirtBackend({
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      });
      await expect(backend.setVmProcessor(HANDLE, 0)).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(backend.setVmProcessor(HANDLE, 241)).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(backend.setVmProcessor(HANDLE, 2.5)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    });

    it("surfaces command_failed when setvcpus returns non-zero", async () => {
      const backend = new LibvirtBackend({
        exec: async (args) => {
          if (args[0] === "setvcpus" && args.includes("--maximum")) {
            return {
              stdout: "",
              stderr: "error: vCPU count exceeds maximum",
              exitCode: 1,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      await expect(backend.setVmProcessor(HANDLE, 8)).rejects.toMatchObject({
        code: "command_failed",
      });
    });
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
