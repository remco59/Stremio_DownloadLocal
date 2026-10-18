// Throwaway qBittorrent / Transmission containers for the real-client tests (needs a working `docker`).
const { execFile } = require('child_process');

const QB_IMAGE = process.env.REAL_QB_IMAGE || 'lscr.io/linuxserver/qbittorrent:latest';
const TR_IMAGE = process.env.REAL_TR_IMAGE || 'lscr.io/linuxserver/transmission:latest';

function sh(cmd, args, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 2 ** 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${stderr || err.message}`)) : resolve(stdout.trim())
    )
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 60000, what = 'condition') {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const NETWORK = 'stremio-real';
async function network() {
  await sh('docker', ['network', 'create', NETWORK]).catch(() => {});
  const gw = await sh('docker', ['network', 'inspect', NETWORK, '-f', '{{(index .IPAM.Config 0).Gateway}}']);
  return { name: NETWORK, gateway: gw };
}

async function rm(name) {
  await sh('docker', ['rm', '-f', name]).catch(() => {});
}

/**
 * qBittorrent with the WebUI on `port` inside and outside (port mapping would trip Host header validation).
 * Returns the URL and the temporary admin password from the log.
 */
async function startQb({ name, port, mounts, image = QB_IMAGE }) {
  await rm(name);
  await sh('docker', [
    'run', '-d', '--name', name, '--network', NETWORK, '-e', 'PUID=0', '-e', 'PGID=0',
    '-e', `WEBUI_PORT=${port}`, '-e', 'TORRENTING_PORT=6881', '-p', `${port}:${port}`,
    ...mounts.flatMap((m) => ['-v', m]), image,
  ]);
  const pass = await waitFor(
    async () => /temporary password is provided for this session: (\S+)/.exec(await sh('docker', ['logs', name]))?.[1],
    90000,
    `${name} password`
  );
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/api/v2/app/version`)).status, 60000, `${name} WebUI`);
  return { name, url, user: 'admin', pass };
}

async function startTr({ name, port, mounts, image = TR_IMAGE }) {
  await rm(name);
  await sh('docker', [
    'run', '-d', '--name', name, '--network', NETWORK, '-e', 'PUID=0', '-e', 'PGID=0',
    '-e', 'USER=admin', '-e', 'PASS=secret', '-p', `${port}:9091`, ...mounts.flatMap((m) => ['-v', m]), image,
  ]);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/transmission/rpc`)).status === 401, 90000, `${name} RPC`);
  return { name, url, user: 'admin', pass: 'secret' };
}

// ---- minimal raw API calls for setting up seeders (independent of the add-on's clients) ----

async function qbSession(c) {
  const r = await fetch(`${c.url}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Referer: c.url },
    body: new URLSearchParams({ username: c.user, password: c.pass }),
  });
  const sid = r.headers.getSetCookie().find((x) => /SID/.test(x));
  if (!sid) throw new Error(`qBittorrent login failed: ${r.status}`);
  const cookie = sid.split(';')[0];
  return async (path, body) => {
    const res = await fetch(`${c.url}/api/v2${path}`, { method: body ? 'POST' : 'GET', headers: { Referer: c.url, Cookie: cookie }, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`qBittorrent ${path}: ${res.status} ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

async function qbPrefs(c, prefs) {
  const api = await qbSession(c);
  await api('/app/setPreferences', new URLSearchParams({ json: JSON.stringify(prefs) }));
}

/** Seeds an existing torrent from qBittorrent: data already in `savePath`, upload capped at `upKBs`. */
async function qbSeed(c, { torrent, savePath, upKBs }) {
  const api = await qbSession(c);
  await api('/app/setPreferences', new URLSearchParams({ json: JSON.stringify({ up_limit: upKBs * 1024, limit_lan_peers: true }) }));
  const fd = new FormData();
  fd.set('torrents', new Blob([torrent]), 'seed.torrent');
  fd.set('savepath', savePath);
  fd.set('skip_checking', 'true');
  await api('/torrents/add', fd);
}

async function trRpc(c, method, args = {}) {
  let sid = '';
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${c.url}/transmission/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64'), 'X-Transmission-Session-Id': sid },
      body: JSON.stringify({ method, arguments: args }),
    });
    if (r.status === 409) {
      sid = r.headers.get('x-transmission-session-id');
      continue;
    }
    const out = await r.json();
    if (out.result !== 'success') throw new Error(`Transmission ${method}: ${out.result}`);
    return out.arguments;
  }
  throw new Error('Transmission session id handshake failed');
}

/** Seeds an existing torrent from Transmission (verifies the data first), upload capped at `upKBs`. */
async function trSeed(c, { torrent, savePath, upKBs }) {
  await trRpc(c, 'session-set', { 'speed-limit-up': upKBs, 'speed-limit-up-enabled': true });
  await trRpc(c, 'torrent-add', { metainfo: torrent.toString('base64'), 'download-dir': savePath });
}

module.exports = { QB_IMAGE, TR_IMAGE, sh, sleep, waitFor, network, rm, startQb, startTr, qbPrefs, qbSeed, qbSession, trRpc, trSeed, NETWORK };
