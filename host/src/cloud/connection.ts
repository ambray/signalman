/**
 * Cloud connection descriptors (v0.3.0-5 sub-task 6, design §13.6).
 *
 * Given a {@link CloudInstanceHandle} and the operator's chosen
 * {@link NetworkMode}, build the addressing parameters a
 * control-plane client needs to reach the guest agent.
 *
 * The descriptors are deliberately data-only — actual tunneling
 * (SSM session-manager port forwarding, Azure Bastion native
 * client port forwarding, raw TCP dial) is the caller's job.
 * Separating the addressing from the protocol keeps this module
 * vendor-agnostic and lets a single control-plane connection
 * driver speak multiple modes.
 *
 * # Locked design
 *
 * - **No SDK calls here.** Building a descriptor must not touch
 *   the network — that's the dialing step. Callers that need a
 *   public IP (mode = public_mtls) call
 *   `backend.getInstanceIp(handle)` before connecting and feed
 *   the result back in via `withResolvedHost`.
 * - **Mode comes from the handle, not the call site.** The
 *   backend recorded the mode at provision time; passing it
 *   through the handle means a control-plane recovery path
 *   (re-attach to an already-running VM) sees the right mode
 *   without re-asking the operator.
 * - **Default to public_mtls when the handle has no mode.**
 *   Back-compat for handles produced before sub-task 6 lands
 *   in production.
 */

import {
  type CloudConnectionDescriptor,
  type CloudInstanceHandle,
  DEFAULT_NETWORK_MODE,
} from "./types.js";

/** Default gRPC port used across all three modes. */
export const DEFAULT_CONNECTION_PORT = 443;

/**
 * Build a connection descriptor from a handle.
 *
 * @param handle  The cloud instance handle.
 * @param opts    Optional overrides:
 *                - `port`: alternative gRPC port (default 443)
 *                - `subscriptionId`, `resourceGroup`: required
 *                  for `azure_bastion` mode (the handle records
 *                  the VM name + region but not the subscription
 *                  /resource-group on the AzureBackend
 *                  constructor; callers thread these through).
 */
export function getConnectionDescriptor(
  handle: CloudInstanceHandle,
  opts: {
    port?: number;
    subscriptionId?: string;
    resourceGroup?: string;
    /**
     * WS6 wave-3: AWS named profile to thread through to the dialer.
     * Forwarded verbatim onto `aws_ssm` descriptors when set.
     */
    awsProfile?: string;
    /**
     * WS6 wave-3: Bastion host name. Required for `azure_bastion`
     * descriptors — `az network bastion tunnel --name` needs it.
     */
    bastionName?: string;
  } = {},
): CloudConnectionDescriptor {
  const port = opts.port ?? DEFAULT_CONNECTION_PORT;
  const mode = handle.network_mode ?? DEFAULT_NETWORK_MODE;

  switch (mode) {
    case "public_mtls":
      return { kind: "public_mtls", port };
    case "aws_ssm":
      if (handle.backend !== "aws") {
        throw new Error(
          `network mode 'aws_ssm' is only valid for AWS handles; ` +
            `got handle backend=${handle.backend}`,
        );
      }
      return {
        kind: "aws_ssm",
        region: handle.region,
        instance_id: handle.id,
        port,
        ...(opts.awsProfile ? { profile: opts.awsProfile } : {}),
      };
    case "azure_bastion": {
      if (handle.backend !== "azure") {
        throw new Error(
          `network mode 'azure_bastion' is only valid for Azure handles; ` +
            `got handle backend=${handle.backend}`,
        );
      }
      if (!opts.subscriptionId) {
        throw new Error(
          "azure_bastion connection descriptor requires opts.subscriptionId " +
            "(handle alone doesn't carry it — pass it from the Azure " +
            "backend's known config).",
        );
      }
      if (!opts.resourceGroup) {
        throw new Error(
          "azure_bastion connection descriptor requires opts.resourceGroup " +
            "(handle alone doesn't carry it — pass it from the Azure " +
            "backend's known config).",
        );
      }
      if (!opts.bastionName) {
        throw new Error(
          "azure_bastion connection descriptor requires opts.bastionName " +
            "(`az network bastion tunnel` needs the Bastion host name; " +
            "a resource group can hold multiple Bastions so it can't be inferred).",
        );
      }
      return {
        kind: "azure_bastion",
        subscription_id: opts.subscriptionId,
        resource_group: opts.resourceGroup,
        vm_name: handle.name,
        port,
        bastion_name: opts.bastionName,
      };
    }
    default: {
      // Exhaustiveness check — if NetworkMode gains a variant the
      // switch above must grow to match.
      const exhaustive: never = mode;
      throw new Error(`unhandled network mode: ${exhaustive as string}`);
    }
  }
}

/**
 * Given a `public_mtls` descriptor and a resolved IP, return a
 * descriptor with `host` populated. No-op for non-public modes.
 *
 * Helper for the common "list VMs → pick one → fetch IP →
 * connect" recovery flow.
 */
export function withResolvedHost(
  descriptor: CloudConnectionDescriptor,
  host: string,
): CloudConnectionDescriptor {
  if (descriptor.kind !== "public_mtls") return descriptor;
  return { ...descriptor, host };
}
