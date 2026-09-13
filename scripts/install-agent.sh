#!/bin/sh
# Ionnet GSM agent installer. Served by the server at /install.sh.
#
#   curl -fsSL https://gsm.example.com/install.sh | sudo sh -s -- --server https://gsm.example.com --token <enrollment token>
#
# Options:
#   --server URL       GSM server base URL (required)
#   --token TOKEN      Enrollment token from Settings → Enrollment (required)
#   --name NAME        Display name (default: hostname)
#   --data-dir DIR     Where instance data lives (default: /var/lib/gsm)
#   --insecure         Skip TLS verification (development only)
#   --version VER      Agent version to download (default: latest)
set -eu

SERVER=""; TOKEN=""; NAME=""; DATA_DIR="/var/lib/gsm"; INSECURE=""; VERSION="latest"
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --insecure) INSECURE="1"; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || { echo "usage: install-agent.sh --server URL --token TOKEN [--name NAME] [--data-dir DIR]" >&2; exit 2; }
[ "$(id -u)" = "0" ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
if ! command -v docker >/dev/null; then
  echo "docker is required: install Docker Engine first (https://docs.docker.com/engine/install/)" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker is installed but not running or not reachable; start it with: systemctl enable --now docker" >&2
  exit 1
fi

SERVER="${SERVER%/}"
ARCH="$(uname -m)"
case "$ARCH" in x86_64|aarch64) ;; *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; esac
CURL="curl -fsSL"; [ -n "$INSECURE" ] && CURL="$CURL -k"

BIN=/usr/local/bin/gsm-agent
TMP="$(mktemp)"
echo "→ downloading gsm-agent ($VERSION, $ARCH) from $SERVER"
$CURL -o "$TMP" "$SERVER/downloads/gsm-agent/$VERSION/$ARCH"
if SUM="$($CURL "$SERVER/downloads/gsm-agent/$VERSION/$ARCH.sha256" 2>/dev/null)"; then
  echo "$SUM  $TMP" | sha256sum -c --quiet - || { echo "checksum mismatch" >&2; rm -f "$TMP"; exit 1; }
fi
install -m 0755 "$TMP" "$BIN"; rm -f "$TMP"

mkdir -p /etc/gsm-agent /var/lib/gsm-agent
chmod 0700 /var/lib/gsm-agent
mkdir -p "$DATA_DIR/instances" "$DATA_DIR/logs" "$DATA_DIR/backups" "$DATA_DIR/state"
chmod 0755 "$DATA_DIR" "$DATA_DIR/instances" "$DATA_DIR/logs" "$DATA_DIR/backups"
chmod 0700 "$DATA_DIR/state"

echo "→ enrolling with $SERVER"
set -- enroll -server "$SERVER" -token "$TOKEN" -data-dir "$DATA_DIR"
[ -n "$NAME" ] && set -- "$@" -name "$NAME"
[ -n "$INSECURE" ] && set -- "$@" -insecure
"$BIN" "$@"

echo "→ installing systemd unit"
$CURL -o /etc/systemd/system/gsm-agent.service "$SERVER/downloads/gsm-agent.service"
systemctl daemon-reload
systemctl enable --now gsm-agent.service
sleep 1
systemctl --no-pager --lines=3 status gsm-agent.service || true
echo "✓ gsm-agent installed and running"
