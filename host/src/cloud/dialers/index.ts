/**
 * Cloud network-mode dialer module (WS6 wave-3 carve-out #5).
 *
 * Public entry-point for the SSM + Bastion tunnel drivers. See
 * `./interface.ts` for the module's locked design constraints.
 *
 * Usage:
 *
 *     import { defaultDialerFor } from "@signalman/host/cloud/dialers";
 *     const dialer = defaultDialerFor(descriptor);
 *     const handle = await dialer.open(descriptor);
 *     try {
 *       // connect to 127.0.0.1:handle.localPort
 *     } finally {
 *       await handle.close();
 *     }
 */

export {
  DialerError,
  DIALER_CLOSE_GRACE_MS,
  DIALER_READY_TIMEOUT_MS,
  pickFreeLocalPort,
  wrapChildProcess,
  type CloudConnectionDescriptor,
  type Dialer,
  type DialerChildHandle,
  type DialerErrorCode,
  type DialerExec,
  type DialerExecOptions,
  type DialerHandle,
} from "./interface.js";

export {
  AwsSsmDialer,
  AWS_SSM_PORT_FORWARD_DOCUMENT,
  AWS_SSM_READY_MARKER,
  DEFAULT_AWS_BIN,
  buildAwsSsmArgs,
  classifyExitFailure,
  makeHandle,
  waitForReady,
  type AwsSsmDialerOptions,
} from "./aws-ssm.js";

export {
  AzureBastionDialer,
  AZURE_BASTION_READY_MARKER,
  DEFAULT_AZ_BIN,
  buildAzureBastionArgs,
  resolveVmResourceId,
  type AzureBastionDialerOptions,
} from "./azure-bastion.js";

import {
  DialerError,
  type CloudConnectionDescriptor,
  type Dialer,
} from "./interface.js";
import { AwsSsmDialer, type AwsSsmDialerOptions } from "./aws-ssm.js";
import {
  AzureBastionDialer,
  type AzureBastionDialerOptions,
} from "./azure-bastion.js";

/**
 * Options accepted by {@link defaultDialerFor} — passed through
 * to the concrete dialer's constructor. Keys are dialer-kind-
 * specific so the caller can tune e.g. `aws_ssm` independently
 * from `azure_bastion`.
 */
export interface DefaultDialerOptions {
  awsSsm?: AwsSsmDialerOptions;
  azureBastion?: AzureBastionDialerOptions;
}

/**
 * Return a fresh dialer instance suitable for the given
 * descriptor's `kind`. The `public_mtls` kind doesn't need a
 * dialer (the host dials TCP directly); passing it raises
 * `DialerError('unsupported_descriptor')` so callers don't
 * accidentally instantiate a no-op dialer.
 */
export function defaultDialerFor(
  descriptor: CloudConnectionDescriptor,
  options: DefaultDialerOptions = {},
): Dialer {
  switch (descriptor.kind) {
    case "aws_ssm":
      return new AwsSsmDialer(options.awsSsm);
    case "azure_bastion":
      return new AzureBastionDialer(options.azureBastion);
    case "public_mtls":
      throw new DialerError(
        "unsupported_descriptor",
        "defaultDialerFor: descriptor kind 'public_mtls' needs no dialer; the host connects to address:port directly",
      );
    default: {
      // Exhaustiveness check — if a new descriptor kind is added
      // upstream, the compiler will fail this branch.
      const _exhaustive: never = descriptor;
      throw new DialerError(
        "unsupported_descriptor",
        `defaultDialerFor: unknown descriptor kind ${String((_exhaustive as { kind?: string }).kind)}`,
      );
    }
  }
}
