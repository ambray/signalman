<#
.SYNOPSIS
Run the service-backed Hyper-V smoke scenario against a local Windows VM.

.DESCRIPTION
Creates a temporary Signalman config with service backend credentials,
runs the `service-backend-smoke` scenario, then verifies that the named
checkpoint still exists. The temp config is removed after the run.

This script intentionally takes guest credentials as parameters instead
of committing machine-local secrets into `.signalman/config.yaml`.
#>

[CmdletBinding()]
param(
    [string]$VmName = "Win11_test",

    [string]$Checkpoint = "base",

    [Parameter(Mandatory = $true)]
    [string]$GuestUsername,

    [Parameter(Mandatory = $true)]
    [string]$GuestPassword,

    [int]$ServicePort,

    [string]$ServiceCertDir,

    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[live-smoke] $Name"
    & $Body
}

function ConvertTo-YamlScalar {
    param([string]$Value)

    return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipBuild) {
    Invoke-Step "build host CLI" {
        Push-Location host
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }
}

$configPath = Join-Path $env:TEMP ("signalman-live-service-smoke-{0}.yaml" -f ([guid]::NewGuid().ToString("N")))
$oldConfig = $env:SIGNALMAN_CONFIG

try {
    Invoke-Step "write temporary service config" {
        $serviceLines = @()
        if ($ServicePort -gt 0) {
            $serviceLines += "  service:"
            $serviceLines += "    port: $ServicePort"
            if ($ServiceCertDir) {
                $serviceLines += "    certDir: $(ConvertTo-YamlScalar $ServiceCertDir)"
            }
        } elseif ($ServiceCertDir) {
            $serviceLines += "  service:"
            $serviceLines += "    certDir: $(ConvertTo-YamlScalar $ServiceCertDir)"
        }

        $yaml = @(
            "hypervisor:",
            "  backend: service"
        ) + $serviceLines + @(
            "  guestCredentials:",
            "    username: $(ConvertTo-YamlScalar $GuestUsername)",
            "    password: $(ConvertTo-YamlScalar $GuestPassword)",
            "",
            "guestAgent:",
            "  defaultPort: 50051",
            "  tls:",
            "    enabled: false",
            "",
            "scenarios:",
            "  dir: ./.signalman/scenarios",
            "  outputDir: ./output",
            "  screenshotDir: ./output/screenshots",
            "",
            "vmAliases:",
            "  endpoint-1: $(ConvertTo-YamlScalar $VmName)"
        )
        $yaml -join [Environment]::NewLine | Set-Content -LiteralPath $configPath -Encoding UTF8
        $env:SIGNALMAN_CONFIG = $configPath
    }

    Invoke-Step "verify VM and checkpoint are visible through service" {
        $checkScript = @'
const { loadConfig } = await import("./host/dist/config.js");
const { selectBackend } = await import("./host/dist/hypervisors/selector.js");

const vmName = process.env.SIGNALMAN_LIVE_VM;
const checkpoint = process.env.SIGNALMAN_LIVE_CHECKPOINT;
const config = loadConfig();
const backend = await selectBackend(config);
const vms = await backend.listVMs();
const vm = vms.find((candidate) => candidate.name.toLowerCase() === vmName.toLowerCase());
if (!vm) {
  throw new Error(`VM '${vmName}' not found. Available VMs: ${vms.map((v) => v.name).join(", ")}`);
}
const checkpoints = await backend.listCheckpoints(vm);
if (!checkpoints.some((candidate) => candidate.label === checkpoint)) {
  throw new Error(`Checkpoint '${checkpoint}' not found on VM '${vmName}'.`);
}
if (backend.dispose) backend.dispose();
'@
        $env:SIGNALMAN_LIVE_VM = $VmName
        $env:SIGNALMAN_LIVE_CHECKPOINT = $Checkpoint
        $checkScript | node --input-type=module
        if ($LASTEXITCODE -ne 0) {
            throw "pre-run service visibility check failed with exit code $LASTEXITCODE"
        }
    }

    Invoke-Step "run service-backend-smoke" {
        node host/dist/cli.js run service-backend-smoke --format json
        if ($LASTEXITCODE -ne 0) {
            throw "service-backend-smoke failed with exit code $LASTEXITCODE"
        }
    }
} finally {
    Invoke-Step "post-run checkpoint check" {
        try {
            if (Test-Path -LiteralPath $configPath) {
                $env:SIGNALMAN_CONFIG = $configPath
                $env:SIGNALMAN_LIVE_VM = $VmName
                $env:SIGNALMAN_LIVE_CHECKPOINT = $Checkpoint
                @'
const { loadConfig } = await import("./host/dist/config.js");
const { selectBackend } = await import("./host/dist/hypervisors/selector.js");

const vmName = process.env.SIGNALMAN_LIVE_VM;
const checkpoint = process.env.SIGNALMAN_LIVE_CHECKPOINT;
const config = loadConfig();
const backend = await selectBackend(config);
const vm = (await backend.listVMs()).find((candidate) => candidate.name.toLowerCase() === vmName.toLowerCase());
if (!vm) {
  throw new Error(`VM '${vmName}' not found during post-run check.`);
}
const status = await backend.getStatus(vm);
const checkpoints = await backend.listCheckpoints(vm);
if (!checkpoints.some((candidate) => candidate.label === checkpoint)) {
  throw new Error(`Checkpoint '${checkpoint}' missing after smoke run.`);
}
console.log(JSON.stringify({ vm: vm.name, status: status.state, checkpoint }, null, 2));
if (backend.dispose) backend.dispose();
'@ | node --input-type=module
                if ($LASTEXITCODE -ne 0) {
                    throw "post-run checkpoint check failed with exit code $LASTEXITCODE"
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
        }
    }
}

Write-Host ""
Write-Host "[live-smoke] complete"
