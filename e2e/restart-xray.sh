#!/bin/sh
pkill -x xray || true
sleep 0.3
setsid xray run -config /usr/local/etc/xray/config.json >/var/log/xray.log 2>&1 &
