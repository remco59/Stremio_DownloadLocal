// Minimal qBittorrent WebUI API (v2) client.
const cfg = require('./config').qb;

let cookie = null;
let categoryReady = false;

async function login() {
  if (!cfg.user) return; // e.g. "bypass auth for clients on localhost/subnet" is enabled
  const res = await fetch(`${cfg.url}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Referer: cfg.url },
    body: new URLSearchParams({ username: cfg.user, password: cfg.pass }),
  });
  const text = (await res.text()).trim();
  if (!res.ok || text !== 'Ok.') {
    throw new Error(`qBittorrent login failed (${res.status}): ${text.slice(0, 80)}`);
  }
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = sc.find((c) => c.startsWith('SID='));
  cookie = sid ? sid.split(';')[0] : null;
}

async function call(path, opts = {}, retried = false) {
  const { method = 'GET', query, form, multipart } = opts;
  if (!cookie && cfg.user) await login();

  const url = new URL(`${cfg.url}/api/v2${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const headers = { Referer: cfg.url }; // qBittorrent's CSRF check wants a matching Referer
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method,
    headers,
    body: multipart || (form ? new URLSearchParams(form) : undefined),
  });

  if (res.status === 403 && cfg.user && !retried) {
    cookie = null;
    return call(path, opts, true);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`qBittorrent ${path} -> ${res.status} ${text.slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function ensureCategory() {
  if (categoryReady) return;
  try {
    await call('/torrents/createCategory', { method: 'POST', form: { category: cfg.category, savePath: '' } });
  } catch {
    /* already exists (409) */
  }
  categoryReady = true;
}

module.exports = {
  info: (hashes) => call('/torrents/info', { query: { hashes: hashes.join('|') } }),
  files: (hash) => call('/torrents/files', { query: { hash } }),
  properties: (hash) => call('/torrents/properties', { query: { hash } }),
  // 0 = not downloaded, 1 = downloading, 2 = downloaded
  pieceStates: (hash) => call('/torrents/pieceStates', { query: { hash } }),
  setFilePriority: (hash, ids, priority) =>
    call('/torrents/filePrio', {
      method: 'POST',
      form: { hash, id: ids.join('|'), priority: String(priority) },
    }),

  async addMagnet(magnet) {
    await ensureCategory();
    const fd = new FormData();
    fd.set('urls', magnet);
    fd.set('category', cfg.category);
    fd.set('tags', 'stremio-addon');
    fd.set('sequentialDownload', 'true'); // fill the file front-to-back so it's playable while growing
    fd.set('firstLastPiecePrio', 'true'); // grab the ends too (MP4 index / MKV cues)
    const out = await call('/torrents/add', { method: 'POST', multipart: fd });
    return String(out).trim() === 'Ok.';
  },
};
