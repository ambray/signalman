# Release dry-run (P6).
#
# Reproduces the .github/workflows/release.yaml build + packaging
# pipeline LOCALLY without invoking signtool, npm publish, or
# `cargo publish`. Use this before pushing a release tag to catch
# version-mismatch / packaging / WiX-template issues with a fast
# feedback loop instead of waiting on CI.
#
# What this script does:
#   1. Verifies host/package.json + guest/Cargo.toml + Cargo.toml
#      versions are aligned with each other (so a tag matches all of
#      them; release.yaml fails the build otherwise).
#   2. Builds the host (`npm run build`) and runs vitest.
#   3. Builds the guest (`cargo build --release`) and runs cargo test.
#   4. Builds the service in release mode.
#   5. Builds the service MSI via cargo-wix (skips signing; that needs
#      a cert).
#   6. Builds the guest MSI via cargo-wix (skips signing; that needs a
#      cert).
#   7. Runs `cargo publish --dry-run` for the guest crate.
#   8. Runs `npm pack` (no publish) for the host package.
#
# What this script does NOT do:
#   - signtool sign       (needs WINDOWS_CERT_BASE64)
#   - npm publish         (needs NPM_TOKEN)
#   - cargo publish       (needs CARGO_REGISTRY_TOKEN)
#   - GitHub Release      (the tag-trigger does this)
#
# Exit codes:
#   0  all checks passed; release.yaml will succeed for this ref
#   1  some check failed; fix before tagging
#
# This is the local twin of the CI pipeline; if a step fails here it
# will fail in CI too, so save yourself the round-trip.

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host " Signalman release dry-run (P6)"
Write-Host "------------------------------------------------------------"
Write-Host " Run this BEFORE pushing a release tag. Skips the publish"
Write-Host " steps (no token / no cert needed) but reproduces every"
Write-Host " build + packaging step .github/workflows/release.yaml runs."
Write-Host "============================================================"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$failures = @()

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    Write-Host ""
    Write-Host "[release] $Name ..."
    try {
        & $Body
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
            throw "non-zero exit code: $LASTEXITCODE"
        }
        Write-Host "[release] $Name : ok"
    } catch {
        Write-Host "[release] $Name : FAIL - $_"
        $script:failures += $Name
    }
}

# Step 1: version alignment
Invoke-Step "version alignment (host + guest + workspace)" {
    $hostVersion = (Get-Content host/package.json -Raw | ConvertFrom-Json).version
    $guestVersion = (Select-String -Path guest/Cargo.toml -Pattern '^version\s*=\s*"(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    $workspaceVersion = (Select-String -Path Cargo.toml -Pattern '^version\s*=\s*"(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value

    Write-Host "  host/package.json: $hostVersion"
    Write-Host "  guest/Cargo.toml:  $guestVersion"
    Write-Host "  Cargo.toml (ws):   $workspaceVersion"

    if ($hostVersion -ne $guestVersion -or $hostVersion -ne $workspaceVersion) {
        throw "Versions out of sync. Bump all three to the same string before tagging."
    }
    Write-Host "  All three match: $hostVersion"
}

# Step 2: host build + test
Invoke-Step "host build + tests" {
    Push-Location host
    try {
        npm ci 2>$null
        if ($LASTEXITCODE -ne 0) { npm install }
        npm run build
        npx vitest run
    } finally { Pop-Location }
}

# Step 3: guest build + tests
Invoke-Step "guest build + tests" {
    Push-Location guest
    try {
        cargo build --release
        cargo test
    } finally { Pop-Location }
}

# Step 4: service build
Invoke-Step "service build" {
    cargo build -p signalman-service --release
}

# Step 5: service MSI build (skip signing)
Invoke-Step "service MSI build (cargo-wix, no signing)" {
    if (-not (Get-Command "cargo-wix" -ErrorAction SilentlyContinue)) {
        throw "cargo-wix is not installed. Install it explicitly first: cargo install cargo-wix --locked --version 0.3.9"
    }
    cargo wix --package signalman-service --no-build --nocapture
    $msi = Get-ChildItem target\wix\signalman-service*.msi | Select-Object -First 1
    if (-not $msi) {
        throw "Service MSI not produced under target/wix/"
    }
    Write-Host "  Service MSI: $($msi.FullName) ($([math]::Round($msi.Length / 1KB, 1)) KB)"
}

# Step 6: guest MSI build (skip signing)
Invoke-Step "guest MSI build (cargo-wix, no signing)" {
    if (-not (Get-Command "cargo-wix" -ErrorAction SilentlyContinue)) {
        throw "cargo-wix is not installed. Install it explicitly first: cargo install cargo-wix --locked --version 0.3.9"
    }
    cargo wix --package signalman-guest --no-build --nocapture
    $msi = Get-ChildItem target\wix\signalman-guest*.msi | Select-Object -First 1
    if (-not $msi) {
        throw "Guest MSI not produced under target/wix/"
    }
    Write-Host "  Guest MSI: $($msi.FullName) ($([math]::Round($msi.Length / 1KB, 1)) KB)"
}

# Step 7: cargo publish dry-run
Invoke-Step "cargo publish --dry-run (guest crate)" {
    Push-Location guest
    try {
        cargo publish --dry-run --allow-dirty
    } finally { Pop-Location }
}

# Step 8: npm pack (no publish)
Invoke-Step "npm pack (host package)" {
    Push-Location host
    try {
        # Clean stale tarballs first so the report below names a fresh one.
        Get-ChildItem *.tgz -ErrorAction SilentlyContinue | Remove-Item -Force
        npm pack
        $tgz = Get-ChildItem *.tgz | Select-Object -First 1
        if (-not $tgz) { throw "npm pack did not produce a tarball" }
        Write-Host "  Tarball: $($tgz.Name) ($([math]::Round($tgz.Length / 1KB, 1)) KB)"
    } finally { Pop-Location }
}

# Verdict
Write-Host ""
Write-Host "============================================================"
if ($failures.Count -eq 0) {
    Write-Host " Release dry-run: PASS"
    Write-Host ""
    Write-Host " Next: push a tag matching the manifest version."
    Write-Host "   git tag v0.1.0"
    Write-Host "   git push origin v0.1.0"
    Write-Host ""
    Write-Host " The Release workflow will pick it up. Make sure these"
    Write-Host " repo secrets are configured before relying on signing /"
    Write-Host " publishing:"
    Write-Host "   - WINDOWS_CERT_BASE64 + WINDOWS_CERT_PASSWORD"
    Write-Host "   - NPM_TOKEN"
    Write-Host "   - CARGO_REGISTRY_TOKEN"
    Write-Host "============================================================"
    exit 0
} else {
    Write-Host " Release dry-run: FAIL"
    foreach ($f in $failures) { Write-Host "   - $f" }
    Write-Host "============================================================"
    exit 1
}
