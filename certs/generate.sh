#!/usr/bin/env bash
# generate.sh - Generate mTLS certificates for Signalman
#
# Outputs:
#   ca.pem      - Self-signed CA certificate
#   ca.key      - CA private key (keep safe)
#   host.pem    - Host server certificate signed by CA
#   host.key    - Host server private key
#   guest.pem   - Guest agent certificate signed by CA
#   guest.key   - Guest agent private key

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DAYS=365
KEY_BITS=2048

echo "=== Signalman mTLS Certificate Generation ==="
echo ""

# --- CA ---
echo "[1/3] Generating CA certificate..."
openssl req -x509 -newkey "rsa:${KEY_BITS}" -nodes \
  -keyout ca.key -out ca.pem \
  -days "$DAYS" \
  -subj "/CN=Signalman CA/O=Example Contributors"

# --- Host (server) ---
echo "[2/3] Generating host server certificate..."
cat > host.ext <<EOF
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
EOF

openssl req -newkey "rsa:${KEY_BITS}" -nodes \
  -keyout host.key -out host.csr \
  -config host.ext

openssl x509 -req -in host.csr \
  -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out host.pem -days "$DAYS" \
  -extensions v3_req -extfile host.ext

# --- Guest (client) ---
echo "[3/3] Generating guest agent certificate..."
cat > guest.ext <<EOF
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
EOF

openssl req -newkey "rsa:${KEY_BITS}" -nodes \
  -keyout guest.key -out guest.csr \
  -config guest.ext

openssl x509 -req -in guest.csr \
  -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out guest.pem -days "$DAYS" \
  -extensions v3_req -extfile guest.ext

# --- Cleanup ---
rm -f host.csr guest.csr host.ext guest.ext ca.srl

echo ""
echo "=== Done ==="
echo "Files generated:"
ls -la ca.pem ca.key host.pem host.key guest.pem guest.key
echo ""
echo "Verify chain:"
openssl verify -CAfile ca.pem host.pem
openssl verify -CAfile ca.pem guest.pem
