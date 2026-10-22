// Vlana — control plane. Zero dependencies: node:http + node:sqlite (Node >= 22.5).
// Wallet login → device keys → subscriptions; node enrollment + agent config; probes → hourly rounds → SOL payouts.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8790;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PROBE_KEY = process.env.PROBE_KEY || '';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBLIC_RPC = process.env.PUBLIC_RPC || 'https://api.mainnet-beta.solana.com'; // handed to browsers that verify rounds; RPC_URL may carry a private key
const MINT = process.env.MINT || '';
const REPO_URL = process.env.REPO_URL || '';
const DEV_FREE = process.env.DEV_FREE === '1';           // no mint yet: everyone gets the dev tier
const TRUST_PROXY = process.env.TRUST_PROXY === '1';     // behind nginx/cloudflare
const DEFAULT_SNI = process.env.DEFAULT_SNI || 'dl.google.com';
// payouts: every round, fresh creator fees are split among nodes that stayed up, and sent right away
const ROUND_MS = (+process.env.ROUND_MIN || 60) * 60e3;
const ROUND0 = Date.parse('2026-10-19T00:00:00Z');
const GOOD_UPTIME = +process.env.GOOD_UPTIME || 0.95;  // share of successful checks in the round
const MIN_CHECKS = +process.env.MIN_CHECKS || 6;       // checks a node needs in the round to count
const MIN_PAYOUT = +process.env.MIN_PAYOUT || 0.001;   // SOL; smaller amounts wait and go out with the next one
const PAYER_KEY = process.env.PAYER_KEY || '';         // base58 secret key of the treasury that collects creator fees
const BUYBACK_WALLET = process.env.BUYBACK_WALLET || ''; // optional: cold wallet for any share not paid to operators (see SPLIT); shown for proof
const MAX_NODES_PER_OPERATOR = +process.env.MAX_NODES_PER_OPERATOR || 3;
const ONLINE_MS = 15 * 60e3;       // a node is online if a probe succeeded within this window
const BALANCE_TTL = 10 * 60e3;
const SESSION_TTL = 30 * 86400e3;
const GB = 1024 ** 3;
// tiers by token balance; first match from the top wins
// home: exits on residential IPs; perks are shown on the site
const TIERS = JSON.parse(process.env.TIERS || JSON.stringify([
  { name: 'dedicated', min: 10_000_000, devices: 10, gb: 2000, home: true, perks: ['own node', 'home IPs', 'streaming'] },
  { name: 'stream', min: 2_000_000, devices: 5, gb: 500, home: true, perks: ['home IPs', 'streaming'] },
  { name: 'home', min: 500_000, devices: 3, gb: 200, home: true, perks: ['home IPs'] },
  { name: 'base', min: 100_000, devices: 2, gb: 100, home: false, perks: [] },
]));
const DEV_TIER = { name: 'dev', min: 0, devices: 3, gb: 50, home: true, perks: [] };
// how each round's creator fees are split, percent; operators' part is paid out automatically
const SPLIT = JSON.parse(process.env.SPLIT || '{"operators":100}');

fs.mkdirSync(DATA, { recursive: true });
// secrets that must survive restarts but don't need to be configured by hand
const secretsFile = path.join(DATA, 'secrets.json');
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {};
if (!secrets.session) secrets.session = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
const SESSION_SECRET = process.env.SESSION_SECRET || secrets.session;

// nodes only ever see opaque client tags, so an operator can't tell users, hops and checkers apart
const tag = (kind, id) => 'c' + crypto.createHmac('sha256', SESSION_SECRET).update(`${kind}:${id}`).digest('hex').slice(0, 12);
const uuidFrom = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
// checker keys rotate daily and travel entry → exit like any user key; yesterday's stay valid during the switch
const PROBE_KEYS = 3;
function probeKeys(t = Date.now()) {
  const d = Math.floor(t / 86400e3), out = [];
  for (const dd of [d - 1, d]) for (let i = 0; i < PROBE_KEYS; i++) {
    const h = crypto.createHmac('sha256', SESSION_SECRET).update(`probe:${dd}:${i}`).digest('hex');
    out.push({ id: `${dd}.${i}`, uuid: uuidFrom(h), tier: { home: i % 2 === 0 }, probe: true, today: dd === d });
  }
  return out;
}

