#!/bin/sh
# Node container: does what install.sh does, minus systemd. Real xray, real agent.py.
set -eu
mkdir -p /etc/vlana /usr/local/etc/xray
KEYS="$(xray x25519)"
PRIV="$(echo "$KEYS" | awk -F': ' '/^Private/{print $2}')"
PUB="$(echo "$KEYS" | awk -F': ' '/Public/{print $2}')"
SID="$(openssl rand -hex 8)"
cat >/etc/vlana/node.json <<J
{"server":"$SERVER","enroll":"$ENROLL","private_key":"$PRIV","public_key":"$PUB","short_id":"$SID","port":443,"sni":"dl.google.com"}
J
export XRAY_RESTART=/e2e/restart-xray.sh CONFIG_EVERY=5 STATS_EVERY=100000
exec python3 /opt/vlana/agent.py
