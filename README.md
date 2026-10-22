# Vlana

[![e2e](../../actions/workflows/e2e.yml/badge.svg)](../../actions/workflows/e2e.yml)

**VPN without an account. Your wallet is the login.**

- **No identity.** No email, no card, no password. Sign in with a Solana wallet, hold `$VLANA`.
- **Invisible.** VLESS + REALITY: traffic looks like a normal HTTPS visit to a big site.
- **Earn.** Anyone can run a node and get paid in SOL from pump.fun creator fees, every hour it stays up.

## Two hops, two operators

```
 you ──▶ entry (operator A) ──▶ exit (operator B) ──▶ site
         sees you,              sees the site,
         not the site           not you
```

Every connection runs through two nodes owned by different wallets. The entry knows your IP but not where you go. The exit knows where traffic goes but not who sent it. No single operator can tie you to what you do.

## Proof it works

`e2e/run.sh` builds the whole network in Docker and pushes real traffic through it. It runs on every push and once a day, see the badge above.

1. A control plane starts. Two operators and one user sign in with fresh ed25519 wallets, the same way a browser wallet does.
2. Each operator enrolls a node. Each node generates its own REALITY keys, starts real **Xray** and the real **agent.py**, and registers.
3. The real **probe** checks both nodes through VLESS+REALITY tunnels and marks them active.
4. The user takes their subscription link, connects to entry A with Xray and loads pages.
5. Xray's own counters are read on both nodes:
   - entry A carried the user's key,
   - exit B received the traffic under entry A's hop key,
   - exit B **never saw the user's key**.
6. Same again through entry B → exit A.

```
▸ user connects via entry a
  entry a counters: {"k1": 44298}
  exit  b counters: {"h1": 37428}
  ✓ entry a carried the user's traffic
  ✓ exit b received it under entry a's hop key
  ✓ exit b never saw the user's key — it only knows entry a
▸ user connects via entry b
  ✓ entry b carried the user's traffic
  ✓ exit a received it under entry b's hop key
▸ PASS: two-hop chain works both ways, no single node sees user + destination
```

Run it yourself (needs Docker and internet):

```sh
e2e/run.sh
```

## Payouts

The network runs in one-hour rounds. When a round closes:

1. Fees that landed in the treasury during the round become its pool. The operators' share (60% by default) is split.
2. A node makes the cut if it passed **95%** of at least **6** checks in that hour. Weight = rarity (1/√ good nodes in its country) × 1.5 for home lines. Max 3 paid nodes per wallet, one per /24.
3. The server signs one Solana transaction with a transfer to every operator and sends it. Amounts under 0.001 SOL carry over to the next payout. If nobody makes the cut, the pool rolls into the next round.

Checkers' and buyback shares stay in the treasury. Without `PAYER_KEY` the server runs the same math and keeps balances owed; you add fees with `POST /api/admin/inflow` and record transfers with `POST /api/admin/payouts`.

## Layout

| path | what |
|---|---|
| `app/server.js` | Control plane. Zero dependencies: `node:http` + `node:sqlite`. Wallet login, devices, subscriptions, node enrollment, scoring, payouts. |
| `app/public/index.html` | The app: connect, devices, nodes, docs. |
| `app/node/install.sh` | One-line node installer: Xray + agent as systemd services. |
| `app/node/agent.py` | Node agent, Python stdlib only. Pulls Xray config, reports traffic. The REALITY private key never leaves the node. |
| `app/probe/probe.js` | Checker. Tests every node through a real tunnel, reports uptime, latency, speed. |
| `e2e/` | The end-to-end test above. |

## Run the control plane

Node.js 22.5+.

```sh
cd app
MINT=<token mint> PUBLIC_URL=https://vlana.app ADMIN_KEY=... PROBE_KEY=... node server.js
```

| env | default | |
|---|---|---|
| `PORT` | `8790` | |
| `PUBLIC_URL` | `http://localhost:$PORT` | used in install commands and subscription links |
| `DATA_DIR` | `app/data` | SQLite database and secrets |
| `MINT` | | `$VLANA` mint address. Balances are read from `RPC_URL`. |
| `RPC_URL` | mainnet-beta | Solana RPC |
| `DEV_FREE` | | `1` with no `MINT`: everyone gets a dev plan |
| `TIERS` | 4 plans | JSON, see `server.js` |
| `SPLIT` | `60/20/20` | each round's fees: operators, checkers, buyback |
| `PAYER_KEY` | | base58 secret key of the treasury wallet that collects creator fees. Set it and payouts are automatic. |
| `BUYBACK_WALLET` | | cold wallet the checkers + buyback shares are swept to. Shown on the Payouts page next to the treasury. |
| `ROUND_MIN` | `60` | round length, minutes |
| `GOOD_UPTIME` | `0.95` | share of passed checks a node needs in a round |
| `MIN_CHECKS` | `6` | checks a node needs in a round to count |
| `MIN_PAYOUT` | `0.001` | SOL; smaller amounts wait for the next payout |
| `ADMIN_KEY` / `PROBE_KEY` | | auth for admin and probe endpoints |
| `MAX_NODES_PER_OPERATOR` | `3` | paid nodes per wallet |
| `DEFAULT_SNI` | `dl.google.com` | site REALITY imitates |
| `TRUST_PROXY` | | `1` behind nginx / Cloudflare |
| `REPO_URL` | | link shown in the app |

## Deploy

Everything runs on one domain: **https://vlana.app** — the app, docs, subscriptions, node installer and API. Ubuntu, Node.js 22.13+, nginx, certbot:

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin vlana
mkdir -p /var/lib/vlana /var/www/vlana-acme && chown vlana:vlana /var/lib/vlana
rsync -a app/ server:/opt/vlana/
cp deploy/vlana.env.example /etc/vlana.env            # fill ADMIN_KEY, PROBE_KEY, later MINT and PAYER_KEY
cp deploy/vlana.service deploy/vlana-probe.service /etc/systemd/system/
echo "PROBE_KEY=<same as in vlana.env>" > /etc/vlana-probe.env
systemctl enable --now vlana vlana-probe
cp deploy/vlana.app.nginx /etc/nginx/sites-available/vlana.app && ln -s ../sites-available/vlana.app /etc/nginx/sites-enabled/
certbot certonly --webroot -w /var/www/vlana-acme -d vlana.app && systemctl reload nginx
```

The checker needs `xray` in `/usr/local/bin` and its geo files in `/usr/local/share/xray`. DNS: one A record, `vlana.app` → the server.

## Run a node

Sign in to the app, open **Nodes**, press **Add a node** and run the command it gives you on a fresh Ubuntu/Debian server:

```sh
curl -fsSL https://vlana.app/install.sh | sudo bash -s <token>
```

Options: `PORT=8443`, `SNI=www.microsoft.com` before `bash`. Logs: `journalctl -u vlana-agent -f`.

## Run a checker

```sh
SERVER=https://vlana.app PROBE_KEY=... PROBE_ID=fra-1 node app/probe/probe.js
```

Needs `xray` and `curl` in `PATH`. Run several from different networks.

## License

MIT
