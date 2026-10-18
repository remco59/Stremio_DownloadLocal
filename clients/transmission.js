// Transmission RPC behind the client interface (see index.js).
// Sequential download (needed to play while downloading) exists from Transmission 4.1 on; older versions
// still work, but pieces arrive in random order so a title is only playable once (almost) complete.
const cfg = require('../config');

const TIMEOUT_MS = 15000;
const DIRS_TTL_MS = 60000;
let sessionId = null;
let session = '';
let dirs = { at: 0, list: [] };

// Accept "http://host:9091" as well as the full RPC URL.
function rpcUrl(url) {
  const u = new URL(String(url).replace(/\/+$/, ''));
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/transmission/rpc';
  return u.href;
}

function checkSession() {
  const key = `${cfg.trUrl}\n${cfg.trUser}\n${cfg.trPass}`;
  if (key !== session) {
    session = key;
    sessionId = null;
    dirs = { at: 0, list: [] };
  }
}

/** One RPC call. Handles the X-Transmission-Session-Id handshake (409 -> retry with the new id). */
async function rpc(method, args = {}, conn = null) {
  if (!conn) checkSession();
  const { url, user, pass } = conn || { url: cfg.trUrl, user: cfg.trUser, pass: cfg.trPass };
  let sid = conn ? conn.sessionId : sessionId;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'Content-Type': 'application/json' };
    if (sid) headers['X-Transmission-Session-Id'] = sid;
    if (user) headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const res = await fetch(rpcUrl(url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, arguments: args }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 409) {
      sid = res.headers.get('x-transmission-session-id');
      if (conn) conn.sessionId = sid;
      else sessionId = sid;
      continue;
    }
    if (res.status === 401) throw Object.assign(new Error('Transmission login failed (401): check username/password'), { status: 401 });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Transmission ${method} -> ${res.status} ${text.slice(0, 120)}`), { status: res.status });
    const out = JSON.parse(text);
    if (out.result !== 'success') throw new Error(`Transmission ${method}: ${out.result}`);
    return out.arguments || {};
  }
  throw new Error('Transmission kept rejecting the session id (409)');
}

async function get(hashes, fields) {
  const { torrents = [] } = await rpc('torrent-get', { ids: hashes, fields });
  return torrents;
}

/** Decodes Transmission's base64 piece bitfield (MSB of byte 0 = piece 0). */
function decodeBitfield(b64, count) {
  const buf = Buffer.from(b64 || '', 'base64');
  const have = new Array(count);
  for (let i = 0; i < count; i++) have[i] = ((buf[i >> 3] || 0) & (0x80 >> (i & 7))) !== 0;
  return have;
}

// status: 0 stopped, 1 check-wait, 2 checking, 3 download-wait, 4 downloading, 5 seed-wait, 6 seeding.
// error: 0 ok, 1 tracker warning, 2 tracker error, 3 local error. Only a local error breaks the download.
function state(t) {
  if (t.error === 3) return 'error';
  if (t.status === 0) return 'paused';
  if (t.metadataPercentComplete < 1) return 'metadata';
  if (t.status === 1 || t.status === 2) return 'checking';
  if (t.status === 3) return 'queued';
  if (t.status === 5 || t.status === 6) return 'seeding';
  return 'downloading';
}

/** "4.1.0 (abcdef)" -> [4, 1] */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2]] : null;
}

function sequentialWarning(version) {
  const v = parseVersion(version);
  if (v && (v[0] > 4 || (v[0] === 4 && v[1] >= 1))) return null;
  return `Transmission ${version || '(unknown version)'} has no sequential download: titles only play once (almost) complete. Use 4.1 or newer to play while downloading.`;
}

module.exports = {
  partialSuffixes: ['.part'],

  /** Transmission's incomplete dir, if enabled (files live there until they complete). */
  async partialDirs() {
    checkSession();
    if (Date.now() - dirs.at < DIRS_TTL_MS) return dirs.list;
    const s = await rpc('session-get', { fields: ['incomplete-dir-enabled', 'incomplete-dir'] });
    dirs = { at: Date.now(), list: s['incomplete-dir-enabled'] && s['incomplete-dir'] ? [s['incomplete-dir'].replace(/\/+$/, '')] : [] };
    return dirs.list;
  },

  async add({ magnet, hash }) {
    const args = { filename: magnet, labels: [cfg.trLabel], sequential_download: true };
    if (cfg.trDownloadDir) args['download-dir'] = cfg.trDownloadDir;
    const out = await rpc('torrent-add', args);
    const t = out['torrent-added'] || out['torrent-duplicate'];
    if (!t) throw new Error('Transmission rejected the torrent');
    if (out['torrent-duplicate']) {
      // Already there (maybe added by hand): still make sure it downloads in order.
      await rpc('torrent-set', { ids: [hash || t.hashString], sequential_download: true }).catch(() => {});
    }
  },

  async info(hashes) {
    const list = await get(hashes, [
      'hashString', 'name', 'status', 'error', 'errorString', 'downloadDir', 'percentDone',
      'sizeWhenDone', 'rateDownload', 'eta', 'metadataPercentComplete',
    ]);
    return list.map((t) => ({
      hash: t.hashString.toLowerCase(),
      name: t.name,
      state: state(t),
      error: t.error === 3 ? `Transmission: ${t.errorString || 'local error'}` : null,
      savePath: (t.downloadDir || '').replace(/\/+$/, ''),
      progress: t.percentDone,
      size: t.sizeWhenDone,
      dlSpeed: t.rateDownload,
      eta: t.eta,
    }));
  },

  async files(hash) {
    const [t] = await get([hash], ['files', 'metadataPercentComplete']);
    if (!t) return null;
    if (t.metadataPercentComplete < 1 || !Array.isArray(t.files)) return [];
    return t.files.map((f, i) => ({ index: i, name: f.name, size: f.length, progress: f.length ? f.bytesCompleted / f.length : 1 }));
  },

  async pieces(hash) {
    const [t] = await get([hash], ['pieces', 'pieceSize', 'pieceCount']);
    if (!t) throw new Error(`Transmission: torrent ${hash} not found`);
    return { pieceSize: t.pieceSize, have: decodeBitfield(t.pieces, t.pieceCount) };
  },

  async setWanted(hash, wanted, fileCount) {
    const keep = new Set(wanted);
    const drop = [...Array(fileCount).keys()].filter((i) => !keep.has(i));
    // An empty list means "all files" to Transmission, so only send non-empty ones.
    const args = { ids: [hash] };
    if (keep.size) args['files-wanted'] = [...keep];
    if (drop.length) args['files-unwanted'] = drop;
    await rpc('torrent-set', args);
  },

  stop: (hash) => rpc('torrent-stop', { ids: [hash] }),
  start: (hash) => rpc('torrent-start', { ids: [hash] }),

  async remove(hash, { deleteFiles = false } = {}) {
    await rpc('torrent-remove', { ids: [hash], 'delete-local-data': !!deleteFiles });
  },

  /** Checks a set of connection settings without touching the live session. */
  async testConnection({ url = cfg.trUrl, user = cfg.trUser, pass = cfg.trPass } = {}) {
    try {
      const s = await rpc('session-get', { fields: ['version', 'rpc-version'] }, { url, user, pass, sessionId: null });
      const out = { ok: true, version: `Transmission ${s.version}` };
      const warning = sequentialWarning(s.version);
      if (warning) out.warning = warning;
      return out;
    } catch (e) {
      if (e.name === 'TimeoutError') return { ok: false, error: 'timed out' };
      return { ok: false, error: e.cause ? String(e.cause.code || e.cause.message) : e.message };
    }
  },

  decodeBitfield,
  sequentialWarning,
};
