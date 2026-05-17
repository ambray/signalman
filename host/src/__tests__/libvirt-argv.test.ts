/**
 * libvirt backend argv-composition tests (v0.4.0-4 cross-platform Chunk 2).
 *
 * These tests assert on the argv shape the backend would pass to
 * `virsh` for each verb. They use the injectable exec callback so
 * nothing actually spawns `virsh`; the test recorder captures argv
 * and timeout and we assert on it directly.
 *
 * Separated from `libvirt-backend.test.ts` because argv composition
 * is the most-frequently-broken layer when adding new verbs, and
 * keeping the assertions in one file makes it easy to scan for
 * coverage of new operations.
 */

import { describe, it, expect } from "vitest";

import {
  LibvirtBackend,
  buildArgv,
  parseDomState,
  parseDomainList,
  parseDomIfAddrIpv4,
  parseSnapshotList,
  parseGuestExecPid,
  parseGuestExecStatus,
  parseGuestFileHandle,
  parseGuestFileRead,
  parsePoolTargetPath,
  buildDomainXml,
  resolveOsProfileDefaults,
  parseDomInfoUsedMemoryMB,
} from "../hypervisors/libvirt.js";
import type { OsProfileDefaults } from "../hypervisors/libvirt.js";

interface ExecCall {
  args: string[];
  timeoutMs: number;
}

