#!/usr/bin/env node
// Checks a running Vlana server from the outside, against this git repo and Solana:
//   1. every file it serves is byte for byte the file at the commit it says it runs
//   2. its recent payout rounds: receipt hash, the memo the treasury put on-chain, and the split itself
// usage: node tools/verify-live.mjs [https://go.vlana.app] [solana rpc]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BASE = (process.argv[2] || 'https://go.vlana.app').replace(/\/$/, '');
const RPC = process.argv[3] || 'https://api.mainnet-beta.solana.com';
const ROUNDS = 6;

const sha = b => createHash('sha256').update(b).digest('hex');
const get = async (path, as = 'json') => {
  const r = await fetch(BASE + path, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return as === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
};
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

let failed = 0;
const line = (ok, what, note = '') => {
  if (ok === false) failed++;
  console.log(`${ok === true ? 'ok  ' : ok === false ? 'FAIL' : 'skip'}  ${what}${note ? `  (${note})` : ''}`);
};

// ---------- 1. served files ----------
const v = await get('/api/version');
console.log(`${BASE} runs ${v.commit}\n`);
let known = true;
try { execFileSync('git', ['cat-file', '-e', `${v.commit}^{commit}`], { stdio: 'ignore' }); } catch { known = false; }
line(known, 'commit is in this repo', v.commit.slice(0, 12));
if (known) {
  for (const [file, { url, sha256 }] of Object.entries(v.files)) {
    const repo = sha(execFileSync('git', ['show', `${v.commit}:${file}`], { maxBuffer: 64 << 20 }));
    const served = sha(await get(url, 'bytes'));
    line(repo === served && served === sha256, `${file} served at ${url}`, repo === served ? served.slice(0, 16) : `repo ${repo.slice(0, 12)} ≠ served ${served.slice(0, 12)}`);
  }
}

// ---------- 2. payout rounds ----------
// the same arithmetic the server runs in windowScores(), in the same order, so floats match exactly
function recompute(R) {
  const rows = R.nodes.map(x => ({ ...x, uptime: x.checks ? x.ok / x.checks : 0 }));
  for (const r of rows) r.good = r.checks >= R.rules.minChecks && r.uptime >= R.rules.goodUptime;
  const per = {};
  for (const r of rows) if (r.good) per[r.country] = (per[r.country] || 0) + 1;
  for (const r of rows) r.raw = r.good ? r.uptime * (1 / Math.sqrt(per[r.country] || 1)) * (r.home ? R.rules.homeBonus : 1) : 0;
  const perOp = {};
  for (const r of rows) if (r.counted) { perOp[r.wallet] = (perOp[r.wallet] || 0) + 1; if (!r.good || perOp[r.wallet] > R.rules.maxPerOperator) return false; }
  const total = rows.reduce((s, r) => s + (r.counted ? r.raw : 0), 0);
  if (Math.abs(R.inflow * R.operatorsPct / 100 + R.carry - R.pool) > 1e-9) return false;
  return rows.every(r => {
    const share = r.counted && total ? r.raw / total : 0;
    const amount = share > 0 ? Math.floor(R.pool * share * 1e9) / 1e9 : 0;
    return Math.abs(share - r.share) < 1e-12 && Math.abs(amount - r.amount) < 1e-12;
  });
}

console.log('');
const pay = await get('/api/payouts');
const recent = pay.rounds.filter(r => r.hash).slice(0, ROUNDS);
if (!recent.length) line(null, 'payout rounds', 'no receipts yet');
for (const { n } of recent) {
  const d = await get(`/api/rounds/${n}`);
  const R = JSON.parse(d.receipt);
  const hashOk = sha(d.receipt) === d.hash;
  const splitOk = recompute(R);
  let chain = null, note = 'memo not posted yet';
  if (d.memo) {
    try {
      const tx = await rpc('getTransaction', [d.memo, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      const logs = tx?.meta?.logMessages || [];
      chain = !!tx && !tx.meta.err && logs.some(l => l.includes(`"vlana:r${n}:${d.hash}"`)) && logs.includes(`Program log: Signed by ${d.treasury}`);
      note = `memo ${d.memo.slice(0, 12)}…`;
    } catch (e) { note = `rpc: ${e.message}`; }
  }
  line(hashOk && splitOk && chain !== false ? (chain === null ? null : true) : false,
    `round ${n}: receipt hash ${hashOk ? 'ok' : 'WRONG'}, split ${splitOk ? 'ok' : 'WRONG'}, on-chain ${chain === null ? '?' : chain ? 'ok' : 'WRONG'}`, note);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
