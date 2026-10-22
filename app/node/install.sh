#!/usr/bin/env bash
# Vlana node installer: xray (REALITY) + agent. Debian/Ubuntu/RHEL.
# usage: curl -fsSL https://go.vlana.app/install.sh | sudo bash -s <enroll-token>
#        PORT=8443 SNI=www.example.com ... to override defaults
#        VLANA_SERVER=https://your.deployment for a self-hosted control plane
set -euo pipefail
SERVER="${VLANA_SERVER:-https://go.vlana.app}"
TOKEN="${1:-}"
PORT="${PORT:-443}"
SNI="${SNI:-dl.google.com}"

[ -n "$TOKEN" ] || { echo "usage: curl -fsSL $SERVER/install.sh | sudo bash -s <token>"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

echo "→ packages"
if command -v apt-get >/dev/null; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3 openssl unzip >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q curl python3 openssl unzip
elif command -v yum >/dev/null; then
  yum install -y -q curl python3 openssl unzip
fi

if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN && ! systemctl is-active -q xray; then
  echo "port $PORT is busy. free it or rerun with PORT=<other>"; exit 1
fi

echo "→ xray"
# the official script skips everything, the service included, when an xray binary is already present
FORCE=""; systemctl cat xray >/dev/null 2>&1 || FORCE="--force"
bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install $FORCE >/dev/null
systemctl cat xray >/dev/null 2>&1 || { echo "xray service was not installed. see https://github.com/XTLS/Xray-install"; exit 1; }

echo "→ agent"
mkdir -p /opt/vlana /etc/vlana
chmod 700 /etc/vlana
curl -fsSL "$SERVER/agent.py" -o /opt/vlana/agent.py

if [ ! -f /etc/vlana/node.json ] || ! grep -q node_id /etc/vlana/node.json; then
  KEYS="$(/usr/local/bin/xray x25519)"
  PRIV="$(echo "$KEYS" | awk -F': ' '/^Private/{print $2}')"
  PUB="$(echo "$KEYS" | awk -F': ' '/Public/{print $2}')"
  SID="$(openssl rand -hex 8)"
  python3 - "$SERVER" "$TOKEN" "$PRIV" "$PUB" "$SID" "$PORT" "$SNI" <<'PY'
import json, sys
s, t, priv, pub, sid, port, sni = sys.argv[1:]
json.dump({"server": s, "enroll": t, "private_key": priv, "public_key": pub,
           "short_id": sid, "port": int(port), "sni": sni}, open('/etc/vlana/node.json', 'w'), indent=1)
PY
  chmod 600 /etc/vlana/node.json
fi

cat >/etc/systemd/system/vlana-agent.service <<EOF
[Unit]
Description=Vlana node agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/vlana/agent.py
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT"/tcp >/dev/null; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-port="$PORT"/tcp && firewall-cmd -q --reload
fi

systemctl daemon-reload
systemctl enable -q xray
systemctl enable -q --now vlana-agent
systemctl restart vlana-agent

echo
echo "✓ node installed. it goes live after the first successful probe (a few minutes)."
echo "  logs: journalctl -u vlana-agent -f"
