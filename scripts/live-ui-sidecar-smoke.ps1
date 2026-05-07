<#
.SYNOPSIS
Run a live UI sidecar smoke test against a local Windows VM.

.DESCRIPTION
Creates a temporary Signalman config with service backend guest credentials,
starts the VM unless requested otherwise, ensures the interactive UI sidecar,
then exercises screenshot, find, click, and type against the guest desktop.

This is intentionally opt-in and machine-local. It does not edit
`.signalman/config.yaml`, and it takes guest credentials as parameters so test
VM secrets are not committed.
#>

[CmdletBinding()]
param(
    [string]$VmName = "Win11_test",

    [string]$Checkpoint = "base",

    [Parameter(Mandatory = $true)]
    [string]$GuestUsername,

    [Parameter(Mandatory = $true)]
    [string]$GuestPassword,

    [string]$SidecarUsername,

    [string]$UiSelector = "[name='Start']",

    [string]$TypeText = "signalman ui smoke",

    [string]$ScreenshotPath,

    [int]$ServicePort,

    [string]$ServiceCertDir,

    [int]$BootTimeoutSeconds = 300,

    [int]$SidecarTimeoutSeconds = 60,

    [switch]$SkipStart
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[live-ui-smoke] $Name"
    & $Body
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SidecarUsername) {
    $SidecarUsername = $GuestUsername
}

if (-not $ScreenshotPath) {
    $safeVmName = $VmName -replace '[^A-Za-z0-9_.-]', '_'
    $ScreenshotPath = Join-Path $repoRoot "output/screenshots/live-ui-sidecar-$safeVmName.png"
}

$configPath = Join-Path $env:TEMP ("signalman-live-ui-sidecar-{0}.yaml" -f ([guid]::NewGuid().ToString("N")))
$oldConfig = $env:SIGNALMAN_CONFIG

$env:SIGNALMAN_LIVE_VM = $VmName
$env:SIGNALMAN_LIVE_CHECKPOINT = $Checkpoint
$env:SIGNALMAN_LIVE_GUEST_USERNAME = $GuestUsername
$env:SIGNALMAN_LIVE_GUEST_PASSWORD = $GuestPassword
$env:SIGNALMAN_LIVE_SIDECAR_USERNAME = $SidecarUsername
$env:SIGNALMAN_LIVE_UI_SELECTOR = $UiSelector
$env:SIGNALMAN_LIVE_TYPE_TEXT = $TypeText
$env:SIGNALMAN_LIVE_SCREENSHOT = $ScreenshotPath
$env:SIGNALMAN_LIVE_CONFIG_PATH = $configPath
$env:SIGNALMAN_LIVE_BASE_CONFIG = Join-Path $repoRoot ".signalman/config.yaml"
$env:SIGNALMAN_LIVE_REPO_ROOT = $repoRoot
$env:SIGNALMAN_LIVE_BOOT_TIMEOUT_MS = [string]($BootTimeoutSeconds * 1000)
$env:SIGNALMAN_LIVE_SIDECAR_TIMEOUT_MS = [string]($SidecarTimeoutSeconds * 1000)
$env:SIGNALMAN_LIVE_SKIP_START = if ($SkipStart) { "true" } else { "false" }
if ($ServicePort -gt 0) {
    $env:SIGNALMAN_LIVE_SERVICE_PORT = [string]$ServicePort
}
if ($ServiceCertDir) {
    $env:SIGNALMAN_LIVE_SERVICE_CERT_DIR = $ServiceCertDir
}

