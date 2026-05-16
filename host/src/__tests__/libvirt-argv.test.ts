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
} from "../hypervisors/libvirt.js";

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

  it("deleteVM destroys first (best effort) then undefines with --remove-all-storage", async () => {
    const { backend, calls } = makeBackend({});
    await backend.deleteVM(HANDLE);
    expect(calls[0].args).toEqual(["destroy", "vm-alpha"]);
    expect(calls[1].args).toEqual([
      "undefine",
      "vm-alpha",
      "--remove-all-storage",
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
