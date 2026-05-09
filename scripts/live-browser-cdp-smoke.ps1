<#
.SYNOPSIS
Run a live Browser* CDP smoke test against a local Windows VM.

.DESCRIPTION
Starts a tiny HTTP server inside the guest, ensures the native UI sidecar,
then validates browser_navigate, browser_click, and browser_screenshot against
Microsoft Edge's loopback CDP endpoint. The script checks that the named
checkpoint still exists before and after the run, but it does not restore,
delete, or overwrite checkpoints.
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

    [int]$GuestHttpPort = 18080,

    [string]$ScreenshotPath,

    [int]$SidecarTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[live-browser-cdp-smoke] $Name"
    & $Body
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SidecarUsername) {
    $SidecarUsername = $GuestUsername
}

if (-not $ScreenshotPath) {
    $safeVmName = $VmName -replace '[^A-Za-z0-9_.-]', '_'
    $ScreenshotPath = Join-Path $repoRoot "output/screenshots/live-browser-cdp-$safeVmName.png"
}

$env:SIGNALMAN_LIVE_VM = $VmName
$env:SIGNALMAN_LIVE_CHECKPOINT = $Checkpoint
$env:SIGNALMAN_LIVE_GUEST_USERNAME = $GuestUsername
$env:SIGNALMAN_LIVE_GUEST_PASSWORD = $GuestPassword
$env:SIGNALMAN_LIVE_SIDECAR_USERNAME = $SidecarUsername
$env:SIGNALMAN_LIVE_GUEST_HTTP_PORT = [string]$GuestHttpPort
$env:SIGNALMAN_LIVE_SCREENSHOT = $ScreenshotPath
$env:SIGNALMAN_LIVE_REPO_ROOT = $repoRoot
$env:SIGNALMAN_LIVE_BASE_CONFIG = Join-Path $repoRoot ".signalman/config.yaml"
$env:SIGNALMAN_LIVE_SIDECAR_TIMEOUT_MS = [string]($SidecarTimeoutSeconds * 1000)

