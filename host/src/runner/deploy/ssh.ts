/**
 * WS6 M9 — `ssh` transport. Shells out to `ssh` + `scp` to push the
 * runner binary, write a registration config, and start the service
 * on a Linux/macOS target.
 *
 * Design constraints:
 *   - Operator supplies the `IdentityFile`; Signalman never handles
 *     SSH keys directly (no in-memory key material; no
 *     control-plane-signed agent forwarding).
 *   - We shell out to system `ssh` and `scp` instead of a native
 *     SSH library (e.g. `ssh2`) so no native deps, no key-format
 *     surprises. The cost: the operator's host must have OpenSSH
 *     installed (default on Linux/macOS; built-in on Win10+).
 *   - StrictHostKeyChecking is left at the operator's `~/.ssh/config`
 *     default. Production callers should pre-populate `known_hosts`;
 *     a future flag can pin a known-hosts file inline.
 *
 * Bootstrap sequence:
 *   1. `ssh <host> -- "test -d ~/.signalman || mkdir -p ~/.signalman"`
 *   2. `scp <binary-url-fetched-locally OR via curl on remote>` —
 *      we go with "fetch on remote" so the operator's host doesn't
 *      have to download the binary first.
 *   3. `ssh <host> -- "curl -fsSL <url> -o /tmp/signalman-runner && chmod +x ..."`
 *   4. `scp` runner.yaml to ~/.signalman/runner.yaml
 *   5. Write systemd unit (or launchd plist) + enable + start, OR
 *      skip if serviceManager == 'none'.
 *
 * Service manager:
 *   - `systemd` — writes /etc/systemd/system/signalman-runner.service,
 *     daemon-reload + enable + start. Requires sudo on the remote.
 *   - `launchd` — writes ~/Library/LaunchAgents/com.signalman.runner.plist,
 *     launchctl load. Operator-level (no sudo).
 *   - `none` — skips the service step; the binary is installed + the
 *     config is written, but the runner isn't auto-started. Useful
 *     for "I'll start it manually" smoke tests.
 */

import { resolveExpectedSha256 } from "./binary.js";
import type {
  BootstrapCommonOptions,
  BootstrapResult,
  RunnerDeployTransport,
  SshTransportOptions,
  TransportExec,
  TransportOptions,
} from "./transport.js";

function sshArgs(opts: SshTransportOptions, command: string): string[] {
  const args: string[] = [];
  if (opts.port) args.push("-p", String(opts.port));
  if (opts.proxyJump) args.push("-J", opts.proxyJump);
  args.push("-i", opts.identityPath);
  args.push(
    "-o",
    "BatchMode=yes", // never prompt for password
    "-o",
    "ConnectTimeout=10",
  );
  args.push(opts.host, "--", command);
  return args;
}

function scpArgs(
  opts: SshTransportOptions,
  localPath: string,
  remotePath: string,
): string[] {
  const args: string[] = [];
  if (opts.port) args.push("-P", String(opts.port));
  if (opts.proxyJump) args.push("-J", opts.proxyJump);
  args.push("-i", opts.identityPath);
  args.push("-o", "BatchMode=yes");
  args.push(localPath, `${opts.host}:${remotePath}`);
  return args;
}

/**
 * Build the install commands. Exposed for unit tests so we can pin
 * the exact command shapes the transport sends to the remote.
 */
export function buildSshInstallCommands(
  common: BootstrapCommonOptions,
  opts: SshTransportOptions,
  expectedSha: string | null,
): string[] {
  const cmds: string[] = [];
  cmds.push("mkdir -p $HOME/.signalman");
  cmds.push(
    `curl -fsSL '${common.binary.url}' -o /tmp/signalman-runner && chmod +x /tmp/signalman-runner`,
  );
  if (expectedSha) {
    cmds.push(
      `actual="$(sha256sum /tmp/signalman-runner | awk '{print $1}')" && ` +
        `if [ "$actual" != "${expectedSha}" ]; then ` +
        `echo "sha256 mismatch: expected ${expectedSha}, got $actual" >&2; exit 1; fi`,
    );
  }
  // Move into PATH. /usr/local/bin needs sudo on most distros; skip
  // sudo and install into ~/.local/bin to stay user-scoped. The
  // operator can move later if they need a system-wide install.
  cmds.push(`mkdir -p $HOME/.local/bin && mv /tmp/signalman-runner $HOME/.local/bin/signalman-runner`);
  return cmds;
}

/**
 * Build the runner.yaml content. Exposed for unit tests.
 */
export function buildRunnerYaml(common: BootstrapCommonOptions): string {
  return [
    `control_plane_url: ${common.controlPlaneUrl}`,
    `token: ${common.token}`,
    `worker_name: ${common.workerName}`,
    ``,
  ].join("\n");
}

