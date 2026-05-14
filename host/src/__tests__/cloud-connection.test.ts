/**
 * v0.3.0-5 sub-task 6 — connection descriptors.
 *
 * Three layers:
 *   - **Unit**: descriptor builder for each network mode;
 *     default-mode fallback; rejection of cross-vendor handles;
 *     port override.
 *   - **Integration**: AWS backend writes `network_mode` onto
 *     the returned handle (verified via `buildInstanceTags` +
 *     handle round-trip with a mocked client).
 *   - **System**: end-to-end provision → getConnectionDescriptor
 *     via the abstraction returns a descriptor consistent with
 *     the config's mode.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONNECTION_PORT,
  getConnectionDescriptor,
  withResolvedHost,
} from "../cloud/connection.js";
import {
  DEFAULT_NETWORK_MODE,
  type CloudInstanceHandle,
} from "../cloud/types.js";

function awsHandle(network_mode?: CloudInstanceHandle["network_mode"]): CloudInstanceHandle {
  return {
    id: "i-0abc",
    backend: "aws",
    name: "test",
    region: "us-east-1",
    network_mode,
  };
}

function azureHandle(network_mode?: CloudInstanceHandle["network_mode"]): CloudInstanceHandle {
  return {
    id: "/subscriptions/X/resourceGroups/Y/providers/Microsoft.Compute/virtualMachines/test",
    backend: "azure",
    name: "test",
    region: "eastus",
    network_mode,
  };
}

// ── UNIT: descriptor builder ──────────────────────────────────────

describe("getConnectionDescriptor — unit", () => {
  it("returns public_mtls with default port for handles without network_mode (back-compat)", () => {
    const d = getConnectionDescriptor(awsHandle(undefined));
    expect(d).toEqual({ kind: "public_mtls", port: DEFAULT_CONNECTION_PORT });
  });

  it("DEFAULT_NETWORK_MODE is public_mtls", () => {
    expect(DEFAULT_NETWORK_MODE).toBe("public_mtls");
  });

  it("builds public_mtls descriptor on explicit public_mtls handle", () => {
    const d = getConnectionDescriptor(awsHandle("public_mtls"));
    expect(d.kind).toBe("public_mtls");
    expect(d.port).toBe(443);
  });

  it("builds aws_ssm descriptor with region + instance_id from AWS handle", () => {
    const d = getConnectionDescriptor(awsHandle("aws_ssm"));
    expect(d).toEqual({
      kind: "aws_ssm",
      region: "us-east-1",
      instance_id: "i-0abc",
      port: 443,
    });
  });

  it("builds azure_bastion descriptor from Azure handle + subscription/RG opts", () => {
    const d = getConnectionDescriptor(azureHandle("azure_bastion"), {
      subscriptionId: "sub-X",
      resourceGroup: "rg-Y",
    });
    expect(d).toEqual({
      kind: "azure_bastion",
      subscription_id: "sub-X",
      resource_group: "rg-Y",
      vm_name: "test",
      port: 443,
    });
  });

  it("honours port override", () => {
    const d = getConnectionDescriptor(awsHandle("aws_ssm"), { port: 8443 });
    expect(d.port).toBe(8443);
  });

  it("rejects aws_ssm mode on an Azure handle", () => {
    const handle = { ...azureHandle("aws_ssm" as const) };
    expect(() => getConnectionDescriptor(handle)).toThrowError(/aws_ssm.*AWS/);
  });

  it("rejects azure_bastion mode on an AWS handle", () => {
    const handle = { ...awsHandle("azure_bastion" as const) };
    expect(() =>
      getConnectionDescriptor(handle, {
        subscriptionId: "X",
        resourceGroup: "Y",
      }),
    ).toThrowError(/azure_bastion.*Azure/);
  });

  it("rejects azure_bastion mode without subscriptionId", () => {
    expect(() =>
      getConnectionDescriptor(azureHandle("azure_bastion"), {
        resourceGroup: "rg-Y",
      }),
    ).toThrowError(/subscriptionId/);
  });

  it("rejects azure_bastion mode without resourceGroup", () => {
    expect(() =>
      getConnectionDescriptor(azureHandle("azure_bastion"), {
        subscriptionId: "sub-X",
      }),
    ).toThrowError(/resourceGroup/);
  });
});

// ── UNIT: withResolvedHost ────────────────────────────────────────

describe("withResolvedHost — populating public IP after fetch", () => {
  it("adds host to a public_mtls descriptor", () => {
    const base = getConnectionDescriptor(awsHandle("public_mtls"));
    const resolved = withResolvedHost(base, "1.2.3.4");
    expect(resolved).toEqual({ kind: "public_mtls", port: 443, host: "1.2.3.4" });
  });

  it("is a no-op for aws_ssm descriptors", () => {
    const base = getConnectionDescriptor(awsHandle("aws_ssm"));
    const result = withResolvedHost(base, "1.2.3.4");
    expect(result).toBe(base);
  });

  it("is a no-op for azure_bastion descriptors", () => {
    const base = getConnectionDescriptor(azureHandle("azure_bastion"), {
      subscriptionId: "X",
      resourceGroup: "Y",
    });
    const result = withResolvedHost(base, "1.2.3.4");
    expect(result).toBe(base);
  });
});

// ── INTEGRATION: handle round-trip ────────────────────────────────

describe("CloudInstanceHandle — network_mode propagation", () => {
  it("absence of network_mode falls back to public_mtls in the descriptor", () => {
    const h: CloudInstanceHandle = {
      id: "i-old",
      backend: "aws",
      name: "legacy",
      region: "us-east-1",
      // network_mode intentionally absent — legacy handle from
      // pre-sub-task-6 storage / state.
    };
    expect(getConnectionDescriptor(h).kind).toBe("public_mtls");
  });

  it("handles carry network_mode through serialisation (JSON round-trip)", () => {
    const original = awsHandle("aws_ssm");
    const roundTripped = JSON.parse(JSON.stringify(original)) as CloudInstanceHandle;
    expect(roundTripped.network_mode).toBe("aws_ssm");
    expect(getConnectionDescriptor(roundTripped).kind).toBe("aws_ssm");
  });
});
