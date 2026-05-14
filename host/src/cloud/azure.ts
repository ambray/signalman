/**
 * Azure cloud backend (v0.3.0-5 sub-task 3).
 *
 * Implements `CloudBackend` for Azure Virtual Machines via the
 * official `@azure/arm-compute` SDK (MIT, Microsoft-maintained).
 *
 * # Locked design (do not re-litigate)
 *
 * - **Compute only.** This backend manages individual VMs only.
 *   Multi-resource stacks (`cloud_stack_test`) route through the
 *   OpenTofu driver (sub-task 4), not this module.
 * - **Subscription + resource group scoped.** Azure RM clients
 *   require a subscription id at construction time, and almost
 *   every operation requires a resource group. The backend takes
 *   both at construction; operators with multi-RG needs construct
 *   separate `AzureBackend` instances (mirrors AWS's per-region
 *   pattern).
 * - **Operator pre-creates NIC + public IP.** For v0.3.0-5
 *   sub-task 3, the abstraction's `config.network.subnet_id`
 *   field holds the Azure NIC's full ARM resource id (e.g.
 *   `/subscriptions/.../networkInterfaces/my-nic`). Signalman
 *   does NOT create networking resources in this sub-task —
 *   that's a follow-up (`@azure/arm-network` integration).
 *   Documented in the field's JSDoc and surfaced in the
 *   `invalid_config` error path so operators get a clear
 *   remediation.
 * - **Constructor-injected client.** Tests pass a stub
 *   `ComputeManagementClient` with `virtualMachines.*` methods
 *   mocked via `vi.fn`. Production callers leave the client
 *   undefined; the constructor wires `new ComputeManagementClient
 *   (new DefaultAzureCredential(), subscriptionId)`.
 * - **SDK's built-in poller for provision + delete.** Azure SDK's
 *   `beginCreateOrUpdateAndWait` and `beginDeleteAndWait` handle
 *   the polling internally with their own timeouts. We don't
 *   bolt our own loop on top — Azure SDK polling is well-tested
 *   and operators expect Azure-style timeouts.
 * - **Custom image resource ids only.** `image_ref` must be a
 *   full ARM resource id (e.g. `/subscriptions/.../galleries/.../
 *   images/.../versions/latest`). Marketplace images
 *   (`{publisher, offer, sku, version}` 4-tuple) are out of
 *   scope for sub-task 3; documented as a follow-up.
 * - **Tag-based ownership.** Same contract as the AWS backend:
 *   every provisioned VM carries `signalman-managed=true` +
 *   `signalman-org=<id>` tags; caller tags can't spoof these
 *   sentinels (see `buildAzureTags`).
 * - **Idempotent terminate.** Azure delete returns success for
 *   already-deleted VMs (per ARM contract); we surface that
 *   verbatim.
 *
 * # What this module does NOT do
 *
 * - Marketplace image lookup (follow-up)
 * - NIC / public IP / VNet / subnet creation (operator pre-creates)
 * - Disk cleanup on terminate — Azure auto-deletes the OS disk
 *   when `deleteOption: "Delete"` is set on the OS disk config
 *   at provision time (which we do); data disks are out of scope
 * - `ssh_public_key` injection (matches AWS sub-task; follow-up
 *   for both providers via cloud-init UserData / Azure's
 *   `osProfile.linuxConfiguration.ssh.publicKeys`)
 * - `listInstances` pagination beyond one Azure page
 */

import {
  ComputeManagementClient,
  type VirtualMachine,
} from "@azure/arm-compute";

import { registerCloudBackend } from "./registry.js";
import {
  CloudBackendError,
  type CloudBackend,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
  type CloudInstanceState,
  type CloudInstanceStatus,
  DEFAULT_INSTANCE_TTL_MINUTES,
  SIGNALMAN_MANAGED_TAG_KEY,
  SIGNALMAN_MANAGED_TAG_VALUE,
  SIGNALMAN_ORG_TAG_KEY,
  SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY,
  SIGNALMAN_TTL_MINUTES_TAG_KEY,
} from "./types.js";