function buildSystemdUnit(common: BootstrapCommonOptions): string {
  return [
    `[Unit]`,
    `Description=Signalman runner (${common.workerName})`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `Environment=SIGNALMAN_RUNNER_CONFIG=%h/.signalman/runner.yaml`,
    `ExecStart=%h/.local/bin/signalman-runner start --worker-name ${common.workerName}`,
    `Restart=on-failure`,
    `RestartSec=10`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

function buildLaunchdPlist(common: BootstrapCommonOptions): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>com.signalman.runner.${common.workerName}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>$HOME/.local/bin/signalman-runner</string>`,
    `    <string>start</string>`,
    `    <string>--worker-name</string>`,
    `    <string>${common.workerName}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export class SshTransport implements RunnerDeployTransport {
  readonly kind = "ssh" as const;

  async bootstrap(
    common: BootstrapCommonOptions,
    opts: TransportOptions,
    exec: TransportExec,
  ): Promise<BootstrapResult> {
    if (opts.kind !== "ssh") {
      throw new Error(`SshTransport.bootstrap: opts.kind must be 'ssh' (got ${opts.kind})`);
    }
    const o = opts as SshTransportOptions;
    const out = common.out ?? process.stderr;
    const expectedSha = resolveExpectedSha256(common.binary);
    const serviceManager = o.serviceManager ?? "systemd";

    out.write(`[runner deploy] ssh -> ${o.host}\n`);

    // Step 1: install the binary + verify
    const installCmds = buildSshInstallCommands(common, o, expectedSha);
    const installLine = installCmds.join(" && ");
    out.write(`[runner deploy] running install commands...\n`);
    const r1 = await exec("ssh", sshArgs(o, installLine));
    if (r1.exitCode !== 0) {
      throw new Error(
        `ssh transport: install commands exited with ${r1.exitCode}: ${r1.stderr.trim()}`,
      );
    }

    // Step 2: write runner.yaml. We send via stdin to a `cat >` on
    // the remote so we don't have to scp a local temp file.
    const yaml = buildRunnerYaml(common);
    out.write(`[runner deploy] writing runner.yaml...\n`);
    const yamlCmd = `cat > $HOME/.signalman/runner.yaml && chmod 0600 $HOME/.signalman/runner.yaml`;
    const r2 = await exec("ssh", sshArgs(o, yamlCmd), { stdin: yaml });
    if (r2.exitCode !== 0) {
      throw new Error(
        `ssh transport: runner.yaml write exited with ${r2.exitCode}: ${r2.stderr.trim()}`,
      );
    }

    // Step 3: install + start the service (or skip)
    let serviceDetail: Record<string, unknown> = { service_manager: serviceManager };
    if (serviceManager === "systemd") {
      const unit = buildSystemdUnit(common);
      const writeUnit = `sudo bash -c 'cat > /etc/systemd/system/signalman-runner.service && systemctl daemon-reload && systemctl enable --now signalman-runner'`;
      out.write(`[runner deploy] writing systemd unit...\n`);
      const r3 = await exec("ssh", sshArgs(o, writeUnit), { stdin: unit });
      if (r3.exitCode !== 0) {
        throw new Error(
          `ssh transport: systemd unit install exited with ${r3.exitCode}: ${r3.stderr.trim()}`,
        );
      }
      serviceDetail.systemd_unit_bytes = unit.length;
    } else if (serviceManager === "launchd") {
      const plist = buildLaunchdPlist(common);
      const writePlist = `mkdir -p $HOME/Library/LaunchAgents && cat > $HOME/Library/LaunchAgents/com.signalman.runner.plist && launchctl load $HOME/Library/LaunchAgents/com.signalman.runner.plist`;
      out.write(`[runner deploy] writing launchd plist...\n`);
      const r3 = await exec("ssh", sshArgs(o, writePlist), { stdin: plist });
      if (r3.exitCode !== 0) {
        throw new Error(
          `ssh transport: launchd plist install exited with ${r3.exitCode}: ${r3.stderr.trim()}`,
        );
      }
      serviceDetail.launchd_plist_bytes = plist.length;
    }
    // serviceManager === 'none' → skip service install entirely.

    return {
      transport: "ssh",
      workerName: common.workerName,
      detail: {
        host: o.host,
        port: o.port ?? 22,
        identityPath: o.identityPath,
        ...serviceDetail,
        sha256_pinned: expectedSha !== null,
      },
    };
  }
}

// scpArgs is currently unused in the impl above (we use ssh + stdin
// for file transfers). It's exported for tests + future use when we
// move to actual file deliveries.
export { scpArgs };
