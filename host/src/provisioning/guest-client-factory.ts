/**
 * Per-VM `GuestAgentClient` factory.
 *
 * The MCP server's `vm_install_bundle` tool (and the CLI's `signalman
 * vm install-bundle` verb) both need to construct a `GuestAgentClient`
 * for an arbitrary VM name on demand. The orchestrator owns a long-
 * lived `guestClients: Map<string, GuestAgentClient>` for scenario
 * runs, but the standalone-tool path doesn't have that map — it has
 * just a name + a backend.
 *
 * This factory consolidates the client-construction recipe in one
 * place so both call sites stay in sync. Specifically:
 *
 *   1. Resolve the VM by name via the backend (vm-cache aware).
 *   2. Get the VM's IP via `backend.getVmIpAddress` (Hyper-V, Tart)
 *      or fall back to `getStatus(handle).ipAddress`.
 *   3. Read the host config (cert paths, auth token, default port).
 *   4. Build a `GuestAgentClient` configured with mTLS + bearer token.
 *
 * Errors are descriptive: a missing VM, missing IP, or missing config
 * each surface a concrete remediation hint that an LLM agent can
 * branch on.
 */

import type { HypervisorBackend } from "../hypervisors/interface.js";
import { GuestAgentClient } from "../guest/client.js";
import { resolveVM } from "../vm-cache.js";
import { loadConfig } from "../config.js";

/**
 * Build a `GuestAgentClient` for the named VM. Throws with a
 * descriptive error message on any preflight failure (VM not found,
 * IP unresolvable, cert files missing).
 */
export async function buildGuestClientForVm(
  backend: HypervisorBackend,
  vmName: string,
): Promise<GuestAgentClient> {
  // Step 1: resolve handle.
  const handle = await resolveVM(backend, vmName);

  // Step 2: get the VM's IP. Prefer the optional fast path, fall back
  // to getStatus.
  let ipAddress: string | undefined;
  if (backend.getVmIpAddress) {
    ipAddress = await backend.getVmIpAddress(handle);
  }
  if (!ipAddress) {
    const status = await backend.getStatus(handle);
    ipAddress = status.ipAddress;
  }
  if (!ipAddress) {
    throw new Error(
      `Cannot resolve IP for VM '${vmName}'. Ensure the VM is running ` +
        `and the hypervisor exposes a guest-IP query (Hyper-V: integration ` +
        `services running; Tart: tart ip). For VMs in 'Off' state, run ` +
        `\`signalman vm start ${vmName}\` first.`,
    );
  }

  // Step 3: load host config (cert paths, auth token, port).
  const config = loadConfig();
  const tlsConfig = config.guestAgent.tls;
  const tlsOptions = tlsConfig.enabled
    ? {
        caPath: tlsConfig.caPath,
        certPath: tlsConfig.certPath,
        keyPath: tlsConfig.keyPath,
      }
    : undefined;

  // Step 4: build the client.
  return new GuestAgentClient(
    ipAddress,
    config.guestAgent.defaultPort,
    tlsOptions,
    { authToken: config.guestAgent.authToken },
  );
}

/**
 * A `getGuestClient` resolver factory bound to a backend resolver.
 * Used by `createVmInstallBundleTool` so the tool can be wired into
 * `createAllTools` without the tool having to know about config or
 * IP resolution.
 *
 * The returned function is intentionally simple — no caching. Bundle
 * installs are infrequent, the per-call IP lookup is cheap, and
 * keeping a stale client around across reboots would be a worse
 * footgun than the few-ms per-call cost.
 */
export function makeGuestClientResolver(
  getBackend: () => Promise<HypervisorBackend>,
): (vmName: string) => Promise<GuestAgentClient> {
  return async (vmName: string) => {
    const backend = await getBackend();
    return buildGuestClientForVm(backend, vmName);
  };
}
