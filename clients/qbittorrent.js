// qBittorrent WebUI API (v2) behind the client interface (see index.js).
const cfg = require('../config');

const TIMEOUT_MS = 15000;
let cookie = null;
let categoryReady = null; // category name known to exist
let session = ''; // url/user/pass the cookie belongs to; a settings change forces a fresh login
const pieceSizes = new Map(); // hash -> piece size (never changes for a torrent)
const DIRS_TTL_MS = 60000;
let dirs = { at: 0, list: [] };

function checkSession() {
  const key = `${cfg.qbUrl}\n${cfg.qbUser}\n${cfg.qbPass}`;
  if (key !== session) {
    session = key;
    cookie = null;
    categoryReady = null;
    dirs = { at: 0, list: [] };
  }
}

async function login({ url, user, pass }) {
  const res = await fetch(`${url}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Referer: url },
    body: new URLSearchParams({ username: user, password: pass }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = (await res.text()).trim();
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = sc.find((c) => /^[^=;]*SID[^=;]*=/.test(c)); // "SID", or "QBT_SID_<port>" on newer versions
  // Success is "200 Ok." up to 5.1 and "204 No Content" from 5.2 on; wrong credentials are "200 Fails." or 401.
  if (res.ok && text !== 'Fails.' && (text === 'Ok.' || sid)) return sid ? sid.split(';')[0] : null;
  if (res.status === 401 && !text.startsWith('Fails')) {
    throw new Error(
      'qBittorrent login refused (401). Check username/password. If the add-on reaches the WebUI on another port than ' +
        "qBittorrent's own WebUI port (Docker port mapping), untick 'Enable Host header validation' in qBittorrent's " +
        'WebUI options or map the same port on both sides.'
    );
  }
  throw new Error(`qBittorrent login failed (${res.status}): ${text.slice(0, 80) || 'wrong username or password'}`);
}

async function call(path, opts = {}, retried = false) {
  checkSession();
  const { method = 'GET', query, form, multipart } = opts;
  // No user = "bypass authentication for clients on localhost/whitelisted subnets" is enabled in qBittorrent.
  if (!cookie && cfg.qbUser) cookie = await login({ url: cfg.qbUrl, user: cfg.qbUser, pass: cfg.qbPass });

  const url = new URL(`${cfg.qbUrl}/api/v2${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const headers = { Referer: cfg.qbUrl }; // qBittorrent's CSRF check wants a matching Referer
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method,
    headers,
    body: multipart || (form ? new URLSearchParams(form) : undefined),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 403 && cfg.qbUser && !retried) {
    cookie = null;
    return call(path, opts, true);
  }
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`qBittorrent ${path} -> ${res.status} ${text.slice(0, 120)}`), { status: res.status });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function ensureCategory() {
  checkSession();
  if (categoryReady === cfg.qbCategory) return;
  try {
    await call('/torrents/createCategory', { method: 'POST', form: { category: cfg.qbCategory, savePath: '' } });
  } catch {
    /* already exists (409) */
  }
  categoryReady = cfg.qbCategory;
}

// qBittorrent 5 renamed pause/resume to stop/start; fall back for 4.x.
async function stopStart(hash, v5, v4) {
  try {
    await call(`/torrents/${v5}`, { method: 'POST', form: { hashes: hash } });
  } catch (e) {
    if (e.status !== 404) throw e;
    await call(`/torrents/${v4}`, { method: 'POST', form: { hashes: hash } });
  }
}

function state(s) {
  if (/^(error|missingFiles)$/.test(s)) return 'error';
  if (/metaDL/i.test(s)) return 'metadata';
  if (/^(paused|stopped)/.test(s)) return 'paused';
  if (/^checking|^moving|^allocating/.test(s)) return 'checking';
  if (/^queued/.test(s)) return 'queued';
  if (/UP$|^uploading$/.test(s)) return 'seeding';
  return 'downloading';
}