try {
    Invoke-Step "run UI sidecar smoke" {
        $smokeScript = @'
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "./src/config.js";
import { selectBackend } from "./src/hypervisors/selector.js";
import { resolveVM } from "./src/vm-cache.js";
import { buildGuestClientForVm } from "./src/provisioning/guest-client-factory.js";
import { ensureUiSidecar } from "./src/guest/ui-sidecar.js";

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

const vmName = required("SIGNALMAN_LIVE_VM");
const checkpoint = process.env.SIGNALMAN_LIVE_CHECKPOINT ?? "";
const guestUsername = required("SIGNALMAN_LIVE_GUEST_USERNAME");
const guestPassword = required("SIGNALMAN_LIVE_GUEST_PASSWORD");
const sidecarUsername = required("SIGNALMAN_LIVE_SIDECAR_USERNAME");
const selector = required("SIGNALMAN_LIVE_UI_SELECTOR");
const typeText = required("SIGNALMAN_LIVE_TYPE_TEXT");
const screenshotPath = required("SIGNALMAN_LIVE_SCREENSHOT");
const configPath = required("SIGNALMAN_LIVE_CONFIG_PATH");
const baseConfigPath = required("SIGNALMAN_LIVE_BASE_CONFIG");
const repoRoot = required("SIGNALMAN_LIVE_REPO_ROOT");
const bootTimeoutMs = Number(process.env.SIGNALMAN_LIVE_BOOT_TIMEOUT_MS ?? 300_000);
const sidecarTimeoutMs = Number(process.env.SIGNALMAN_LIVE_SIDECAR_TIMEOUT_MS ?? 60_000);
const skipStart = process.env.SIGNALMAN_LIVE_SKIP_START === "true";

const baseConfig = fs.existsSync(baseConfigPath) ? loadConfig(baseConfigPath) : loadConfig();
const liveConfig = structuredClone(baseConfig);
const resolveRepoPath = (value) => {
  if (!value || path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value);
};
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
if (process.env.SIGNALMAN_LIVE_SERVICE_PORT) {
  liveConfig.hypervisor.service.port = Number(process.env.SIGNALMAN_LIVE_SERVICE_PORT);
}
if (process.env.SIGNALMAN_LIVE_SERVICE_CERT_DIR) {
  liveConfig.hypervisor.service.certDir = process.env.SIGNALMAN_LIVE_SERVICE_CERT_DIR;
}
if (liveConfig.hypervisor.service?.certDir) {
  liveConfig.hypervisor.service.certDir = resolveRepoPath(liveConfig.hypervisor.service.certDir);
}
if (liveConfig.guestAgent?.tls?.enabled) {
  liveConfig.guestAgent.tls.caPath = resolveRepoPath(liveConfig.guestAgent.tls.caPath);
  liveConfig.guestAgent.tls.certPath = resolveRepoPath(liveConfig.guestAgent.tls.certPath);
  liveConfig.guestAgent.tls.keyPath = resolveRepoPath(liveConfig.guestAgent.tls.keyPath);
}
liveConfig.vmAliases = {
  ...(liveConfig.vmAliases ?? {}),
  "endpoint-1": vmName,
};

fs.writeFileSync(configPath, YAML.stringify(liveConfig), "utf8");
process.env.SIGNALMAN_CONFIG = configPath;

const config = loadConfig();
const backend = await selectBackend(config);
let client;
try {
  const handle = await resolveVM(backend, vmName);
  console.log(JSON.stringify({ step: "resolved", backend: backend.name, handle }));

  if (checkpoint) {
    const checkpoints = await backend.listCheckpoints(handle);
    if (!checkpoints.some((candidate) => candidate.label === checkpoint)) {
      throw new Error(`Checkpoint '${checkpoint}' not found on VM '${vmName}'.`);
    }
    console.log(JSON.stringify({ step: "checkpoint", checkpoint }));
  }

  let status = await backend.getStatus(handle);
  console.log(JSON.stringify({ step: "initial-status", state: status.state, ipAddress: status.ipAddress ?? "" }));

  if (!skipStart && status.state !== "running") {
    await backend.startVM(handle);
    console.log(JSON.stringify({ step: "start-requested" }));
  }

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    status = await backend.getStatus(handle);
    console.log(JSON.stringify({
      step: "boot-poll",
      state: status.state,
      ipAddress: status.ipAddress ?? "",
      guestAgentReachable: Boolean(status.guestAgentReachable),
    }));
    if (status.state === "running" && isUsableGuestIp(status.ipAddress)) break;
    await sleep(5_000);
  }
  if (status.state !== "running" || !isUsableGuestIp(status.ipAddress)) {
    throw new Error(
      `VM '${vmName}' did not reach running state with a usable IP within ${bootTimeoutMs}ms; ` +
        `last state=${status.state}, ip=${status.ipAddress ?? ""}.`,
    );
  }

  client = await buildGuestClientForVm(backend, vmName);
  const health = await client.health(10_000);
  console.log(JSON.stringify({ step: "guest-health", health }));

  const sidecar = await ensureUiSidecar(client, {
    username: sidecarUsername,
    runNow: true,
    timeoutMs: sidecarTimeoutMs,
  });
  console.log(JSON.stringify({ step: "sidecar", sidecar }));
  if (sidecar.state !== "Running") {
    throw new Error(
      `UI sidecar is not running for '${sidecarUsername}' (state=${sidecar.state}). ` +
        `The user may need to be logged into an interactive Windows session.`,
    );
  }

  const screenshot = await client.uiScreenshot({ format: "png", timeoutMs: 30_000 });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, screenshot.imageData);
  console.log(JSON.stringify({
    step: "screenshot",
    path: screenshotPath,
    width: screenshot.width,
    height: screenshot.height,
    bytes: screenshot.imageData.length,
  }));

  const elements = await client.uiFind(selector, { findTimeoutMs: 5_000, timeoutMs: 30_000 });
  console.log(JSON.stringify({ step: "find", selector, count: elements.length, first: elements[0] ?? null }));
  if (elements.length === 0) {
    throw new Error(`UI selector '${selector}' returned no elements.`);
  }

  const click = await client.uiClick(selector, { timeoutMs: 30_000 });
  console.log(JSON.stringify({ step: "click", click }));
  if (!click.success) {
    throw new Error(`UI click failed for '${selector}': ${click.error}`);
  }

  const type = await client.uiType(typeText, { timeoutMs: 30_000 });
  console.log(JSON.stringify({ step: "type", type }));
  if (!type.success) {
    throw new Error(`UI type failed: ${type.error}`);
  }

  console.log(JSON.stringify({
    step: "complete",
    vm: vmName,
    screenshotPath,
    selector,
  }));
} finally {
  client?.dispose?.();
  backend.dispose?.();
}
'@
        Push-Location host
        try {
            $smokeScript | npx tsx -
            if ($LASTEXITCODE -ne 0) {
                throw "live UI sidecar smoke failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }
} finally {
    if ($null -eq $oldConfig) {
        Remove-Item Env:\SIGNALMAN_CONFIG -ErrorAction SilentlyContinue
    } else {
        $env:SIGNALMAN_CONFIG = $oldConfig
    }
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_VM -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_CHECKPOINT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_GUEST_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_GUEST_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SIDECAR_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_UI_SELECTOR -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_TYPE_TEXT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SCREENSHOT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_CONFIG_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_BASE_CONFIG -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_REPO_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_BOOT_TIMEOUT_MS -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SIDECAR_TIMEOUT_MS -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SKIP_START -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SERVICE_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SERVICE_CERT_DIR -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[live-ui-smoke] complete"
