/**
 * v0.3.0-5 sub-task 3 — Azure cloud backend tests.
 *
 * Mocks the `ComputeManagementClient.virtualMachines.*` methods
 * so no real Azure calls fire. Each test constructs an
 * `AzureBackend` with an injected client.
 */

import { describe, it, expect, vi } from "vitest";
import {
  type ComputeManagementClient,
  type VirtualMachine,
} from "@azure/arm-compute";

import {
  AzureBackend,
  buildAzureTags,
  mapAzureError,
  mapAzureState,
} from "../cloud/azure.js";
import {
  CloudBackendError,
  SIGNALMAN_MANAGED_TAG_KEY,
  SIGNALMAN_MANAGED_TAG_VALUE,
  SIGNALMAN_ORG_TAG_KEY,
  type CloudInstanceConfig,
} from "../cloud/types.js";
import {
  getCloudBackend,
  listRegisteredBackends,
} from "../cloud/registry.js";

// ── Mock client helper ────────────────────────────────────────────

type VirtualMachinesMock = {
  beginCreateOrUpdateAndWait: ReturnType<typeof vi.fn>;
  beginDeleteAndWait: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  listAll: ReturnType<typeof vi.fn>;
};

function makeMockClient(): {
  client: ComputeManagementClient;
  vms: VirtualMachinesMock;
} {
  const vms: VirtualMachinesMock = {
    beginCreateOrUpdateAndWait: vi.fn(),
    beginDeleteAndWait: vi.fn(),
    get: vi.fn(),
    listAll: vi.fn(),
  };
  const client = { virtualMachines: vms } as unknown as ComputeManagementClient;
  return { client, vms };
}

function fullConfig(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return {
    region: "eastus",
    instance_type: "Standard_D2s_v3",
    image_ref:
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/galleries/g/images/img/versions/1.0",
    name: "test-vm",
    network: {
      subnet_id:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic-1",
    },
    ...overrides,
  };
}

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// ── Constructor validation ────────────────────────────────────────

describe("AzureBackend — constructor", () => {
  const baseOpts = {
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
    region: "eastus",
  };

  it("rejects an empty subscriptionId with invalid_config", () => {
    expect(
      () => new AzureBackend({ ...baseOpts, subscriptionId: "" }),
    ).toThrowError(
      expect.objectContaining({
        name: "CloudBackendError",
        code: "invalid_config",
      }),
    );
  });

  it("rejects an empty resourceGroup with invalid_config", () => {
    expect(
      () => new AzureBackend({ ...baseOpts, resourceGroup: "" }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
      }),
    );
  });

  it("rejects an empty region with invalid_config", () => {
    expect(() => new AzureBackend({ ...baseOpts, region: "" })).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
      }),
    );
  });

  it("constructs cleanly with valid options + injected client", () => {
    const { client } = makeMockClient();
    const b = new AzureBackend({ ...baseOpts, client });
    expect(b.name).toBe("azure");
  });
});

// ── provisionInstance — happy path ────────────────────────────────

