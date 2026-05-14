/**
 * AWS cloud backend (v0.3.0-5 sub-task 2).
 *
 * Implements `CloudBackend` for AWS EC2. Uses the official
 * `@aws-sdk/client-ec2` v3 SDK (Apache-2.0, Amazon-maintained).
 *
 * # Locked design (do not re-litigate)
 *
 * - **EC2 only.** This backend handles single-instance VMs
 *   (`cloud_vm_test`). Multi-resource stacks (`cloud_stack_test`)
 *   route through the OpenTofu driver (sub-task 4), not this
 *   module. EC2 RunInstances is intentionally narrow.
 * - **Constructor-injected client.** Tests pass a stub `EC2Client`
 *   with a `vi.fn` `send` method. Production callers leave the
 *   client undefined and we construct one with the configured
 *   region. No `aws-sdk-client-mock` dep needed.
 * - **Polling loop, not SDK waiter.** The AWS SDK's
 *   `waitUntilInstanceRunning` helper pulls in `@smithy/util-waiter`
 *   and uses opaque retry math. We roll our own simple polling
 *   with explicit timeout + interval so tests can drive it
 *   deterministically. Default: 60s timeout, 2s interval.
 * - **Tag-based ownership.** Every provisioned instance carries
 *   `signalman-managed=true` + `signalman-org=<org_id>` tags.
 *   `listInstances` filters by these tags on the AWS side so the
 *   cost-reaper (sub-task 6) only sees Signalman instances.
 * - **Terminate is idempotent.** AWS itself returns success when
 *   terminating an already-terminated instance; we surface that
 *   verbatim. The cost-reaper depends on this when sweeping
 *   races.
 *
 * # What this module does NOT do
 *
 * - **`ssh_public_key` is silently ignored in this sub-task.**
 *   Cloud-init UserData injection lands as a follow-up; the
 *   abstraction declares the field but the AWS backend doesn't
 *   wire it yet. Documented in the field's JSDoc.
 * - **`listInstances` returns at most one page** (1000 instances
 *   per AWS default). Pagination lands when a real consumer hits
 *   the limit; sub-task 2 throws `quota_exceeded` if the result
 *   says there's a NextToken.
 * - **No SDK retry/backoff customisation.** Uses the SDK's
 *   default retry strategy. Operators can tune via
 *   AWS_MAX_ATTEMPTS env var per the SDK's contract.
 */

import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type DescribeInstancesCommandOutput,
  type Filter,
  type _InstanceType,
  type RunInstancesCommandOutput,
  type Tag,
  type TerminateInstancesCommandOutput,
} from "@aws-sdk/client-ec2";

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
} from "./types.js";

// ── Public constants ──────────────────────────────────────────────

/** Default poll interval while waiting for an instance to reach `running`. */
export const AWS_PROVISION_POLL_INTERVAL_MS = 2_000;

/** Default timeout for the `running`-state wait. */
export const AWS_PROVISION_TIMEOUT_MS = 60_000;

// ── Options ────────────────────────────────────────────────────────

/** Constructor options for {@link AwsBackend}. */
export interface AwsBackendOptions {
  /**
   * AWS region the backend operates in. Required because AWS
   * SDK clients are region-scoped; cross-region operations
   * require separate clients.
   */
  region: string;
  /**
   * Pre-constructed EC2 client. Production callers leave this
   * undefined and we construct one with the configured region.
   * Tests inject a stub with a `send` mock.
   */
  client?: EC2Client;
  /**
   * Poll interval while waiting for an instance to reach `running`.
   * Defaults to {@link AWS_PROVISION_POLL_INTERVAL_MS} (2s).
   * Tests inject a small value to keep the suite fast.
   */
  pollIntervalMs?: number;
  /**
   * Timeout for the running-state wait. Defaults to
   * {@link AWS_PROVISION_TIMEOUT_MS} (60s). Tests inject a small
   * value to verify the timeout path.
   */
  pollTimeoutMs?: number;
  /**
   * Injectable sleep function for testability. Defaults to
   * `setTimeout`. Tests inject a function that resolves
   * immediately so the polling loop completes without real
   * wall-clock waits.
   */
  sleep?: (ms: number) => Promise<void>;
}

