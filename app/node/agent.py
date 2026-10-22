#!/usr/bin/env python3
# Vlana node agent. Stdlib only.
# Registers the node once, then pulls the xray config from the control plane and reports per-user traffic.
# The REALITY private key never leaves this machine: the server sends a config without it and we fill it in here.
import json, os, subprocess, sys, time, urllib.request, urllib.error

CONF = os.environ.get('VLANA_CONF', '/etc/vlana/node.json')
XRAY = os.environ.get('XRAY_BIN', '/usr/local/bin/xray')
XCONF = os.environ.get('XRAY_CONFIG', '/usr/local/etc/xray/config.json')
RESTART = os.environ.get('XRAY_RESTART', 'systemctl restart xray').split()
API = os.environ.get('XRAY_API', '127.0.0.1:10085')
CONFIG_EVERY = int(os.environ.get('CONFIG_EVERY', 30))
STATS_EVERY = int(os.environ.get('STATS_EVERY', 60))


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def load():
    with open(CONF) as f:
        return json.load(f)


def save(c):
    tmp = CONF + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(c, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONF)


def call(c, method, path, body=None, auth=True):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(c['server'] + path, data=data, method=method,
                               headers={'Content-Type': 'application/json', 'User-Agent': 'vlana-agent/1'})
    if auth:
        r.add_header('Authorization', 'Bearer %s:%s' % (c['node_id'], c['secret']))
    with urllib.request.urlopen(r, timeout=20) as f:
        return json.loads(f.read() or b'{}')


def country():
    try:
        with urllib.request.urlopen('https://ipinfo.io/country', timeout=6) as f:
            return f.read().decode().strip()[:2]
    except Exception:
        return ''


def xray_version():
    try:
        return subprocess.run([XRAY, 'version'], capture_output=True, text=True, timeout=10).stdout.split('\n')[0][:40]
    except Exception:
        return ''


def register(c):
    r = call(c, 'POST', '/api/agent/register', {
        'enroll': c['enroll'], 'public_key': c['public_key'], 'short_id': c['short_id'],
        'port': c['port'], 'sni': c['sni'], 'country': country(), 'version': xray_version(),
    }, auth=False)
    c['node_id'], c['secret'] = r['node_id'], r['secret']
    c.pop('enroll', None)
    save(c)
    log('registered as node', c['node_id'])


def apply(c, cfg):
    for ib in cfg.get('inbounds', []):
        rs = ib.get('streamSettings', {}).get('realitySettings')
        if rs is not None:
            rs['privateKey'] = c['private_key']
    base, ext = os.path.splitext(XCONF)
    tmp = base + '.new' + (ext or '.json')  # xray picks the parser from the extension
    with open(tmp, 'w') as f:
        json.dump(cfg, f)
    os.chmod(tmp, 0o644)
    t = subprocess.run([XRAY, 'run', '-test', '-config', tmp], capture_output=True, text=True, timeout=30)
    if t.returncode != 0:
        log('config rejected by xray:', (t.stdout + t.stderr)[-400:])
        return False
    os.replace(tmp, XCONF)
    subprocess.run(RESTART, timeout=30)
    return True


def stats():
    r = subprocess.run([XRAY, 'api', 'statsquery', '--server=' + API, '-pattern', 'user>>>', '-reset'],
                       capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        return []
    per = {}
    for s in json.loads(r.stdout or '{}').get('stat', []):
        parts = s.get('name', '').split('>>>')  # user>>>k12>>>traffic>>>uplink
        if len(parts) != 4:
            continue
        e = per.setdefault(parts[1], {'email': parts[1], 'up': 0, 'down': 0})
        e['up' if parts[3] == 'uplink' else 'down'] += int(s.get('value', 0))
    return [e for e in per.values() if e['up'] or e['down']]


def main():
    c = load()
    while 'node_id' not in c:
        try:
            register(c)
        except urllib.error.HTTPError as e:
            log('register failed:', e.code, e.read()[:200])
            if e.code == 404:
                sys.exit('enroll token is unknown or already used. get a new install command from the app.')
            time.sleep(30)
        except Exception as e:
            log('register failed:', e)
            time.sleep(30)

    current, last_stats = None, 0
    while True:
        try:
            r = call(c, 'GET', '/api/agent/config')
            if r['hash'] != current:
                if apply(c, r['config']):
                    current = r['hash']
                    log('config applied', current[:10], 'clients:', len(r['config']['inbounds'][1]['settings']['clients']))
            if time.time() - last_stats >= STATS_EVERY:
                s = stats()
                if s:
                    call(c, 'POST', '/api/agent/stats', {'stats': s})
                last_stats = time.time()
        except urllib.error.HTTPError as e:
            log('server said', e.code)
            if e.code in (401, 403):
                time.sleep(300)
        except Exception as e:
            log('error:', e)
        time.sleep(CONFIG_EVERY)


if __name__ == '__main__':
    main()
