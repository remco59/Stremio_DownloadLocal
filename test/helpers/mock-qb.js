// In-process stand-in for the qBittorrent WebUI API (v2) on top of the shared torrent model.
const { createModel, serve } = require('./model');

async function form(req, body) {
  // Let undici parse both urlencoded and multipart bodies for us.
  const r = new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body });
  return Object.fromEntries(await r.formData());
}

function qbState(model, t) {
  if (t.error) return t.error;
  const done = model.isComplete(t);
  if (t.paused) return done ? 'stoppedUP' : 'stoppedDL';
  if (!t.metadata) return 'metaDL';
  return done ? 'uploading' : 'downloading';
}

/**
 * @param {{user?:string, pass?:string, v4?:boolean, v52?:boolean, tempPath?:string|null}} opts
 *   v52: login like qBittorrent 5.2+ (204 + QBT_SID_<port> cookie, 401 on wrong password)
 *   tempPath: incomplete-files folder (client path), or null when disabled
 */
function createMockQb({ user = 'admin', pass = 'secret', v4 = false, v52 = false, tempPath = null, model = createModel() } = {}) {
  const SID = 'SID=mock-session';
  const categories = new Set();

  const server = serve(model, async (req, res, url, body, send) => {
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    model.calls.push(`${req.method} ${p}`);

    if (!p.startsWith('/api/v2/')) return send(res, 404, 'Not Found');
    if (p === '/api/v2/auth/login') {
      const f = await form(req, body);
      if (v52) {
        if (f.username !== user || f.password !== pass) return send(res, 401, 'Unauthorized');
        res.writeHead(204, { 'Set-Cookie': `QBT_${SID.replace('SID=', 'SID_8080=')}; HttpOnly; path=/` });
        return res.end();
      }
      if (f.username === user && f.password === pass) return send(res, 200, 'Ok.', { 'Set-Cookie': `${SID}; HttpOnly; path=/` });
      return send(res, 200, 'Fails.');
    }
    const cookie = v52 ? `QBT_${SID.replace('SID=', 'SID_8080=')}` : SID;
    if (user && req.headers.cookie !== cookie) return send(res, 403, 'Forbidden');

    const f = req.method === 'POST' ? await form(req, body) : {};
    const one = (h) => model.torrents.get(String(h || '').toLowerCase());
    const many = (hs) => String(hs || '').toLowerCase().split('|').map((h) => model.torrents.get(h)).filter(Boolean);
    const t = one(q.hash || f.hash);

    switch (p) {
      case '/api/v2/app/version':
        return send(res, 200, v4 ? 'v4.6.7' : v52 ? 'v5.2.4' : 'v5.0.0');
      case '/api/v2/app/preferences':
        return send(res, 200, { temp_path_enabled: !!tempPath, temp_path: tempPath || '/downloads/incomplete', save_path: '/downloads' });
      case '/api/v2/torrents/info': {
        const want = q.hashes ? q.hashes.toLowerCase().split('|') : null;
        const list = [...model.torrents.values()]
          .filter((x) => !want || want.includes(x.hash))
          .map((x) => ({
            hash: x.hash,
            name: x.name,
            state: qbState(model, x),
            save_path: x.savePath,
            progress: model.progress(x),
            size: x.files.reduce((s, y) => s + (y.priority ? y.size : 0), 0),
            dlspeed: 1234,
            eta: 60,
            num_seeds: x.seeds,
          }));
        return send(res, 200, list);
      }
      case '/api/v2/torrents/files':
        if (!t) return send(res, 404, 'Not Found');
        if (!t.metadata) return send(res, 200, []);
        return send(
          res,
          200,
          t.files.map((x, i) => ({ index: i, name: x.name, size: x.size, priority: x.priority, progress: model.fileProgress(t, i) }))
        );
      case '/api/v2/torrents/properties':
        if (!t) return send(res, 404, 'Not Found');
        return send(res, 200, { piece_size: t.pieceSize, save_path: t.savePath });
      case '/api/v2/torrents/pieceStates':
        if (!t) return send(res, 404, 'Not Found');
        return send(res, 200, t.pieces.map((x) => (x ? 2 : 0)));
      case '/api/v2/torrents/filePrio':
        if (!t) return send(res, 404, 'Not Found');
        for (const id of String(f.id).split('|')) t.files[+id].priority = +f.priority;
        return send(res, 200, '');
      case '/api/v2/torrents/createCategory':
        if (categories.has(f.category)) return send(res, 409, 'Conflict');
        categories.add(f.category);
        return send(res, 200, '');
      case '/api/v2/torrents/add': {
        const m = /btih:([0-9a-f]{40})/i.exec(f.urls || '');
        model.added.push({ magnet: f.urls, label: f.category, sequential: f.sequentialDownload === 'true', raw: f });
        if (!m) return send(res, 200, 'Fails.');
        const hash = m[1].toLowerCase();
        if (model.torrents.has(hash)) return send(res, 200, 'Fails.');
        if (model.onAdd) model.onAdd(hash, model.added.at(-1));
        const nt = model.torrents.get(hash);
        if (nt) Object.assign(nt, { sequential: f.sequentialDownload === 'true', label: f.category });
        return send(res, 200, 'Ok.');
      }
      case '/api/v2/torrents/stop':
      case '/api/v2/torrents/start':
        if (v4) return send(res, 404, 'Not Found');
        many(f.hashes).forEach((x) => (x.paused = p.endsWith('stop')));
        return send(res, 200, '');
      case '/api/v2/torrents/pause':
      case '/api/v2/torrents/resume':
        if (!v4) return send(res, 404, 'Not Found');
        many(f.hashes).forEach((x) => (x.paused = p.endsWith('pause')));
        return send(res, 200, '');
      case '/api/v2/torrents/delete':
        many(f.hashes).forEach((x) => {
          model.torrents.delete(x.hash);
          x.deletedFiles = f.deleteFiles === 'true';
          model.lastRemoved = x;
        });
        return send(res, 200, '');
      default:
        return send(res, 404, 'Not Found');
    }
  });

  return { mock: model, ...server };
}

module.exports = { createMockQb };
