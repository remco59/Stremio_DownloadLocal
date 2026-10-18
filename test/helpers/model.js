// Client-neutral torrent model shared by the mock qBittorrent and mock Transmission servers.
// Tests drive it directly: add torrents, flip pieces, pause, inspect what was added.
const http = require('http');

function createModel() {
  const model = {
    torrents: new Map(),
    torrentio: {}, // Stremio ID -> { streams: [...] } served at /stream/:type/:id.json
    added: [], // normalized { magnet, label, sequential, raw } for every add call
    calls: [], // "METHOD /path" or RPC method names
    onAdd: null, // (hash, added) => void - create the torrent in reaction to an add

    addTorrent({ hash, name = 'Torrent', savePath = '/downloads', pieceSize = 16384, files, metadata = true }) {
      const total = files.reduce((s, f) => s + f.size, 0);
      const t = {
        hash: hash.toLowerCase(),
        name,
        savePath,
        pieceSize,
        files: files.map((f) => ({ priority: 1, ...f })), // priority 0 = not wanted
        pieces: new Array(Math.ceil(total / pieceSize)).fill(false),
        metadata,
        paused: false,
        error: null, // e.g. 'missingFiles'
        sequential: false,
        label: null,
      };
      model.torrents.set(t.hash, t);
      return t;
    },
    /** Mark pieces [from, to) as downloaded. */
    havePieces(hash, from, to) {
      const t = model.torrents.get(hash);
      for (let i = from; i < Math.min(to, t.pieces.length); i++) t.pieces[i] = true;
    },
    completeAll(hash) {
      model.torrents.get(hash).pieces.fill(true);
    },
    isComplete(t) {
      return t.pieces.every(Boolean);
    },
    fileBytesDone(t, idx) {
      const off = t.files.slice(0, idx).reduce((s, f) => s + f.size, 0);
      const f = t.files[idx];
      let have = 0;
      for (let p = Math.floor(off / t.pieceSize); p * t.pieceSize < off + f.size; p++) {
        if (!t.pieces[p]) continue;
        have += Math.min(off + f.size, (p + 1) * t.pieceSize) - Math.max(off, p * t.pieceSize);
      }
      return have;
    },
    fileProgress(t, idx) {
      const f = t.files[idx];
      return f.size ? model.fileBytesDone(t, idx) / f.size : 1;
    },
    progress(t) {
      return t.pieces.filter(Boolean).length / (t.pieces.length || 1);
    },
  };
  return model;
}

/** Serves `handle(req, res, url, body)` plus the Torrentio-style endpoint for `model`. */
function serve(model, handle) {
  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isText ? 'text/plain' : 'application/json', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const sm = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(url.pathname);
      if (sm) return send(res, 200, model.torrentio[decodeURIComponent(sm[2])] || { streams: [] });
      await handle(req, res, url, body, send);
    } catch (e) {
      send(res, 500, String(e.stack || e));
    }
  });

  return {
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

module.exports = { createModel, serve };