describe("AzureBackend.provisionInstance — happy path", () => {
  it("calls beginCreateOrUpdateAndWait + returns handle", async () => {
    const { client, vms } = makeMockClient();
    vms.beginCreateOrUpdateAndWait.mockResolvedValueOnce({
      id:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/test-vm",
      name: "test-vm",
      location: "eastus",
    } as VirtualMachine);

    const backend = new AzureBackend({
      subscriptionId: "sub",
      resourceGroup: "rg",
      region: "eastus",
      client,
    });
    const handle = await backend.provisionInstance(fullConfig());

    expect(handle).toEqual({
      id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/test-vm",
      backend: "azure",
      name: "test-vm",
      region: "eastus",
    });
    expect(vms.beginCreateOrUpdateAndWait).toHaveBeenCalledTimes(1);
    const [rg, name, params] = vms.beginCreateOrUpdateAndWait.mock.calls[0];
    expect(rg).toBe("rg");
    expect(name).toBe("test-vm");
    expect((params as VirtualMachine).hardwareProfile?.vmSize).toBe(
      "Standard_D2s_v3",
    );
    expect(
      (params as VirtualMachine).storageProfile?.imageReference?.id,
    ).toContain("/galleries/");
  });

  it("emits the Signalman ownership tags on every VM create", async () => {
    const { client, vms } = makeMockClient();
    vms.beginCreateOrUpdateAndWait.mockResolvedValueOnce({
      id: "/.../virtualMachines/tagged",
      name: "tagged",
    } as VirtualMachine);

    const backend = new AzureBackend({
      subscriptionId: "sub",
      resourceGroup: "rg",
      region: "eastus",
      client,
    });
    await backend.provisionInstance(fullConfig({ org_id: "org-7" }));

    const params = vms.beginCreateOrUpdateAndWait.mock.calls[0][2] as VirtualMachine;
    expect(params.tags?.[SIGNALMAN_MANAGED_TAG_KEY]).toBe(
      SIGNALMAN_MANAGED_TAG_VALUE,
    );
    expect(params.tags?.[SIGNALMAN_ORG_TAG_KEY]).toBe("org-7");
    expect(params.tags?.["signalman-ttl-minutes"]).toBe("60");
  });

  it("sets osDisk.deleteOption=Delete so terminate auto-cleans the disk", async () => {
    const { client, vms } = makeMockClient();
    vms.beginCreateOrUpdateAndWait.mockResolvedValueOnce({
      id: "/.../virtualMachines/x",
      name: "x",
    } as VirtualMachine);

    const backend = new AzureBackend({
      subscriptionId: "sub",
      resourceGroup: "rg",
      region: "eastus",
      client,
    });
    await backend.provisionInstance(fullConfig());
    const params = vms.beginCreateOrUpdateAndWait.mock.calls[0][2] as VirtualMachine;
    expect(params.storageProfile?.osDisk?.deleteOption).toBe("Delete");
  });

  it("attaches the operator-supplied NIC as primary", async () => {
    const { client, vms } = makeMockClient();
    vms.beginCreateOrUpdateAndWait.mockResolvedValueOnce({
      id: "/.../virtualMachines/x",
      name: "x",
    } as VirtualMachine);
    const nicId =
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/my-nic";

    const backend = new AzureBackend({
      subscriptionId: "sub",
      resourceGroup: "rg",
      region: "eastus",
      client,
    });
    await backend.provisionInstance(
      fullConfig({ network: { subnet_id: nicId } }),
    );
    const params = vms.beginCreateOrUpdateAndWait.mock.calls[0][2] as VirtualMachine;
    expect(params.networkProfile?.networkInterfaces?.[0]?.id).toBe(nicId);
    expect(params.networkProfile?.networkInterfaces?.[0]?.primary).toBe(true);
  });
});

// ── provisionInstance — validation + error paths ──────────────────

