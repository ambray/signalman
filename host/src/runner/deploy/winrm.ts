/**
 * WS6 M9 — `winrm` transport. Shells out to `pwsh` running
 * `Invoke-Command -ComputerName` to bootstrap a Windows runner.
 *
 * Requirements on the operator's host:
 *   - PowerShell 7+ on PATH (`pwsh`)
 *   - WinRM configured on the target (`Enable-PSRemoting -Force` on the
 *     target before this transport will work)
 *
 * Auth: operator supplies `username` + `password`. The transport
 * builds a `PSCredential` inline and threads it through via
 * `-Credential`. We never log the password (audit detail carries
 * username only).
 *
 * Bootstrap sequence (one Invoke-Command session, scripted body):
 *   1. New-Item -Path 'C:\Program Files\Signalman' -ItemType Directory
 *   2. Invoke-WebRequest -Uri <binary.url> -OutFile <path>
 *   3. (Optional) Get-FileHash + sha256 verify
 *   4. Set-Content -Path $env:USERPROFILE\.signalman\runner.yaml
 *   5. Register a Windows service via `New-Service` (or `sc.exe create`)
 *   6. Start-Service
 */

import { resolveExpectedSha256 } from "./binary.js";
import type {
  BootstrapCommonOptions,
  BootstrapResult,
  RunnerDeployTransport,
  TransportExec,
  TransportOptions,
  WinRmTransportOptions,
} from "./transport.js";

/**
 * Build the PowerShell `ScriptBlock` body that runs remotely.
 * Exposed for unit tests so we can pin the exact PS commands.
 */
export function buildWinRmScript(
  common: BootstrapCommonOptions,
  expectedSha: string | null,
): string {
  const url = common.binary.url.replace(/'/g, `''`);
  const workerName = common.workerName.replace(/'/g, `''`);
  const cpUrl = common.controlPlaneUrl.replace(/'/g, `''`);
  const token = common.token.replace(/'/g, `''`);
  const lines: string[] = [
    `$ErrorActionPreference = 'Stop'`,
    `New-Item -ItemType Directory -Force -Path 'C:\\Program Files\\Signalman' | Out-Null`,
    `Invoke-WebRequest -Uri '${url}' -OutFile 'C:\\Program Files\\Signalman\\signalman-runner.exe'`,
  ];
  if (expectedSha) {
    lines.push(
      `$actual = (Get-FileHash -Algorithm SHA256 'C:\\Program Files\\Signalman\\signalman-runner.exe').Hash.ToLower()`,
      `if ($actual -ne '${expectedSha}') { throw "sha256 mismatch: expected ${expectedSha}, got $actual" }`,
    );
  }
  lines.push(
    `New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.signalman" | Out-Null`,
    `Set-Content -Path "$env:USERPROFILE\\.signalman\\runner.yaml" -Value @"`,
    `control_plane_url: ${cpUrl}`,
    `token: ${token}`,
    `worker_name: ${workerName}`,
    `"@`,
    // Register as Windows service. Use sc.exe (built-in; doesn't need
    // PSWindowsService module). DisplayName is human-facing.
    `& sc.exe create 'SignalmanRunner_${workerName}' binPath= '"C:\\Program Files\\Signalman\\signalman-runner.exe" start --worker-name ${workerName}' start= auto DisplayName= 'Signalman Runner (${workerName})' | Out-Null`,
    `& sc.exe start 'SignalmanRunner_${workerName}' | Out-Null`,
  );
  return lines.join("\n");
}

/**
 * Build the argv passed to `pwsh` to run the script body remotely.
 * Exposed for unit tests.
 */
export function buildWinRmInvokeArgs(opts: WinRmTransportOptions): string[] {
  // pwsh -NoProfile -NonInteractive -Command "& {<wrapped script>}"
  // The wrapped script builds the PSCredential + Invoke-Command in
  // one shot so the password never lands in a separate exec call.
  const username = opts.username.replace(/'/g, `''`);
  const port = opts.port ?? (opts.useSsl === false ? 5985 : 5986);
  const useSsl = opts.useSsl !== false; // default true
  const host = opts.host.replace(/'/g, `''`);
  const sslArg = useSsl ? " -UseSSL" : "";
  // ConvertTo-SecureString reads the password from a placeholder env
  // var the verb layer populates via the `env` option.
  const wrapper = [
    `$pw = ConvertTo-SecureString -AsPlainText -Force $env:SIGNALMAN_WINRM_PASSWORD`,
    `$cred = New-Object System.Management.Automation.PSCredential('${username}', $pw)`,
    // Inline the remote script via -ScriptBlock; we'll pipe the body
    // through stdin so it's not on the argv.
    `$body = [System.Console]::In.ReadToEnd()`,
    `$sb = [ScriptBlock]::Create($body)`,
    `Invoke-Command -ComputerName '${host}' -Port ${port}${sslArg} -Credential $cred -ScriptBlock $sb`,
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", wrapper];
}

export class WinRmTransport implements RunnerDeployTransport {
  readonly kind = "winrm" as const;

  async bootstrap(
    common: BootstrapCommonOptions,
    opts: TransportOptions,
    exec: TransportExec,
  ): Promise<BootstrapResult> {
    if (opts.kind !== "winrm") {
      throw new Error(`WinRmTransport.bootstrap: opts.kind must be 'winrm' (got ${opts.kind})`);
    }
    const o = opts as WinRmTransportOptions;
    const out = common.out ?? process.stderr;
    const expectedSha = resolveExpectedSha256(common.binary);

    out.write(`[runner deploy] winrm -> ${o.host}\n`);

    const body = buildWinRmScript(common, expectedSha);
    const args = buildWinRmInvokeArgs(o);
    const r = await exec("pwsh", args, {
      stdin: body,
      env: { SIGNALMAN_WINRM_PASSWORD: o.password },
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `winrm transport: pwsh exited with ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }

    return {
      transport: "winrm",
      workerName: common.workerName,
      detail: {
        host: o.host,
        port: o.port ?? (o.useSsl === false ? 5985 : 5986),
        useSsl: o.useSsl !== false,
        username: o.username, // explicitly NOT password
        sha256_pinned: expectedSha !== null,
      },
    };
  }
}
