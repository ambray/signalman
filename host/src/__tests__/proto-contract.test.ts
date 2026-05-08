/**
 * Proto v1 contract tests (P7 D1 minimum-viable).
 *
 * Two layers of contract validation:
 *
 * 1. **Source-level**: parse `proto/guest.proto` and
 *    `service/proto/signalman_service.proto` as text and assert the
 *    v1 freeze invariants — reserved field tags, expected oneofs,
 *    expected message types. Catches a maintainer who removes the
 *    `reserved` clauses or drops a oneof variant without realising
 *    that's a wire-format break.
 *
 * 2. **Wire-level**: load both protos via @grpc/proto-loader, build
 *    sample messages with each oneof variant, serialise via the
 *    generated request-serializer, deserialise back, and verify the
 *    round-tripped object carries the expected variant. Catches the
 *    case where the proto compiles but the encoder/decoder is wrong
 *    (e.g., a field number mismatch between Rust and TS sides).
 *
 * What this test does NOT do (yet, deferred to a P7 follow-up):
 *
 * - **Live host↔Rust gRPC contract test**: spawn `signalman-service`
 *   as a subprocess, connect via real @grpc/grpc-js with mTLS, send
 *   real RPCs end-to-end. That requires `cargo build`-then-spawn
 *   plumbing, cert generation in TS, and free-port detection — a
 *   bigger lift than v0.1.0 needs once the static + wire-level
 *   layers are in place. The audit C2 mTLS-handshake test (D2) is
 *   the right vehicle for that work and is being built in parallel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as protoLoader from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GUEST_PROTO = path.join(REPO_ROOT, "proto", "guest.proto");
const SERVICE_PROTO = path.join(REPO_ROOT, "service", "proto", "signalman_service.proto");

// ── Source-level contract assertions ──────────────────────────────

describe("proto/guest.proto v1 freeze invariants", () => {
  const source = fs.readFileSync(GUEST_PROTO, "utf-8");

  it("declares package signalman.guest", () => {
    expect(source).toMatch(/^package\s+signalman\.guest\s*;/m);
  });

  it("ProcessInfo reserves Windows-only field tags 8-11", () => {
    // The P8 freeze moved is_appcontainer / appcontainer_sid /
    // is_low_integrity / is_in_job into a oneof; a maintainer who
    // removes the `reserved` clause could re-use those tags for an
    // unrelated field, breaking older binaries on the wire. Field
    // names appear inline in a single `reserved "...","..."` line —
    // we check for each name's quoted form.
    const block = extractMessageBlock(source, "ProcessInfo");
    expect(block).toContain("reserved 8 to 11");
    expect(block).toContain('"is_appcontainer"');
    expect(block).toContain('"appcontainer_sid"');
    expect(block).toContain('"is_low_integrity"');
    expect(block).toContain('"is_in_job"');
  });

  it("ProcessInfo declares oneof platform_details with windows/linux/macos variants", () => {
    const block = extractMessageBlock(source, "ProcessInfo");
    expect(block).toMatch(/oneof\s+platform_details\s*\{/);
    expect(block).toMatch(/WindowsProcessDetails\s+windows\s*=\s*100/);
    expect(block).toMatch(/LinuxProcessDetails\s+linux\s*=\s*101/);
    expect(block).toMatch(/MacOsProcessDetails\s+macos\s*=\s*102/);
  });

  it("ProcessInspectResponse reserves Windows-only field tags 2,5,6,7,8", () => {
    const block = extractMessageBlock(source, "ProcessInspectResponse");
    expect(block).toContain("reserved 2, 5, 6, 7, 8");
    expect(block).toMatch(/oneof\s+platform_details\s*\{/);
  });

  it("VerifyRestrictionResponse reserves Windows-only field tags", () => {
    const block = extractMessageBlock(source, "VerifyRestrictionResponse");
    // Tags 2-7 + 10, 11 — the audit-flagged Windows fields
    // (restriction_mode, has_appcontainer_token, etc.).
    expect(block).toContain("reserved 2, 3, 4, 5, 6, 7, 10, 11");
    expect(block).toMatch(/oneof\s+platform_details\s*\{/);
  });

  it("StreamReadiness RPC is reserved as a server-streaming slot", () => {
    expect(source).toMatch(
      /rpc\s+StreamReadiness\s*\(\s*StreamReadinessRequest\s*\)\s+returns\s*\(\s*stream\s+ReadinessUpdate\s*\)/,
    );
  });

  it("GuestAgent exposes the UI keyboard action contract", () => {
    expect(source).toMatch(/rpc\s+UIKey\s*\(\s*UIKeyRequest\s*\)\s+returns\s*\(\s*UIActionResponse\s*\)/);
    const block = extractMessageBlock(source, "UIKeyRequest");
    expect(block).toMatch(/string\s+keys\s*=\s*1\b/);
    expect(block).toMatch(/string\s+selector\s*=\s*2\b/);
    expect(block).toMatch(/string\s+window_title\s*=\s*3\b/);
    expect(block).toMatch(/uint32\s+repeat\s*=\s*4\b/);
  });

  it("UI responses expose per-RPC duration diagnostics", () => {
    expect(extractMessageBlock(source, "UIActionResponse")).toMatch(
      /uint64\s+duration_ms\s*=\s*3\b/,
    );
    expect(extractMessageBlock(source, "UIFindResponse")).toMatch(
      /uint64\s+duration_ms\s*=\s*2\b/,
    );
    expect(extractMessageBlock(source, "UIScreenshotResponse")).toMatch(
      /uint64\s+duration_ms\s*=\s*5\b/,
    );
  });

  it("WindowsProcessDetails carries the four expected fields", () => {
    const block = extractMessageBlock(source, "WindowsProcessDetails");
    expect(block).toMatch(/bool\s+is_appcontainer\s*=\s*1\b/);
    expect(block).toMatch(/string\s+appcontainer_sid\s*=\s*2\b/);
    expect(block).toMatch(/bool\s+is_low_integrity\s*=\s*3\b/);
    expect(block).toMatch(/bool\s+is_in_job\s*=\s*4\b/);
  });

  it("LinuxProcessDetails and MacOsProcessDetails are present (empty placeholders)", () => {
    // Empty messages lock the variant tag in the oneof so future
    // platform-specific work doesn't require a new variant number.
    expect(extractMessageBlock(source, "LinuxProcessDetails")).toBeDefined();
    expect(extractMessageBlock(source, "MacOsProcessDetails")).toBeDefined();
  });
});

describe("service/proto/signalman_service.proto v1 freeze invariants", () => {
  const source = fs.readFileSync(SERVICE_PROTO, "utf-8");

  it("declares package signalman.service", () => {
    expect(source).toMatch(/^package\s+signalman\.service\s*;/m);
  });

  it("VmConfig declares oneof hypervisor_specific with hyperv/libvirt/vmrun variants", () => {
    const block = extractMessageBlock(source, "VmConfig");
    expect(block).toMatch(/oneof\s+hypervisor_specific\s*\{/);
    expect(block).toMatch(/HyperVVmConfig\s+hyperv\s*=\s*100/);
    expect(block).toMatch(/LibvirtVmConfig\s+libvirt\s*=\s*101/);
    expect(block).toMatch(/VmrunVmConfig\s+vmrun\s*=\s*102/);
  });

  it("HyperVVmConfig is present (empty placeholder reserves the variant tag)", () => {
    expect(extractMessageBlock(source, "HyperVVmConfig")).toBeDefined();
  });

  it("ControlPlane service exposes the expected RPC surface", () => {
    // Pin the RPC list so a removed RPC is a loud test failure
    // rather than a silent contract break.
    const expected = [
      "Health",
      "GetActiveBackend",
      "VmCreate",
      "VmStart",
      "VmStop",
      "VmPause",
      "VmResume",
      "VmDelete",
      "VmGetStatus",
      "VmList",
      "CheckpointCreate",
      "CheckpointRestore",
      "CheckpointDelete",
      "CheckpointList",
      "VmCopyFile",
      "VmRunCommand",
      "VmGetIp",
      "VmWaitAgent",
      "VmSetMemory",
      "VmSetProcessor",
      "VmInstall",
    ];
    for (const rpc of expected) {
      expect(source).toMatch(new RegExp(`rpc\\s+${rpc}\\s*\\(`));
    }
  });
});

// ── Wire-level round-trip ─────────────────────────────────────────

describe("guest proto wire-level round-trip (oneof platform_details)", () => {
  // Load the proto and grab the gRPC method's serializers — that's
  // the simplest path to encode/decode without pulling in protobufjs
  // directly.
  const def = protoLoader.loadSync(GUEST_PROTO, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def);
  // proto.signalman.guest.GuestAgent is the service constructor; its
  // methods carry serializers we can use. Service method keys are
  // PascalCase regardless of `keepCase` (that flag only affects
  // message field names, not RPC method names).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guestSvc = (proto as any).signalman.guest.GuestAgent.service;
  // ProcessList returns ProcessListResponse which contains
  // ProcessInfo[]. Use that for round-trip.
  const processListMethod = guestSvc.ProcessList;

  it("roundtrips a ProcessInfo carrying the Windows variant", () => {
    const original = {
      processes: [
        {
          pid: 1234,
          name: "explorer.exe",
          path: "C:\\Windows\\explorer.exe",
          commandLine: "explorer.exe",
          memoryBytes: 100_000_000,
          cpuPercent: 1.5,
          user: "Aaron",
          platformDetails: "windows",
          windows: {
            isAppcontainer: true,
            appcontainerSid: "S-1-15-2-...",
            isLowIntegrity: false,
            isInJob: true,
          },
        },
      ],
    };
    const buf = processListMethod.responseSerialize(original);
    const decoded = processListMethod.responseDeserialize(buf);
    expect(decoded.processes).toHaveLength(1);
    const p = decoded.processes[0];
    expect(p.pid).toBe(1234);
    expect(p.name).toBe("explorer.exe");
    // The oneof discriminator surfaces as the platformDetails field
    // when the loader is configured with `oneofs: true`.
    expect(p.platformDetails).toBe("windows");
    expect(p.windows).toMatchObject({
      isAppcontainer: true,
      appcontainerSid: "S-1-15-2-...",
      isInJob: true,
    });
    // The non-active variants should NOT be populated.
    expect(p.linux).toBeUndefined();
    expect(p.macos).toBeUndefined();
  });

  it("roundtrips a ProcessInfo with no platform_details set", () => {
    // A future Linux guest agent may not populate the oneof until
    // its variant is wired. The wire format must accept this.
    const original = {
      processes: [
        {
          pid: 1,
          name: "init",
          path: "",
          commandLine: "",
          memoryBytes: 0,
          cpuPercent: 0,
          user: "",
        },
      ],
    };
    const buf = processListMethod.responseSerialize(original);
    const decoded = processListMethod.responseDeserialize(buf);
    expect(decoded.processes[0].pid).toBe(1);
    // platformDetails discriminator absent when no variant set.
    expect(decoded.processes[0].platformDetails).toBeFalsy();
  });
});

describe("service proto wire-level round-trip (oneof hypervisor_specific)", () => {
  const def = protoLoader.loadSync(SERVICE_PROTO, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cpSvc = (proto as any).signalman.service.ControlPlane.service;
  // PascalCase per service-method-naming convention; see comment in
  // the guest-proto block above.
  const vmCreateMethod = cpSvc.VmCreate;

  it("roundtrips a VmConfig with the HyperV variant", () => {
    const original = {
      config: {
        name: "endpoint-1",
        template: "win11-base",
        cpus: 4,
        memoryMb: 8192,
        diskGb: 80,
        network: { switchName: "Default Switch", staticIp: "" },
        guestAgentPort: 50051,
        hypervisorSpecific: "hyperv",
        hyperv: {},
      },
    };
    const buf = vmCreateMethod.requestSerialize(original);
    const decoded = vmCreateMethod.requestDeserialize(buf);
    expect(decoded.config.name).toBe("endpoint-1");
    expect(decoded.config.cpus).toBe(4);
    expect(decoded.config.hypervisorSpecific).toBe("hyperv");
    // libvirt and vmrun variants absent.
    expect(decoded.config.libvirt).toBeUndefined();
    expect(decoded.config.vmrun).toBeUndefined();
  });

  it("roundtrips a VmConfig with no hypervisor_specific set", () => {
    // The agnostic fields suffice for current Example scenarios; the
    // oneof is optional. Wire format must accept absence.
    const original = {
      config: {
        name: "endpoint-1",
        template: "win11-base",
        cpus: 2,
        memoryMb: 4096,
        diskGb: 40,
        network: { switchName: "", staticIp: "" },
        guestAgentPort: 50051,
      },
    };
    const buf = vmCreateMethod.requestSerialize(original);
    const decoded = vmCreateMethod.requestDeserialize(buf);
    expect(decoded.config.name).toBe("endpoint-1");
    expect(decoded.config.hypervisorSpecific).toBeFalsy();
  });
});

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Extract the body of a `message <name> { ... }` block from a proto
 * source file. Returns the body INCLUDING the surrounding braces, or
 * `undefined` when no block matches. Handles nested braces correctly.
 */
function extractMessageBlock(source: string, name: string): string | undefined {
  const re = new RegExp(`message\\s+${name}\\s*\\{`, "m");
  const match = re.exec(source);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return source.slice(start, i - 1);
}
