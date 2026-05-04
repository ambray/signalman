# P7 D4 placeholder. Real E2E will spin up a Hyper-V VM, install the
# guest agent, run a scenario, and capture artifacts. This smoke validates
# the toolchain so the lane stays exercised until the full E2E lands.
# See `docs/testing.md` and ROADMAP P7 D4.
#
# Exit codes:
#   0  all checks passed
#   1  one or more checks failed
#
# Each check writes a "[smoke] <name>: ok|FAIL" line so failures are
# easy to grep out of CI logs. Build artifacts are expected to already
# exist (the workflow runs the cargo/npm builds before invoking this
# script); we re-run the build commands here defensively in case the
# script is invoked stand-alone by a developer.

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host " Signalman E2E smoke (P7 D4 placeholder)"
Write-Host "------------------------------------------------------------"
Write-Host " This is NOT a real end-to-end test. It only verifies that"
Write-Host " host/guest/service binaries build and respond to a basic"
Write-Host " --help / --version flag. Replace with a real Hyper-V VM"
Write-Host " scenario once a self-hosted runner is wired up (see"
Write-Host " ROADMAP.md P7.3 D4)."
Write-Host "============================================================"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$failures = @()

function Invoke-Check {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[smoke] $Name ..."
    try {
        & $Body
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
            throw "non-zero exit code: $LASTEXITCODE"
        }
        Write-Host "[smoke] $Name : ok"
    } catch {
        Write-Host "[smoke] $Name : FAIL - $_"
        $script:failures += $Name
    }
}

# Host CLI
Invoke-Check "host build" {
    Push-Location host
    try {
        npm ci 2>$null
        if ($LASTEXITCODE -ne 0) { npm install }
        npm run build
        if (-not (Test-Path "dist/cli.js")) {
            throw "expected dist/cli.js after npm run build"
        }
    } finally { Pop-Location }
}

Invoke-Check "host CLI --help" {
    Push-Location host
    try {
        node dist/cli.js --help | Out-Null
    } finally { Pop-Location }
}

# Guest agent
Invoke-Check "guest build (release)" {
    Push-Location guest
    try {
        cargo build --release
    } finally { Pop-Location }
}

Invoke-Check "guest --version" {
    $bin = Join-Path $repoRoot "guest/target/release/signalman-guest.exe"
    if (-not (Test-Path $bin)) {
        # Workspace builds can also place the binary at the repo root target.
        $alt = Join-Path $repoRoot "target/release/signalman-guest.exe"
        if (Test-Path $alt) { $bin = $alt }
        else { throw "signalman-guest.exe not found at $bin or $alt" }
    }
    & $bin --version
}

# Service
Invoke-Check "service build (release)" {
    cargo build -p signalman-service --release
}

Invoke-Check "service --version" {
    $bin = Join-Path $repoRoot "target/release/signalman-service.exe"
    if (-not (Test-Path $bin)) {
        throw "signalman-service.exe not found at $bin"
    }
    & $bin --version
}

# Verdict
Write-Host ""
Write-Host "============================================================"
if ($failures.Count -eq 0) {
    Write-Host " E2E smoke: PASS (placeholder - see ROADMAP P7 D4)"
    Write-Host "============================================================"
    exit 0
} else {
    Write-Host " E2E smoke: FAIL"
    foreach ($f in $failures) { Write-Host "   - $f" }
    Write-Host "============================================================"
    exit 1
}
