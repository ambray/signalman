<#
.SYNOPSIS
Refresh the locally installed Signalman Windows service from this checkout.

.DESCRIPTION
This script is for developer Hyper-V hosts where the Signalman SCM service
points at this repo's target directory, for example:

  C:\path\to\signalman\target\debug\signalman-service.exe run-service

It must run from an elevated PowerShell. The script first preflight-builds
the service into a temporary target directory, then stops/uninstalls the
existing SCM service, rebuilds the configured target in-place, installs it,
and starts it. Cert material under ProgramData is preserved by the service
install path.

The preflight build keeps a compile error from removing a currently working
service.
#>

[CmdletBinding()]
param(
    [ValidateSet("debug", "release")]
    [string]$Profile = "debug",

    [string]$CertDir,

    [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

function Assert-WindowsAdmin {
    if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
        throw "update-dev-service.ps1 is only supported on Windows."
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $admin = [Security.Principal.WindowsBuiltInRole]::Administrator
    if (-not $principal.IsInRole($admin)) {
        throw "Run this script from an elevated PowerShell session."
    }
}

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[service-update] $Name"
    & $Body
}

function Test-ServiceExists {
    $svc = Get-Service -Name Signalman -ErrorAction SilentlyContinue
    return $null -ne $svc
}

function Wait-ServiceState {
    param(
        [ValidateSet("Running", "Stopped")]
        [string]$State,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $svc = Get-Service -Name Signalman -ErrorAction SilentlyContinue
        if ($State -eq "Stopped") {
            if ($null -eq $svc -or $svc.Status -eq "Stopped") { return }
        } elseif ($null -ne $svc -and $svc.Status -eq "Running") {
            return
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "Signalman service did not reach state '$State' within ${TimeoutSeconds}s."
}

Assert-WindowsAdmin

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$cargoArgs = @("build", "-p", "signalman-service")
if ($Profile -eq "release") {
    $cargoArgs += "--release"
}

$profileDir = if ($Profile -eq "release") { "release" } else { "debug" }
$serviceExe = Join-Path $repoRoot "target\$profileDir\signalman-service.exe"

if (-not $SkipPreflight) {
    Invoke-Step "preflight build into temporary target directory" {
        $oldTargetDir = $env:CARGO_TARGET_DIR
        try {
            $env:CARGO_TARGET_DIR = Join-Path $env:TEMP "signalman-service-preflight-target"
            & cargo @cargoArgs
            if ($LASTEXITCODE -ne 0) {
                throw "cargo preflight build failed with exit code $LASTEXITCODE"
            }
        } finally {
            if ($null -eq $oldTargetDir) {
                Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
            } else {
                $env:CARGO_TARGET_DIR = $oldTargetDir
            }
        }
    }
}

if (Test-ServiceExists) {
    Invoke-Step "stop and delete existing SCM service" {
        $svc = Get-Service -Name Signalman -ErrorAction Stop
        if ($svc.Status -ne "Stopped") {
            sc.exe stop Signalman | Out-Host
            Wait-ServiceState -State Stopped
        }

        sc.exe delete Signalman | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "sc.exe delete Signalman failed with exit code $LASTEXITCODE"
        }
    }
}

Invoke-Step "build service binary in repo target directory" {
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $serviceExe)) {
        throw "Expected service binary at $serviceExe"
    }
}

Invoke-Step "install SCM service" {
    $installArgs = @("install", "--binary", $serviceExe)
    if ($CertDir) {
        $installArgs += @("--cert-dir", $CertDir)
    }
    & $serviceExe @installArgs
    if ($LASTEXITCODE -ne 0) {
        throw "signalman-service install failed with exit code $LASTEXITCODE"
    }
}

Invoke-Step "start SCM service" {
    & $serviceExe start
    if ($LASTEXITCODE -ne 0) {
        throw "signalman-service start failed with exit code $LASTEXITCODE"
    }
    Wait-ServiceState -State Running
}

Invoke-Step "show service configuration" {
    sc.exe qc Signalman
}

Write-Host ""
Write-Host "[service-update] complete"