module.exports = {
  label: 'qBittorrent',
  // Settings-page fields for this client (see settings.js); `connection` maps them onto testConnection().
  settings: {
    fields: [
      { key: 'qbUrl', label: 'WebUI URL', type: 'url', help: 'e.g. http://192.168.1.10:8080' },
      { key: 'qbUser', label: 'Username', type: 'text', optional: true,
        help: 'Empty if qBittorrent bypasses auth for this client.' },
      { key: 'qbPass', label: 'Password', type: 'secret', optional: true },
      { key: 'qbCategory', label: 'Category', type: 'text', help: 'Category for torrents added by the add-on.' },
    ],
    connection: { url: 'qbUrl', user: 'qbUser', pass: 'qbPass' },
  },

  partialSuffixes: ['.!qB'], // only with "Append .!qB extension to incomplete files" on

  /** qBittorrent's incomplete-files folder, if enabled ("Keep incomplete torrents in"). */
  async partialDirs() {
    checkSession();
    if (Date.now() - dirs.at < DIRS_TTL_MS) return dirs.list;
    const p = await call('/app/preferences');
    dirs = { at: Date.now(), list: p.temp_path_enabled && p.temp_path ? [String(p.temp_path).replace(/\/+$/, '')] : [] };
    return dirs.list;
  },

  async add({ magnet, hash }) {
    await ensureCategory();
    const fd = new FormData();
    fd.set('urls', magnet);
    fd.set('category', cfg.qbCategory);
    fd.set('tags', 'stremio-addon');
    fd.set('sequentialDownload', 'true'); // fill the file front-to-back so it's playable while growing
    fd.set('firstLastPiecePrio', 'true'); // grab the ends too (MP4 index / MKV cues)
    let out;
    try {
      out = await call('/torrents/add', { method: 'POST', multipart: fd });
    } catch (e) {
      if (e.status !== 409) throw e; // newer versions answer 409 instead of "Fails."
    }
    if (String(out).trim() === 'Ok.') return;
    // "Fails." usually means the torrent is already in qBittorrent - fine if so.
    if (!(await module.exports.info([hash])).length) throw new Error('qBittorrent rejected the torrent');
  },

  async info(hashes) {
    const list = await call('/torrents/info', { query: { hashes: hashes.join('|') } });
    return list.map((t) => ({
      hash: t.hash.toLowerCase(),
      name: t.name,
      state: state(t.state),
      error: state(t.state) === 'error' ? `qBittorrent state: ${t.state}` : null,
      savePath: t.save_path,
      progress: t.progress,
      size: t.size,
      dlSpeed: t.dlspeed,
      eta: t.eta,
    }));
  },

  async files(hash) {
    let files;
    try {
      files = await call('/torrents/files', { query: { hash } });
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (!Array.isArray(files)) return [];
    return files.map((f, i) => ({ index: i, name: f.name, size: f.size, progress: f.progress }));
  },

  async pieces(hash) {
    if (!pieceSizes.has(hash)) pieceSizes.set(hash, (await call('/torrents/properties', { query: { hash } })).piece_size);
    const states = await call('/torrents/pieceStates', { query: { hash } }); // 0 = missing, 1 = downloading, 2 = done
    return { pieceSize: pieceSizes.get(hash), have: states.map((s) => s === 2) };
  },

  async setWanted(hash, wanted, fileCount) {
    const keep = new Set(wanted);
    const drop = [...Array(fileCount).keys()].filter((i) => !keep.has(i));
    const prio = (ids, priority) =>
      call('/torrents/filePrio', { method: 'POST', form: { hash, id: ids.join('|'), priority: String(priority) } });
    if (drop.length) await prio(drop, 0);
    if (keep.size) await prio([...keep], 1);
  },

  stop: (hash) => stopStart(hash, 'stop', 'pause'),
  start: (hash) => stopStart(hash, 'start', 'resume'),

  async remove(hash, { deleteFiles = false } = {}) {
    await call('/torrents/delete', { method: 'POST', form: { hashes: hash, deleteFiles: String(!!deleteFiles) } });
    pieceSizes.delete(hash);
  },

  /** Checks a set of connection settings without touching the live session. */
  async testConnection({ url = cfg.qbUrl, user = cfg.qbUser, pass = cfg.qbPass } = {}) {
    url = String(url).replace(/\/+$/, '');
    try {
      const sid = user ? await login({ url, user, pass }) : null;
      const res = await fetch(`${url}/api/v2/app/version`, {
        headers: { Referer: url, ...(sid ? { Cookie: sid } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = (await res.text()).trim();
      if (res.status === 403) {
        return { ok: false, error: user ? 'Logged in, but access was refused (403)' : 'Access refused (403): set a username and password' };
      }
      if (!res.ok) return { ok: false, error: `qBittorrent answered ${res.status}: ${text.slice(0, 80)}` };
      return { ok: true, version: `qBittorrent ${text}` };
    } catch (e) {
      return { ok: false, error: netError(e) };
    }
  },
};

function netError(e) {
  if (e.name === 'TimeoutError') return 'timed out';
  if (e.cause) return String(e.cause.code || e.cause.message);
  return e.message;
}
