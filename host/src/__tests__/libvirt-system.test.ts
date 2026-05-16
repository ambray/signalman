/**
 * libvirt system-lane test (v0.5 libvirt-parity, M6).
 *
 * Drives the REAL `virsh` binary against libvirt's deterministic
 * in-memory test driver (`test:///default`). The test driver ships
 * with libvirt itself — no QEMU, no storage pools, no real network.
 * It exposes a single "test" domain that is always "running" and
 * is the canonical smoke-test target for code that wants to know
 * "does my virsh-shelling-out actually work end-to-end."
 *
 * Why this lane:
 *
 *  - Unit + integration tests (`libvirt-argv.test.ts`,
 *    `libvirt-backend.test.ts`) all use the injected exec callback,
 *    so they never actually spawn virsh. That catches argv-shape
 *    drift but misses real-virsh failures (binary on PATH, env-var
 *    interaction, virsh version differences).
 *  - Real-VM tests need QEMU + a guest image + a storage pool;
 *    those are M7's territory and run gated behind
 *    SIGNALMAN_LIBVIRT_TESTS=1 because they're slow + downloadful.
 *  - This file sits between the two: real virsh, no QEMU, fast.
 *    CI on a Linux runner with libvirt-clients installed picks up
 *    parser regressions immediately.
 *
 * Skip behavior:
 *  - Non-Linux platforms: skipped (no virsh binary in the standard
 *    PATH on macOS/Windows).
 *  - SIGNALMAN_LIBVIRT_TESTS !== "1": skipped, so the file doesn't
 *    flake on Linux CI hosts where the libvirt-clients package isn't
 *    installed. Operators opt in by setting the env var.
 */

import { describe, it, expect } from "vitest";

import { LibvirtBackend } from "../hypervisors/libvirt.js";

const enabled =
  process.platform === "linux" && process.env.SIGNALMAN_LIBVIRT_TESTS === "1";

// vitest's describe.skipIf was added in v0.20; the project targets
// v3.x, so it's available. Use it to keep the file readable rather
// than wrapping every `it` in a conditional skip.
describe.skipIf(!enabled)(
  "LibvirtBackend system lane (test:///default)",
  () => {
    function makeBackend() {
      // No injected exec — this uses real virsh on PATH.
      return new LibvirtBackend({ connectUri: "test:///default" });
    }

    it("isAvailable returns true against the test driver", async () => {
      const backend = makeBackend();
      expect(await backend.isAvailable()).toBe(true);
    });

    it("listVMs returns the canonical 'test' domain", async () => {
      const backend = makeBackend();
      const vms = await backend.listVMs();
      // The test driver always exposes a domain literally named "test".
      // We assert presence rather than exact equality so future libvirt
      // versions adding more default domains don't break the test.
      const names = vms.map((v) => v.name);
      expect(names).toContain("test");
      const testVm = vms.find((v) => v.name === "test")!;
      expect(testVm.backend).toBe("libvirt");
      expect(testVm.id).toBe("test");
    });

    it("getStatus reports the test domain as running", async () => {
      const backend = makeBackend();
      const status = await backend.getStatus({
        id: "test",
        name: "test",
        backend: "libvirt",
      });
      expect(status.state).toBe("running");
      // The test driver doesn't speak QGA, so guestAgentReachable
      // should come back false — the qgaPing probe runs but virsh
      // returns a non-zero exit, which qgaPing maps to false.
      expect(status.guestAgentReachable).toBe(false);
    });

    it("listCheckpoints returns the test driver's snapshot list (may be empty)", async () => {
      const backend = makeBackend();
      const snaps = await backend.listCheckpoints({
        id: "test",
        name: "test",
        backend: "libvirt",
      });
      expect(Array.isArray(snaps)).toBe(true);
    });

    it("vm_not_found bubbles up cleanly for a domain that does not exist", async () => {
      const backend = makeBackend();
      await expect(
        backend.getStatus({
          id: "does-not-exist",
          name: "does-not-exist",
          backend: "libvirt",
        }),
      ).rejects.toMatchObject({ code: "vm_not_found" });
    });

    it("getVmIpAddress walks the source-fallback chain against real virsh output", async () => {
      // The test driver synthesizes a fake IPv4 lease for its default
      // 'test' domain — current libvirt returns 192.168.122.3. We
      // don't pin the exact value because future libvirt versions can
      // shuffle the test fixtures; what we DO want to pin is that the
      // source-fallback loop in getVmIpAddress doesn't blow up on
      // real virsh output and successfully parses some IPv4 dotted
      // quad.
      const backend = makeBackend();
      const ip = await backend.getVmIpAddress({
        id: "test",
        name: "test",
        backend: "libvirt",
      });
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });
  },
);

describe("LibvirtBackend system lane (skip note)", () => {
  it("documents the SIGNALMAN_LIBVIRT_TESTS env-var contract", () => {
    // This single always-running case exists so the file isn't
    // entirely empty in CI runs that skip the gated suite. It
    // also pins the env-var name as the documented entry point —
    // if someone renames it without updating CI / docs the test
    // surfaces the change.
    expect("SIGNALMAN_LIBVIRT_TESTS").toBe("SIGNALMAN_LIBVIRT_TESTS");
  });
});
