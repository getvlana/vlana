// Vlana probe. Connects to every node through a real VLESS+REALITY tunnel and reports reachability, latency, speed.
// Run several of these from different networks; each reports under its own PROBE_ID.
// env: SERVER, PROBE_KEY, PROBE_ID, XRAY_BIN (default: xray in PATH), INTERVAL (s, 300), CONCURRENCY (4), ONCE=1
'use strict';
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const SERVER = (process.env.SERVER || 'http://localhost:8790').replace(/\/$/, '');
const KEY = process.env.PROBE_KEY || '';
const ID = process.env.PROBE_ID || os.hostname();
const XRAY = process.env.XRAY_BIN || 'xray';
const INTERVAL = (+process.env.INTERVAL || 300) * 1e3;
const CONCURRENCY = +process.env.CONCURRENCY || 4;
const PING_URL = 'https://www.gstatic.com/generate_204';
const SPEED_URL = 'https://speed.cloudflare.com/__down?bytes=2000000';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (p, body) => {
  const r = await fetch(SERVER + p, { method: body ? 'POST' : 'GET', headers: { 'x-probe-key': KEY, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const freePort = () => new Promise((ok, fail) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', fail); });
const curl = (port, url, maxTime) => new Promise(ok => {
  execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{time_starttransfer} %{speed_download}', '--socks5-hostname', `127.0.0.1:${port}`, '--max-time', String(maxTime), url],
    (err, out) => { const [code, ttfb, speed] = String(out || '').trim().split(' '); ok({ code: +code || 0, ttfb: +ttfb || 0, speed: +speed || 0 }); });
});
async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise(r => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

async function check(t, uuid) {
  const port = await freePort();
  const file = path.join(os.tmpdir(), `vlana-probe-${process.pid}-${t.id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    log: { loglevel: 'none' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { udp: false } }],
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: t.ip, port: t.port, users: [{ id: uuid, encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
      streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: t.sni, fingerprint: 'chrome', publicKey: t.pbk, shortId: t.sid } },
    }],
  }));
  const x = spawn(XRAY, ['run', '-config', file], { stdio: 'ignore' });
  try {
    if (!await waitPort(port, 4000)) return { id: t.id, ok: false };
    const ping = await curl(port, PING_URL, 10);
    if (ping.code !== 204) return { id: t.id, ok: false };
    const speed = await curl(port, SPEED_URL, 15);
    return { id: t.id, ok: true, latency: Math.round(ping.ttfb * 1000), mbps: +(speed.speed * 8 / 1e6).toFixed(2) };
  } finally {
    x.kill();
    fs.rmSync(file, { force: true });
  }
}

async function round() {
  const { uuids, targets } = await api('/api/probe/targets');
  const results = [], queue = [...targets];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let t; (t = queue.shift());) results.push(await check(t, uuids[Math.floor(Math.random() * uuids.length)]).catch(() => ({ id: t.id, ok: false })));
  }));
  await api('/api/probe/report', { probe: ID, results });
  console.log(new Date().toISOString(), results.map(r => `#${r.id}:${r.ok ? `${r.latency}ms ${r.mbps}Mbps` : 'DOWN'}`).join('  ') || 'no nodes');
}

(async () => {
  for (;;) {
    await round().catch(e => console.error('round failed:', e.message));
    if (process.env.ONCE === '1') break;
    await sleep(INTERVAL);
  }
})();
