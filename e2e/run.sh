#!/usr/bin/env bash
# End-to-end proof: control plane + two nodes from two operators, real Xray, real agent, real probe.
# A user connects through entry A; we read Xray's own counters to show the traffic left through exit B
# and that exit B never saw the user's key. Then the other way round.
# Needs docker and internet. Usage: e2e/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NET=vl-e2e IMG=vlana-e2e
C="vl-control vl-node-a vl-node-b vl-tester"
cleanup() {
  if [ "${1:-}" = fail ]; then for c in $C; do echo "── logs: $c"; docker logs --tail 40 "$c" 2>&1 || true; done; fi
  docker rm -f $C >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
}
trap 'cleanup fail' ERR
trap cleanup EXIT
cleanup

step() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
T() { docker exec vl-tester node /repo/e2e/test.js "$@"; }
stats() { docker exec "vl-node-$1" python3 /e2e/stats.py; }
get() { python3 -c "import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2],0))" "$1" "$2"; }
keys() { python3 -c "import json,sys; print(sum(v for k,v in json.loads(sys.argv[1]).items() if k.startswith('k')))" "$1"; }

step "build image (xray $(sed -n 's/^ARG XRAY_VERSION=//p' e2e/Dockerfile))"
docker build -q -t $IMG e2e >/dev/null
docker network create $NET >/dev/null

step "start control plane"
docker run -d --name vl-control --network $NET -v "$PWD/app:/app:ro" \
  -e DATA_DIR=/tmp/data -e DEV_FREE=1 -e PROBE_KEY=e2e -e PUBLIC_URL=http://vl-control:8790 $IMG node /app/server.js >/dev/null
docker run -d --name vl-tester --network $NET -v "$PWD:/repo:ro" $IMG sleep infinity >/dev/null

step "two operators enroll a node each, a user adds a device"
read -r TOK_A TOK_B < <(T setup)
ok "enroll tokens issued"

step "nodes install themselves (xray + agent.py)"
docker run -d --name vl-node-a --network $NET -v "$PWD/app/node:/opt/vlana:ro" -v "$PWD/e2e:/e2e:ro" \
  -e SERVER=http://vl-control:8790 -e ENROLL="$TOK_A" $IMG /e2e/node.sh >/dev/null
docker run -d --name vl-node-b --network $NET -v "$PWD/app/node:/opt/vlana:ro" -v "$PWD/e2e:/e2e:ro" \
  -e SERVER=http://vl-control:8790 -e ENROLL="$TOK_B" $IMG /e2e/node.sh >/dev/null

step "checker probes both nodes through real VLESS+REALITY tunnels"
read -r ID_A ID_B < <(T live)
ok "node A = #$ID_A, node B = #$ID_B, both active"

check_chain() { # entry-letter entry-id exit-letter
  local entry=$1 eid=$2 exit=$3
  step "user connects via entry $entry"
  T connect "$eid"
  local se sx; se=$(stats "$entry"); sx=$(stats "$exit")
  local user_on_entry hop_on_exit user_on_exit
  user_on_entry=$(keys "$se"); hop_on_exit=$(get "$sx" "h$eid"); user_on_exit=$(keys "$sx")
  echo "  entry $entry counters: $se"
  echo "  exit  $exit counters: $sx"
  [ "$user_on_entry" -gt 0 ] || { echo "✗ entry $entry saw no user traffic"; exit 1; }
  ok "entry $entry carried the user's traffic ($user_on_entry bytes)"
  # only user traffic is routed entry→exit under the entry's hop key (probes go direct), so any bytes here
  # prove the chain. Xray undercounts on the exit: Vision splices the last leg in the kernel.
  [ "$hop_on_exit" -gt 0 ] || { echo "✗ exit $exit got no traffic from entry $entry"; exit 1; }
  ok "exit $exit received it under entry $entry's hop key"
}

check_chain a "$ID_A" b
[ "$(keys "$(stats b)")" = 0 ] || { echo "✗ exit b saw the user's key"; exit 1; }
ok "exit b never saw the user's key — it only knows entry a"
check_chain b "$ID_B" a

step "PASS: two-hop chain works both ways, no single node sees user + destination"
