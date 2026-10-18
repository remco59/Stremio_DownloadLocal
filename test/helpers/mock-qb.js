// In-process stand-in for the qBittorrent WebUI API (v2) plus a Torrentio-style /stream endpoint.
// Tests drive it through the returned `mock` object: add torrents, flip piece states, inspect calls.
const http = require('http');

function fileProgress(t, idx) {
  const off = t.files.slice(0, idx).reduce((s, f) => s + f.size, 0);
  const f = t.files[idx];
  if (!f.size) return 1;
  let have = 0;
  for (let p = Math.floor(off / t.piece_size); p * t.piece_size < off + f.size; p++) {
    if (t.pieces[p] !== 2) continue;
    const a = Math.max(off, p * t.piece_size);
    const b = Math.min(off + f.size, (p + 1) * t.piece_size);
    have += b - a;
  }
  return have / f.size;
}

function createMockQb({ user = 'admin', pass = 'secret' } = {}) {
  const SID = 'SID=mock-session';
  const mock = {
    torrents: new Map(),
    categories: new Set(),
    torrentio: {}, // Stremio ID -> { streams: [...] }
    added: [], // FormData fields of every torrents/add call
    calls: [], // "METHOD /path" log
    loggedIn: false,
    onAdd: null, // (hash, fields) => void - create the torrent in reaction to an add

    addTorrent({ hash, name = 'Torrent', savePath = '/downloads', pieceSize = 16384, files, state = 'downloading' }) {
      const total = files.reduce((s, f) => s + f.size, 0);
      const t = {
        hash: hash.toLowerCase(),
        name,
        state,
        save_path: savePath,
        piece_size: pieceSize,
        files: files.map((f) => ({ priority: 1, ...f })),
        pieces: new Array(Math.ceil(total / pieceSize)).fill(0),
        metadata: true,
      };
      mock.torrents.set(t.hash, t);
      return t;
    },
    /** Mark pieces [from, to) as downloaded (2). */
    havePieces(hash, from, to) {
      const t = mock.torrents.get(hash);
      for (let i = from; i < Math.min(to, t.pieces.length); i++) t.pieces[i] = 2;
    },
    completeAll(hash) {
      const t = mock.torrents.get(hash);
      t.pieces.fill(2);
      t.state = 'uploading';
    },
  };

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isText ? 'text/plain' : 'application/json', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  };

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function form(req, body) {
    // Let undici parse both urlencoded and multipart bodies for us.
    const r = new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body });
    return Object.fromEntries(await r.formData());
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    mock.calls.push(`${req.method} ${p}`);
    const body = req.method === 'POST' ? await readBody(req) : null;

    const sm = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(p);
    if (sm) return send(res, 200, mock.torrentio[decodeURIComponent(sm[2])] || { streams: [] });

    if (!p.startsWith('/api/v2/')) return send(res, 404, 'Not Found');
    if (p === '/api/v2/auth/login') {
      const f = await form(req, body);
      if (f.username === user && f.password === pass) {
        mock.loggedIn = true;
        return send(res, 200, 'Ok.', { 'Set-Cookie': `${SID}; HttpOnly; path=/` });
      }
      return send(res, 200, 'Fails.');
    }
    if (user && req.headers.cookie !== SID) return send(res, 403, 'Forbidden');

    const t = q.hash ? mock.torrents.get(q.hash.toLowerCase()) : null;
    switch (p) {
      case '/api/v2/app/version':
        return send(res, 200, 'v5.0.0');
      case '/api/v2/torrents/info': {
        const want = q.hashes ? q.hashes.toLowerCase().split('|') : null;
        const list = [...mock.torrents.values()]
          .filter((x) => !want || want.includes(x.hash))
          .map((x) => ({
            hash: x.hash,
            name: x.name,
            state: x.state,
            save_path: x.save_path,
            progress: x.pieces.filter((s) => s === 2).length / (x.pieces.length || 1),
          }));
        return send(res, 200, list);
      }
      case '/api/v2/torrents/files':
        if (!t) return send(res, 404, 'Not Found');
        if (!t.metadata) return send(res, 200, []);
        return send(
          res,
          200,
          t.files.map((f, i) => ({ index: i, name: f.name, size: f.size, priority: f.priority, progress: fileProgress(t, i) }))
        );
      case '/api/v2/torrents/properties':
        if (!t) return send(res, 404, 'Not Found');
        return send(res, 200, { piece_size: t.piece_size, save_path: t.save_path });
      case '/api/v2/torrents/pieceStates':
        if (!t) return send(res, 404, 'Not Found');
        return send(res, 200, t.pieces);
      case '/api/v2/torrents/filePrio': {
        const f = await form(req, body);
        const ft = mock.torrents.get(String(f.hash).toLowerCase());
        if (!ft) return send(res, 404, 'Not Found');
        for (const id of String(f.id).split('|')) ft.files[+id].priority = +f.priority;
        return send(res, 200, '');
      }
      case '/api/v2/torrents/createCategory': {
        const f = await form(req, body);
        if (mock.categories.has(f.category)) return send(res, 409, 'Conflict');
        mock.categories.add(f.category);
        return send(res, 200, '');
      }
      case '/api/v2/torrents/add': {
        const f = await form(req, body);
        mock.added.push(f);
        const m = /btih:([0-9a-f]{40})/i.exec(f.urls || '');
        if (!m) return send(res, 200, 'Fails.');
        const hash = m[1].toLowerCase();
        if (mock.torrents.has(hash)) return send(res, 200, 'Fails.');
        if (mock.onAdd) mock.onAdd(hash, f);
        return send(res, 200, 'Ok.');
      }
      default:
        return send(res, 404, 'Not Found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, String(e.stack || e)));
  });

  return {
    mock,
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
      ),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

module.exports = { createMockQb };
