/**
 * Azure Bastion native-client tunnel dialer (WS6 wave-3 carve-out #5).
 *
 * Opens a Bastion tunnel to a private Azure VM via the `az network
 * bastion tunnel` subcommand. Used when a guest agent's network
 * mode is `azure_bastion` — the VM has no public IP and the host
 * reaches the gRPC port through the Bastion host.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Shell out to the `az` CLI.** Azure Bastion native-client
 *   tunnelling is implemented inside the `az` CLI (with the
 *   `bastion` extension installed); the underlying multiplexed
 *   tunnel protocol is not exposed through `@azure/*` SDKs. The
 *   CLI is the canonical operator path. No Azure SDK dep is
 *   added.
 * - **Ready detection: `"Tunnel is ready"`.** The `az bastion
 *   tunnel` command prints this line on stdout once the local
 *   listener is up. `open()` resolves at that point.
 * - **Refuses non-`azure_bastion` descriptors.** A wrong-kind
 *   descriptor raises `DialerError('unsupported_descriptor')`
 *   synchronously inside `open()`. The {@link defaultDialerFor}
 *   helper in `./index.ts` routes by kind.
 *
 * # Known gap (descriptor shape)
 *
 * The WS1 sub-task 6 descriptor for `azure_bastion` carries
 * `subscription_id`, `resource_group`, `vm_name`, and `port`. The
 * `az network bastion tunnel` command additionally needs the
 * **Bastion host name** (`--name`): a resource group can host
 * multiple Bastions, so we can't infer it. Operators extending
 * the descriptor shape upstream should add `bastion_name` to
 * `signalman_cloud_connection_descriptor`. Until then this dialer
 * reads it from the descriptor's transitional `bastion_name`
 * field declared in `./interface.ts`.
 *
 * # What this module does NOT do
 *
 * - **No SDK-side tunnel creation.** Operators set up their Azure
 *   credentials (`az login`, managed identity, service principal
 *   env) before running Signalman; the CLI inherits them.
 * - **No extension install check.** When `bastion` extension is
 *   missing the CLI prints a clear error and offers to install;
 *   we surface that as `tunnel_failed` and let the operator
 *   install with `az extension add -n bastion`.
 */

import { spawn } from "node:child_process";

import {
  DialerError,
  DIALER_CLOSE_GRACE_MS,
  DIALER_READY_TIMEOUT_MS,
  pickFreeLocalPort,
  wrapChildProcess,
  type CloudConnectionDescriptor,
  type Dialer,
  type DialerChildHandle,
  type DialerExec,
  type DialerHandle,
} from "./interface.js";
import { makeHandle, waitForReady } from "./aws-ssm.js";

// ── Public constants ──────────────────────────────────────────────

/** Default `az` CLI binary lookup. */
export const DEFAULT_AZ_BIN = "az";

/**
 * The `az network bastion tunnel` command prints this line on
 * stdout when the local listener is established. Match prefix
 * only; different CLI versions print slightly different suffixes.
 */
export const AZURE_BASTION_READY_MARKER = "Tunnel is ready";

// ── Options ───────────────────────────────────────────────────────

export interface AzureBastionDialerOptions {
  /**
   * Path to the `az` binary. Defaults to {@link DEFAULT_AZ_BIN}
   * (looked up on PATH).
   */
  azBin?: string;
  /**
   * Injectable spawner for tests. Production callers leave this
   * undefined; the dialer spawns the binary via
   * `node:child_process.spawn`.
   */
  exec?: DialerExec;
  /**
   * Override the ready-line wait timeout. Defaults to
   * {@link DIALER_READY_TIMEOUT_MS} (30s).
   */
  readyTimeoutMs?: number;
  /**
   * Override the SIGTERM→SIGKILL grace period. Defaults to
   * {@link DIALER_CLOSE_GRACE_MS} (5s).
   */
  closeGraceMs?: number;
  /**
   * Caller-supplied local port. When absent the dialer picks a
   * free one via {@link pickFreeLocalPort}.
   */
  localPort?: number;
}

