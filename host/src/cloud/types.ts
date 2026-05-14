/**
 * Cloud-provider abstraction layer (v0.3.0-5 sub-task 1).
 *
 * Parallels `host/src/hypervisors/interface.ts` for cloud
 * workloads. Cloud VMs don't share the Hyper-V lifecycle (no
 * checkpoint/restore; provision-then-destroy instead), so they
 * get a separate interface rather than overloading
 * `HypervisorBackend`.
 *
 * The orchestrator dispatches between hypervisor and cloud
 * backends via the scenario YAML's `target_kind` field, added in
 * sub-task 2.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Separate interface from `HypervisorBackend`.** Cloud
 *   workloads are conceptually different (no checkpoints,
 *   immutable images, lifecycle is provision-then-destroy). A
 *   single overloaded interface would either lose type safety or
 *   force every backend to no-op half its methods.
 * - **TTL is config-side, not enforced by the backend.** The
 *   cost-guardrails reaper (sub-task 6) polls `listInstances`
 *   filtered by Signalman tags and terminates past-TTL instances.
 *   Keeps the backend implementation small.
 * - **Tag-based ownership.** Every Signalman-provisioned cloud
 *   instance carries `signalman-managed=true` +
 *   `signalman-org=<org_id>` tags so the reaper and audit tools
 *   can identify them without leaking other workloads.
 * - **No vendor-specific surface here.** AMI IDs, Azure managed-
 *   image IDs, GCP image families are passed as opaque strings
 *   in `CloudInstanceConfig.image_ref`. Vendor-specific helpers
 *   (e.g. AMI-region lookup, image-spec validation) live in the
 *   per-vendor backend modules.
 * - **Async provision waits for `running`.** Production callers
 *   get a handle that's known-startable. Test callers inject
 *   stubs that return immediately without polling.
 *
 * # Sub-task scope
 *
 * This commit ships ONLY the abstraction:
 *   - `CloudBackend` interface
 *   - Config + handle + status shapes
 *   - Backend-kind + target-kind enums
 *   - `CloudBackendError` with stable codes
 *
 * No vendor SDK deps. No registry calls beyond the module-level
 * singletons in `registry.ts`. AWS / Azure / OpenTofu / k8s
 * implementations land in sub-tasks 2-7.
 */

// ── Enums ──────────────────────────────────────────────────────────

/**
 * Cloud-backend identifier. Open-ended string union so vendors
 * can be added without coordinating with the abstraction.
 *
 * `aws` and `azure` ship in sub-tasks 2 and 3. `gcp`, `ibm`,
 * `digitalocean` etc are reserved future values.
 */
export type CloudBackendKind = "aws" | "azure" | "gcp" | "ibm" | "digitalocean";

/**
 * Target-kind enum extending the scenario YAML's `vms[]` /
 * `stacks[]` dispatch.
 *
 * - `cloud_vm_test` — ephemeral cloud VM, single instance.
 *   Routes through {@link CloudBackend.provisionInstance}.
 * - `cloud_stack_test` — multi-resource cloud stack defined as
 *   HCL. Routes through the OpenTofu driver (sub-task 4); not
 *   yet handled by this abstraction.
 * - `k8s_test` — manifests-based Kubernetes deploy. Routes
 *   through the k8s driver (v0.3.0-6); not yet handled by this
 *   abstraction.
 *
 * The legacy "hypervisor" kind is the implicit default when the
 * scenario YAML omits `target_kind`; existing scenarios continue
 * to work unchanged.
 */
export type CloudTargetKind =
  | "cloud_vm_test"
  | "cloud_stack_test"
  | "k8s_test";

// ── Config + handle + status shapes ───────────────────────────────

/**
 * Inputs to {@link CloudBackend.provisionInstance}.
 *
 * Vendor-specific identifiers (AMI / Azure managed-image / GCP
 * image family) pass through as opaque strings in `image_ref`.
 * The backend interprets them; the abstraction does not.
 */
