# generate-dev-certs.ps1 — Generate a CA + server + client cert for Signalman mTLS (Windows).
#
# Mirrors scripts/generate-dev-certs.sh. Defaults to ECDSA P-256 (preferred);
# pass -UseRsa for the RSA 2048 fallback. v0.2.0+ should standardize on
# ECDSA P-256.
#
# Outputs (under -OutDir, default .\certs\dev\):
#   ca.pem, ca.key
#   server.pem, server.key
#   client.pem, client.key
#
# Default SANs: localhost, 127.0.0.1, ::1, 172.30.0.10. Add more with -San.
#
# Requires openssl.exe on PATH (Git for Windows ships one at
# "C:\Program Files\Git\usr\bin\openssl.exe" which is auto-detected).

[CmdletBinding()]
param(
    [string]$OutDir = ".\certs\dev",
    [string[]]$San = @(),
    [int]$Days = 365,
    [switch]$UseRsa,
    [string]$ServerCN = "signalman-guest",
    [string]$ClientCN = "signalman-host"
)

$ErrorActionPreference = "Stop"

# Locate openssl.
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
    $gitOpenssl = "C:\Program Files\Git\usr\bin\openssl.exe"
    if (Test-Path $gitOpenssl) {
        $env:PATH = "C:\Program Files\Git\usr\bin;$env:PATH"
    } else {
        throw "openssl.exe not found. Install Git for Windows or add openssl to PATH."
    }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Push-Location $OutDir

try {
    # Build the SAN list. Defaults cover localhost + the Hyper-V test target.
    $sanEntries = @("DNS:localhost", "IP:127.0.0.1", "IP:::1", "IP:172.30.0.10")
    foreach ($s in $San) {
        if ($s -match '^[0-9A-Fa-f.:]+$' -and $s -match '[.:]') {
            $sanEntries += "IP:$s"
        } else {
            $sanEntries += "DNS:$s"
        }
    }
    $sanList = ($sanEntries -join ",")

    function New-Key([string]$Out) {
        if ($UseRsa) {
            openssl genrsa -out $Out 2048 2>$null | Out-Null
        } else {
            openssl ecparam -name prime256v1 -genkey -noout -out $Out
        }
    }

    function Write-Ext([string]$Path, [string]$Eku) {
        @"
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = $Eku
subjectAltName = $sanList
"@ | Set-Content -Path $Path -Encoding ASCII
    }

    Write-Host "=== Signalman dev certificate generation ===" -ForegroundColor Cyan
    Write-Host "Output: $(Get-Location)"
    if ($UseRsa) { Write-Host "Algorithm: RSA 2048" } else { Write-Host "Algorithm: ECDSA P-256" }
    Write-Host "SAN: $sanList"
    Write-Host ""

    # --- CA ---
    Write-Host "[1/3] CA" -ForegroundColor Yellow
    New-Key ca.key
    openssl req -x509 -new -key ca.key -days $Days `
        -out ca.pem `
        -subj "/CN=Signalman Dev CA/O=Signalman Contributors"

    # --- Server ---
    Write-Host "[2/3] Server cert ($ServerCN)" -ForegroundColor Yellow
    New-Key server.key
    openssl req -new -key server.key -out server.csr `
        -subj "/CN=$ServerCN/O=Signalman Contributors"
    Write-Ext server.ext serverAuth
    openssl x509 -req -in server.csr `
        -CA ca.pem -CAkey ca.key -CAcreateserial `
        -out server.pem -days $Days `
        -extfile server.ext

    # --- Client ---
    Write-Host "[3/3] Client cert ($ClientCN)" -ForegroundColor Yellow
    New-Key client.key
    openssl req -new -key client.key -out client.csr `
        -subj "/CN=$ClientCN/O=Signalman Contributors"
    Write-Ext client.ext clientAuth
    openssl x509 -req -in client.csr `
        -CA ca.pem -CAkey ca.key -CAcreateserial `
        -out client.pem -days $Days `
        -extfile client.ext

    Remove-Item -Force -ErrorAction SilentlyContinue server.csr, client.csr, server.ext, client.ext, ca.srl

    Write-Host ""
    Write-Host "=== Done ===" -ForegroundColor Green
    Get-ChildItem ca.pem, ca.key, server.pem, server.key, client.pem, client.key |
        Format-Table Name, Length

    openssl verify -CAfile ca.pem server.pem
    openssl verify -CAfile ca.pem client.pem
}
finally {
    Pop-Location
}
