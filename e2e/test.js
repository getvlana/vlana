// e2e steps, run inside the tester container. State between steps lives in /tmp/e2e.json.
//   setup        → logs in two operators + one user, enrolls a node per operator, prints both enroll tokens
//   live         → waits for both nodes to register, runs the real probe until both are active, prints their ids
//   connect <id> → connects through the user's subscription link for entry node <id> and fetches a page
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');

const SERVER = process.env.SERVER || 'http://vl-control:8790';
const STATE = '/tmp/e2e.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const log = (...a) => console.error('  ·', ...a);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of buf) { if (x) break; s = '1' + s; }
  return s;
}
async function req(method, path, body, token) {
  const r = await fetch(SERVER + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
// the same wallet login a browser does: sign the server's nonce message with an ed25519 key
async function login() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const wallet = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  const { message } = await req('POST', '/api/auth/nonce', { wallet });
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');
  return { wallet, token: (await req('POST', '/api/auth/verify', { wallet, signature })).token };
}
async function until(what, fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(e => (log(e.message), null));
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(3000);
  }
}

async function setup() {
  for (let i = 0; ; i++) { try { await req('GET', '/api/network'); break; } catch { if (i > 60) throw new Error('control plane down'); await sleep(500); } }
  const opA = await login(), opB = await login(), user = await login();
  const tokens = [];
  for (const op of [opA, opB]) {
    const v = await req('POST', '/api/operator/enroll', {}, op.token);
    tokens.push(v.nodes[0].install.split(' ').pop());
  }
  const me = await req('POST', '/api/keys', { label: 'e2e' }, user.token);
  fs.writeFileSync(STATE, JSON.stringify({ opA, opB, user, sub: me.keys[0].sub }));
  log(`operator A ${opA.wallet}`); log(`operator B ${opB.wallet}`); log(`user ${user.wallet}`);
  console.log(tokens.join(' '));
}

async function live() {
  const s = state();
  const ids = await until('both nodes register', async () => {
    const a = (await req('GET', '/api/operator', null, s.opA.token)).nodes[0];
    const b = (await req('GET', '/api/operator', null, s.opB.token)).nodes[0];
    return a.status !== 'enrolling' && b.status !== 'enrolling' && [a.id, b.id];
  }, 120e3);
  log('registered: nodes', ids.join(', '));
  await until('probe marks both active', async () => {
    await new Promise(r => execFile('node', ['/repo/app/probe/probe.js'], { env: { ...process.env, SERVER, PROBE_KEY: 'e2e', PROBE_ID: 'e2e', ONCE: '1' } }, (e, out, err) => { log('probe:', String(out || err).trim()); r(); }));
    const n = await req('GET', '/api/network');
    return n.online === 2;
  }, 180e3);
  log('both nodes active');
  await sleep(15e3); // let both agents pull the config that wires entry → exit
  console.log(ids.join(' '));
}

function parseLink(l) {
  const u = new URL(l), p = u.searchParams;
  return { uuid: u.username, ip: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port, sni: p.get('sni'), pbk: p.get('pbk'), sid: p.get('sid'), name: decodeURIComponent(u.hash.slice(1)) };
}
const curl = (port, url) => new Promise(ok => execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--socks5-hostname', `127.0.0.1:${port}`, '--max-time', '15', url], (e, out) => ok(+out || 0)));

async function connect(id) {
  const s = state();
  const link = await until(`subscription lists node ${id}`, async () => {
    const r = await fetch(s.sub);
    const links = Buffer.from(await r.text(), 'base64').toString().split('\n').filter(Boolean);
    return links.find(l => parseLink(l).name.endsWith(`-${String(id).padStart(2, '0')}`));
  }, 60e3);
  const t = parseLink(link);
  log(`client → ${t.name} (${t.ip}:${t.port}, sni ${t.sni})`);
  const port = 10800 + id;
  fs.writeFileSync('/tmp/client.json', JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { udp: false } }],
    outbounds: [{
      protocol: 'vless',
      settings: { vnext: [{ address: t.ip, port: t.port, users: [{ id: t.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
      streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: t.sni, fingerprint: 'chrome', publicKey: t.pbk, shortId: t.sid } },
    }],
  }));
  const x = spawn('xray', ['run', '-config', '/tmp/client.json'], { stdio: 'ignore' });
  try {
    await until('page loads through the chain', async () => (await curl(port, 'https://www.gstatic.com/generate_204')) === 204, 60e3);
    for (let i = 0; i < 3; i++) await curl(port, 'https://speed.cloudflare.com/__down?bytes=500000');
    log('page loaded through', t.name);
  } finally { x.kill(); }
}

const [step, arg] = process.argv.slice(2);
({ setup, live, connect: () => connect(+arg) })[step]().catch(e => { console.error('✗', e.message); process.exit(1); });