// ── Options ────────────────────────────────────────────────────────

/**
 * Constructor options for {@link AzureBackend}.
 *
 * Production callers supply just `subscriptionId` + `resourceGroup`
 * + `region`; tests inject a stub `client` with mocked
 * `virtualMachines` methods.
 */
export interface AzureBackendOptions {
  /** Azure subscription id (GUID). */
  subscriptionId: string;
  /** Resource group all operations target. */
  resourceGroup: string;
  /** Azure region (`"eastus"`, `"westeurope"`, ...). */
  region: string;
  /**
   * Pre-constructed client. Leave undefined in production; the
   * constructor wires `new ComputeManagementClient(new
   * DefaultAzureCredential(), subscriptionId)`. Tests inject a
   * stub.
   */
  client?: ComputeManagementClient;
}

// ── Backend implementation ────────────────────────────────────────

/**
 * Azure VM implementation of `CloudBackend`.
 *
 * Construct directly with a stub client for tests, or rely on the
 * module-load registration that wires it under
 * `getCloudBackend("azure")` with config from env.
 */
export class AzureBackend implements CloudBackend {
  readonly name = "azure" as const;
  private readonly client: ComputeManagementClient;
  private readonly subscriptionId: string;
  private readonly resourceGroup: string;
  private readonly region: string;