// ── Argv construction ─────────────────────────────────────────────

/**
 * Build the fully-qualified VM resource id from the descriptor's
 * `subscription_id` / `resource_group` / `vm_name` fields, or
 * fall through to the optional `vm_resource_id` override.
 */
export function resolveVmResourceId(descriptor: {
  subscription_id: string;
  resource_group: string;
  vm_name: string;
  vm_resource_id?: string;
}): string {
  if (descriptor.vm_resource_id && descriptor.vm_resource_id.length > 0) {
    return descriptor.vm_resource_id;
  }
  return (
    `/subscriptions/${descriptor.subscription_id}` +
    `/resourceGroups/${descriptor.resource_group}` +
    `/providers/Microsoft.Compute/virtualMachines/${descriptor.vm_name}`
  );
}

/**
 * Build the argv vector passed to the `az` CLI for a Bastion
 * tunnel. Exported so tests can assert the exact argv without
 * mocking the whole dial flow.
 */
export function buildAzureBastionArgs(
  descriptor: {
    subscription_id: string;
    resource_group: string;
    vm_name: string;
    port: number;
    bastion_name: string;
    vm_resource_id?: string;
  },
  localPort: number,
): string[] {
  const args: string[] = [];
  args.push("network", "bastion", "tunnel");
  args.push("--name", descriptor.bastion_name);
  args.push("--resource-group", descriptor.resource_group);
  args.push("--target-resource-id", resolveVmResourceId(descriptor));
  args.push("--resource-port", String(descriptor.port));
  args.push("--port", String(localPort));
  args.push("--subscription", descriptor.subscription_id);
  return args;
}

// ── Dialer ────────────────────────────────────────────────────────

/**
 * Azure Bastion native-client tunnel dialer. See module header
 * for design constraints and the descriptor-shape known gap.
 */
export class AzureBastionDialer implements Dialer {
  private readonly azBin: string;
  private readonly exec: DialerExec;
  private readonly readyTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly overrideLocalPort: number | undefined;

  constructor(options: AzureBastionDialerOptions = {}) {
    this.azBin = options.azBin ?? DEFAULT_AZ_BIN;
    this.exec = options.exec ?? defaultBastionExec;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DIALER_READY_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DIALER_CLOSE_GRACE_MS;
    this.overrideLocalPort = options.localPort;
  }

  async open(descriptor: CloudConnectionDescriptor): Promise<DialerHandle> {
    if (descriptor.kind !== "azure_bastion") {
      throw new DialerError(
        "unsupported_descriptor",
        `AzureBastionDialer received descriptor of kind '${descriptor.kind}'; expected 'azure_bastion'`,
      );
    }
    if (!descriptor.bastion_name || descriptor.bastion_name.length === 0) {
      throw new DialerError(
        "unsupported_descriptor",
        "AzureBastionDialer requires 'bastion_name' on the descriptor; see module header 'Known gap' for the WS1 sub-task 6 follow-up to surface this field through signalman_cloud_connection_descriptor",
      );
    }

    const localPort =
      this.overrideLocalPort ?? (await pickFreeLocalPort());

    const args = buildAzureBastionArgs(descriptor, localPort);

    let child: DialerChildHandle;
    try {
      child = this.exec(this.azBin, args, {});
    } catch (err) {
      throw new DialerError(
        "cli_not_found",
        `failed to spawn '${this.azBin}': ${describeError(err)}`,
        err,
      );
    }

    await waitForReady(child, {
      readyMarker: AZURE_BASTION_READY_MARKER,
      timeoutMs: this.readyTimeoutMs,
      cliName: "az network bastion tunnel",
    });

    return makeHandle(child, localPort, this.closeGraceMs);
  }
}

// ── Production-default spawner ────────────────────────────────────

const defaultBastionExec: DialerExec = (command, args, opts) => {
  const child = spawn(command, args, {
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return wrapChildProcess(child);
};

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