// what this server is running, so anyone can compare it with the public repo
const REVISION = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'REVISION'), 'utf8').trim(); } catch { }
  try { return require('node:child_process').execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
})();
const SERVED = { 'app/public/index.html': '/', 'app/node/install.sh': '/install.sh', 'app/node/agent.py': '/agent.py' };
// repo paths are relative to the repo root; on a server only app/ is deployed, so resolve from here
const fileHash = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, rel.replace(/^app\//, '')))).digest('hex');

const db = new DatabaseSync(path.join(DATA, 'vlana.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS wallets(address TEXT PRIMARY KEY, balance REAL DEFAULT 0, balance_at INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS keys(
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, uuid TEXT UNIQUE, label TEXT, sub TEXT UNIQUE,
  created INTEGER, revoked INTEGER DEFAULT 0, month TEXT, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, operator TEXT, enroll TEXT UNIQUE, secret_hash TEXT,
  ip TEXT, port INTEGER, pbk TEXT, sid TEXT, sni TEXT, country TEXT DEFAULT '', home INTEGER DEFAULT 0,
  hop_uuid TEXT, status TEXT DEFAULT 'enrolling', version TEXT, created INTEGER, last_seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS probes(node INTEGER, probe TEXT, ts INTEGER, ok INTEGER, latency INTEGER, mbps REAL);
CREATE INDEX IF NOT EXISTS probes_node_ts ON probes(node, ts);
CREATE TABLE IF NOT EXISTS traffic(node INTEGER, day TEXT, bytes INTEGER DEFAULT 0, PRIMARY KEY(node, day));
CREATE TABLE IF NOT EXISTS rounds(n INTEGER PRIMARY KEY, start INTEGER, end INTEGER, inflow REAL, pool REAL, nodes INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS earnings(round INTEGER, node INTEGER, wallet TEXT, share REAL, amount REAL, PRIMARY KEY(round, node));
CREATE TABLE IF NOT EXISTS owed(wallet TEXT PRIMARY KEY, amount REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`);
// weekly payouts were replaced by per-round transfers; keep any old rows aside
if (db.prepare(`SELECT 1 FROM pragma_table_info('payouts') WHERE name='epoch'`).get()) db.exec(`ALTER TABLE payouts RENAME TO payouts_weekly`);
// each round keeps its receipt (the exact JSON that was hashed) and the tx that put the hash on-chain
for (const c of ['receipt TEXT', 'hash TEXT', 'memo_tx TEXT'])
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('rounds') WHERE name=?`).get(c.split(' ')[0])) db.exec(`ALTER TABLE rounds ADD COLUMN ${c}`);
db.exec(`CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY AUTOINCREMENT, round INTEGER, wallet TEXT, amount REAL, tx TEXT, created INTEGER, paid_at INTEGER)`);

const q = {
  wallet: db.prepare(`SELECT * FROM wallets WHERE address=?`),
  walletUpsert: db.prepare(`INSERT INTO wallets(address,created) VALUES(?,?) ON CONFLICT DO NOTHING`),
  walletBal: db.prepare(`UPDATE wallets SET balance=?, balance_at=? WHERE address=?`),
  walletsWithKeys: db.prepare(`SELECT DISTINCT w.* FROM wallets w JOIN keys k ON k.wallet=w.address AND k.revoked=0`),
  keysOf: db.prepare(`SELECT * FROM keys WHERE wallet=? AND revoked=0 ORDER BY id`),
  keysAll: db.prepare(`SELECT * FROM keys WHERE revoked=0 ORDER BY wallet, id`),
  keyBySub: db.prepare(`SELECT * FROM keys WHERE sub=? AND revoked=0`),
  keyIns: db.prepare(`INSERT INTO keys(wallet,uuid,label,sub,created,month) VALUES(?,?,?,?,?,?)`),
  keyRevoke: db.prepare(`UPDATE keys SET revoked=1 WHERE id=? AND wallet=?`),
  keyUse: db.prepare(`UPDATE keys SET used=CASE WHEN month=?1 THEN used+?2 ELSE ?2 END, month=?1 WHERE id=?3`),
  node: db.prepare(`SELECT * FROM nodes WHERE id=?`),
  nodeByEnroll: db.prepare(`SELECT * FROM nodes WHERE enroll=?`),
  nodesLive: db.prepare(`SELECT * FROM nodes WHERE status IN ('pending','active') ORDER BY id`),
  nodesAll: db.prepare(`SELECT * FROM nodes WHERE status!='removed' ORDER BY id`),
  nodesOf: db.prepare(`SELECT * FROM nodes WHERE operator=? AND status!='removed' ORDER BY id`),
  nodeEnroll: db.prepare(`INSERT INTO nodes(operator,enroll,sni,port,hop_uuid,created) VALUES(?,?,?,?,?,?)`),
  nodeRegister: db.prepare(`UPDATE nodes SET secret_hash=?, ip=?, port=?, pbk=?, sid=?, sni=?, country=?, version=?, status='pending', last_seen=? WHERE id=?`),
  nodeSeen: db.prepare(`UPDATE nodes SET last_seen=?, ip=? WHERE id=?`),
  nodeStatus: db.prepare(`UPDATE nodes SET status=? WHERE id=?`),
  nodeAdmin: db.prepare(`UPDATE nodes SET status=?, home=?, country=? WHERE id=?`),
  nodeRemove: db.prepare(`UPDATE nodes SET status='removed' WHERE id=? AND operator=?`),
  probeIns: db.prepare(`INSERT INTO probes(node,probe,ts,ok,latency,mbps) VALUES(?,?,?,?,?,?)`),
  lastOk: db.prepare(`SELECT node, MAX(ts) ts FROM probes WHERE ok=1 AND ts>? GROUP BY node`),
  probeStats: db.prepare(`SELECT node, COUNT(*) total, SUM(ok) ok, AVG(CASE WHEN ok=1 THEN latency END) latency, AVG(CASE WHEN ok=1 THEN mbps END) mbps
                          FROM probes WHERE ts>=? AND ts<? GROUP BY node`),
  probePrune: db.prepare(`DELETE FROM probes WHERE ts<?`),
  traffic: db.prepare(`INSERT INTO traffic(node,day,bytes) VALUES(?,?,?) ON CONFLICT(node,day) DO UPDATE SET bytes=bytes+excluded.bytes`),
  trafficSum: db.prepare(`SELECT node, SUM(bytes) bytes FROM traffic WHERE day>=? AND day<? GROUP BY node`),
  payoutsOf: db.prepare(`SELECT * FROM payouts WHERE wallet=? ORDER BY paid_at DESC LIMIT 200`),
  payoutsPaid: db.prepare(`SELECT * FROM payouts ORDER BY paid_at DESC LIMIT 50`),
  paidAll: db.prepare(`SELECT * FROM payouts ORDER BY paid_at DESC LIMIT 500`),
  earnedByNode: db.prepare(`SELECT node, SUM(amount) s, COUNT(*) n FROM earnings GROUP BY node`),
  paidTotal: db.prepare(`SELECT COALESCE(SUM(amount),0) s, COUNT(*) n, COUNT(DISTINCT wallet) ops FROM payouts`),
  paidBy: db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE wallet=?`),
  payoutIns: db.prepare(`INSERT INTO payouts(round,wallet,amount,tx,created,paid_at) VALUES(?,?,?,?,?,?)`),
  roundIns: db.prepare(`INSERT OR REPLACE INTO rounds(n,start,end,inflow,pool,nodes,created,receipt,hash) VALUES(?,?,?,?,?,?,?,?,?)`),
  roundGet: db.prepare(`SELECT * FROM rounds WHERE n=?`),
  roundsUnposted: db.prepare(`SELECT n, hash FROM rounds WHERE hash IS NOT NULL AND memo_tx IS NULL AND n>=? ORDER BY n LIMIT 6`),
  roundMemo: db.prepare(`UPDATE rounds SET memo_tx=? WHERE n=?`),
  payoutsOfRound: db.prepare(`SELECT wallet, amount, tx FROM payouts WHERE round=? ORDER BY id`),
  roundsRecent: db.prepare(`SELECT * FROM rounds ORDER BY n DESC LIMIT ?`),
  feesIn: db.prepare(`SELECT COALESCE(SUM(inflow),0) s FROM rounds`),
  owedTotal: db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owed WHERE amount>0`),
  earnIns: db.prepare(`INSERT OR REPLACE INTO earnings(round,node,wallet,share,amount) VALUES(?,?,?,?,?)`),
  earnByNode: db.prepare(`SELECT node, SUM(amount) s, COUNT(*) rounds FROM earnings WHERE wallet=? GROUP BY node`),
  earnLast: db.prepare(`SELECT * FROM earnings WHERE wallet=? ORDER BY round DESC LIMIT 1`),
  owed: db.prepare(`SELECT amount FROM owed WHERE wallet=?`),
  owedAdd: db.prepare(`INSERT INTO owed(wallet,amount) VALUES(?,?) ON CONFLICT(wallet) DO UPDATE SET amount=amount+excluded.amount`),
  owedDue: db.prepare(`SELECT * FROM owed WHERE amount>=? ORDER BY amount DESC`),
  kvGet: db.prepare(`SELECT v FROM kv WHERE k=?`),
  kvSet: db.prepare(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`),
};

const now = () => Date.now();
const isWallet = w => typeof w === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const short = w => w.slice(0, 4) + '…' + w.slice(-4);
const month = () => new Date().toISOString().slice(0, 7);
const day = (t = now()) => new Date(t).toISOString().slice(0, 10);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const token = (n = 18) => crypto.randomBytes(n).toString('base64url');
const ipOf = req => {
  if (TRUST_PROXY) {
    const h = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
    if (h) return String(h).trim();
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
};
const nodeName = n => `${(n.country || 'xx').toLowerCase()}-${String(n.id).padStart(2, '0')}`;

// ---------- rounds ----------
const roundOf = t => Math.floor((t - ROUND0) / ROUND_MS);
const roundRange = r => [ROUND0 + r * ROUND_MS, ROUND0 + (r + 1) * ROUND_MS];
const kv = (k, d) => { const r = q.kvGet.get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => q.kvSet.run(k, JSON.stringify(v));
const roundInfo = () => { const n = roundOf(now()); const [start, end] = roundRange(n); return { n, start, end, ms: ROUND_MS, good: GOOD_UPTIME, minChecks: MIN_CHECKS, minPayout: MIN_PAYOUT }; };

// ---------- wallet auth (ed25519 over a nonce message) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function verifySig(wallet, message, sigB64) {
  const pub = b58decode(wallet);
  if (pub.length !== 32) return false;
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, pub]), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message), key, sig);
}
const nonces = new Map(); // wallet -> { message, exp }
function sessionFor(wallet) {
  const exp = now() + SESSION_TTL;
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(`${wallet}.${exp}`).digest('base64url');
  return `${wallet}.${exp}.${mac}`;
}
function sessionWallet(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const [wallet, exp, mac] = t.split('.');
  if (!wallet || !exp || !mac || +exp < now()) return null;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(`${wallet}.${exp}`).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  return wallet;
}

// ---------- token balance → tier ----------
async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10e3) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function fetchBalance(wallet) {
  if (!MINT) return 0;
  const res = await rpc('getTokenAccountsByOwner', [wallet, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return res.value.reduce((s, a) => s + (a.account.data.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
}
async function refreshBalance(wallet, force) {
  const w = q.wallet.get(wallet);
  if (!force && w && now() - w.balance_at < BALANCE_TTL) return w.balance;
  try {
    const b = await fetchBalance(wallet);
    q.walletBal.run(b, now(), wallet);
    return b;
  } catch (e) {
    console.error('balance', wallet, e.message);
    return w ? w.balance : 0;
  }
}
const tierFor = balance => (!MINT && DEV_FREE) ? DEV_TIER : (TIERS.find(t => balance >= t.min) || null);

// keys that currently get access: within the wallet's device limit and monthly cap
function activeKeys() {
  const out = [], m = month();
  const byWallet = new Map();
  for (const k of q.keysAll.all()) { if (!byWallet.has(k.wallet)) byWallet.set(k.wallet, []); byWallet.get(k.wallet).push(k); }
  for (const [wallet, keys] of byWallet) {
    const w = q.wallet.get(wallet);
    const tier = tierFor(w ? w.balance : 0);
    if (!tier) continue;
    for (const k of keys.slice(0, tier.devices)) {
      const used = k.month === m ? k.used : 0;
      if (used < tier.gb * GB) out.push({ ...k, tier });
    }
  }
  return out;
}

// ---------- node health + scoring ----------
function onlineSet() {
  const s = new Set();
  for (const r of q.lastOk.all(now() - ONLINE_MS)) s.add(r.node);
  return s;
}
const subnet24 = ip => (ip || '').includes(':') ? ip.split(':').slice(0, 3).join(':') : (ip || '').split('.').slice(0, 3).join('.');

// a node counts in a window if it passed GOOD_UPTIME of at least MIN_CHECKS checks.
// weight = uptime · rarity(country) · home bonus; best MAX per operator, one per /24
function windowScores(start, end, minChecks = MIN_CHECKS) {
  const stats = new Map(q.probeStats.all(start, end).map(r => [r.node, r]));
  const nodes = q.nodesAll.all().filter(n => n.status !== 'banned' && n.created < end && n.pbk);
  const rows = nodes.map(n => {
    const s = stats.get(n.id) || { total: 0, ok: 0 };
    const uptime = s.total ? s.ok / s.total : 0;
    return { node: n, uptime, checks: s.total, ok: s.ok || 0, good: s.total >= minChecks && uptime >= GOOD_UPTIME, latency: s.latency ? Math.round(s.latency) : null, mbps: s.mbps ? +s.mbps.toFixed(1) : null };
  });
  const perCountry = {};
  for (const r of rows) if (r.good) perCountry[r.node.country || 'xx'] = (perCountry[r.node.country || 'xx'] || 0) + 1;
  for (const r of rows) {
    const rarity = 1 / Math.sqrt(perCountry[r.node.country || 'xx'] || 1);
    r.raw = r.good ? r.uptime * rarity * (r.node.home ? 1.5 : 1) : 0;
    r.rarity = +rarity.toFixed(2);
  }
  rows.sort((a, b) => b.raw - a.raw);
  const seenNet = new Set(), perOp = {};
  for (const r of rows) {
    const net = subnet24(r.node.ip);
    perOp[r.node.operator] = (perOp[r.node.operator] || 0);
    r.counted = r.raw > 0 && !seenNet.has(net) && perOp[r.node.operator] < MAX_NODES_PER_OPERATOR;
    if (r.counted) { seenNet.add(net); perOp[r.node.operator]++; }
  }
  const total = rows.reduce((s, r) => s + (r.counted ? r.raw : 0), 0);
  for (const r of rows) r.share = r.counted && total ? r.raw / total : 0;
  return rows;
}

// ---------- solana transfers (legacy tx, system program, no deps) ----------
const LAMPORTS = 1e9;
function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of buf) { if (x) break; s = '1' + s; }
  return s;
}
const key32 = s => { const b = b58decode(s); return b.length >= 32 ? b.subarray(b.length - 32) : Buffer.concat([Buffer.alloc(32 - b.length), b]); };
const compact = n => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if (!n) { o.push(b); break; } o.push(b | 0x80); } return Buffer.from(o); };
let PAYER = null;
if (PAYER_KEY) {
  const sk = b58decode(PAYER_KEY);
  if (sk.length !== 64) throw new Error('PAYER_KEY must be a 64-byte base58 secret key');
  PAYER = {
    pub: sk.subarray(32), address: b58encode(sk.subarray(32)),
    key: crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sk.subarray(0, 32)]), format: 'der', type: 'pkcs8' }),
  };
}
const solBalance = async a => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value / LAMPORTS;
// one transaction, many SystemProgram.transfer instructions; resolves with the signature once confirmed
function sendSol(list) {
  const keys = [PAYER.pub, ...list.map(x => key32(x.wallet)), Buffer.alloc(32)];
  const sys = keys.length - 1;
  const ixs = list.map((x, i) => {
    const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(x.lamports), 4);
    return Buffer.concat([Buffer.from([sys]), compact(2), Buffer.from([0, i + 1]), compact(data.length), data]);
  });
  return sendTx(keys, ixs);
}
// a memo signed by the treasury: puts a round's receipt hash on-chain
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
function sendMemo(text) {
  const data = Buffer.from(text);
  return sendTx([PAYER.pub, key32(MEMO_PROGRAM)], [Buffer.concat([Buffer.from([1]), compact(1), Buffer.from([0]), compact(data.length), data])]);
}
async function sendTx(keys, ixs) {
  const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = Buffer.concat([Buffer.from([1, 0, 1]), compact(keys.length), ...keys, key32(blockhash), compact(ixs.length), ...ixs]);
  const tx = Buffer.concat([compact(1), crypto.sign(null, msg, PAYER.key), msg]);
  const sig = await rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st?.err) throw new Error('tx failed: ' + JSON.stringify(st.err));
    if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus)) return sig;
  }
  throw new Error('tx not confirmed: ' + sig);
}

// ---------- rounds → earnings → transfers ----------
// fees that land in the treasury during a round are that round's pool (operators' cut of it).
// the treasury balance after the last payout is the baseline; anything above it is new.
async function settle(r) {
  const [start, end] = roundRange(r);
  let inflow = kv('manualInflow', 0);
  kvSet('manualInflow', 0);
  if (PAYER) {
    const bal = await solBalance(PAYER.address);
    const base = kv('baseline', null);
    if (base !== null) {
      // SOL you announced as a top-up (POST /api/admin/topup) is not fees: skip it once it lands
      let fresh = Math.max(0, bal - base);
      const skip = Math.min(kv('topup', 0), fresh);
      if (skip > 0) { kvSet('topup', kv('topup', 0) - skip); fresh -= skip; }
      inflow += fresh;
    }
    kvSet('baseline', bal);
  }
  const carry = kv('carry', 0);
  const pool = inflow * (SPLIT.operators ?? 100) / 100 + carry;
  const scored = windowScores(start, end);
  const rows = scored.filter(x => x.share > 0);
  kvSet('carry', rows.length ? 0 : pool); // nobody qualified: the pool rolls into the next round
  const amountOf = x => x.share > 0 ? Math.floor(pool * x.share * LAMPORTS) / LAMPORTS : 0;
  for (const x of rows) {
    const amount = amountOf(x);
    q.earnIns.run(r, x.node.id, x.node.operator, x.share, amount);
    if (amount > 0) q.owedAdd.run(x.node.operator, amount);
  }
  // everything needed to redo the split by hand. its sha256 goes on-chain in a memo from the treasury
  const receipt = JSON.stringify({
    v: 1, round: r, start, end, inflow, carry, operatorsPct: SPLIT.operators ?? 100, pool,
    rules: { goodUptime: GOOD_UPTIME, minChecks: MIN_CHECKS, homeBonus: 1.5, maxPerOperator: MAX_NODES_PER_OPERATOR },
    nodes: scored.map(x => ({ name: nodeName(x.node), wallet: x.node.operator, country: x.node.country || 'xx', home: !!x.node.home, checks: x.checks, ok: x.ok, counted: x.counted, share: x.share, amount: amountOf(x) })),
  });
  q.roundIns.run(r, start, end, inflow, pool, rows.length, now(), receipt, sha(receipt));
  console.log(`round ${r}: inflow ${inflow.toFixed(6)} pool ${pool.toFixed(6)} → ${rows.length} nodes`);
  await payDue(r);
  await postReceipts();
}
async function postReceipts() {
  if (!PAYER) return;
  for (const r of q.roundsUnposted.all(roundOf(now()) - 48)) {
    try {
      const sig = await sendMemo(`vlana:r${r.n}:${r.hash}`);
      q.roundMemo.run(sig, r.n);
      kvSet('baseline', kv('baseline', 0) - 5000 / LAMPORTS); // the fee isn't fees in
    } catch (e) { console.error('receipt memo failed, will retry next round:', e.message); break; }
  }
}
async function payDue(r) {
  if (!PAYER) return; // manual mode: owed amounts wait for /api/admin/payouts
  const due = q.owedDue.all(MIN_PAYOUT).filter(o => isWallet(o.wallet) && o.wallet !== PAYER.address);
  for (let i = 0; i < due.length; i += 18) {
    const batch = due.slice(i, i + 18).map(o => ({ wallet: o.wallet, amount: o.amount, lamports: Math.floor(o.amount * LAMPORTS) }));
    try {
      const sig = await sendSol(batch);
      for (const b of batch) { q.owedAdd.run(b.wallet, -b.amount); q.payoutIns.run(r, b.wallet, b.amount, sig, now(), now()); }
      // what we sent (plus the fee) leaves the treasury without counting as new fees
      kvSet('baseline', kv('baseline', 0) - batch.reduce((s, b) => s + b.lamports, 0) / LAMPORTS - 5000 / LAMPORTS);
      console.log(`paid ${batch.length} operators in ${sig}`);
    } catch (e) { console.error('payout failed, will retry next round:', e.message); }
  }
}
let settling = false;
async function tick() {
  if (settling) return;
  settling = true;
  try {
    const cur = roundOf(now());
    let last = kv('lastRound', null);
    // first start, or back after a long outage: don't replay ancient rounds; unpaid fees are still above the baseline
    if (last === null || cur - last > 48) { last = cur - 1; kvSet('lastRound', last); }
    for (let r = last + 1; r < cur; r++) { await settle(r); kvSet('lastRound', r); }
  } catch (e) { console.error('settle:', e.message); } finally { settling = false; }
}

// ---------- xray config for one node ----------
const FLOW = 'xtls-rprx-vision';
function realityOut(tag, n, uuid) {
  return {
    tag, protocol: 'vless',
    settings: { vnext: [{ address: n.ip, port: n.port, users: [{ id: uuid, encryption: 'none', flow: FLOW }] }] },
    streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: n.sni, fingerprint: 'chrome', publicKey: n.pbk, shortId: n.sid } },
  };
}
// each key gets a stable exit per entry, run by a different operator, so no single operator sees who and where
// home exits are reserved for tiers that include them; those tiers prefer them when any are up
function exitFor(key, entry, exits) {
  let pool = exits.filter(x => x.id !== entry.id && x.operator !== entry.operator);
  const home = pool.filter(x => x.home);
  pool = key.tier?.home ? (home.length ? home : pool) : pool.filter(x => !x.home);
  if (!pool.length) return null;
  const h = parseInt(sha(`${key.uuid}:${entry.id}`).slice(0, 8), 16);
  return pool[h % pool.length];
}
function nodeConfig(node) {
  const online = onlineSet();
  const live = q.nodesLive.all().filter(n => n.pbk);
  const exits = live.filter(n => n.status === 'active' && online.has(n.id));
  const keys = [...(node.status === 'active' ? activeKeys() : []), ...probeKeys()].map(k => ({ ...k, tag: tag(k.probe ? 'p' : 'k', k.id) }));
  const clients = [
    ...keys.map(k => ({ id: k.uuid, email: k.tag, flow: FLOW })),
    ...live.filter(n => n.id !== node.id).map(n => ({ id: n.hop_uuid, email: tag('h', n.id), flow: FLOW })),
  ].sort((a, b) => a.email < b.email ? -1 : 1);
  // IPv4 out: what sites see is the node's registered address, so /api/check can name it
  const outbounds = [{ tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } }, { tag: 'block', protocol: 'blackhole' }];
  const rules = [
    { inboundTag: ['api-in'], outboundTag: 'api' },
    { protocol: ['bittorrent'], outboundTag: 'block' },
    { ip: ['geoip:private'], outboundTag: 'block' },
    { port: '25,465,587', outboundTag: 'block' },
  ];
  const byExit = new Map();
  for (const k of keys) {
    const x = exitFor(k, node, exits);
    if (!x) continue;
    if (!byExit.has(x.id)) byExit.set(x.id, { x, users: [] });
    byExit.get(x.id).users.push(k.tag);
  }
  for (const { x, users } of byExit.values()) {
    outbounds.push(realityOut(`exit-${x.id}`, x, node.hop_uuid));
    rules.push({ user: users, outboundTag: `exit-${x.id}` });
  }
  return {
    log: { loglevel: 'warning', access: 'none' },
    api: { tag: 'api', services: ['StatsService'] },
    stats: {},
    policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      { tag: 'api-in', listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
      {
        tag: 'vless-in', listen: '0.0.0.0', port: node.port, protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: { network: 'tcp', security: 'reality', realitySettings: { show: false, dest: `${node.sni}:443`, xver: 0, serverNames: [node.sni], privateKey: '', shortIds: [node.sid] } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
      },
    ],
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  };
}

// ---------- subscription ----------
function vlessLink(k, n) {
  const p = new URLSearchParams({ encryption: 'none', flow: FLOW, security: 'reality', sni: n.sni, fp: 'chrome', pbk: n.pbk, sid: n.sid, type: 'tcp' });
  return `vless://${k.uuid}@${n.ip.includes(':') ? `[${n.ip}]` : n.ip}:${n.port}?${p}#${encodeURIComponent(`Vlana ${nodeName(n)}`)}`;
}

// ---------- http helpers ----------
function send(res, code, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(code, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function readBody(req, limit = 1e6) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { fail(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { fail(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', fail);
  });
}
const hits = new Map(); // crude per-ip rate limit
function limited(req, bucket, max, windowMs) {
  const k = bucket + ipOf(req), t = now();
  const h = (hits.get(k) || []).filter(x => t - x < windowMs);
  h.push(t); hits.set(k, h);
  return h.length > max;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.py': 'text/plain; charset=utf-8' };
function serveStatic(res, file) {
  const p = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, 'not found');
  const img = /\.(png|webp|jpg|ico|svg)$/.test(p);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', ...(img ? { 'Cache-Control': 'public, max-age=86400' } : {}) });
  fs.createReadStream(p).pipe(res);
}
const nodeAuth = req => {
  const [id, secret] = String(req.headers.authorization || '').replace(/^Bearer /, '').split(':');
  const n = id && secret ? q.node.get(+id) : null;
  return n && n.secret_hash && n.secret_hash === sha(secret) && n.status !== 'removed' ? n : null;
};
const keyOk = (req, header, key) => key && req.headers[header] && crypto.timingSafeEqual(Buffer.from(sha(String(req.headers[header]))), Buffer.from(sha(key)));

// install.sh is served byte for byte as in the repo; it defaults to go.vlana.app, other deployments pass their URL
const installCmd = t => PUBLIC_URL === 'https://go.vlana.app'
  ? `curl -fsSL ${PUBLIC_URL}/install.sh | sudo bash -s ${t}`
  : `curl -fsSL ${PUBLIC_URL}/install.sh | sudo VLANA_SERVER=${PUBLIC_URL} bash -s ${t}`;

function meView(wallet) {
  const w = q.wallet.get(wallet);
  const tier = tierFor(w.balance);
  const m = month();
  const active = new Set(activeKeys().filter(k => k.wallet === wallet).map(k => k.id));
  return {
    wallet, balance: w.balance, mint: MINT, tier, tiers: TIERS, devFree: !MINT && DEV_FREE,
    keys: q.keysOf.all(wallet).map(k => ({
      id: k.id, label: k.label, created: k.created, active: active.has(k.id),
      used: k.month === m ? k.used : 0, cap: tier ? tier.gb * GB : 0,
      sub: `${PUBLIC_URL}/sub/${k.sub}`,
    })),
  };
}

function operatorView(wallet) {
  const rd = roundInfo();
  const live = new Map(windowScores(rd.start, now() + 1, 1).map(r => [r.node.id, r]));
  const earned = new Map(q.earnByNode.all(wallet).map(r => [r.node, r]));
  const online = onlineSet();
  const nodes = q.nodesOf.all(wallet).map(n => {
    const s = live.get(n.id) || {};
    return {
      id: n.id, name: n.pbk ? nodeName(n) : 'enrolling…', status: n.status === 'active' && !online.has(n.id) ? 'offline' : n.status,
      country: n.country, home: !!n.home, ip: n.ip, port: n.port, sni: n.sni, version: n.version, last_seen: n.last_seen,
      uptime: s.uptime ?? 0, checks: s.checks ?? 0, onTrack: (s.uptime ?? 0) >= GOOD_UPTIME && n.status === 'active', latency: s.latency, mbps: s.mbps,
      earned: earned.get(n.id)?.s || 0, rounds: earned.get(n.id)?.rounds || 0,
      install: n.status === 'enrolling' ? installCmd(n.enroll) : null,
    };
  });
  const last = q.earnLast.get(wallet);
  return {
    round: rd, nodes, maxNodes: MAX_NODES_PER_OPERATOR,
    owed: q.owed.get(wallet)?.amount || 0, paid: q.paidBy.get(wallet).s, lastRound: last ? { n: last.round, amount: last.amount } : null,
    payouts: q.payoutsOf.all(wallet).map(p => ({ round: p.round, amount: p.amount, tx: p.tx, paid_at: p.paid_at })),
  };
}

// where is this request coming from, and (signed in) which chain does each of my devices take
function checkView(req) {
  const ip = ipOf(req);
  const live = q.nodesLive.all().filter(n => n.pbk);
  const pub = n => ({ name: nodeName(n), country: n.country, home: !!n.home, operator: n.operator });
  const hit = live.find(n => n.ip === ip);
  const out = { ip, node: hit ? pub(hit) : null };
  const wallet = sessionWallet(req);
  if (wallet) {
    const online = onlineSet();
    const up = live.filter(n => n.status === 'active' && online.has(n.id));
    out.devices = activeKeys().filter(k => k.wallet === wallet).map(k => ({
      label: k.label,
      chains: up.map(e => { const x = exitFor(k, e, up); return { entry: pub(e), exit: x ? pub(x) : null }; }),
    }));
  }
  return out;
}
function networkView() {
  const online = onlineSet();
  const day = q.probeStats.all(now() - 86400e3, now() + 1);
  const st = new Map(day.map(r => [r.node, r]));
  const earned = new Map(q.earnedByNode.all().map(r => [r.node, r]));
  const live = q.nodesLive.all().filter(n => n.pbk);
  const opNodes = op => live.filter(x => x.operator === op).length;
  const nodes = live.map(n => {
    const s = st.get(n.id) || { total: 0, ok: 0 };
    const e = earned.get(n.id) || { s: 0, n: 0 };
    return {
      name: nodeName(n), country: n.country, home: !!n.home, online: online.has(n.id) && n.status === 'active', uptime: s.total ? s.ok / s.total : 0, latency: s.latency ? Math.round(s.latency) : null,
      // operator wallets are public anyway: they are the payout recipients
      operator: n.operator, opNodes: opNodes(n.operator), checks: s.total, mbps: s.mbps ? Math.round(s.mbps * 10) / 10 : null,
      since: n.created, seen: n.last_seen, earned: e.s, rounds: e.n,
    };
  });
  return {
    round: roundInfo(),
    online: nodes.filter(n => n.online).length,
    countries: new Set(nodes.filter(n => n.online).map(n => n.country)).size,
    paid: q.paidTotal.get().s,
    mint: MINT, repo: REPO_URL, tiers: TIERS, split: SPLIT,
    nodes,
  };
}

// public wallet balances for the treasury block, cached so page views don't hit the RPC
const balCache = new Map();
function cachedBalance(a) {
  if (!a) return null;
  const c = balCache.get(a);
  if (!c || now() - c.at > 60e3) {
    balCache.set(a, { v: c?.v ?? null, at: now() });
    solBalance(a).then(v => balCache.set(a, { v, at: now() })).catch(e => console.error('balance', a, e.message));
  }
  return balCache.get(a).v;
}

function payoutsView() {
  const t = q.paidTotal.get();
  return {
    round: roundInfo(), split: SPLIT, auto: !!PAYER, treasury: PAYER?.address || null,
    wallets: {
      treasury: PAYER ? { address: PAYER.address, balance: cachedBalance(PAYER.address) } : null,
      buyback: isWallet(BUYBACK_WALLET) ? { address: BUYBACK_WALLET, balance: cachedBalance(BUYBACK_WALLET) } : null,
      feesIn: q.feesIn.get().s, owed: q.owedTotal.get().s,
    },
    paid: t.s, transfers_n: t.n, operators: t.ops,
    rounds: q.roundsRecent.all(48).map(r => ({ n: r.n, end: r.end, inflow: r.inflow, pool: r.pool, nodes: r.nodes, hash: r.hash, memo: r.memo_tx })),
    transfers: q.paidAll.all().map(p => ({ round: p.round, wallet: p.wallet, amount: p.amount, tx: p.tx, paid_at: p.paid_at })),
  };
}

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  let mm;

  // public
  // public read-only data, so the landing page (and anyone) can show it
  const open = { 'Access-Control-Allow-Origin': '*' };
  if (m === 'GET' && p === '/api/network') return send(res, 200, networkView(), open);
  if (m === 'GET' && p === '/api/payouts') return send(res, 200, payoutsView(), open);
  if (m === 'GET' && (mm = p.match(/^\/api\/rounds\/(\d+)$/))) {
    const r = q.roundGet.get(+mm[1]);
    if (!r?.receipt) return send(res, 404, { error: 'no receipt for this round' }, open);
    return send(res, 200, { n: r.n, receipt: r.receipt, hash: r.hash, memo: r.memo_tx, treasury: PAYER?.address || null, rpc: PUBLIC_RPC, payouts: q.payoutsOfRound.all(r.n) }, open);
  }
  if (m === 'GET' && p === '/api/check') return send(res, 200, checkView(req));
  if (m === 'GET' && p === '/install.sh') { res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, 'node', 'install.sh')).pipe(res); }
  if (m === 'GET' && p === '/api/version') return send(res, 200, { commit: REVISION, repo: REPO_URL, files: Object.fromEntries(Object.entries(SERVED).map(([f, url]) => [f, { url, sha256: fileHash(f) }])) });
  if (m === 'GET' && p === '/agent.py') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, 'node', 'agent.py')).pipe(res); }

  if (m === 'GET' && (mm = p.match(/^\/sub\/([\w-]{10,64})$/))) {
    const k = q.keyBySub.get(mm[1]);
    if (!k) return send(res, 404, 'not found');
    await refreshBalance(k.wallet);
    const tier = tierFor(q.wallet.get(k.wallet).balance);
    const active = activeKeys().some(a => a.id === k.id);
    const online = onlineSet();
    const links = active ? q.nodesLive.all().filter(n => n.status === 'active' && online.has(n.id)).map(n => vlessLink(k, n)) : [];
    const used = k.month === month() ? k.used : 0;
    return send(res, 200, Buffer.from(links.join('\n')).toString('base64'), {
      'profile-title': 'base64:' + Buffer.from('Vlana').toString('base64'),
      'profile-update-interval': '6',
      'subscription-userinfo': `upload=0; download=${used}; total=${tier ? tier.gb * GB : 0}; expire=0`,
      'profile-web-page-url': PUBLIC_URL,
    });
  }

  // wallet auth
  if (m === 'POST' && p === '/api/auth/nonce') {
    if (limited(req, 'nonce', 30, 60e3)) return send(res, 429, { error: 'slow down' });
    const { wallet } = await readBody(req, 4e3);
    if (!isWallet(wallet)) return send(res, 400, { error: 'bad wallet' });
    const message = `Vlana login\n\nWallet: ${wallet}\nNonce: ${token(12)}\nIssued: ${new Date().toISOString()}\n\nSigning is free and proves you own this wallet.`;
    nonces.set(wallet, { message, exp: now() + 5 * 60e3 });
    return send(res, 200, { message });
  }
  if (m === 'POST' && p === '/api/auth/verify') {
    if (limited(req, 'verify', 30, 60e3)) return send(res, 429, { error: 'slow down' });
    const { wallet, signature } = await readBody(req, 4e3);
    const n = nonces.get(wallet);
    if (!n || n.exp < now()) return send(res, 400, { error: 'nonce expired' });
    nonces.delete(wallet);
    let ok = false;
    try { ok = verifySig(wallet, n.message, String(signature || '')); } catch { }
    if (!ok) return send(res, 401, { error: 'bad signature' });
    q.walletUpsert.run(wallet, now());
    await refreshBalance(wallet, true);
    return send(res, 200, { token: sessionFor(wallet) });
  }

  // user
  if (p === '/api/me' || p.startsWith('/api/keys') || p.startsWith('/api/operator')) {
    const wallet = sessionWallet(req);
    if (!wallet || !q.wallet.get(wallet)) return send(res, 401, { error: 'login' });

    if (m === 'GET' && p === '/api/me') { await refreshBalance(wallet, url.searchParams.has('refresh')); return send(res, 200, meView(wallet)); }
    if (m === 'POST' && p === '/api/keys') {
      const { label } = await readBody(req, 4e3);
      const tier = tierFor(await refreshBalance(wallet));
      if (!tier) return send(res, 403, { error: 'hold $VLANA to get access' });
      if (q.keysOf.all(wallet).length >= tier.devices) return send(res, 403, { error: `your tier allows ${tier.devices} devices` });
      q.keyIns.run(wallet, crypto.randomUUID(), clean(label, 24) || 'device', token(), now(), month());
      return send(res, 200, meView(wallet));
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/keys\/(\d+)$/))) { q.keyRevoke.run(+mm[1], wallet); return send(res, 200, meView(wallet)); }

    if (m === 'GET' && p === '/api/operator') return send(res, 200, operatorView(wallet));
    if (m === 'POST' && p === '/api/operator/enroll') {
      const pending = q.nodesOf.all(wallet).filter(n => n.status === 'enrolling');
      if (pending.length >= 3) return send(res, 400, { error: 'finish installing your pending nodes first' });
      if (q.nodesOf.all(wallet).length >= 20) return send(res, 400, { error: 'node limit reached' });
      const b = await readBody(req, 4e3);
      const sni = /^[a-z0-9.-]{3,80}$/i.test(b.sni || '') ? b.sni.toLowerCase() : DEFAULT_SNI;
      const port = Number.isInteger(+b.port) && +b.port > 0 && +b.port < 65536 ? +b.port : 443;
      q.nodeEnroll.run(wallet, token(), sni, port, crypto.randomUUID(), now());
      return send(res, 200, operatorView(wallet));
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/operator\/nodes\/(\d+)$/))) { q.nodeRemove.run(+mm[1], wallet); return send(res, 200, operatorView(wallet)); }
    return send(res, 404, { error: 'not found' });
  }

  // node agent
  if (m === 'POST' && p === '/api/agent/register') {
    if (limited(req, 'reg', 20, 60e3)) return send(res, 429, { error: 'slow down' });
    const b = await readBody(req, 8e3);
    const n = q.nodeByEnroll.get(String(b.enroll || ''));
    if (!n || n.status !== 'enrolling') return send(res, 404, { error: 'unknown or used enroll token' });
    if (!/^[\w-]{40,48}$/.test(b.public_key || '') || !/^[0-9a-f]{0,16}$/.test(b.short_id || '')) return send(res, 400, { error: 'bad keys' });
    const port = Number.isInteger(+b.port) && +b.port > 0 && +b.port < 65536 ? +b.port : n.port;
    const sni = /^[a-z0-9.-]{3,80}$/i.test(b.sni || '') ? b.sni.toLowerCase() : n.sni;
    const country = /^[A-Za-z]{2}$/.test(b.country || '') ? b.country.toUpperCase() : '';
    const secret = token(24);
    q.nodeRegister.run(sha(secret), ipOf(req), port, b.public_key, b.short_id || '', sni, country, clean(b.version, 40), now(), n.id);
    return send(res, 200, { node_id: n.id, secret });
  }
  if (p.startsWith('/api/agent/')) {
    const n = nodeAuth(req);
    if (!n) return send(res, 401, { error: 'unknown node' });
    q.nodeSeen.run(now(), ipOf(req), n.id);
    if (m === 'GET' && p === '/api/agent/config') {
      if (n.status === 'banned') return send(res, 403, { error: 'banned' });
      const config = nodeConfig(q.node.get(n.id));
      const hash = sha(JSON.stringify(config));
      return send(res, 200, { hash, config });
    }
    if (m === 'POST' && p === '/api/agent/stats') {
      const { stats } = await readBody(req, 2e6);
      let total = 0;
      const mo = month(), keyOf = new Map(q.keysAll.all().map(k => [tag('k', k.id), k.id]));
      for (const s of Array.isArray(stats) ? stats : []) {
        const bytes = Math.max(0, (+s.up || 0) + (+s.down || 0));
        if (!bytes) continue;
        total += bytes;
        const id = keyOf.get(s.email);
        if (id) q.keyUse.run(mo, bytes, id);
      }
      if (total) q.traffic.run(n.id, day(), total);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  // probes
  if (p.startsWith('/api/probe/')) {
    if (!keyOk(req, 'x-probe-key', PROBE_KEY)) return send(res, 401, { error: 'probe key' });
    if (m === 'GET' && p === '/api/probe/targets') {
      return send(res, 200, { uuids: probeKeys().filter(k => k.today).map(k => k.uuid), targets: q.nodesLive.all().filter(n => n.pbk).map(n => ({ id: n.id, ip: n.ip, port: n.port, pbk: n.pbk, sid: n.sid, sni: n.sni })) });
    }
    if (m === 'POST' && p === '/api/probe/report') {
      const { probe, results } = await readBody(req, 1e6);
      const t = now();
      for (const r of Array.isArray(results) ? results : []) {
        const n = q.node.get(+r.id);
        if (!n) continue;
        q.probeIns.run(n.id, clean(probe, 32) || 'probe', t, r.ok ? 1 : 0, Math.round(+r.latency || 0), +(+r.mbps || 0).toFixed(2));
        if (r.ok && n.status === 'pending') q.nodeStatus.run('active', n.id); // first good probe makes a node live
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  // admin
  if (p.startsWith('/api/admin/')) {
    if (!keyOk(req, 'x-admin-key', ADMIN_KEY)) return send(res, 401, { error: 'admin key' });
    if (m === 'GET' && p === '/api/admin/state') {
      const rd = roundInfo();
      const scores = windowScores(rd.start, now() + 1, 1).map(r => ({
        id: r.node.id, name: nodeName(r.node), operator: r.node.operator, ip: r.node.ip, country: r.node.country, home: !!r.node.home,
        status: r.node.status, uptime: r.uptime, checks: r.checks, good: r.good, rarity: r.rarity, latency: r.latency, mbps: r.mbps, counted: r.counted, share: r.share,
      }));
      return send(res, 200, {
        round: rd, treasury: PAYER?.address || null, baseline: kv('baseline', null), carry: kv('carry', 0), topup: kv('topup', 0), lastRound: kv('lastRound', null),
        scores, owed: q.owedDue.all(0), rounds: q.roundsRecent.all(24),
        nodes: q.nodesAll.all().map(n => ({ id: n.id, name: nodeName(n), operator: n.operator, status: n.status, ip: n.ip, port: n.port, country: n.country, home: !!n.home, version: n.version, last_seen: n.last_seen })),
      });
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/nodes\/(\d+)$/))) {
      const n = q.node.get(+mm[1]);
      if (!n) return send(res, 404, { error: 'no node' });
      const b = await readBody(req, 4e3);
      const status = ['pending', 'active', 'banned', 'removed'].includes(b.status) ? b.status : n.status;
      const country = /^[A-Za-z]{2}$/.test(b.country || '') ? b.country.toUpperCase() : n.country;
      q.nodeAdmin.run(status, b.home === undefined ? n.home : (b.home ? 1 : 0), country, n.id);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/tags') {
      const out = {};
      for (const k of q.keysAll.all()) out[tag('k', k.id)] = `k${k.id}`;
      for (const n of q.nodesAll.all()) out[tag('h', n.id)] = `h${n.id}`;
      for (const k of probeKeys()) out[tag('p', k.id)] = 'probe';
      return send(res, 200, out);
    }
    // without PAYER_KEY: add fees by hand to the next round, and record transfers you sent yourself
    if (m === 'POST' && p === '/api/admin/inflow') {
      const { sol } = await readBody(req, 4e3);
      if (!(+sol > 0)) return send(res, 400, { error: 'sol > 0 required' });
      kvSet('manualInflow', kv('manualInflow', 0) + +sol);
      return send(res, 200, { manualInflow: kv('manualInflow', 0) });
    }
    if (m === 'POST' && p === '/api/admin/topup') {
      const { sol } = await readBody(req, 4e3);
      if (!(+sol > 0)) return send(res, 400, { error: 'sol > 0 required' });
      kvSet('topup', kv('topup', 0) + +sol);
      return send(res, 200, { topup: kv('topup', 0) });
    }
    if (m === 'POST' && p === '/api/admin/payouts') {
      const { wallet, amount, tx } = await readBody(req, 4e3);
      if (!isWallet(wallet) || !(+amount > 0)) return send(res, 400, { error: 'wallet and amount required' });
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(tx || '')) return send(res, 400, { error: 'bad tx signature' });
      q.owedAdd.run(wallet, -amount);
      q.payoutIns.run(roundOf(now()), wallet, +amount, tx, now(), now());
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (m === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
  if (m === 'GET' || m === 'HEAD') return serveStatic(res, p === '/' ? 'index.html' : p);
  send(res, 404, 'not found');
}

http.createServer((req, res) => {
  route(req, res).catch(e => {
    if (!e.code || e.code >= 500 || typeof e.code !== 'number') console.error(e);
    if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { error: e.code ? e.message : 'server error' });
  });
}).listen(PORT, () => console.log(`vlana on :${PORT} → ${PUBLIC_URL}${MINT ? '' : DEV_FREE ? ' (no mint, DEV_FREE)' : ' (no mint, nobody has access)'} · payouts ${PAYER ? 'auto from ' + PAYER.address : 'manual (no PAYER_KEY)'}`));

// close finished rounds and pay out
setInterval(tick, 30e3).unref();
tick();

// keep holder balances fresh so sold bags lose access, and prune old probes
setInterval(async () => {
  for (const w of q.walletsWithKeys.all()) { await refreshBalance(w.address); await new Promise(r => setTimeout(r, 250)); }
}, 15 * 60e3).unref();
setInterval(() => q.probePrune.run(now() - 60 * 86400e3), 6 * 3600e3).unref();
setInterval(() => { for (const [w, n] of nonces) if (n.exp < now()) nonces.delete(w); hits.clear(); }, 10 * 60e3).unref();
