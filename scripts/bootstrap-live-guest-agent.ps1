<#
.SYNOPSIS
Prepare a local Windows VM for live Signalman guest/UI sidecar smoke tests.

.DESCRIPTION
Bootstraps a dedicated Hyper-V test VM through the Signalman service backend:

  * optionally builds a statically-linked Windows guest agent
  * sets VM memory
  * starts the VM and waits for a usable non-link-local IPv4 address
  * copies the guest agent binary and TLS server certs into the VM
  * configures test-user autologon for interactive UI sidecar tests
  * registers a SYSTEM scheduled task that runs the guest agent at boot
  * opens the guest firewall for TCP/50051
  * verifies host-to-guest gRPC health

This script intentionally takes guest credentials as parameters and does not
edit `.signalman/config.yaml`. It mutates only the current VM state; it does
not restore, delete, or overwrite checkpoints.
#>

[CmdletBinding()]
param(
    [string]$VmName = "Win11_test",

    [Parameter(Mandatory = $true)]
    [string]$GuestUsername,

    [Parameter(Mandatory = $true)]
    [string]$GuestPassword,

    [int]$MemoryMB = 8192,

    [int]$BootTimeoutSeconds = 300,

    [int]$ServicePort,

    [string]$ServiceCertDir,

    [switch]$SkipGuestBuild,

    [switch]$SkipAutoLogon
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[bootstrap-live-guest] $Name"
    & $Body
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipGuestBuild) {
    Invoke-Step "build statically-linked guest agent" {
        $oldRustflags = $env:RUSTFLAGS
        try {
            $env:RUSTFLAGS = "-C target-feature=+crt-static"
            cargo build -p signalman-guest --release
            if ($LASTEXITCODE -ne 0) {
                throw "cargo build -p signalman-guest --release failed with exit code $LASTEXITCODE"
            }
        } finally {
            if ($null -eq $oldRustflags) {
                Remove-Item Env:\RUSTFLAGS -ErrorAction SilentlyContinue
            } else {
                $env:RUSTFLAGS = $oldRustflags
            }
        }
    }
}

$env:SIGNALMAN_BOOTSTRAP_VM = $VmName
$env:SIGNALMAN_BOOTSTRAP_GUEST_USERNAME = $GuestUsername
$env:SIGNALMAN_BOOTSTRAP_GUEST_PASSWORD = $GuestPassword
$env:SIGNALMAN_BOOTSTRAP_MEMORY_MB = [string]$MemoryMB
$env:SIGNALMAN_BOOTSTRAP_TIMEOUT_MS = [string]($BootTimeoutSeconds * 1000)
$env:SIGNALMAN_BOOTSTRAP_REPO_ROOT = $repoRoot
$env:SIGNALMAN_BOOTSTRAP_BASE_CONFIG = Join-Path $repoRoot ".signalman/config.yaml"
$env:SIGNALMAN_BOOTSTRAP_SKIP_AUTOLOGON = if ($SkipAutoLogon) { "true" } else { "false" }
if ($ServicePort -gt 0) {
    $env:SIGNALMAN_BOOTSTRAP_SERVICE_PORT = [string]$ServicePort
}
if ($ServiceCertDir) {
    $env:SIGNALMAN_BOOTSTRAP_SERVICE_CERT_DIR = $ServiceCertDir
}

