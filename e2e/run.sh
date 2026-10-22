#!/usr/bin/env bash
# End-to-end proof: control plane + two nodes from two operators, real Xray, real agent, real probe.
# A user connects through entry A; Xray's own counters, sampled before and after, show the traffic left
# through exit B and that exit B never saw the user's key. Then the other way round.
# Nodes only see opaque client tags; the control plane's admin API translates them for the test.
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
# counters per node, with tags translated to k<id> (user device), h<id> (hop from entry <id>), probe
stats() { docker exec "vl-node-$1" python3 /e2e/stats.py | python3 -c "
import json,sys; t=json.loads(sys.argv[1]); out={}
for k,v in json.load(sys.stdin).items(): n=t.get(k,k); out[n]=out.get(n,0)+v
print(json.dumps(out))" "$(T tags)"; }
# bytes that appeared between two snapshots: prefix filter (k = user devices, h<id> = one hop)
grew() { python3 -c "
import json,sys; a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2]); p=sys.argv[3]
print(sum(v-a.get(k,0) for k,v in b.items() if (k==p if p[0]=='h' else k.startswith(p))))" "$1" "$2" "$3"; }

step "build image (xray $(sed -n 's/^ARG XRAY_VERSION=//p' e2e/Dockerfile))"
docker build -q -t $IMG e2e >/dev/null
docker network create $NET >/dev/null

step "start control plane"
docker run -d --name vl-control --network $NET -v "$PWD/app:/app:ro" \
  -e DATA_DIR=/tmp/data -e DEV_FREE=1 -e PROBE_KEY=e2e -e ADMIN_KEY=e2e -e PUBLIC_URL=http://vl-control:8790 $IMG node /app/server.js >/dev/null
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
  local e0 x0 e1 x1; e0=$(stats "$entry"); x0=$(stats "$exit")
  T connect "$eid"
  sleep 4 # xray adds a connection's bytes when it closes
  e1=$(stats "$entry"); x1=$(stats "$exit")
  local user_on_entry hop_on_exit user_on_exit
  user_on_entry=$(grew "$e0" "$e1" k); hop_on_exit=$(grew "$x0" "$x1" "h$eid"); user_on_exit=$(grew "$x0" "$x1" k)
  echo "  entry $entry counters: $e1"
  echo "  exit  $exit counters: $x1"
  [ "$user_on_entry" -gt 0 ] || { echo "✗ entry $entry saw no user traffic"; exit 1; }
  ok "entry $entry carried the user's traffic (+$user_on_entry bytes)"
  # the user's bytes must show up on the exit under the entry's hop key, not just a trickle
  [ $((hop_on_exit * 10)) -ge $((user_on_entry * 9)) ] || { echo "✗ exit $exit got $hop_on_exit of $user_on_entry bytes from entry $entry"; exit 1; }
  ok "exit $exit received it under entry $entry's hop key (+$hop_on_exit bytes)"
  [ "$user_on_exit" = 0 ] || { echo "✗ exit $exit saw the user's key"; exit 1; }
  ok "exit $exit never saw the user's key — it only knows entry $entry"
}

step "nodes can't tell checkers from users"
cfg=$(docker exec vl-node-a cat /usr/local/etc/xray/config.json)
if echo "$cfg" | grep -qiE '"email": *"(probe|k[0-9]+|h[0-9]+)"'; then echo "✗ node config has readable client labels"; exit 1; fi
ok "node config only has opaque client tags"

check_chain a "$ID_A" b
check_chain b "$ID_B" a

step "PASS: two-hop chain works both ways, no single node sees user + destination"