// ── Backend implementation ────────────────────────────────────────

/**
 * AWS-EC2 implementation of `CloudBackend`.
 *
 * Construct directly for tests with an injected client, or rely
 * on the module-load registration that wires it under
 * `getCloudBackend("aws")`.
 */
export class AwsBackend implements CloudBackend {
  readonly name = "aws" as const;
  private readonly client: EC2Client;
  private readonly region: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AwsBackendOptions) {
    if (!opts.region || opts.region.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "AwsBackend requires a non-empty region",
      );
    }
    this.region = opts.region;
    this.client = opts.client ?? new EC2Client({ region: opts.region });
    this.pollIntervalMs = opts.pollIntervalMs ?? AWS_PROVISION_POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? AWS_PROVISION_TIMEOUT_MS;
    this.sleep =
      opts.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async provisionInstance(
    config: CloudInstanceConfig,
  ): Promise<CloudInstanceHandle> {
    // ── Validate config ──
    if (!config.image_ref || config.image_ref.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "AWS provisionInstance requires image_ref (AMI id)",
      );
    }
    if (!config.instance_type || config.instance_type.length === 0) {
      throw new CloudBackendError(
        "invalid_config",
        "AWS provisionInstance requires instance_type",
      );
    }
    if (config.region !== this.region) {
      throw new CloudBackendError(
        "invalid_config",
        `AWS backend is scoped to region '${this.region}' but ` +
          `config requested '${config.region}'. Construct a separate ` +
          `AwsBackend per region (AWS SDK clients are region-scoped).`,
      );
    }

    // ── Build RunInstancesCommand ──
    const orgId = config.org_id ?? "default";
    const ttlMinutes = config.ttl_minutes ?? DEFAULT_INSTANCE_TTL_MINUTES;
    const tags = buildInstanceTags(config, orgId, ttlMinutes);

    const runInput = {
      ImageId: config.image_ref,
      // The abstraction takes a free string; AWS SDK types it as a
      // string-literal union. Cast at the boundary — the SDK
      // rejects unknown types at the API layer if the cast is wrong,
      // which is the right error surface (AWS-side, not at compile).
      InstanceType: config.instance_type as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: config.network?.subnet_id,
      SecurityGroupIds: config.network?.security_group_ids,
      // AWS treats undefined as "use subnet default"; we surface
      // the abstraction's `assign_public_ip` only when set.
      ...(config.network?.assign_public_ip !== undefined
        ? {
            NetworkInterfaces: [
              {
                DeviceIndex: 0,
                AssociatePublicIpAddress: config.network.assign_public_ip,
                SubnetId: config.network?.subnet_id,
                Groups: config.network?.security_group_ids,
              },
            ],
            // SubnetId + SecurityGroupIds can't appear at top level
            // when NetworkInterfaces is set.
            SubnetId: undefined,
            SecurityGroupIds: undefined,
          }
        : {}),
      TagSpecifications: [
        {
          ResourceType: "instance" as const,
          Tags: tags,
        },
      ],
    };

    let runOutput: RunInstancesCommandOutput;
    try {
      runOutput = await this.client.send(new RunInstancesCommand(runInput));
    } catch (err) {
      throw mapAwsError(err, "provision_failed", "RunInstances failed");
    }

    const instance = runOutput.Instances?.[0];
    if (!instance || !instance.InstanceId) {
      throw new CloudBackendError(
        "provision_failed",
        "RunInstances returned no instance id",
      );
    }

    const handle: CloudInstanceHandle = {
      id: instance.InstanceId,
      backend: "aws",
      name: config.name,
      region: this.region,
    };

    // ── Poll until running ──
    await this.waitUntilRunning(handle);

    return handle;
  }

  async terminateInstance(handle: CloudInstanceHandle): Promise<void> {
    let out: TerminateInstancesCommandOutput;
    try {
      out = await this.client.send(
        new TerminateInstancesCommand({ InstanceIds: [handle.id] }),
      );
    } catch (err) {
      // AWS returns InvalidInstanceID.NotFound when the instance
      // doesn't exist. Treat as idempotent success — the reaper
      // depends on this when sweeping races.
      if (isAwsErrorCode(err, "InvalidInstanceID.NotFound")) {
        return;
      }
      throw mapAwsError(err, "terminate_failed", "TerminateInstances failed");
    }
    const change = out.TerminatingInstances?.[0];
    if (!change) {
      // AWS-API-level success with no per-instance result is the
      // already-terminated case (or a wider AWS quirk). Treat as
      // idempotent success.
      return;
    }
  }

  async getInstanceStatus(
    handle: CloudInstanceHandle,
  ): Promise<CloudInstanceStatus> {
    let out: DescribeInstancesCommandOutput;
    try {
      out = await this.client.send(
        new DescribeInstancesCommand({ InstanceIds: [handle.id] }),
      );
    } catch (err) {
      if (isAwsErrorCode(err, "InvalidInstanceID.NotFound")) {
        throw new CloudBackendError(
          "instance_not_found",
          `AWS instance ${handle.id} not found in region ${this.region}`,
          err,
        );
      }
      throw mapAwsError(err, "provision_failed", "DescribeInstances failed");
    }
    const instance = out.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      throw new CloudBackendError(
        "instance_not_found",
        `AWS instance ${handle.id} not present in DescribeInstances response`,
      );
    }
    return {
      handle,
      state: mapEc2State(instance.State?.Name),
      public_ip: instance.PublicIpAddress,
      private_ip: instance.PrivateIpAddress,
      reason: instance.StateReason?.Message,
    };
  }

  async getInstanceIp(handle: CloudInstanceHandle): Promise<string | null> {
    const status = await this.getInstanceStatus(handle);
    return status.public_ip ?? null;
  }

  async listInstances(filter?: {
    tags?: Record<string, string>;
  }): Promise<CloudInstanceHandle[]> {
    // Always filter by the Signalman-managed tag so callers can't
    // accidentally see operator-owned EC2 instances. Caller tags
    // narrow further.
    const filters: Filter[] = [
      {
        Name: `tag:${SIGNALMAN_MANAGED_TAG_KEY}`,
        Values: [SIGNALMAN_MANAGED_TAG_VALUE],
      },
    ];
    if (filter?.tags) {
      for (const [k, v] of Object.entries(filter.tags)) {
        filters.push({ Name: `tag:${k}`, Values: [v] });
      }
    }

    let out: DescribeInstancesCommandOutput;
    try {
      out = await this.client.send(
        new DescribeInstancesCommand({ Filters: filters }),
      );
    } catch (err) {
      throw mapAwsError(err, "provision_failed", "DescribeInstances failed");
    }

    if (out.NextToken) {
      // Pagination is out of scope for sub-task 2. Surface
      // explicitly so operators know they need to narrow the
      // filter rather than silently getting truncated results.
      throw new CloudBackendError(
        "quota_exceeded",
        `AWS DescribeInstances returned a NextToken in region ` +
          `${this.region}: result exceeds one page. ` +
          `Narrow the filter (e.g. add an org tag) or wait for ` +
          `the v0.3.0-5 pagination follow-up.`,
      );
    }

    const handles: CloudInstanceHandle[] = [];
    for (const reservation of out.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (!instance.InstanceId) continue;
        const nameTag = instance.Tags?.find((t) => t.Key === "Name");
        handles.push({
          id: instance.InstanceId,
          backend: "aws",
          name: nameTag?.Value ?? instance.InstanceId,
          region: this.region,
        });
      }
    }
    return handles;
  }

  // ── Internal helpers ────────────────────────────────────────────

  private async waitUntilRunning(handle: CloudInstanceHandle): Promise<void> {
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getInstanceStatus(handle);
      if (status.state === "running") return;
      if (status.state === "terminated") {
        throw new CloudBackendError(
          "provision_failed",
          `AWS instance ${handle.id} entered terminated state during ` +
            `provisioning${status.reason ? `: ${status.reason}` : ""}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
    throw new CloudBackendError(
      "provision_failed",
      `AWS instance ${handle.id} did not reach running state within ` +
        `${this.pollTimeoutMs}ms`,
    );
  }
}

// ── Tagging helpers ───────────────────────────────────────────────

/**
 * Build the full EC2 tag set for a provisioned instance: the
 * always-on Signalman tags + the friendly Name + any caller-
 * supplied tags. Caller tags can't override the Signalman
 * sentinel keys (defensive: a malicious config trying to set
 * `signalman-managed=false` would otherwise hide the instance
 * from the reaper).
 *
 * Exported for tests.
 */
export function buildInstanceTags(
  config: CloudInstanceConfig,
  orgId: string,
  ttlMinutes: number,
): Tag[] {
  const sentinelKeys = new Set([
    SIGNALMAN_MANAGED_TAG_KEY,
    SIGNALMAN_ORG_TAG_KEY,
    "signalman-ttl-minutes",
  ]);
  const tags: Tag[] = [
    { Key: "Name", Value: config.name },
    { Key: SIGNALMAN_MANAGED_TAG_KEY, Value: SIGNALMAN_MANAGED_TAG_VALUE },
    { Key: SIGNALMAN_ORG_TAG_KEY, Value: orgId },
    { Key: "signalman-ttl-minutes", Value: String(ttlMinutes) },
  ];
  if (config.tags) {
    for (const [k, v] of Object.entries(config.tags)) {
      if (sentinelKeys.has(k)) {
        // Skip — the always-on sentinel wins. Operators set their
        // own tags under different keys.
        continue;
      }
      tags.push({ Key: k, Value: v });
    }
  }
  return tags;
}

// ── Error mapping ─────────────────────────────────────────────────

/**
 * Map an AWS SDK error to a `CloudBackendError`. Pulls the AWS
 * error code into the message when available so the operator
 * sees both the canonical Signalman code and the AWS-side code.
 *
 * Exported for tests.
 */
export function mapAwsError(
  err: unknown,
  defaultCode: "provision_failed" | "terminate_failed" | "auth_failed",
  fallbackMessage: string,
): CloudBackendError {
  const e = err as { name?: string; message?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const awsCode = e.name ?? e.Code;
  // AWS auth errors surface with these names; map to auth_failed
  // so callers can dispatch.
  const authCodes = new Set([
    "UnauthorizedOperation",
    "AuthFailure",
    "InvalidClientTokenId",
    "RequestExpired",
    "SignatureDoesNotMatch",
  ]);
  const code = awsCode && authCodes.has(awsCode) ? "auth_failed" : defaultCode;
  const message = awsCode
    ? `${fallbackMessage} (AWS code: ${awsCode}): ${e.message ?? String(err)}`
    : `${fallbackMessage}: ${e.message ?? String(err)}`;
  return new CloudBackendError(code, message, err);
}

/** Check whether an AWS SDK error matches a specific error code. */
function isAwsErrorCode(err: unknown, awsCode: string): boolean {
  const e = err as { name?: string; Code?: string };
  return e.name === awsCode || e.Code === awsCode;
}

// ── State mapping ─────────────────────────────────────────────────

/**
 * Map an EC2 `InstanceState.Name` to the abstraction's
 * `CloudInstanceState`. AWS states: pending, running,
 * shutting-down, terminated, stopping, stopped.
 *
 * Exported for tests.
 */
export function mapEc2State(
  awsState: string | undefined,
): CloudInstanceState {
  switch (awsState) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "stopping":
    case "stopped":
      return "stopped";
    case "shutting-down":
    case "terminated":
      return "terminated";
    default:
      return "unknown";
  }
}

// ── Module-load registration ──────────────────────────────────────

/**
 * Register the AWS backend factory at module-load time. The
 * factory pulls the region from `AWS_REGION` env (matching the
 * AWS SDK's default) and defaults to `us-east-1` when unset.
 *
 * Operators with multi-region needs construct `AwsBackend`
 * instances directly per region rather than going through the
 * single-region registry entry.
 */
registerCloudBackend(
  "aws",
  () =>
    new AwsBackend({
      region: process.env.AWS_REGION ?? "us-east-1",
    }),
);