try {
    Invoke-Step "bootstrap guest agent through service backend" {
        $bootstrapScript = @'
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./src/config.js";
import { selectBackend } from "./src/hypervisors/selector.js";
import { resolveVM } from "./src/vm-cache.js";
import { buildGuestClientForVm } from "./src/provisioning/guest-client-factory.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUsableGuestIp = (ipAddress) =>
  Boolean(ipAddress) &&
  !ipAddress.startsWith("169.254.") &&
  ipAddress !== "0.0.0.0";
const psSingle = (value) => value.replaceAll("'", "''");
const resolveRepoPath = (repoRoot, value) => {
  if (!value || path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value);
};

const vmName = required("SIGNALMAN_BOOTSTRAP_VM");
const guestUsername = required("SIGNALMAN_BOOTSTRAP_GUEST_USERNAME");
const guestPassword = required("SIGNALMAN_BOOTSTRAP_GUEST_PASSWORD");
const memoryMB = Number(process.env.SIGNALMAN_BOOTSTRAP_MEMORY_MB ?? "8192");
const timeoutMs = Number(process.env.SIGNALMAN_BOOTSTRAP_TIMEOUT_MS ?? "300000");
const repoRoot = required("SIGNALMAN_BOOTSTRAP_REPO_ROOT");
const baseConfigPath = required("SIGNALMAN_BOOTSTRAP_BASE_CONFIG");
const skipAutoLogon = process.env.SIGNALMAN_BOOTSTRAP_SKIP_AUTOLOGON === "true";

const baseConfig = fs.existsSync(baseConfigPath) ? loadConfig(baseConfigPath) : loadConfig();
if (!baseConfig.guestAgent.authToken) {
  throw new Error("guestAgent.authToken is required in .signalman/config.yaml");
}

const liveConfig = structuredClone(baseConfig);
liveConfig.hypervisor = {
  ...liveConfig.hypervisor,
  backend: "service",
  guestCredentials: {
    username: guestUsername,
    password: guestPassword,
  },
  service: {
    ...(liveConfig.hypervisor.service ?? {}),
  },
};
if (process.env.SIGNALMAN_BOOTSTRAP_SERVICE_PORT) {
  liveConfig.hypervisor.service.port = Number(process.env.SIGNALMAN_BOOTSTRAP_SERVICE_PORT);
}
if (process.env.SIGNALMAN_BOOTSTRAP_SERVICE_CERT_DIR) {
  liveConfig.hypervisor.service.certDir = process.env.SIGNALMAN_BOOTSTRAP_SERVICE_CERT_DIR;
}
if (liveConfig.hypervisor.service?.certDir) {
  liveConfig.hypervisor.service.certDir = resolveRepoPath(repoRoot, liveConfig.hypervisor.service.certDir);
}
if (liveConfig.guestAgent?.tls?.enabled) {
  liveConfig.guestAgent.tls.caPath = resolveRepoPath(repoRoot, liveConfig.guestAgent.tls.caPath);
  liveConfig.guestAgent.tls.certPath = resolveRepoPath(repoRoot, liveConfig.guestAgent.tls.certPath);
  liveConfig.guestAgent.tls.keyPath = resolveRepoPath(repoRoot, liveConfig.guestAgent.tls.keyPath);
}

const tempConfigPath = path.join(process.env.TEMP ?? repoRoot, `signalman-bootstrap-${Date.now()}.yaml`);
fs.writeFileSync(tempConfigPath, JSON.stringify(liveConfig), "utf8");
process.env.SIGNALMAN_CONFIG = tempConfigPath;

const backend = await selectBackend(liveConfig);
let client;
try {
  const handle = await resolveVM(backend, vmName);
  console.log(JSON.stringify({ step: "resolved", backend: backend.name, handle }));

  if (backend.setVmMemory && memoryMB > 0) {
    await backend.setVmMemory(handle, memoryMB);
    console.log(JSON.stringify({ step: "memory", memoryMB }));
  }

  let status = await backend.getStatus(handle);
  if (status.state !== "running") {
    await backend.startVM(handle);
    console.log(JSON.stringify({ step: "start-requested" }));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    status = await backend.getStatus(handle);
    console.log(JSON.stringify({
      step: "boot-poll",
      state: status.state,
      ipAddress: status.ipAddress ?? "",
    }));
    if (status.state === "running" && isUsableGuestIp(status.ipAddress)) break;
    await sleep(5_000);
  }
  if (status.state !== "running" || !isUsableGuestIp(status.ipAddress)) {
    throw new Error(
      `VM '${vmName}' did not reach running state with a usable IP within ${timeoutMs}ms; ` +
        `last state=${status.state}, ip=${status.ipAddress ?? ""}.`,
    );
  }

  const mkdir = await backend.executeCommand(
    handle,
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "New-Item -ItemType Directory -Force -Path 'C:\\Program Files\\Signalman','C:\\ProgramData\\Signalman\\certs' | Out-Null",
    ],
    60_000,
  );
  if (mkdir.exitCode !== 0) {
    throw new Error(`failed to create guest directories: ${mkdir.stderr || mkdir.stdout}`);
  }

  const files = [
    [path.join(repoRoot, "target/release/signalman-guest.exe"), "C:\\Program Files\\Signalman\\signalman-guest.exe"],
    [path.join(repoRoot, ".signalman/service-certs/ca.pem"), "C:\\ProgramData\\Signalman\\certs\\ca.pem"],
    [path.join(repoRoot, ".signalman/service-certs/server.pem"), "C:\\ProgramData\\Signalman\\certs\\server.pem"],
    [path.join(repoRoot, ".signalman/service-certs/server.key"), "C:\\ProgramData\\Signalman\\certs\\server.key"],
  ];
  for (const [hostPath, guestPath] of files) {
    if (!fs.existsSync(hostPath)) {
      throw new Error(`required bootstrap file is missing: ${hostPath}`);
    }
    await backend.copyFileToVM(handle, hostPath, guestPath);
    console.log(JSON.stringify({ step: "copied", guestPath }));
  }

  const token = baseConfig.guestAgent.authToken;
  const autoLogonScript = skipAutoLogon
    ? ""
    : `
$winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '1' -Type String
Set-ItemProperty -Path $winlogon -Name ForceAutoLogon -Value '1' -Type String
Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value '${psSingle(guestUsername)}' -Type String
Set-ItemProperty -Path $winlogon -Name DefaultPassword -Value '${psSingle(guestPassword)}' -Type String
Set-ItemProperty -Path $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String
`;

  const installScript = `
$ErrorActionPreference = 'Continue'
${autoLogonScript}
Stop-Service -Name SignalmanGuest -Force -ErrorAction SilentlyContinue
sc.exe delete SignalmanGuest | Out-Null
Get-Process signalman-guest -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
schtasks.exe /Delete /TN SignalmanGuest /F 2>$null | Out-Null
$runner = 'C:\\ProgramData\\Signalman\\run-guest.cmd'
$lines = @(
  '@echo off',
  'set SIGNALMAN_AUTH_TOKEN=${token}',
  'C:\\Progra~1\\Signalman\\signalman-guest.exe --bind 0.0.0.0:50051 --tls-cert C:\\ProgramData\\Signalman\\certs\\server.pem --tls-key C:\\ProgramData\\Signalman\\certs\\server.key --tls-ca C:\\ProgramData\\Signalman\\certs\\ca.pem'
)
Set-Content -LiteralPath $runner -Value $lines -Encoding ASCII
schtasks.exe /Create /TN SignalmanGuest /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $runner /F
schtasks.exe /Run /TN SignalmanGuest
New-NetFirewallRule -DisplayName 'Signalman Guest gRPC 50051' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 50051 -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Seconds 5
$proc = Get-Process signalman-guest -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw 'signalman-guest process did not start' }
@{ ProcessId = $proc.Id; Path = $proc.Path; AutoLogon = ${skipAutoLogon ? "$false" : "$true"} } | ConvertTo-Json -Compress
`;
  const install = await backend.executeCommand(
    handle,
    "powershell.exe",
    ["-NoProfile", "-Command", installScript],
    120_000,
  );
  if (install.exitCode !== 0) {
    throw new Error(`guest task bootstrap failed: ${install.stderr || install.stdout}`);
  }
  console.log(JSON.stringify({ step: "guest-task", result: install.stdout.trim() }));

  client = await buildGuestClientForVm(backend, vmName);
  const health = await client.health(30_000);
  console.log(JSON.stringify({ step: "guest-health", health }));
} finally {
  client?.dispose?.();
  backend.dispose?.();
  try { fs.unlinkSync(tempConfigPath); } catch {}
}
'@
        Push-Location host
        try {
            $bootstrapScript | npx tsx -
            if ($LASTEXITCODE -ne 0) {
                throw "guest bootstrap failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }
} finally {
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_VM -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_GUEST_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_GUEST_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_MEMORY_MB -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_TIMEOUT_MS -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_REPO_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_BASE_CONFIG -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_SKIP_AUTOLOGON -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_SERVICE_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_BOOTSTRAP_SERVICE_CERT_DIR -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[bootstrap-live-guest] complete"