try {
    Invoke-Step "run Browser* CDP smoke" {
        $smokeScript = @'
import fs from "node:fs";
import path from "node:path";
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

const psSingle = (value) => value.replaceAll("'", "''");
const repoRoot = required("SIGNALMAN_LIVE_REPO_ROOT");
const vmName = required("SIGNALMAN_LIVE_VM");
const checkpoint = process.env.SIGNALMAN_LIVE_CHECKPOINT ?? "";
const guestUsername = required("SIGNALMAN_LIVE_GUEST_USERNAME");
const guestPassword = required("SIGNALMAN_LIVE_GUEST_PASSWORD");
const sidecarUsername = required("SIGNALMAN_LIVE_SIDECAR_USERNAME");
const guestHttpPort = Number(required("SIGNALMAN_LIVE_GUEST_HTTP_PORT"));
const screenshotPath = required("SIGNALMAN_LIVE_SCREENSHOT");
const sidecarTimeoutMs = Number(process.env.SIGNALMAN_LIVE_SIDECAR_TIMEOUT_MS ?? 60_000);
const baseConfigPath = required("SIGNALMAN_LIVE_BASE_CONFIG");

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
if (liveConfig.hypervisor.service?.certDir) {
  liveConfig.hypervisor.service.certDir = resolveRepoPath(liveConfig.hypervisor.service.certDir);
}
if (liveConfig.guestAgent?.tls?.enabled) {
  liveConfig.guestAgent.tls.caPath = resolveRepoPath(liveConfig.guestAgent.tls.caPath);
  liveConfig.guestAgent.tls.certPath = resolveRepoPath(liveConfig.guestAgent.tls.certPath);
  liveConfig.guestAgent.tls.keyPath = resolveRepoPath(liveConfig.guestAgent.tls.keyPath);
}

const backend = await selectBackend(liveConfig);
let client;
try {
  const handle = await resolveVM(backend, vmName);
  const checkpoints = await backend.listCheckpoints(handle);
  if (checkpoint && !checkpoints.some((candidate) => candidate.label === checkpoint)) {
    throw new Error(`Checkpoint '${checkpoint}' not found on VM '${vmName}'.`);
  }
  console.log(JSON.stringify({ step: "checkpoint-before", checkpoint, labels: checkpoints.map((cp) => cp.label) }));

  client = await buildGuestClientForVm(backend, vmName);
  console.log(JSON.stringify({ step: "guest-health", health: await client.health(15_000) }));

  const guestServer = `
$ErrorActionPreference = 'Stop'
$html = '<!doctype html><html><head><title>Signalman CDP Smoke</title></head><body><main><h1 id="title">Signalman CDP Smoke</h1><button id="mark" onclick="document.title=''Clicked''; location.hash=''clicked''; document.body.setAttribute(''data-clicked'',''true'');">Mark</button></main></body></html>'
$body = [Text.Encoding]::UTF8.GetBytes($html)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('127.0.0.1'), ${guestHttpPort})
$listener.Start()
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
    while (($line = $reader.ReadLine()) -ne $null -and $line.Length -gt 0) {}
    $newline = [string][char]13 + [string][char]10
    $headers = "HTTP/1.1 200 OK" + $newline +
      "Content-Type: text/html; charset=utf-8" + $newline +
      "Content-Length: " + $body.Length + $newline +
      "Connection: close" + $newline + $newline
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
  } finally {
    $client.Close()
  }
}
`;
  const encodedGuestServer = Buffer.from(guestServer, "utf16le").toString("base64");
  const serverScript = `
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like '*cdp-smoke-server.ps1*' } |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
$scriptPath = 'C:\\ProgramData\\Signalman\\cdp-smoke-server.ps1'
$server = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedGuestServer}'))
Set-Content -LiteralPath $scriptPath -Value $server -Encoding UTF8
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath)
Start-Sleep -Seconds 2
$probe = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${guestHttpPort}/' -TimeoutSec 5
@{ StatusCode = $probe.StatusCode; Length = $probe.Content.Length } | ConvertTo-Json -Compress
`;
  const encodedServerScript = Buffer.from(serverScript, "utf16le").toString("base64");
  const server = await client.runCommand(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedServerScript],
    { timeoutMs: 30_000, runAs: "SYSTEM" },
  );
  console.log(JSON.stringify({
    step: "guest-http-server",
    exitCode: server.exitCode,
    stdout: server.stdout.trim(),
    stderr: server.stderr.trim(),
  }));
  if (server.exitCode !== 0) {
    throw new Error(`guest HTTP server setup failed: ${server.stderr || server.stdout}`);
  }

  const sidecar = await ensureUiSidecar(client, {
    username: sidecarUsername,
    engine: "native",
    runNow: true,
    waitReadyMs: sidecarTimeoutMs,
    timeoutMs: sidecarTimeoutMs + 15_000,
  });
  console.log(JSON.stringify({ step: "sidecar", sidecar }));
  if (!sidecar.ready) {
    throw new Error(`native UI sidecar did not become ready: ${JSON.stringify(sidecar)}`);
  }

  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const edgeProfile = "C:\\ProgramData\\Signalman\\browser-cdp-profile";
  const launchCommand =
    `"${edgePath}" --remote-debugging-port=9222 --no-first-run --no-default-browser-check ` +
    `--user-data-dir="${edgeProfile}" about:blank`;
  const escape = await client.uiKey("{ESC}", { timeoutMs: 15_000 });
  console.log(JSON.stringify({ step: "ui-escape", escape }));
  const runDialog = await client.uiKey("#r", { timeoutMs: 15_000 });
  console.log(JSON.stringify({ step: "ui-run-dialog", runDialog }));
  if (!runDialog.success) {
    throw new Error(`failed to open Run dialog: ${runDialog.error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const typedLaunch = await client.uiType(launchCommand, { timeoutMs: 30_000 });
  console.log(JSON.stringify({ step: "ui-type-edge-launch", typedLaunch }));
  if (!typedLaunch.success) {
    throw new Error(`failed to type Edge launch command: ${typedLaunch.error}`);
  }
  const enterLaunch = await client.uiKey("{ENTER}", { timeoutMs: 15_000 });
  console.log(JSON.stringify({ step: "ui-enter-edge-launch", enterLaunch }));
  if (!enterLaunch.success) {
    throw new Error(`failed to submit Edge launch command: ${enterLaunch.error}`);
  }
  const waitForCdpScript = `
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      @{ Ready = $true; Content = $response.Content } | ConvertTo-Json -Compress
      exit 0
    }
  } catch {}
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
@{ Ready = $false } | ConvertTo-Json -Compress
exit 1
`;
  const encodedWaitForCdp = Buffer.from(waitForCdpScript, "utf16le").toString("base64");
  const cdpProbe = await client.runCommand(
    "powershell.exe",
    ["-NoProfile", "-EncodedCommand", encodedWaitForCdp],
    { timeoutMs: 40_000, runAs: "SYSTEM" },
  );
  console.log(JSON.stringify({
    step: "cdp-probe",
    exitCode: cdpProbe.exitCode,
    stdout: cdpProbe.stdout.trim(),
    stderr: cdpProbe.stderr.trim(),
  }));
  if (cdpProbe.exitCode !== 0) {
    throw new Error(`CDP endpoint did not become reachable: ${cdpProbe.stderr || cdpProbe.stdout}`);
  }

  const url = `http://127.0.0.1:${guestHttpPort}/`;
  const nav = await client.browserNavigate(url, 90_000);
  console.log(JSON.stringify({ step: "browser-navigate", nav }));
  if (!nav.success || !nav.pageUrl.startsWith(url)) {
    throw new Error(`browser navigate failed: ${JSON.stringify(nav)}`);
  }

  const click = await client.browserClick("#mark", 90_000);
  console.log(JSON.stringify({ step: "browser-click", click }));
  if (!click.success || click.pageTitle !== "Clicked") {
    throw new Error(`browser click failed: ${JSON.stringify(click)}`);
  }

  const screenshot = await client.browserScreenshot({
    format: "png",
    fullPage: false,
    timeoutMs: 90_000,
  });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, screenshot.imageData);
  console.log(JSON.stringify({
    step: "browser-screenshot",
    path: screenshotPath,
    format: screenshot.format,
    width: screenshot.width,
    height: screenshot.height,
    bytes: screenshot.imageData.length,
  }));
  if (screenshot.imageData.length < 1_000) {
    throw new Error(`browser screenshot too small: ${screenshot.imageData.length} bytes`);
  }

  const checkpointsAfter = await backend.listCheckpoints(handle);
  if (checkpoint && !checkpointsAfter.some((candidate) => candidate.label === checkpoint)) {
    throw new Error(`Checkpoint '${checkpoint}' missing after smoke run.`);
  }
  console.log(JSON.stringify({ step: "checkpoint-after", checkpoint, labels: checkpointsAfter.map((cp) => cp.label) }));
} finally {
  try {
    if (client) {
      const cleanupScript = "Get-CimInstance Win32_Process -Filter \"name = 'powershell.exe'\" | Where-Object { $_.CommandLine -like '*cdp-smoke-server.ps1*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }; Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue; exit 0";
      const encodedCleanupScript = Buffer.from(cleanupScript, "utf16le").toString("base64");
      await client.runCommand(
        "powershell.exe",
        [
          "-NoProfile",
          "-EncodedCommand",
          encodedCleanupScript,
        ],
        { timeoutMs: 15_000, runAs: "SYSTEM", maxRetries: 0 },
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ step: "cleanup-warning", error: String(error) }));
  }
  client?.dispose?.();
  backend.dispose?.();
}
'@
        Push-Location host
        try {
            $smokeScript | npx tsx -
            if ($LASTEXITCODE -ne 0) {
                throw "live Browser* CDP smoke failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }
} finally {
    Remove-Item Env:\SIGNALMAN_LIVE_VM -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_CHECKPOINT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_GUEST_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_GUEST_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SIDECAR_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_GUEST_HTTP_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SCREENSHOT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_REPO_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_BASE_CONFIG -ErrorAction SilentlyContinue
    Remove-Item Env:\SIGNALMAN_LIVE_SIDECAR_TIMEOUT_MS -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[live-browser-cdp-smoke] complete"
