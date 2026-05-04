/**
 * Hypervisor backend selection shared by the MCP server and CLI runner.
 *
 * Keeping this in one module avoids drift between direct advanced tools and
 * `signalman.run` scenario execution.
 */

import type { SignalmanConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { HypervisorBackend } from "./interface.js";
import { HyperVBackend } from "./hyperv.js";
import { ServiceBackend } from "./service.js";
import { TartBackend } from "./tart.js";
import { VmwareBackend } from "./vmware.js";

export function buildBackendList(
  config: SignalmanConfig = loadConfig(),
): HypervisorBackend[] {
  const vmware = new VmwareBackend({
    vmrunPath: config.hypervisor.vmrunPath,
    guestUser: config.hypervisor.guestCredentials?.username,
    guestPass: config.hypervisor.guestCredentials?.password,
  });
  const hyperv = new HyperVBackend({
    guestAgentPort: config.guestAgent.defaultPort,
    guestAgentAuthToken: config.guestAgent.authToken,
    guestAgentTls: config.guestAgent.tls.enabled
      ? {
          caPath: config.guestAgent.tls.caPath,
          certPath: config.guestAgent.tls.certPath,
          keyPath: config.guestAgent.tls.keyPath,
        }
      : undefined,
  });
  const service = new ServiceBackend();
  const tart = new TartBackend({ tartPath: config.hypervisor.tartPath });

  const byName: Record<SignalmanConfig["hypervisor"]["backend"], HypervisorBackend> = {
    service,
    hyperv,
    vmware,
    tart,
  };

  const base =
    process.platform === "darwin"
      ? [tart, vmware, service, hyperv]
      : [service, hyperv, vmware, tart];

  const preferred = byName[config.hypervisor.backend];
  return [preferred, ...base.filter((backend) => backend.name !== preferred.name)];
}

export async function selectBackend(
  config: SignalmanConfig = loadConfig(),
): Promise<HypervisorBackend> {
  for (const backend of buildBackendList(config)) {
    if (await backend.isAvailable()) {
      return backend;
    }
  }
  throw new Error(
    "No hypervisor backend available. Install Signalman service, Hyper-V, Tart, or VMware Workstation/Fusion.",
  );
}
