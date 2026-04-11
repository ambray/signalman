# generate.ps1 - Generate mTLS certificates for Signalman (Windows)
#
# Requires: openssl.exe on PATH (ships with Git for Windows, or install via winget/choco)
#
# Outputs:
#   ca.pem      - Self-signed CA certificate
#   ca.key      - CA private key (keep safe)
#   host.pem    - Host server certificate signed by CA
#   host.key    - Host server private key
#   guest.pem   - Guest agent certificate signed by CA
#   guest.key   - Guest agent private key

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ScriptDir

$Days = 365
$KeyBits = 2048

Write-Host "=== Signalman mTLS Certificate Generation ===" -ForegroundColor Cyan
Write-Host ""

# Locate openssl
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
    # Try Git for Windows bundled openssl
    $gitOpenssl = "C:\Program Files\Git\usr\bin\openssl.exe"
    if (Test-Path $gitOpenssl) {
        $env:PATH = "C:\Program Files\Git\usr\bin;$env:PATH"
    } else {
        Write-Error "openssl.exe not found. Install Git for Windows or add openssl to PATH."
        exit 1
    }
}

# --- CA ---
Write-Host "[1/3] Generating CA certificate..." -ForegroundColor Yellow
openssl req -x509 -newkey "rsa:$KeyBits" -nodes `
    -keyout ca.key -out ca.pem `
    -days $Days `
    -subj "/CN=Signalman CA/O=Example Contributors"

# --- Host (server) ---
Write-Host "[2/3] Generating host server certificate..." -ForegroundColor Yellow

$hostExt = @"
[req]
distinguished_name = req_dn
req_extensions = v3_req
prompt = no

[req_dn]
CN = signalman-host
O  = Example Contributors

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = signalman-host
IP.1  = 127.0.0.1
IP.2  = ::1
IP.3  = 172.30.0.1
IP.4  = 172.30.0.2
IP.5  = 172.30.0.3
IP.6  = 172.30.0.4
IP.7  = 172.30.0.5
IP.8  = 172.30.0.10
"@
$hostExt | Set-Content -Path host.ext -Encoding ASCII

openssl req -newkey "rsa:$KeyBits" -nodes `
    -keyout host.key -out host.csr `
    -config host.ext

openssl x509 -req -in host.csr `
    -CA ca.pem -CAkey ca.key -CAcreateserial `
    -out host.pem -days $Days `
    -extensions v3_req -extfile host.ext

# --- Guest (client) ---
Write-Host "[3/3] Generating guest agent certificate..." -ForegroundColor Yellow

$guestExt = @"
[req]
distinguished_name = req_dn
req_extensions = v3_req
prompt = no

[req_dn]
CN = signalman-guest
O  = Example Contributors

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = signalman-guest
IP.1  = 127.0.0.1
IP.2  = ::1
IP.3  = 172.30.0.10
IP.4  = 172.30.0.11
IP.5  = 172.30.0.12
IP.6  = 172.30.0.13
IP.7  = 172.30.0.14
IP.8  = 172.30.0.15
"@
$guestExt | Set-Content -Path guest.ext -Encoding ASCII

openssl req -newkey "rsa:$KeyBits" -nodes `
    -keyout guest.key -out guest.csr `
    -config guest.ext

openssl x509 -req -in guest.csr `
    -CA ca.pem -CAkey ca.key -CAcreateserial `
    -out guest.pem -days $Days `
    -extensions v3_req -extfile guest.ext

# --- Cleanup ---
Remove-Item -Force -ErrorAction SilentlyContinue host.csr, guest.csr, host.ext, guest.ext, ca.srl

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Files generated:"
Get-ChildItem ca.pem, ca.key, host.pem, host.key, guest.pem, guest.key | Format-Table Name, Length

Write-Host "Verify chain:"
openssl verify -CAfile ca.pem host.pem
openssl verify -CAfile ca.pem guest.pem

Pop-Location
