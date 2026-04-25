#!/usr/bin/env bash
# generate-dev-certs.sh — Generate a CA + server + client cert for Signalman mTLS.
#
# This is the v0.1.0 development helper. It defaults to ECDSA P-256
# (preferred), with an --rsa fallback for environments where ECDSA is not
# yet wired through the toolchain. v0.2.0+ should standardize on ECDSA P-256.
#
# Outputs (under --out-dir, default ./certs/dev/):
#   ca.pem, ca.key
#   server.pem, server.key
#   client.pem, client.key
#
# The set of SubjectAltName entries is configurable. By default it covers
# `localhost`, `127.0.0.1`, and the static `172.30.0.10` Hyper-V test
# target documented in the roadmap; extend with `--san <DNS-or-IP>` (may
# be repeated).
#
# Requirements: openssl >= 1.1.1.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --out-dir <DIR>        Output directory (default: ./certs/dev)
  --san <NAME>           Add a SubjectAltName (DNS or IP). May be repeated.
  --days <N>             Validity in days (default: 365)
  --rsa                  Use RSA 2048 instead of ECDSA P-256
  --server-cn <CN>       Server certificate Common Name (default: signalman-guest)
  --client-cn <CN>       Client certificate Common Name (default: signalman-host)
  -h, --help             Show this help

Default SANs: localhost, 127.0.0.1, ::1, 172.30.0.10
USAGE
}

OUT_DIR="./certs/dev"
DAYS=365
USE_RSA=0
SERVER_CN="signalman-guest"
CLIENT_CN="signalman-host"
EXTRA_SANS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2;;
    --san) EXTRA_SANS+=("$2"); shift 2;;
    --days) DAYS="$2"; shift 2;;
    --rsa) USE_RSA=1; shift;;
    --server-cn) SERVER_CN="$2"; shift 2;;
    --client-cn) CLIENT_CN="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "unknown option: $1" >&2; usage; exit 2;;
  esac
done

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# Build the SAN block. Default list covers the Hyper-V loopback test
# target plus localhost; users add more via --san.
declare -a SANS=("DNS:localhost" "IP:127.0.0.1" "IP:::1" "IP:172.30.0.10")
for s in "${EXTRA_SANS[@]:-}"; do
  # Crude DNS-vs-IP detection: anything containing only digits + dots/colons
  # is treated as an IP. Good enough for dev cert tooling.
  if [[ "$s" =~ ^[0-9A-Fa-f.:]+$ && "$s" =~ [.:] ]]; then
    SANS+=("IP:$s")
  else
    SANS+=("DNS:$s")
  fi
done
SAN_LIST=$(IFS=, ; echo "${SANS[*]}")

KEY_GEN_CMD() {
  # Stdout: openssl args to emit a fresh private key for the chosen alg.
  if [[ "$USE_RSA" -eq 1 ]]; then
    echo "genrsa -out"
  else
    echo "ecparam -name prime256v1 -genkey -noout -out"
  fi
}

new_key() {
  local out="$1"
  if [[ "$USE_RSA" -eq 1 ]]; then
    openssl genrsa -out "$out" 2048 2>/dev/null
  else
    openssl ecparam -name prime256v1 -genkey -noout -out "$out"
  fi
}

echo "=== Signalman dev certificate generation ==="
echo "Output: $(pwd)"
if [[ "$USE_RSA" -eq 1 ]]; then
  echo "Algorithm: RSA 2048"
else
  echo "Algorithm: ECDSA P-256"
fi
echo "SAN: $SAN_LIST"
echo

# --- CA ------------------------------------------------------------
echo "[1/3] CA"
new_key ca.key
openssl req -x509 -new -key ca.key -days "$DAYS" \
  -out ca.pem \
  -subj "/CN=Signalman Dev CA/O=Signalman Contributors"

write_ext() {
  local file="$1"; local eku="$2"
  cat > "$file" <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = $eku
subjectAltName = $SAN_LIST
EOF
}

# --- Server --------------------------------------------------------
echo "[2/3] Server cert ($SERVER_CN)"
new_key server.key
openssl req -new -key server.key -out server.csr \
  -subj "/CN=$SERVER_CN/O=Signalman Contributors"
write_ext server.ext serverAuth
openssl x509 -req -in server.csr \
  -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.pem -days "$DAYS" \
  -extfile server.ext

# --- Client --------------------------------------------------------
echo "[3/3] Client cert ($CLIENT_CN)"
new_key client.key
openssl req -new -key client.key -out client.csr \
  -subj "/CN=$CLIENT_CN/O=Signalman Contributors"
write_ext client.ext clientAuth
openssl x509 -req -in client.csr \
  -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out client.pem -days "$DAYS" \
  -extfile client.ext

# Cleanup intermediate files.
rm -f server.csr client.csr server.ext client.ext ca.srl

echo
echo "=== Done ==="
ls -la ca.pem ca.key server.pem server.key client.pem client.key
echo
openssl verify -CAfile ca.pem server.pem
openssl verify -CAfile ca.pem client.pem