describe("AzureBackend.provisionInstance — validation", () => {
  const opts = {
    subscriptionId: "sub",
    resourceGroup: "rg",
    region: "eastus",
  };

  it("rejects missing image_ref", async () => {
    const backend = new AzureBackend({ ...opts, client: makeMockClient().client });
    await expect(
      backend.provisionInstance({ ...fullConfig(), image_ref: "" }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("rejects missing instance_type", async () => {
    const backend = new AzureBackend({ ...opts, client: makeMockClient().client });
    await expect(
      backend.provisionInstance({ ...fullConfig(), instance_type: "" }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("rejects region mismatch", async () => {
    const backend = new AzureBackend({ ...opts, client: makeMockClient().client });
    await expect(
      backend.provisionInstance(fullConfig({ region: "westus2" })),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("rejects missing network.subnet_id (NIC id) with actionable remediation", async () => {
    const backend = new AzureBackend({ ...opts, client: makeMockClient().client });
    const cfg = fullConfig();
    delete cfg.network;
    await expect(backend.provisionInstance(cfg)).rejects.toMatchObject({
      code: "invalid_config",
    });
    try {
      await backend.provisionInstance(cfg);
    } catch (err) {
      // Error message names the workaround so operators know what to do.
      expect((err as Error).message).toContain("pre-created");
      expect((err as Error).message).toContain("Network Interface");
    }
  });

  it("wraps VM create failures as provision_failed", async () => {
    const { client, vms } = makeMockClient();
    const azureErr = Object.assign(new Error("boom"), {
      code: "InternalServerError",
      statusCode: 500,
    });
    vms.beginCreateOrUpdateAndWait.mockRejectedValueOnce(azureErr);
    const backend = new AzureBackend({ ...opts, client });
    await expect(backend.provisionInstance(fullConfig())).rejects.toMatchObject({
      code: "provision_failed",
    });
  });

  it("maps Azure auth errors to auth_failed", async () => {
    const { client, vms } = makeMockClient();
    const azureErr = Object.assign(new Error("auth refused"), {
      code: "AuthenticationFailed",
      statusCode: 401,
    });
    vms.beginCreateOrUpdateAndWait.mockRejectedValueOnce(azureErr);
    const backend = new AzureBackend({ ...opts, client });
    await expect(backend.provisionInstance(fullConfig())).rejects.toMatchObject({
      code: "auth_failed",
    });
  });
});

// ── terminateInstance ────────────────────────────────────────────

describe("AzureBackend.terminateInstance", () => {
  const opts = {
    subscriptionId: "sub",
    resourceGroup: "rg",
    region: "eastus",
  };

  it("calls beginDeleteAndWait with rg + name", async () => {
    const { client, vms } = makeMockClient();
    vms.beginDeleteAndWait.mockResolvedValueOnce(undefined);
    const backend = new AzureBackend({ ...opts, client });
    await backend.terminateInstance({
      id: "/.../virtualMachines/term-1",
      backend: "azure",
      name: "term-1",
      region: "eastus",
    });
    expect(vms.beginDeleteAndWait).toHaveBeenCalledWith("rg", "term-1");
  });

  it("treats statusCode=404 as idempotent success", async () => {
    const { client, vms } = makeMockClient();
    const notFound = Object.assign(new Error("gone"), { statusCode: 404 });
    vms.beginDeleteAndWait.mockRejectedValueOnce(notFound);
    const backend = new AzureBackend({ ...opts, client });
    await expect(
      backend.terminateInstance({
        id: "/.../virtualMachines/gone-1",
        backend: "azure",
        name: "gone-1",
        region: "eastus",
      }),
    ).resolves.toBeUndefined();
  });

  it("treats code=ResourceNotFound as idempotent success", async () => {
    const { client, vms } = makeMockClient();
    const notFound = Object.assign(new Error("gone"), {
      code: "ResourceNotFound",
    });
    vms.beginDeleteAndWait.mockRejectedValueOnce(notFound);
    const backend = new AzureBackend({ ...opts, client });
    await expect(
      backend.terminateInstance({
        id: "/.../virtualMachines/gone-2",
        backend: "azure",
        name: "gone-2",
        region: "eastus",
      }),
    ).resolves.toBeUndefined();
  });

  it("wraps other delete failures as terminate_failed", async () => {
    const { client, vms } = makeMockClient();
    const limitErr = Object.assign(new Error("throttled"), {
      code: "TooManyRequests",
      statusCode: 429,
    });
    vms.beginDeleteAndWait.mockRejectedValueOnce(limitErr);
    const backend = new AzureBackend({ ...opts, client });
    await expect(
      backend.terminateInstance({
        id: "/.../virtualMachines/x",
        backend: "azure",
        name: "x",
        region: "eastus",
      }),
    ).rejects.toMatchObject({ code: "terminate_failed" });
  });
});

// ── getInstanceStatus + getInstanceIp ─────────────────────────────

describe("AzureBackend.getInstanceStatus", () => {
  const opts = {
    subscriptionId: "sub",
    resourceGroup: "rg",
    region: "eastus",
  };

  it("returns running state when power-status indicates running", async () => {
    const { client, vms } = makeMockClient();
    vms.get.mockResolvedValueOnce({
      provisioningState: "Succeeded",
      instanceView: {
        statuses: [{ code: "PowerState/running" }],
      },
    } as VirtualMachine);
    const backend = new AzureBackend({ ...opts, client });
    const status = await backend.getInstanceStatus({
      id: "/.../virtualMachines/r",
      backend: "azure",
      name: "r",
      region: "eastus",
    });
    expect(status.state).toBe("running");
  });

  it("maps Azure 404 to instance_not_found", async () => {
    const { client, vms } = makeMockClient();
    vms.get.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { statusCode: 404 }),
    );
    const backend = new AzureBackend({ ...opts, client });
    await expect(
      backend.getInstanceStatus({
        id: "/.../virtualMachines/missing",
        backend: "azure",
        name: "missing",
        region: "eastus",
      }),
    ).rejects.toMatchObject({ code: "instance_not_found" });
  });

  it("surfaces provisioningState=Failed status message as reason", async () => {
    const { client, vms } = makeMockClient();
    vms.get.mockResolvedValueOnce({
      provisioningState: "Failed",
      instanceView: {
        statuses: [
          {
            code: "ProvisioningState/failed/InternalOperationError",
            message: "InternalOperationError: ARM is sad",
          },
        ],
      },
    } as VirtualMachine);
    const backend = new AzureBackend({ ...opts, client });
    const status = await backend.getInstanceStatus({
      id: "/.../virtualMachines/sad",
      backend: "azure",
      name: "sad",
      region: "eastus",
    });
    expect(status.state).toBe("unknown");
    expect(status.reason).toContain("ARM is sad");
  });

  it("getInstanceIp returns null (NIC introspection not in this sub-task)", async () => {
    const backend = new AzureBackend({ ...opts, client: makeMockClient().client });
    const ip = await backend.getInstanceIp({
      id: "/.../virtualMachines/x",
      backend: "azure",
      name: "x",
      region: "eastus",
    });
    expect(ip).toBeNull();
  });
});

// ── listInstances ────────────────────────────────────────────────

describe("AzureBackend.listInstances", () => {
  const opts = {
    subscriptionId: "sub",
    resourceGroup: "rg",
    region: "eastus",
  };

  it("filters to Signalman-tagged VMs only", async () => {
    const { client, vms } = makeMockClient();
    vms.listAll.mockReturnValueOnce(
      asyncIter<VirtualMachine>([
        {
          name: "mine",
          id: "/.../virtualMachines/mine",
          location: "eastus",
          tags: { [SIGNALMAN_MANAGED_TAG_KEY]: SIGNALMAN_MANAGED_TAG_VALUE },
        },
        {
          name: "not-mine",
          id: "/.../virtualMachines/not-mine",
          location: "eastus",
          tags: { project: "other" },
        },
      ]),
    );
    const backend = new AzureBackend({ ...opts, client });
    const handles = await backend.listInstances();
    expect(handles).toHaveLength(1);
    expect(handles[0].name).toBe("mine");
  });

  it("narrows by caller tags AFTER signalman-managed filter", async () => {
    const { client, vms } = makeMockClient();
    vms.listAll.mockReturnValueOnce(
      asyncIter<VirtualMachine>([
        {
          name: "alpha",
          id: "/.../virtualMachines/alpha",
          location: "eastus",
          tags: {
            [SIGNALMAN_MANAGED_TAG_KEY]: SIGNALMAN_MANAGED_TAG_VALUE,
            project: "demo",
          },
        },
        {
          name: "beta",
          id: "/.../virtualMachines/beta",
          location: "eastus",
          tags: {
            [SIGNALMAN_MANAGED_TAG_KEY]: SIGNALMAN_MANAGED_TAG_VALUE,
            project: "other",
          },
        },
      ]),
    );
    const backend = new AzureBackend({ ...opts, client });
    const handles = await backend.listInstances({ tags: { project: "demo" } });
    expect(handles).toHaveLength(1);
    expect(handles[0].name).toBe("alpha");
  });

  it("returns empty array when no signalman-managed VMs present", async () => {
    const { client, vms } = makeMockClient();
    vms.listAll.mockReturnValueOnce(
      asyncIter<VirtualMachine>([
        { name: "external", tags: { project: "other" } } as VirtualMachine,
      ]),
    );
    const backend = new AzureBackend({ ...opts, client });
    const handles = await backend.listInstances();
    expect(handles).toEqual([]);
  });

  it("throws quota_exceeded when result exceeds one page", async () => {
    const { client, vms } = makeMockClient();
    const pageSize = 1001;
    const huge = Array.from({ length: pageSize }, (_, i) => ({
      name: `vm-${i}`,
      id: `/.../virtualMachines/vm-${i}`,
      location: "eastus",
      tags: { [SIGNALMAN_MANAGED_TAG_KEY]: SIGNALMAN_MANAGED_TAG_VALUE },
    })) as VirtualMachine[];
    vms.listAll.mockReturnValueOnce(asyncIter(huge));
    const backend = new AzureBackend({ ...opts, client });
    await expect(backend.listInstances()).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });
});

// ── Pure helpers ─────────────────────────────────────────────────

describe("buildAzureTags", () => {
  it("always includes the Signalman sentinel tags", () => {
    const tags = buildAzureTags(fullConfig(), "org-1", 60);
    expect(tags[SIGNALMAN_MANAGED_TAG_KEY]).toBe(SIGNALMAN_MANAGED_TAG_VALUE);
    expect(tags[SIGNALMAN_ORG_TAG_KEY]).toBe("org-1");
    expect(tags["signalman-ttl-minutes"]).toBe("60");
  });

  it("merges caller tags but refuses to override sentinel keys", () => {
    const tags = buildAzureTags(
      fullConfig({
        tags: {
          [SIGNALMAN_MANAGED_TAG_KEY]: "false",
          [SIGNALMAN_ORG_TAG_KEY]: "spoofed",
          "signalman-ttl-minutes": "9999999",
          project: "demo",
        },
      }),
      "real-org",
      60,
    );
    expect(tags[SIGNALMAN_MANAGED_TAG_KEY]).toBe(SIGNALMAN_MANAGED_TAG_VALUE);
    expect(tags[SIGNALMAN_ORG_TAG_KEY]).toBe("real-org");
    expect(tags["signalman-ttl-minutes"]).toBe("60");
    expect(tags.project).toBe("demo");
  });
});

describe("mapAzureError", () => {
  it("maps known auth codes to auth_failed regardless of default", () => {
    const e = Object.assign(new Error("bad"), {
      code: "AuthenticationFailed",
    });
    expect(mapAzureError(e, "provision_failed", "x").code).toBe("auth_failed");
  });

  it("maps statusCode 401 / 403 to auth_failed even with unknown code", () => {
    const e401 = Object.assign(new Error("x"), { statusCode: 401 });
    const e403 = Object.assign(new Error("x"), { statusCode: 403 });
    expect(mapAzureError(e401, "provision_failed", "x").code).toBe("auth_failed");
    expect(mapAzureError(e403, "terminate_failed", "x").code).toBe("auth_failed");
  });

  it("uses the provided default code for non-auth Azure errors", () => {
    const e = Object.assign(new Error("limit"), { code: "TooManyRequests" });
    const wrapped = mapAzureError(e, "terminate_failed", "terminate failed");
    expect(wrapped.code).toBe("terminate_failed");
    expect(wrapped.message).toContain("TooManyRequests");
    expect(wrapped.message).toContain("terminate failed");
  });

  it("preserves the underlying error as cause", () => {
    const e = new Error("inner");
    const wrapped = mapAzureError(e, "provision_failed", "x");
    expect(wrapped.cause).toBe(e);
  });
});

describe("mapAzureState", () => {
  it("maps provisioningState=Creating to pending", () => {
    expect(mapAzureState({ provisioningState: "Creating" } as VirtualMachine)).toBe(
      "pending",
    );
  });

  it("maps provisioningState=Updating to pending", () => {
    expect(mapAzureState({ provisioningState: "Updating" } as VirtualMachine)).toBe(
      "pending",
    );
  });

  it("maps provisioningState=Deleting to terminated", () => {
    expect(mapAzureState({ provisioningState: "Deleting" } as VirtualMachine)).toBe(
      "terminated",
    );
  });

  it("maps provisioningState=Failed to unknown", () => {
    expect(mapAzureState({ provisioningState: "Failed" } as VirtualMachine)).toBe(
      "unknown",
    );
  });

  it("maps PowerState/running to running", () => {
    expect(
      mapAzureState({
        provisioningState: "Succeeded",
        instanceView: { statuses: [{ code: "PowerState/running" }] },
      } as VirtualMachine),
    ).toBe("running");
  });

  it("maps PowerState/stopped to stopped", () => {
    expect(
      mapAzureState({
        provisioningState: "Succeeded",
        instanceView: { statuses: [{ code: "PowerState/stopped" }] },
      } as VirtualMachine),
    ).toBe("stopped");
  });

  it("maps PowerState/deallocated to stopped", () => {
    expect(
      mapAzureState({
        provisioningState: "Succeeded",
        instanceView: { statuses: [{ code: "PowerState/deallocated" }] },
      } as VirtualMachine),
    ).toBe("stopped");
  });

  it("returns unknown when no PowerState is present", () => {
    expect(
      mapAzureState({
        provisioningState: "Succeeded",
        instanceView: { statuses: [{ code: "OtherStatus/foo" }] },
      } as VirtualMachine),
    ).toBe("unknown");
  });

  it("returns unknown when neither provisioningState nor instanceView are present", () => {
    expect(mapAzureState({} as VirtualMachine)).toBe("unknown");
  });
});

// ── Module-load registration ──────────────────────────────────────

describe("Azure backend auto-registration", () => {
  it("registers an 'azure' factory on module import", () => {
    // listRegisteredBackends comes from sub-task 1; should include
    // "azure" once we've imported cloud/azure.js (which happens at
    // the top of this file).
    expect(listRegisteredBackends()).toContain("azure");
  });

  it("getCloudBackend('azure') throws invalid_config when env vars are missing", () => {
    // Save and clear env so the factory walk fails the way it
    // would on a fresh local-mode invocation.
    const priorSub = process.env.AZURE_SUBSCRIPTION_ID;
    const priorRg = process.env.AZURE_RESOURCE_GROUP;
    delete process.env.AZURE_SUBSCRIPTION_ID;
    delete process.env.AZURE_RESOURCE_GROUP;
    try {
      expect(() => getCloudBackend("azure")).toThrowError(
        expect.objectContaining({
          name: "CloudBackendError",
          code: "invalid_config",
        }),
      );
    } finally {
      if (priorSub !== undefined) process.env.AZURE_SUBSCRIPTION_ID = priorSub;
      if (priorRg !== undefined) process.env.AZURE_RESOURCE_GROUP = priorRg;
    }
  });
});

// ── CloudBackendError surface sanity ──────────────────────────────

describe("CloudBackendError — Azure-specific codes route", () => {
  it("auth_failed is recognised by the error class", () => {
    const e = new CloudBackendError("auth_failed", "x");
    expect(e.code).toBe("auth_failed");
  });
});