  constructor(opts: AzureBackendOptions) {
    if (!opts.subscriptionId || opts.subscriptionId.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "AzureBackend requires a non-empty subscriptionId",
      );
    }
    if (!opts.resourceGroup || opts.resourceGroup.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "AzureBackend requires a non-empty resourceGroup",
      );
    }
    if (!opts.region || opts.region.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "AzureBackend requires a non-empty region",
      );
    }
    this.subscriptionId = opts.subscriptionId;
    this.resourceGroup = opts.resourceGroup;
    this.region = opts.region;
    this.client = opts.client ?? buildDefaultClient(opts.subscriptionId);
  }

  async provisionInstance(
    config: CloudInstanceConfig,
  ): Promise<CloudInstanceHandle> {
    // ── Validate config ──
    if (!config.image_ref || config.image_ref.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "Azure provisionInstance requires image_ref (ARM resource id of " +
          "the image / gallery image version)",
      );
    }
    if (!config.instance_type || config.instance_type.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "Azure provisionInstance requires instance_type (Azure VM size, " +
          "e.g. 'Standard_D2s_v3')",
      );
    }
    if (config.region !== this.region) {
      throw new CloudBackendError(
        "invalid_config",
        `Azure backend is scoped to region '${this.region}' but ` +
          `config requested '${config.region}'. Construct a separate ` +
          `AzureBackend per region.`,
      );
    }
    const nicId = config.network?.subnet_id;
    if (!nicId || nicId.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "Azure provisionInstance requires config.network.subnet_id to " +
          "hold the ARM resource id of a pre-created Network Interface " +
          "(NIC). Signalman does not create networking resources in " +
          "v0.3.0-5 sub-task 3; operators pre-create the VNet, subnet, " +
          "and NIC (optionally with a public IP attached) and reference " +
          "the NIC here.",
      );
    }

    const orgId = config.org_id ?? "default";
    const ttlMinutes = config.ttl_minutes ?? DEFAULT_INSTANCE_TTL_MINUTES;
    const tags = buildAzureTags(config, orgId, ttlMinutes);

    const vmParams: VirtualMachine = {
      location: this.region,
      hardwareProfile: { vmSize: config.instance_type },
      storageProfile: {
        imageReference: { id: config.image_ref },
        osDisk: {
          createOption: "FromImage",
          // Azure does not auto-clean OS disks on VM delete unless
          // we set deleteOption=Delete at provision time. Without
          // this, terminated VMs leak their OS disks indefinitely.
          deleteOption: "Delete",
        },
      },
      networkProfile: {
        networkInterfaces: [
          { id: nicId, primary: true },
        ],
      },
      tags,
    };

    let vm: VirtualMachine;
    try {
      vm = await this.client.virtualMachines.beginCreateOrUpdateAndWait(
        this.resourceGroup,
        config.name,
        vmParams,
      );
    } catch (err) {
      throw mapAzureError(err, "provision_failed", "VM create failed");
    }

    return {
      id: vm.id ?? `${this.resourceGroup}/${config.name}`,
      backend: "azure",
      name: config.name,
      region: this.region,
    };
  }

  async terminateInstance(handle: CloudInstanceHandle): Promise<void> {
    try {
      await this.client.virtualMachines.beginDeleteAndWait(
        this.resourceGroup,
        handle.name,
      );
    } catch (err) {
      if (isAzureNotFound(err)) {
        // Azure ARM contract: delete of an already-deleted VM
        // returns 204 / ResourceNotFound. Treat as idempotent
        // success — the reaper depends on this when sweeping
        // races.
        return;
      }
      throw mapAzureError(err, "terminate_failed", "VM delete failed");
    }
  }

  async getInstanceStatus(
    handle: CloudInstanceHandle,
  ): Promise<CloudInstanceStatus> {
    let vm: VirtualMachine;
    try {
      vm = await this.client.virtualMachines.get(
        this.resourceGroup,
        handle.name,
        // expand=instanceView returns the running power-state in
        // addition to the static provisioningState. We need both
        // to map cleanly to our abstraction's CloudInstanceState.
        { expand: "instanceView" },
      );
    } catch (err) {
      if (isAzureNotFound(err)) {
        throw new CloudBackendError(
          "instance_not_found",
          `Azure VM ${handle.name} not found in ${this.resourceGroup}`,
          err,
        );
      }
      throw mapAzureError(err, "provision_failed", "VM get failed");
    }
    return {
      handle,
      state: mapAzureState(vm),
      // sub-task 3 doesn't ship NIC introspection — IPs require a
      // separate @azure/arm-network call to resolve the NIC's
      // ipConfigurations. Returning undefined for now; the
      // follow-up that adds NIC management also wires IPs.
      reason: vm.instanceView?.statuses?.find(
        (s) => s.code?.startsWith("ProvisioningState/failed"),
      )?.message,
    };
  }

  async getInstanceIp(_handle: CloudInstanceHandle): Promise<string | null> {
    // See getInstanceStatus comment: requires @azure/arm-network.
    // Returning null is the documented "no IP available" sentinel;
    // callers that need IPs in v0.3.0-5 sub-task 3 must read
    // them from the operator-managed NIC out-of-band.
    return null;
  }

  async listInstances(filter?: {
    tags?: Record<string, string>;
  }): Promise<CloudInstanceHandle[]> {
    const handles: CloudInstanceHandle[] = [];
    try {
      // listAll returns an AsyncIterable across the subscription;
      // we filter client-side because Azure RM doesn't support
      // tag-equality filters in the list operation (only on the
      // resources REST API, which has a different shape and
      // pagination model).
      //
      // Pagination: Azure SDK's iterator handles paging internally.
      // We bound the total count we accumulate to one "page" of
      // 1000 results — see the quota_exceeded throw below.
      const pageSize = 1000;
      for await (const vm of this.client.virtualMachines.listAll()) {
        if (handles.length >= pageSize) {
          throw new CloudBackendError(
            "quota_exceeded",
            `Azure listInstances result exceeded ${pageSize} entries in ` +
              `subscription ${this.subscriptionId}: narrow the filter ` +
              `(e.g. add an org tag) or wait for the pagination follow-up.`,
          );
        }
        const tags = vm.tags ?? {};
        // Required: signalman-managed tag.
        if (tags[SIGNALMAN_MANAGED_TAG_KEY] !== SIGNALMAN_MANAGED_TAG_VALUE) {
          continue;
        }
        // Caller filter tags.
        if (filter?.tags) {
          let matchAll = true;
          for (const [k, v] of Object.entries(filter.tags)) {
            if (tags[k] !== v) {
              matchAll = false;
              break;
            }
          }
          if (!matchAll) continue;
        }
        if (!vm.name) continue;
        handles.push({
          id: vm.id ?? `${this.resourceGroup}/${vm.name}`,
          backend: "azure",
          name: vm.name,
          region: vm.location ?? this.region,
          tags: { ...tags },
        });
      }
    } catch (err) {
      if (err instanceof CloudBackendError) throw err;
      throw mapAzureError(err, "provision_failed", "VM listAll failed");
    }
    return handles;
  }
}

