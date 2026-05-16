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
import { LibvirtBackend } from "./libvirt.js";
import { ServiceBackend } from "./service.js";
import { TartBackend } from "./tart.js";
import { VmrunBackend } from "./vmrun.js";
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
  const service = new ServiceBackend({
    host: config.hypervisor.service?.host,
    port: config.hypervisor.service?.port,
    certDir: config.hypervisor.service?.certDir,
    guestCredentials: config.hypervisor.guestCredentials,
  });
  const tart = new TartBackend({ tartPath: config.hypervisor.tartPath });
  // v0.4.0-4 cross-platform: libvirt (Linux) + vmrun (parallel-track
  // VMware) backends. Construction is cheap; isAvailable() probes the
  // backing CLI before the selector picks one.
  const libvirt = new LibvirtBackend({
    virshPath: config.hypervisor.virshPath,
    connectUri: config.hypervisor.libvirtUri,
    storagePool: config.hypervisor.libvirtStoragePool,
  });
  const vmrun = new VmrunBackend({
    vmrunPath: config.hypervisor.vmrunPath,
    guestUser: config.hypervisor.guestCredentials?.username,
    guestPass: config.hypervisor.guestCredentials?.password,
  });

  const byName: Record<SignalmanConfig["hypervisor"]["backend"], HypervisorBackend> = {
    service,
    hyperv,
    vmware,
    tart,
    libvirt,
    vmrun,
  };

  // Platform-aware fallback ordering. On Linux libvirt is first so an
  // unconfigured operator on a KVM host gets routed through virsh
  // immediately; macOS prefers tart for Apple Silicon; Windows keeps
  // the existing service-first chain.  `vmrun` sits next to `vmware`
  // in every list — they're equivalent shape on Workstation/Fusion
  // hosts; the operator picks whichever they prefer via the explicit
  // `hypervisor.backend` setting.
  let base: HypervisorBackend[];
  if (process.platform === "darwin") {
    base = [tart, vmware, vmrun, service, hyperv, libvirt];
  } else if (process.platform === "linux") {
    base = [libvirt, service, vmware, vmrun, hyperv, tart];
  } else {
    base = [service, hyperv, vmware, vmrun, tart, libvirt];
  }

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
