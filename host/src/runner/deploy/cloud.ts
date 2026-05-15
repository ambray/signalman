/**
 * WS6 M9 — `cloud` transport. Orchestrates a fresh cloud VM
 * provision via the registered cloud backend, then dispatches to the
 * `ssh` or `winrm` transport (per `osFamily`) to bootstrap the
 * runner on the new instance.
 *
 * One-call "give me a runner on AWS in us-east-1":
 *
 *   signalman runner deploy --transport cloud \
 *     --provider aws --region us-east-1 \
 *     --instance-type t3.medium --image-ref ami-... \
 *     --os linux \
 *     --inner-ssh-identity ~/.ssh/id_ed25519
 *
 * The transport:
 *   1. Calls `signalman_cloud_provision` (via the cloud module)
 *      to get a CloudInstanceHandle.
 *   2. Polls `getInstanceIp` until a public IP appears (the
 *      provision call already waits for `running`, but the IP can
 *      lag a tick).
 *   3. Builds an `ssh` or `winrm` TransportOptions with the
 *      operator-supplied inner credentials + the cloud host = IP.
 *   4. Delegates `bootstrap()` to that inner transport.
 *
 * The cloud-provisioned VM is tagged with `signalman-managed=true`
 * by the cloud backend; the cost-reaper owns its TTL. If
 * `ttlMinutes` is omitted, the default 60min applies.
 *
 * Failure semantics:
 *   - Provision fails: no VM created (or aborted mid-flight); raise.
 *   - IP timeout: VM exists; raise + leave it to the reaper. The
 *     operator gets the handle in the error message so they can
 *     terminate manually if needed.
 *   - Inner bootstrap fails: VM exists; raise + leave it to the
 *     reaper. Same operator note.
 */

import { SshTransport } from "./ssh.js";
import { WinRmTransport } from "./winrm.js";
import type {
  BootstrapCommonOptions,
  BootstrapResult,
  CloudTransportOptions,
  RunnerDeployTransport,
  SshTransportOptions,
  TransportExec,
  TransportOptions,
  WinRmTransportOptions,
} from "./transport.js";

export interface CloudTransportDeps {
  /**
   * Cloud-provision invoker. Production wires through the cloud
   * backend registry; tests inject a stub.
   */
  provision: (input: {
    provider: "aws" | "azure";
    region: string;
    instanceType: string;
    imageRef: string;
    name: string;
    orgId?: string;
    ttlMinutes?: number;
  }) => Promise<{ id: string; backend: "aws" | "azure"; name: string; region: string }>;
  /**
   * IP resolver — called after provision returns. Production wires
   * through `backend.getInstanceIp(handle)`; tests inject.
   */
  getIp: (handle: { id: string; backend: "aws" | "azure"; region: string; name: string }) => Promise<string | null>;
  /** Optional poll-IP interval. Default 5000ms. */
  ipPollIntervalMs?: number;
  /** Optional poll-IP timeout. Default 120000ms. */
  ipPollTimeoutMs?: number;
  /** Injectable now-fn. */
  now?: () => Date;
  /** Injectable sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class CloudTransport implements RunnerDeployTransport {
  readonly kind = "cloud" as const;

  constructor(private readonly deps: CloudTransportDeps) {}

  async bootstrap(
    common: BootstrapCommonOptions,
    opts: TransportOptions,
    exec: TransportExec,
  ): Promise<BootstrapResult> {
    if (opts.kind !== "cloud") {
      throw new Error(`CloudTransport.bootstrap: opts.kind must be 'cloud' (got ${opts.kind})`);
    }
    const o = opts as CloudTransportOptions;
    const out = common.out ?? process.stderr;

    // Validate inner-transport credentials BEFORE provisioning to
    // avoid orphaning a VM when the operator forgot to set
    // identityPath / username / password.
    if (o.osFamily === "linux") {
      if (!o.innerSsh?.identityPath) {
        throw new Error(
          "cloud transport (os=linux): innerSsh.identityPath is required (no SSH credentials supplied)",
        );
      }
    } else {
      if (!o.innerWinRm?.username || !o.innerWinRm?.password) {
        throw new Error(
          "cloud transport (os=windows): innerWinRm.username + innerWinRm.password are required",
        );
      }
    }

    out.write(
      `[runner deploy] cloud provision ${o.provider}/${o.region}/${o.instanceType} (image=${o.imageRef})\n`,
    );
    const handle = await this.deps.provision({
      provider: o.provider,
      region: o.region,
      instanceType: o.instanceType,
      imageRef: o.imageRef,
      name: o.name,
      orgId: o.orgId,
      ttlMinutes: o.ttlMinutes,
    });
    out.write(`[runner deploy] provisioned handle ${handle.id}; polling for IP...\n`);

    const ip = await this.pollForIp(handle, out);
    if (!ip) {
      throw new Error(
        `cloud transport: instance ${handle.id} did not surface a public IP within timeout. ` +
          `VM is still provisioned (handle ${JSON.stringify(handle)}); terminate via ` +
          `'signalman cloud terminate' or let the cost-reaper handle it.`,
      );
    }
    out.write(`[runner deploy] instance ${handle.id} has public_ip=${ip}; bootstrapping...\n`);

    try {
      const innerResult = await this.dispatchInner(common, o, ip, exec);
      return {
        transport: "cloud",
        workerName: common.workerName,
        detail: {
          provider: o.provider,
          region: o.region,
          instance_type: o.instanceType,
          instance_id: handle.id,
          public_ip: ip,
          os_family: o.osFamily,
          inner_transport: innerResult.transport,
          inner_detail: innerResult.detail,
        },
      };
    } catch (err) {
      throw new Error(
        `cloud transport: inner ${o.osFamily === "linux" ? "ssh" : "winrm"} bootstrap failed; ` +
          `VM ${handle.id} remains provisioned (terminate via 'signalman cloud terminate' or wait for reaper). ` +
          `Inner error: ${(err as Error).message}`,
      );
    }
  }

  private async pollForIp(
    handle: { id: string; backend: "aws" | "azure"; region: string; name: string },
    _out: NodeJS.WritableStream,
  ): Promise<string | null> {
    const interval = this.deps.ipPollIntervalMs ?? 5000;
    const timeout = this.deps.ipPollTimeoutMs ?? 120_000;
    const now = this.deps.now ?? (() => new Date());
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const start = now().getTime();
    while (now().getTime() - start < timeout) {
      const ip = await this.deps.getIp(handle);
      if (ip) return ip;
      await sleep(interval);
    }
    return null;
  }

  private async dispatchInner(
    common: BootstrapCommonOptions,
    o: CloudTransportOptions,
    ip: string,
    exec: TransportExec,
  ): Promise<BootstrapResult> {
    if (o.osFamily === "linux") {
      const sshOpts: SshTransportOptions = {
        kind: "ssh",
        host: ip,
        identityPath: o.innerSsh!.identityPath,
        // Cloud-provisioned VMs typically need a few seconds for sshd
        // to be reachable. The default ConnectTimeout in our ssh args
        // already covers a 10s window; if the operator needs more,
        // they can adjust their `~/.ssh/config`. For first-boot AMIs
        // a short additional sleep would be nice but is out of scope
        // for M9.
      };
      return new SshTransport().bootstrap(common, sshOpts, exec);
    } else {
      const winOpts: WinRmTransportOptions = {
        kind: "winrm",
        host: ip,
        username: o.innerWinRm!.username,
        password: o.innerWinRm!.password,
      };
      return new WinRmTransport().bootstrap(common, winOpts, exec);
    }
  }
}
