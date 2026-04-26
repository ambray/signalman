#!/usr/bin/env bash
# Install signalman-guest as a macOS LaunchDaemon inside a VM.
#
# This is the root/control-plane half of the macOS guest story. It runs the
# guest agent as root for command execution and file operations. UI automation
# should be installed separately as a per-user LaunchAgent once those RPCs land,
# because Accessibility and Screen Recording are TCC grants on the login session.

set -euo pipefail

LABEL="com.signalman.guest"
BINARY="./target/release/signalman-guest"
INSTALL_DIR="/usr/local/signalman"
STATE_DIR="/Library/Signalman"
WORKSPACE="/var/lib/signalman/workspace"
BIND="0.0.0.0:50051"
TOKEN="${SIGNALMAN_AUTH_TOKEN:-}"
TLS_CERT=""
TLS_KEY=""
TLS_CA=""
ALLOW_INSECURE=0
LOAD_NOW=1

usage() {
  cat <<USAGE
Usage: sudo $(basename "$0") [options]

Options:
  --binary <PATH>        signalman-guest binary to install
                         (default: ./target/release/signalman-guest)
  --install-dir <DIR>    Install directory (default: /usr/local/signalman)
  --state-dir <DIR>      Root-owned config/log directory (default: /Library/Signalman)
  --workspace <DIR>      Guest file-operation workspace jail
                         (default: /var/lib/signalman/workspace)
  --bind <ADDR:PORT>     gRPC bind address (default: 0.0.0.0:50051)
  --token <TOKEN>        Bearer token for host->guest RPC authentication
  --tls-cert <PATH>      Server certificate PEM
  --tls-key <PATH>       Server private key PEM
  --tls-ca <PATH>        Client CA PEM for mTLS
  --label <LABEL>        LaunchDaemon label (default: com.signalman.guest)
  --allow-insecure       Pass --allow-insecure; only accepted on loopback binds
  --no-load              Install files but do not bootstrap launchd
  -h, --help             Show this help

Example:
  sudo scripts/macos/install-guest-agent.sh \\
    --binary target/release/signalman-guest \\
    --workspace /var/lib/signalman/workspace \\
    --token "\$SIGNALMAN_AUTH_TOKEN" \\
    --tls-cert /Library/Signalman/certs/server.pem \\
    --tls-key /Library/Signalman/certs/server.key \\
    --tls-ca /Library/Signalman/certs/ca.pem
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) BINARY="$2"; shift 2;;
    --install-dir) INSTALL_DIR="$2"; shift 2;;
    --state-dir) STATE_DIR="$2"; shift 2;;
    --workspace) WORKSPACE="$2"; shift 2;;
    --bind) BIND="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --tls-cert) TLS_CERT="$2"; shift 2;;
    --tls-key) TLS_KEY="$2"; shift 2;;
    --tls-ca) TLS_CA="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --allow-insecure) ALLOW_INSECURE=1; shift;;
    --no-load) LOAD_NOW=0; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown option: $1" >&2; usage; exit 2;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install-guest-agent.sh must run as root" >&2
  exit 1
fi

if [[ ! -x "$BINARY" ]]; then
  echo "signalman-guest binary not found or not executable: $BINARY" >&2
  exit 1
fi

if [[ -z "$TOKEN" && "$ALLOW_INSECURE" -ne 1 ]]; then
  echo "missing --token or SIGNALMAN_AUTH_TOKEN; use --allow-insecure only for loopback development" >&2
  exit 1
fi

if [[ "$ALLOW_INSECURE" -eq 1 ]]; then
  case "$BIND" in
    127.0.0.1:*|localhost:*|"[::1]":*) ;;
    *)
      echo "--allow-insecure is only allowed with a loopback --bind" >&2
      exit 1
      ;;
  esac
fi

if [[ -n "$TLS_CERT" || -n "$TLS_KEY" || -n "$TLS_CA" ]]; then
  if [[ -z "$TLS_CERT" || -z "$TLS_KEY" ]]; then
    echo "--tls-cert and --tls-key must be provided together" >&2
    exit 1
  fi
fi

PLIST="/Library/LaunchDaemons/${LABEL}.plist"
RUNNER="${INSTALL_DIR}/run-guest-agent.sh"
ENV_FILE="${STATE_DIR}/guest.env"
LOG_DIR="${STATE_DIR}/logs"

install -d -o root -g wheel -m 0755 "$INSTALL_DIR" "$STATE_DIR" "$LOG_DIR"
install -d -o root -g wheel -m 0755 "$WORKSPACE"
install -o root -g wheel -m 0755 "$BINARY" "${INSTALL_DIR}/signalman-guest"

tmp_env="$(mktemp)"
{
  printf 'SIGNALMAN_BIND=%q\n' "$BIND"
  printf 'SIGNALMAN_WORKSPACE=%q\n' "$WORKSPACE"
  if [[ -n "$TOKEN" ]]; then
    printf 'SIGNALMAN_AUTH_TOKEN=%q\n' "$TOKEN"
  fi
  if [[ -n "$TLS_CERT" ]]; then
    printf 'SIGNALMAN_TLS_CERT=%q\n' "$TLS_CERT"
    printf 'SIGNALMAN_TLS_KEY=%q\n' "$TLS_KEY"
  fi
  if [[ -n "$TLS_CA" ]]; then
    printf 'SIGNALMAN_TLS_CA=%q\n' "$TLS_CA"
  fi
} > "$tmp_env"
install -o root -g wheel -m 0600 "$tmp_env" "$ENV_FILE"
rm -f "$tmp_env"

tmp_runner="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'set -a\n'
  printf 'source %q\n' "$ENV_FILE"
  printf 'set +a\n'
  if [[ "$ALLOW_INSECURE" -eq 1 ]]; then
    printf 'exec %q --allow-insecure\n' "${INSTALL_DIR}/signalman-guest"
  else
    printf 'exec %q\n' "${INSTALL_DIR}/signalman-guest"
  fi
} > "$tmp_runner"
install -o root -g wheel -m 0755 "$tmp_runner" "$RUNNER"
rm -f "$tmp_runner"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

tmp_plist="$(mktemp)"
cat > "$tmp_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$RUNNER")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$WORKSPACE")</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${LOG_DIR}/guest.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${LOG_DIR}/guest.err.log")</string>
</dict>
</plist>
PLIST
plutil -lint "$tmp_plist" >/dev/null
install -o root -g wheel -m 0644 "$tmp_plist" "$PLIST"
rm -f "$tmp_plist"

if [[ "$LOAD_NOW" -eq 1 ]]; then
  launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PLIST"
  launchctl enable "system/${LABEL}"
  launchctl kickstart -k "system/${LABEL}"
fi

echo "Installed ${LABEL}"
echo "Binary: ${INSTALL_DIR}/signalman-guest"
echo "Workspace: ${WORKSPACE}"
echo "Config: ${ENV_FILE}"
echo "Logs: ${LOG_DIR}"