export interface CloudInstanceConfig {
  /**
   * Provider-specific region identifier. e.g. `"us-east-1"`,
   * `"eastus"`, `"us-central1"`. Required; the abstraction
   * does not assume a default.
   */
  region: string;
  /**
   * Provider-specific instance type / SKU. e.g. `"t3.medium"`,
   * `"Standard_D2s_v3"`, `"n1-standard-2"`. Required.
   */
  instance_type: string;
  /**
   * Opaque image identifier. The provider interprets it: AWS AMI
   * id, Azure managed-image id, GCP image self-link, etc.
   * Required.
   */
  image_ref: string;
  /**
   * Friendly name for the instance. Surfaces as a vendor tag (AWS
   * Name tag, Azure VM name, GCP instance name). Sanitised by the
   * vendor implementation if needed.
   */
  name: string;
  /**
   * Organisation id the instance belongs to. Surfaces as a
   * `signalman-org` vendor tag so the cost-reaper (sub-task 6)
   * can attribute usage. Required for production calls;
   * defaults to `"default"` for local-mode tests.
   */
  org_id?: string;
  /**
   * Max lifetime in minutes. The cost-guardrails reaper
   * (sub-task 6) polls instances and terminates past-TTL ones.
   * Defaults to {@link DEFAULT_INSTANCE_TTL_MINUTES} (60min).
   * Operators tune for their max-expected-scenario wall-clock.
   */
  ttl_minutes?: number;
  /**
   * SSH public key (OpenSSH format) to inject. Optional; the
   * vendor backend wires it into the instance's user-data or
   * vendor key-management API. When omitted, the instance is
   * provisioned without a key (only the guest agent's mTLS path
   * remains).
   */
  ssh_public_key?: string;
  /**
   * Additional vendor tags merged onto the instance. The
   * `signalman-managed=true` and `signalman-org=<org_id>` tags
   * are always added; caller tags can override them only via
   * explicit operator decision (the vendor backend enforces).
   */
  tags?: Record<string, string>;
  /**
   * Network configuration. Optional; the vendor backend supplies
   * a sensible default VPC / vnet when omitted. Cross-vendor
   * shape kept narrow on purpose; vendor-specific knobs (e.g.
   * AWS placement groups) belong in the backend's own option type.
   */
  network?: {
    /**
     * Vendor subnet id. Optional; defaults to the vendor's
     * default subnet in the chosen region.
     */
    subnet_id?: string;
    /**
     * Vendor security-group / nsg id(s). Optional.
     */
    security_group_ids?: string[];
    /**
     * Whether to attach a public IP. Defaults to true for
     * `cloud_vm_test` (the orchestrator needs reachability for
     * the guest agent), false for cloud runners (which dial out).
     */
    assign_public_ip?: boolean;
  };
}

/**
 * Opaque handle for an in-flight cloud instance. The vendor
 * backend populates the fields; callers treat the object as
 * opaque outside `CloudBackend.*` calls.
 */
export interface CloudInstanceHandle {
  /** Vendor-specific instance id (AWS instance-id, Azure resource id, ...). */
  id: string;
  /** Backend kind that owns this handle. */
  backend: CloudBackendKind;
  /** Friendly name from the config. */
  name: string;
  /** Region the instance was provisioned in. */
  region: string;
}

/** Runtime state of a cloud instance. */
export type CloudInstanceState =
  | "pending"
  | "running"
  | "stopped"
  | "terminated"
  | "unknown";

/** Status of a cloud instance, returned by `getInstanceStatus`. */
export interface CloudInstanceStatus {
  handle: CloudInstanceHandle;
  state: CloudInstanceState;
  /** Public IP if assigned + the instance has one yet. */
  public_ip?: string;
  /** Private IP within the VPC / vnet. */
  private_ip?: string;
  /** Vendor-specific status reason when state is `unknown` or stuck. */
  reason?: string;
}

// ── Public constants ──────────────────────────────────────────────

/** Default TTL applied when {@link CloudInstanceConfig.ttl_minutes} is absent. */
export const DEFAULT_INSTANCE_TTL_MINUTES = 60;