// ── Tagging helpers ───────────────────────────────────────────────

/**
 * Build the full Azure VM tag set: the always-on Signalman tags
 * plus any caller-supplied tags. Caller tags can't override the
 * sentinel keys — same spoofing defence as the AWS backend.
 *
 * Exported for tests.
 */
export function buildAzureTags(
  config: CloudInstanceConfig,
  orgId: string,
  ttlMinutes: number,
  now: Date = new Date(),
): Record<string, string> {
  const expiresAtEpochSec = Math.floor(now.getTime() / 1000) + ttlMinutes * 60;
  const sentinelKeys = new Set([
    SIGNALMAN_MANAGED_TAG_KEY,
    SIGNALMAN_ORG_TAG_KEY,
    SIGNALMAN_TTL_MINUTES_TAG_KEY,
    SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY,
  ]);
  const tags: Record<string, string> = {
    [SIGNALMAN_MANAGED_TAG_KEY]: SIGNALMAN_MANAGED_TAG_VALUE,
    [SIGNALMAN_ORG_TAG_KEY]: orgId,
    [SIGNALMAN_TTL_MINUTES_TAG_KEY]: String(ttlMinutes),
    [SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY]: String(expiresAtEpochSec),
  };
  if (config.tags) {
    for (const [k, v] of Object.entries(config.tags)) {
      if (sentinelKeys.has(k)) continue; // sentinel wins
      tags[k] = v;
    }
  }
  return tags;
}

// ── Error mapping ─────────────────────────────────────────────────

/**
 * Map an Azure SDK error to a `CloudBackendError`. The SDK
 * surfaces errors with a `statusCode` (HTTP status) and a `code`
 * (Azure-specific string like `"ResourceNotFound"`).
 *
 * Auth-related codes route to `auth_failed`; everything else
 * uses the supplied default.
 *
 * Exported for tests.
 */
export function mapAzureError(
  err: unknown,
  defaultCode: "provision_failed" | "terminate_failed" | "auth_failed",
  fallbackMessage: string,
): CloudBackendError {
  const e = err as {
    code?: string;
    statusCode?: number;
    message?: string;
    name?: string;
  };
  const azureCode = e.code ?? e.name;
  const authCodes = new Set([
    "InvalidAuthenticationTokenTenant",
    "AuthenticationFailed",
    "Unauthorized",
    "ExpiredAuthenticationToken",
    "InvalidAuthenticationToken",
  ]);
  const code =
    azureCode && authCodes.has(azureCode)
      ? "auth_failed"
      : e.statusCode === 401 || e.statusCode === 403
      ? "auth_failed"
      : defaultCode;
  const message = azureCode
    ? `${fallbackMessage} (Azure code: ${azureCode}): ${e.message ?? String(err)}`
    : `${fallbackMessage}: ${e.message ?? String(err)}`;
  return new CloudBackendError(code, message, err);
}

/**
 * Detect Azure's "resource not found" surface. The SDK uses
 * `statusCode === 404` on the error object plus optionally
 * `code === "ResourceNotFound"`.
 */
function isAzureNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string };
  return e.statusCode === 404 || e.code === "ResourceNotFound";
}

// ── State mapping ─────────────────────────────────────────────────

/**
 * Map an Azure VM's combined provisioningState + power-state
 * (via `instanceView`) to our abstraction's `CloudInstanceState`.
 *
 * Azure has two state axes:
 * - provisioningState: Creating / Updating / Succeeded / Failed / Deleting
 * - power-state (in instanceView statuses): starting / running / stopping
 *   / stopped / deallocating / deallocated
 *
 * The combination determines what we surface:
 * - provisioningState=Failed → `unknown` with reason
 * - provisioningState=Deleting → `terminated`
 * - power-state=running → `running`
 * - power-state=stopped/deallocated → `stopped`
 * - provisioningState=Creating → `pending`
 * - default → `unknown`
 *
 * Exported for tests.
 */
export function mapAzureState(vm: VirtualMachine): CloudInstanceState {
  const provisioning = vm.provisioningState;
  if (provisioning === "Failed") return "unknown";
  if (provisioning === "Deleting") return "terminated";
  if (provisioning === "Creating" || provisioning === "Updating") {
    return "pending";
  }
  // provisioningState = "Succeeded" (or undefined) — fall through
  // to the power-state from instanceView.
  const powerStatus = vm.instanceView?.statuses?.find((s) =>
    s.code?.startsWith("PowerState/"),
  );
  const power = powerStatus?.code?.replace("PowerState/", "");
  switch (power) {
    case "running":
    case "starting":
      return "running";
    case "stopping":
    case "stopped":
    case "deallocating":
    case "deallocated":
      return "stopped";
    default:
      return "unknown";
  }
}

// ── Default-client construction ───────────────────────────────────

/**
 * Build a production `ComputeManagementClient` using the SDK's
 * `DefaultAzureCredential` (walks env vars → managed identity →
 * Azure CLI). Pulled into a function so the import of
 * `@azure/identity` happens lazily — tests using an injected
 * client never load it.
 */
function buildDefaultClient(subscriptionId: string): ComputeManagementClient {
  // Lazy require so tests that inject a client don't need
  // `@azure/identity` available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DefaultAzureCredential } = require("@azure/identity") as {
    DefaultAzureCredential: new () => unknown;
  };
  // The TokenCredential interface is satisfied by DefaultAzureCredential
  // at runtime; cast at the boundary so the abstraction stays SDK-shape-
  // independent.
  const credential =
    new DefaultAzureCredential() as ConstructorParameters<
      typeof ComputeManagementClient
    >[0];
  return new ComputeManagementClient(credential, subscriptionId);
}

// ── Module-load registration ──────────────────────────────────────

/**
 * Register the Azure backend factory at module-load time.
 *
 * The factory reads three env vars:
 * - `AZURE_SUBSCRIPTION_ID` (required)
 * - `AZURE_RESOURCE_GROUP` (required)
 * - `AZURE_REGION` (defaults to `"eastus"`)
 *
 * If a required env var is missing, the factory throws
 * `invalid_config` on first `getCloudBackend("azure")` call —
 * lazy enough that just importing this module doesn't fail in
 * environments without Azure credentials configured.
 */
registerCloudBackend(
  "azure",
  () => {
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
    const region = process.env.AZURE_REGION ?? "eastus";
    if (!subscriptionId) {
      throw new CloudBackendError(
        "invalid_config",
        "AZURE_SUBSCRIPTION_ID env var is required to construct the " +
          "default Azure backend. Set it or construct AzureBackend " +
          "directly with explicit options.",
      );
    }
    if (!resourceGroup) {
      throw new CloudBackendError(
        "invalid_config",
        "AZURE_RESOURCE_GROUP env var is required to construct the " +
          "default Azure backend. Set it or construct AzureBackend " +
          "directly with explicit options.",
      );
    }
    return new AzureBackend({ subscriptionId, resourceGroup, region });
  },
);
