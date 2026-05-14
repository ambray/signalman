/**
 * v0.3.0-5 sub-task 6 — CLI surface for `signalman cloud
 * connection-descriptor`.
 *
 * System-layer coverage: parses argv → dispatches to
 * cmdCloudConnectionDescriptor → captures stdout → asserts
 * structured output. Connection descriptors are pure-data
 * helpers (no I/O), so this is a thin wrapper test over the
 * unit-tested `getConnectionDescriptor`.
 */

import { describe, it, expect } from "vitest";
import { cmdCloudConnectionDescriptor, type ParsedArgs } from "../cli.js";

function argsFor(opts: Record<string, string>): ParsedArgs {
  return {
    positional: [],
    flags: new Set<string>(),
    options: new Map<string, string>(Object.entries(opts)),
    params: {},
  };
}

function captureStdout(): { restore: () => void; read: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: typeof original }).write = original;
    },
    read: () => buf,
  };
}

describe("signalman cloud connection-descriptor — CLI surface", () => {
  it("public_mtls default mode emits human-readable descriptor", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudConnectionDescriptor(
        argsFor({
          provider: "aws",
          id: "i-0abc",
          name: "test",
          region: "us-east-1",
        }),
      );
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/kind: public_mtls/);
      expect(out).toMatch(/port: 443/);
      expect(out).toMatch(/resolve via signalman_cloud_status/);
    } finally {
      capture.restore();
    }
  });

  it("aws_ssm emits region + instance_id", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudConnectionDescriptor(
        argsFor({
          provider: "aws",
          id: "i-0abc",
          name: "test",
          region: "us-east-1",
          "network-mode": "aws_ssm",
          format: "json",
        }),
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.read()) as {
        kind: string;
        region: string;
        instance_id: string;
        port: number;
      };
      expect(parsed.kind).toBe("aws_ssm");
      expect(parsed.region).toBe("us-east-1");
      expect(parsed.instance_id).toBe("i-0abc");
      expect(parsed.port).toBe(443);
    } finally {
      capture.restore();
    }
  });

  it("azure_bastion requires subscription-id and resource-group", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudConnectionDescriptor(
        argsFor({
          provider: "azure",
          id: "/subs/X/rg/Y/vm/test",
          name: "test",
          region: "eastus",
          "network-mode": "azure_bastion",
        }),
      );
      expect(exit).toBe(4); // missing subscriptionId → error
    } finally {
      capture.restore();
    }
  });

  it("azure_bastion with all required fields emits descriptor", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudConnectionDescriptor(
        argsFor({
          provider: "azure",
          id: "/subs/X/rg/Y/vm/test",
          name: "test",
          region: "eastus",
          "network-mode": "azure_bastion",
          "subscription-id": "sub-X",
          "resource-group": "rg-Y",
          format: "json",
        }),
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.read()) as {
        kind: string;
        subscription_id: string;
        resource_group: string;
        vm_name: string;
      };
      expect(parsed.kind).toBe("azure_bastion");
      expect(parsed.subscription_id).toBe("sub-X");
      expect(parsed.resource_group).toBe("rg-Y");
      expect(parsed.vm_name).toBe("test");
    } finally {
      capture.restore();
    }
  });

  it("custom --port overrides default 443", async () => {
    const capture = captureStdout();
    try {
      await cmdCloudConnectionDescriptor(
        argsFor({
          provider: "aws",
          id: "i-0abc",
          name: "test",
          region: "us-east-1",
          "network-mode": "aws_ssm",
          port: "8443",
          format: "json",
        }),
      );
      const parsed = JSON.parse(capture.read()) as { port: number };
      expect(parsed.port).toBe(8443);
    } finally {
      capture.restore();
    }
  });

  it("rejects missing --provider", async () => {
    await expect(
      cmdCloudConnectionDescriptor(
        argsFor({ id: "x", name: "x", region: "x" }),
      ),
    ).rejects.toThrowError();
  });

  it("rejects invalid --network-mode", async () => {
    await expect(
      cmdCloudConnectionDescriptor(
        argsFor({
          provider: "aws",
          id: "i-0abc",
          name: "test",
          region: "us-east-1",
          "network-mode": "carrier-pigeon",
        }),
      ),
    ).rejects.toThrowError();
  });
});