/** Required tag key signalling Signalman-managed instances to the reaper. */
export const SIGNALMAN_MANAGED_TAG_KEY = "signalman-managed";

/** Required tag key carrying the owning org id. */
export const SIGNALMAN_ORG_TAG_KEY = "signalman-org";

/** Value the reaper matches against {@link SIGNALMAN_MANAGED_TAG_KEY}. */
export const SIGNALMAN_MANAGED_TAG_VALUE = "true";

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Stable error code for `CloudBackendError`. Callers can dispatch
 * on these without parsing message strings.
 *
 * Codes prefixed `tofu_` are added by the OpenTofu driver
 * (sub-task 4); other vendor backends shouldn't emit them.
 */
export type CloudBackendErrorCode =
  | "unsupported_provider"
  | "provision_failed"
  | "terminate_failed"
  | "instance_not_found"
  | "ttl_expired"
  | "auth_failed"
  | "quota_exceeded"
  | "invalid_config"
  // ── OpenTofu driver (sub-task 4) ────────────────────────────
  | "tofu_failed"
  | "tofu_not_found"
  | "invalid_stack_name"
  | "module_path_missing"
  | "project_root_invalid";

/**
 * Structured error for cloud-backend failures. Carries the stable
 * `code` plus an optional underlying `cause` (vendor SDK error,
 * subprocess stderr text, etc).
 */
export class CloudBackendError extends Error {
  constructor(
    public readonly code: CloudBackendErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CloudBackendError";
  }
}

// ── Backend interface ─────────────────────────────────────────────

/**
 * Per-vendor cloud backend. Implementations live in
 * `host/src/cloud/aws.ts`, `azure.ts`, etc (sub-tasks 2+).
 *
 * Method-level locked rules:
 *
 * - `provisionInstance` is async; it waits for the cloud to
 *   confirm `running` state before returning. Pre-running
 *   states (`pending`, `creating`) are internal to the backend.
 *   Production callers always get a `running` handle.
 * - `terminateInstance` is idempotent — a handle for an
 *   already-terminated instance returns success, not an error.
 *   The cost-reaper depends on this so repeat sweeps don't
 *   error on race-deletions.
 * - `getInstanceStatus` may return `state: "unknown"` with a
 *   vendor-specific `reason` when the cloud is in an unusual
 *   transitional state. Callers branch on `state` and skip
 *   action on `unknown` rather than treating it as either
 *   running or stopped.
 * - `listInstances` returns ONLY Signalman-tagged instances
 *   (filter by the `SIGNALMAN_MANAGED_TAG_*` constants). Backends
 *   must enforce this so the reaper can't accidentally touch
 *   operator-owned cloud workloads.
 */
export interface CloudBackend {
  /** Backend identifier; matches the registry key. */
  readonly name: CloudBackendKind;
  /**
   * Provision a single cloud instance and wait for it to reach
   * `running` state. Throws {@link CloudBackendError} on any
   * failure during provisioning or polling.
   */
  provisionInstance(config: CloudInstanceConfig): Promise<CloudInstanceHandle>;
  /**
   * Terminate an instance. Idempotent — terminating an already-
   * terminated handle is success.
   */
  terminateInstance(handle: CloudInstanceHandle): Promise<void>;
  /** Read current state + IPs for an instance. */
  getInstanceStatus(handle: CloudInstanceHandle): Promise<CloudInstanceStatus>;
  /** Convenience accessor over `getInstanceStatus().public_ip`. */
  getInstanceIp(handle: CloudInstanceHandle): Promise<string | null>;
  /**
   * List Signalman-tagged instances for this backend. The
   * backend filters by `signalman-managed=true` internally;
   * callers may further restrict via `filter.tags`.
   *
   * Returns at most one page of instances (vendor-specific
   * pagination is hidden behind this call; backends that hit
   * pagination boundaries throw `quota_exceeded` for the
   * operator to widen filters).
   */
  listInstances(filter?: {
    tags?: Record<string, string>;
  }): Promise<CloudInstanceHandle[]>;
}
