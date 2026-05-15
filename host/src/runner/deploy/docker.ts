/**
 * WS6 M9 — `docker` transport. Shells out to `docker run` to start
 * the runner as a container.
 *
 * Operator provides:
 *   - `image`: a pre-built runner image they pushed (e.g.
 *     `ghcr.io/operator/signalman-runner:0.4.x`). We do NOT build
 *     images on the fly — that's a separate operator workflow.
 *   - `context` (optional): docker context name for routing to a
 *     remote daemon. Default = the local daemon.
 *   - `extraVolumes` / `extraEnv`: any extras the operator's image
 *     needs (cred mounts, custom paths, etc.).
 *
 * Bootstrap sequence:
 *   1. `docker --context <ctx> pull <image>` (idempotent; ensures the
 *      image is on the daemon)
 *   2. `docker --context <ctx> rm -f <containerName>` (idempotent
 *      teardown of a prior incarnation)
 *   3. `docker --context <ctx> run -d --name <containerName> \
 *        -e SIGNALMAN_CONTROL_PLANE=<url> \
 *        -e SIGNALMAN_TOKEN=<token> \
 *        -e SIGNALMAN_WORKER_NAME=<name> \
 *        <extraVolumes> <extraEnv> <image>`
 *
 * Binary distribution: the operator's image already contains the
 * runner binary; `binary.url` is informational only for docker. This
 * matches the operator's mental model — they choose the runner
 * binary by building it into their image.
 */

import type {
  BootstrapCommonOptions,
  BootstrapResult,
  DockerTransportOptions,
  RunnerDeployTransport,
  TransportExec,
  TransportOptions,
} from "./transport.js";

/**
 * Build the `docker run` argv. Exposed for unit tests so we can pin
 * the exact command line that talks to the docker daemon.
 */
export function buildDockerRunArgs(
  common: BootstrapCommonOptions,
  opts: DockerTransportOptions,
): string[] {
  const ctx = opts.context && opts.context.length > 0 && opts.context !== "default"
    ? ["--context", opts.context]
    : [];
  const containerName = opts.containerName ?? `signalman-runner-${common.workerName}`;
  const args: string[] = [...ctx, "run", "-d", "--name", containerName];
  args.push(
    "-e",
    `SIGNALMAN_CONTROL_PLANE=${common.controlPlaneUrl}`,
    "-e",
    `SIGNALMAN_TOKEN=${common.token}`,
    "-e",
    `SIGNALMAN_WORKER_NAME=${common.workerName}`,
  );
  for (const v of opts.extraVolumes ?? []) {
    args.push("-v", v);
  }
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  args.push("--restart", "on-failure");
  args.push(opts.image);
  return args;
}

export function buildDockerPullArgs(opts: DockerTransportOptions): string[] {
  const ctx = opts.context && opts.context.length > 0 && opts.context !== "default"
    ? ["--context", opts.context]
    : [];
  return [...ctx, "pull", opts.image];
}

export function buildDockerRmArgs(
  common: BootstrapCommonOptions,
  opts: DockerTransportOptions,
): string[] {
  const ctx = opts.context && opts.context.length > 0 && opts.context !== "default"
    ? ["--context", opts.context]
    : [];
  const containerName = opts.containerName ?? `signalman-runner-${common.workerName}`;
  return [...ctx, "rm", "-f", containerName];
}

export class DockerTransport implements RunnerDeployTransport {
  readonly kind = "docker" as const;

  async bootstrap(
    common: BootstrapCommonOptions,
    opts: TransportOptions,
    exec: TransportExec,
  ): Promise<BootstrapResult> {
    if (opts.kind !== "docker") {
      throw new Error(`DockerTransport.bootstrap: opts.kind must be 'docker' (got ${opts.kind})`);
    }
    const o = opts as DockerTransportOptions;
    const out = common.out ?? process.stderr;
    const containerName = o.containerName ?? `signalman-runner-${common.workerName}`;

    out.write(`[runner deploy] docker pull ${o.image}${o.context ? ` (context=${o.context})` : ""}\n`);
    const pullArgs = buildDockerPullArgs(o);
    const pull = await exec("docker", pullArgs);
    if (pull.exitCode !== 0) {
      throw new Error(`docker transport: pull exited with ${pull.exitCode}: ${pull.stderr.trim()}`);
    }

    // Teardown a prior container with the same name. We tolerate
    // exit-code != 0 here because "no such container" is the
    // happy-path first-run case.
    out.write(`[runner deploy] docker rm -f ${containerName} (idempotent)\n`);
    await exec("docker", buildDockerRmArgs(common, o));

    out.write(`[runner deploy] docker run -d ...\n`);
    const runArgs = buildDockerRunArgs(common, o);
    const run = await exec("docker", runArgs);
    if (run.exitCode !== 0) {
      throw new Error(`docker transport: run exited with ${run.exitCode}: ${run.stderr.trim()}`);
    }
    const containerId = run.stdout.trim();

    return {
      transport: "docker",
      workerName: common.workerName,
      detail: {
        image: o.image,
        context: o.context ?? "default",
        container_name: containerName,
        container_id: containerId,
        extra_volumes: (o.extraVolumes ?? []).length,
        extra_env_keys: Object.keys(o.extraEnv ?? {}),
      },
    };
  }
}