/** Build a backend whose exec records the argv and returns canned stdout. */
function makeBackend(opts: {
  connectUri?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const calls: ExecCall[] = [];
  const backend = new LibvirtBackend({
    connectUri: opts.connectUri,
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

const HANDLE = { id: "vm-alpha", name: "vm-alpha", backend: "libvirt" } as const;

// ── buildArgv unit tests ──────────────────────────────────────────

describe("buildArgv", () => {
  it("splices the connect URI before the verb when supplied", () => {
    expect(buildArgv("list", ["--all"], "qemu:///system")).toEqual([
      "-c",
      "qemu:///system",
      "list",
      "--all",
    ]);
  });

  it("omits the connect-URI prefix when undefined", () => {
    expect(buildArgv("list", ["--all"])).toEqual(["list", "--all"]);
  });
});

// ── Parsers ────────────────────────────────────────────────────────

describe("parseDomState", () => {
  it("maps libvirt 'running' verbatim", () => {
    expect(parseDomState("running\n")).toBe("running");
  });

  it("maps 'shut off' (with internal space) to stopped", () => {
    expect(parseDomState("shut off\n")).toBe("stopped");
  });

  it("collapses 'shutoff' (no-space variant) to stopped", () => {
    expect(parseDomState("shutoff")).toBe("stopped");
  });

  it("collapses 'crashed' to stopped — orchestrator treats it the same", () => {
    expect(parseDomState("crashed")).toBe("stopped");
  });

  it("maps 'paused' verbatim", () => {
    expect(parseDomState("paused")).toBe("paused");
  });

  it("maps 'pmsuspended' to saved (memory-on-disk)", () => {
    expect(parseDomState("pmsuspended")).toBe("saved");
  });

  it("falls back to 'unknown' for anything else", () => {
    expect(parseDomState("totally-novel-state")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(parseDomState("RUNNING")).toBe("running");
  });
});

describe("parseDomainList", () => {
  it("returns one entry per non-blank line", () => {
    expect(parseDomainList("vm-alpha\nvm-beta\nvm-gamma\n")).toEqual([
      "vm-alpha",
      "vm-beta",
      "vm-gamma",
    ]);
  });

  it("skips blank lines and trims whitespace", () => {
    expect(parseDomainList("  vm-alpha  \n\n  vm-beta\n")).toEqual([
      "vm-alpha",
      "vm-beta",
    ]);
  });

  it("returns [] on empty output", () => {
    expect(parseDomainList("")).toEqual([]);
  });
});

describe("parseDomIfAddrIpv4", () => {
  it("strips the /CIDR suffix from the first IPv4 column", () => {
    const raw =
      " Name       MAC address          Protocol     Address\n" +
      "-------------------------------------------------------------------------------\n" +
      " vnet0      52:54:00:8e:5b:c1    ipv4         192.168.122.42/24\n";
    expect(parseDomIfAddrIpv4(raw)).toBe("192.168.122.42");
  });

  it("returns null when only IPv6 is present", () => {
    const raw =
      " Name       MAC address          Protocol     Address\n" +
      "-------------------------------------------------------------------------------\n" +
      " vnet0      52:54:00:8e:5b:c1    ipv6         fe80::5054:ff:fe8e:5bc1/64\n";
    expect(parseDomIfAddrIpv4(raw)).toBeNull();
  });

  it("returns null on empty output", () => {
    expect(parseDomIfAddrIpv4("")).toBeNull();
  });

  it("prefers IPv4 over IPv6 when both are listed", () => {
    const raw =
      " Name       MAC address          Protocol     Address\n" +
      "-------------------------------------------------------------------------------\n" +
      " vnet0      52:54:00:8e:5b:c1    ipv6         fe80::5054:ff:fe8e:5bc1/64\n" +
      " vnet0      52:54:00:8e:5b:c1    ipv4         10.0.0.5/24\n";
    expect(parseDomIfAddrIpv4(raw)).toBe("10.0.0.5");
  });
});

describe("parseDomInfoUsedMemoryMB", () => {
  it("converts 'Used memory: <KiB>' to MiB (rounded down)", () => {
    const raw =
      "Id:             1\nName:           test\nMax memory:     4194304 KiB\n" +
      "Used memory:    2097152 KiB\nPersistent:     yes\n";
    expect(parseDomInfoUsedMemoryMB(raw)).toBe(2048);
  });

  it("returns 0 when balloon hasn't reported yet (shown as '-')", () => {
    const raw = "Used memory:    - KiB\n";
    expect(parseDomInfoUsedMemoryMB(raw)).toBe(0);
  });

  it("returns null when the line is missing", () => {
    expect(parseDomInfoUsedMemoryMB("Name: x\nState: shut off\n")).toBeNull();
  });

  it("rounds non-power-of-2 values down to whole MiB", () => {
    // 2147483 KiB = ~2097.155 MiB → 2097
    expect(parseDomInfoUsedMemoryMB("Used memory:    2147483 KiB")).toBe(2097);
  });
});

describe("parseSnapshotList", () => {
  it("returns one CheckpointInfo per snapshot", () => {
    const raw =
      " Name        Creation Time              State\n" +
      "------------------------------------------------------------\n" +
      " snap-01     2024-01-15 10:30:00 +0000  shutoff\n" +
      " snap-02     2024-02-20 14:45:12 +0000  running\n";
    const out = parseSnapshotList(raw);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("snap-01");
    expect(out[0].label).toBe("snap-01");
    expect(out[0].createdAt).toBeInstanceOf(Date);
    expect(out[0].createdAt.getUTCFullYear()).toBe(2024);
  });

  it("returns [] when no snapshots exist", () => {
    expect(parseSnapshotList("")).toEqual([]);
  });

  it("never returns NaN dates — falls back to epoch on parse failure", () => {
    const raw =
      " Name        Creation Time              State\n" +
      "------------------------------------------------------------\n" +
      " snap-01     not-a-date here garbage    shutoff\n";
    const out = parseSnapshotList(raw);
    expect(out).toHaveLength(1);
    expect(out[0].createdAt.getTime()).toBe(0);
  });
});

describe("parseGuestExecPid", () => {
  it("extracts the numeric pid from a QGA submit envelope", () => {
    expect(parseGuestExecPid('{"return":{"pid":1234}}')).toBe(1234);
  });

  it("throws when the payload is not valid JSON", () => {
    expect(() => parseGuestExecPid("not-json")).toThrow(/not valid JSON/);
  });

  it("throws when the pid field is missing or non-numeric", () => {
    expect(() => parseGuestExecPid('{"return":{}}')).toThrow(/numeric pid/);
    expect(() => parseGuestExecPid('{"return":{"pid":"42"}}')).toThrow(
      /numeric pid/,
    );
  });
});

describe("parseGuestExecStatus", () => {
  it("decodes base64 out-data and err-data into utf8 strings", () => {
    const out = Buffer.from("hello world\n").toString("base64");
    const err = Buffer.from("oops\n").toString("base64");
    const status = parseGuestExecStatus(
      JSON.stringify({
        return: {
          exited: true,
          exitcode: 0,
          "out-data": out,
          "err-data": err,
        },
      }),
    );
    expect(status.exited).toBe(true);
    expect(status.exitcode).toBe(0);
    expect(status.outData).toBe("hello world\n");
    expect(status.errData).toBe("oops\n");
  });

  it("returns exited=false without exitcode while the guest is still running", () => {
    const status = parseGuestExecStatus('{"return":{"exited":false}}');
    expect(status.exited).toBe(false);
    expect(status.exitcode).toBeUndefined();
    expect(status.signal).toBeUndefined();
  });

  it("surfaces the signal field when the guest process was killed", () => {
    const status = parseGuestExecStatus(
      '{"return":{"exited":true,"signal":9}}',
    );
    expect(status.exited).toBe(true);
    expect(status.signal).toBe(9);
    expect(status.exitcode).toBeUndefined();
  });

  it("surfaces the truncated flags when QGA reports buffer overflow", () => {
    const status = parseGuestExecStatus(
      '{"return":{"exited":true,"exitcode":0,"out-truncated":true,"err-truncated":true}}',
    );
    expect(status.outTruncated).toBe(true);
    expect(status.errTruncated).toBe(true);
  });

  it("throws when the payload is not valid JSON", () => {
    expect(() => parseGuestExecStatus("not-json")).toThrow(/not valid JSON/);
  });

  it("throws when the return body is missing", () => {
    expect(() => parseGuestExecStatus("{}")).toThrow(/missing return body/);
  });
});

describe("parseGuestFileHandle", () => {
  it("extracts the numeric handle from a QGA open envelope", () => {
    expect(parseGuestFileHandle('{"return":42}')).toBe(42);
  });

  it("throws when the payload is not valid JSON", () => {
    expect(() => parseGuestFileHandle("not-json")).toThrow(/not valid JSON/);
  });

  it("throws when the handle is missing or not a number", () => {
    expect(() => parseGuestFileHandle("{}")).toThrow(/numeric handle/);
    expect(() => parseGuestFileHandle('{"return":"x"}')).toThrow(
      /numeric handle/,
    );
  });
});

describe("parseGuestFileRead", () => {
  it("decodes buf-b64 into a Buffer and surfaces eof", () => {
    const b64 = Buffer.from("hello", "utf8").toString("base64");
    const out = parseGuestFileRead(
      JSON.stringify({ return: { count: 5, "buf-b64": b64, eof: false } }),
    );
    expect(out.buf.toString("utf8")).toBe("hello");
    expect(out.eof).toBe(false);
  });

  it("returns an empty buffer when buf-b64 is absent (eof case)", () => {
    const out = parseGuestFileRead('{"return":{"count":0,"eof":true}}');
    expect(out.buf.length).toBe(0);
    expect(out.eof).toBe(true);
  });

  it("throws when the payload is not valid JSON", () => {
    expect(() => parseGuestFileRead("not-json")).toThrow(/not valid JSON/);
  });

  it("throws when the return body is missing", () => {
    expect(() => parseGuestFileRead("{}")).toThrow(/missing return body/);
  });
});

describe("parsePoolTargetPath", () => {
  it("extracts the target path from a typical dir-pool dumpxml output", () => {
    const xml =
      "<pool type='dir'>\n" +
      "  <name>default</name>\n" +
      "  <target>\n" +
      "    <path>/var/lib/libvirt/images</path>\n" +
      "    <permissions><mode>0711</mode></permissions>\n" +
      "  </target>\n" +
      "</pool>\n";
    expect(parsePoolTargetPath(xml)).toBe("/var/lib/libvirt/images");
  });

  it("returns null when the pool has no <target><path>", () => {
    expect(parsePoolTargetPath("<pool type='iscsi'></pool>")).toBeNull();
  });

  it("trims surrounding whitespace from the path", () => {
    const xml = "<pool><target><path>   /tmp/p   </path></target></pool>";
    expect(parsePoolTargetPath(xml)).toBe("/tmp/p");
  });
});

describe("resolveOsProfileDefaults", () => {
  it("linux: BIOS + virtio + UTC, no TPM/Secure Boot, no Windows extras", () => {
    expect(resolveOsProfileDefaults("linux")).toEqual({
      firmware: "bios",
      secureBoot: false,
      tpm: "none",
      diskBus: "virtio",
      nicModel: "virtio",
      clockOffset: "utc",
      windowsExtras: false,
    });
  });

  it("linux-uefi: UEFI without Secure Boot/TPM", () => {
    const d = resolveOsProfileDefaults("linux-uefi");
    expect(d.firmware).toBe("efi");
    expect(d.secureBoot).toBe(false);
    expect(d.tpm).toBe("none");
    expect(d.clockOffset).toBe("utc");
    expect(d.windowsExtras).toBe(false);
  });

  it("windows-10: UEFI + virtio, localtime clock, Windows extras on", () => {
    const d = resolveOsProfileDefaults("windows-10");
    expect(d.firmware).toBe("efi");
    expect(d.secureBoot).toBe(false);
    expect(d.tpm).toBe("none");
    expect(d.clockOffset).toBe("localtime");
    expect(d.windowsExtras).toBe(true);
  });

  it("windows-11: UEFI + Secure Boot + TPM 2.0 + Windows extras (all mandatory at createVM)", () => {
    expect(resolveOsProfileDefaults("windows-11")).toEqual({
      firmware: "efi",
      secureBoot: true,
      tpm: "tpm-2.0",
      diskBus: "virtio",
      nicModel: "virtio",
      clockOffset: "localtime",
      windowsExtras: true,
    });
  });
});

describe("buildDomainXml", () => {
  /** Build the linux-profile defaults (legacy v0.5 baseline). */
  function linuxOs(): OsProfileDefaults {
    return resolveOsProfileDefaults("linux");
  }

  it("renders a stable, opinionated domain XML for the linux baseline", () => {
    const xml = buildDomainXml({
      name: "vm-test",
      memoryMB: 2048,
      cpus: 2,
      diskPath: "/var/lib/libvirt/images/vm-test.qcow2",
      networkName: "default",
      os: linuxOs(),
    });
    expect(xml).toContain("<domain type='kvm'>");
    expect(xml).toContain("<name>vm-test</name>");
    expect(xml).toContain("<memory unit='MiB'>2048</memory>");
    expect(xml).toContain("<currentMemory unit='MiB'>2048</currentMemory>");
    expect(xml).toContain("<vcpu placement='static'>2</vcpu>");
    expect(xml).toContain("<type arch='x86_64' machine='q35'>hvm</type>");
    expect(xml).toContain("<cpu mode='host-passthrough'/>");
    expect(xml).toContain(
      "<source file='/var/lib/libvirt/images/vm-test.qcow2'/>",
    );
    expect(xml).toContain("<source network='default'/>");
    expect(xml).toContain(
      "<target type='virtio' name='org.qemu.guest_agent.0'/>",
    );
    // linux baseline: BIOS firmware (no firmware='efi' attribute),
    // virtio disk (vda), UTC clock, no TPM, no Windows extras.
    expect(xml).not.toContain("firmware='efi'");
    expect(xml).toContain("<target dev='vda' bus='virtio'/>");
    expect(xml).toContain("<clock offset='utc'/>");
    expect(xml).not.toContain("<tpm");
    expect(xml).not.toContain("<input type='tablet'");
    expect(xml).not.toContain("<smm");
  });

  it("XML-escapes name + paths + network so a stray special char can't break the XML", () => {
    const xml = buildDomainXml({
      name: "name&with<bad>",
      memoryMB: 1024,
      cpus: 1,
      diskPath: "/path/with'apos.qcow2",
      networkName: 'net"quote',
      os: linuxOs(),
    });
    expect(xml).toContain("<name>name&amp;with&lt;bad&gt;</name>");
    expect(xml).toContain("/path/with&apos;apos.qcow2");
    expect(xml).toContain("net&quot;quote");
    expect(xml).not.toMatch(/<name>name&with</);
  });

  it("linux-uefi: emits firmware='efi' + secure-boot=no + UTC clock + no Windows extras", () => {
    const xml = buildDomainXml({
      name: "vm",
      memoryMB: 2048,
      cpus: 2,
      diskPath: "/tmp/d.qcow2",
      networkName: "default",
      os: resolveOsProfileDefaults("linux-uefi"),
    });
    expect(xml).toContain("<os firmware='efi'>");
    expect(xml).toContain("<feature enabled='no' name='secure-boot'/>");
    expect(xml).toContain("<feature enabled='no' name='enrolled-keys'/>");
    expect(xml).toContain("<clock offset='utc'/>");
    expect(xml).not.toContain("<smm");
    expect(xml).not.toContain("<tpm");
    expect(xml).not.toContain("<input type='tablet'");
  });

  it("windows-10: UEFI + virtio + localtime clock + Windows extras (tablet/QXL/VNC); no Secure Boot or TPM by default", () => {
    const xml = buildDomainXml({
      name: "win10",
      memoryMB: 4096,
      cpus: 2,
      diskPath: "/tmp/win10.qcow2",
      networkName: "default",
      os: resolveOsProfileDefaults("windows-10"),
    });
    expect(xml).toContain("<os firmware='efi'>");
    expect(xml).toContain("<feature enabled='no' name='secure-boot'/>");
    expect(xml).toContain("<clock offset='localtime'>");
    expect(xml).toContain("<timer name='rtc' tickpolicy='catchup'/>");
    expect(xml).toContain("<timer name='hpet' present='no'/>");
    expect(xml).toContain("<target dev='vda' bus='virtio'/>");
    expect(xml).toContain("<input type='tablet' bus='usb'/>");
    expect(xml).toContain("<model type='qxl'/>");
    expect(xml).toContain(
      "<graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>",
    );
    expect(xml).not.toContain("<tpm");
    expect(xml).not.toContain("<smm");
  });

  it("windows-11: UEFI + Secure Boot=yes + TPM 2.0 + SMM + Windows extras", () => {
    const xml = buildDomainXml({
      name: "win11",
      memoryMB: 4096,
      cpus: 2,
      diskPath: "/tmp/win11.qcow2",
      networkName: "default",
      os: resolveOsProfileDefaults("windows-11"),
    });
    expect(xml).toContain("<os firmware='efi'>");
    expect(xml).toContain("<feature enabled='yes' name='secure-boot'/>");
    expect(xml).toContain("<feature enabled='yes' name='enrolled-keys'/>");
    expect(xml).toContain("<smm state='on'/>");
    expect(xml).toContain(
      "<tpm model='tpm-crb'>\n      <backend type='emulator' version='2.0'/>\n    </tpm>",
    );
    expect(xml).toContain("<clock offset='localtime'>");
    expect(xml).toContain("<input type='tablet' bus='usb'/>");
    expect(xml).toContain("<model type='qxl'/>");
    expect(xml).toContain("<target dev='vda' bus='virtio'/>");
  });

  it("disk bus override: sata yields <target dev='sda' bus='sata'/>", () => {
    const xml = buildDomainXml({
      name: "vm",
      memoryMB: 2048,
      cpus: 2,
      diskPath: "/tmp/d.qcow2",
      networkName: "default",
      os: { ...resolveOsProfileDefaults("windows-10"), diskBus: "sata" },
    });
    expect(xml).toContain("<target dev='sda' bus='sata'/>");
    expect(xml).not.toContain("<target dev='vda'");
  });

  it("NIC override: e1000e yields <model type='e1000e'/>", () => {
    const xml = buildDomainXml({
      name: "vm",
      memoryMB: 2048,
      cpus: 2,
      diskPath: "/tmp/d.qcow2",
      networkName: "default",
      os: { ...resolveOsProfileDefaults("linux"), nicModel: "e1000e" },
    });
    expect(xml).toContain("<model type='e1000e'/>");
    expect(xml).not.toContain("<model type='virtio'/>");
  });

  it("extraCdroms: virtio-as-primary places CDROMs starting at sda", () => {
    const xml = buildDomainXml({
      name: "win-vm",
      memoryMB: 4096,
      cpus: 2,
      diskPath: "/var/lib/libvirt/images/win-vm.qcow2",
      networkName: "default",
      os: resolveOsProfileDefaults("windows-11"),
      extraCdroms: [
        "/iso/virtio-win.iso",
        "/iso/win11-installer.iso",
      ],
    });
    expect(xml).toContain("<target dev='vda' bus='virtio'/>"); // primary
    expect(xml).toContain("<source file='/iso/virtio-win.iso'/>");
    expect(xml).toContain("<target dev='sda' bus='sata'/>"); // first cdrom
    expect(xml).toContain("<source file='/iso/win11-installer.iso'/>");
    expect(xml).toContain("<target dev='sdb' bus='sata'/>"); // second cdrom
    // Both CDROMs are readonly + raw-format.
    expect(
      (xml.match(/<disk type='file' device='cdrom'>/g) ?? []).length,
    ).toBe(2);
    expect((xml.match(/<readonly\/>/g) ?? []).length).toBe(2);
    expect((xml.match(/<driver name='qemu' type='raw'\/>/g) ?? []).length).toBe(
      2,
    );
  });

  it("extraCdroms: sata-as-primary offsets CDROMs starting at sdb", () => {
    const xml = buildDomainXml({
      name: "win-bare",
      memoryMB: 4096,
      cpus: 2,
      diskPath: "/var/lib/libvirt/images/win-bare.qcow2",
      networkName: "default",
      os: { ...resolveOsProfileDefaults("windows-10"), diskBus: "sata" },
      extraCdroms: ["/iso/win10-installer.iso"],
    });
    expect(xml).toContain("<target dev='sda' bus='sata'/>"); // primary at sda
    expect(xml).toContain("<source file='/iso/win10-installer.iso'/>");
    expect(xml).toContain("<target dev='sdb' bus='sata'/>"); // cdrom at sdb
  });

  it("extraCdroms: empty array (or unset) emits no <disk device='cdrom'>", () => {
    const xml = buildDomainXml({
      name: "vm",
      memoryMB: 2048,
      cpus: 2,
      diskPath: "/tmp/d.qcow2",
      networkName: "default",
      os: resolveOsProfileDefaults("linux"),
    });
    expect(xml).not.toContain("device='cdrom'");
    expect(xml).not.toContain("<readonly/>");
  });
});

// ── Backend.run argv tests (per verb) ────────────────────────────

describe("LibvirtBackend argv composition", () => {
  it("prefixes every call with -c when connectUri is set", async () => {
    const { backend, calls } = makeBackend({
      connectUri: "qemu:///system",
      stdout: "running",
    });
    await backend.getStatus(HANDLE);
    expect(calls[0].args.slice(0, 2)).toEqual(["-c", "qemu:///system"]);
    expect(calls[0].args).toContain("domstate");
  });

  it("startVM shells `virsh start <name>` with the lifecycle timeout", async () => {
    const { backend, calls } = makeBackend({});
    await backend.startVM(HANDLE);
    expect(calls[0].args).toEqual(["start", "vm-alpha"]);
    expect(calls[0].timeoutMs).toBe(5 * 60_000);
  });

  it("stopVM passes 'shutdown' by default and 'destroy' when force=true", async () => {
    const { backend: backend1, calls: c1 } = makeBackend({});
    await backend1.stopVM(HANDLE);
    expect(c1[0].args).toEqual(["shutdown", "vm-alpha"]);

    const { backend: backend2, calls: c2 } = makeBackend({});
    await backend2.stopVM(HANDLE, true);
    expect(c2[0].args).toEqual(["destroy", "vm-alpha"]);
  });

  it("deleteVM destroys first (best effort) then undefines with the full cleanup-flag set", async () => {
    const { backend, calls } = makeBackend({});
    await backend.deleteVM(HANDLE);
    expect(calls[0].args).toEqual(["destroy", "vm-alpha"]);
    // The full flag set covers: disk volume (--remove-all-storage),
    // external snapshot volumes (--delete-storage-volume-snapshots,
    // no-op on directory pools but cleans separate snapshot files
    // on backends that track them), snapshot metadata
    // (--snapshots-metadata, required to undefine domains with
    // any snapshots), checkpoint metadata (--checkpoints-metadata),
    // and the nvram file (--nvram for UEFI domains).
    expect(calls[1].args).toEqual([
      "undefine",
      "vm-alpha",
      "--remove-all-storage",
      "--delete-storage-volume-snapshots",
      "--snapshots-metadata",
      "--checkpoints-metadata",
      "--nvram",
    ]);
  });

  it("createCheckpoint shells `snapshot-create-as <vm> <label>`", async () => {
    const { backend, calls } = makeBackend({});
    const handle = await backend.createCheckpoint(HANDLE, "snap-abc");
    expect(calls[0].args).toEqual([
      "snapshot-create-as",
      "vm-alpha",
      "snap-abc",
    ]);
    expect(handle.label).toBe("snap-abc");
    expect(handle.vmHandle).toBe(HANDLE);
  });

  it("restoreCheckpoint shells `snapshot-revert <vm> <label>`", async () => {
    const { backend, calls } = makeBackend({});
    await backend.restoreCheckpoint({
      id: "snap-abc",
      label: "snap-abc",
      vmHandle: HANDLE,
    });
    expect(calls[0].args).toEqual([
      "snapshot-revert",
      "vm-alpha",
      "snap-abc",
    ]);
  });

  it("listVMs uses --all --name for the simplest text shape", async () => {
    const { backend, calls } = makeBackend({ stdout: "" });
    await backend.listVMs();
    expect(calls[0].args).toEqual(["list", "--all", "--name"]);
  });

  it("getVmIpAddress shells `domifaddr <name> --source lease` first and parses the IPv4 column", async () => {
    const { backend, calls } = makeBackend({
      stdout:
        " Name       MAC address          Protocol     Address\n" +
        "-------------------------------------------------------------------------------\n" +
        " vnet0      52:54:00:8e:5b:c1    ipv4         10.0.0.7/24\n",
    });
    const ip = await backend.getVmIpAddress(HANDLE);
    expect(calls[0].args).toEqual([
      "domifaddr",
      "vm-alpha",
      "--source",
      "lease",
    ]);
    expect(ip).toBe("10.0.0.7");
    // First source returned a usable IP, so the backend short-circuits
    // — there should be no follow-up to `agent` or `arp`.
    expect(calls).toHaveLength(1);
  });

  it("isAvailable shells `version --daemon` with a short timeout", async () => {
    const { backend, calls } = makeBackend({});
    await backend.isAvailable();
    expect(calls[0].args).toEqual(["version", "--daemon"]);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("rejects domain names that contain shell metacharacters", async () => {
    const { backend } = makeBackend({});
    await expect(
      backend.startVM({ id: "bad", name: "bad;rm -rf", backend: "libvirt" }),
    ).rejects.toThrow(/Invalid VM name/);
  });
});
