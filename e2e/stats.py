# Prints this node's per-user xray traffic counters as {"k3": bytes, "h1": bytes, ...}. Does not reset them.
import json, subprocess
out = subprocess.run(['xray', 'api', 'statsquery', '--server=127.0.0.1:10085', '-pattern', 'user>>>'], capture_output=True, text=True).stdout
per = {}
for s in json.loads(out or '{}').get('stat', []):
    _, user, _, _ = s['name'].split('>>>')
    per[user] = per.get(user, 0) + int(s.get('value', 0))
print(json.dumps(per))
