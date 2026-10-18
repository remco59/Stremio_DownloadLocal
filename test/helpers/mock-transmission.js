// In-process stand-in for the Transmission RPC API on top of the shared torrent model.
const { createModel, serve } = require('./model');

/** Piece bitfield as Transmission sends it: base64, most significant bit of byte 0 = piece 0. */
function bitfield(have) {
  const buf = Buffer.alloc(Math.ceil(have.length / 8));
  have.forEach((h, i) => {
    if (h) buf[i >> 3] |= 0x80 >> (i & 7);
  });
  return buf.toString('base64');
}

/**
 * @param {{user?:string, pass?:string, version?:string, incompleteDir?:string|null}} opts
 *   incompleteDir: client path of the incomplete dir, or null when disabled
 */
function createMockTransmission({ user = 'admin', pass = 'secret', version = '4.1.0 (mock)', incompleteDir = null, model = createModel() } = {}) {
  const SESSION = 'mock-session-id';
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const fields = (t, names) => {
    const done = model.isComplete(t);
    const wanted = t.files.filter((f) => f.priority);
    const all = {
      hashString: t.hash,
      name: t.name,
      status: t.paused ? 0 : done ? 6 : 4,
      error: t.error ? 3 : 0,
      errorString: t.error || '',
      downloadDir: t.savePath,
      percentDone: wanted.length ? wanted.reduce((s, f) => s + model.fileBytesDone(t, t.files.indexOf(f)), 0) / wanted.reduce((s, f) => s + f.size, 0) : 0,
      sizeWhenDone: wanted.reduce((s, f) => s + f.size, 0),
      totalSize: t.files.reduce((s, f) => s + f.size, 0),
      rateDownload: 1234,
      eta: 60,
      metadataPercentComplete: t.metadata ? 1 : 0,
      files: t.metadata ? t.files.map((f, i) => ({ name: f.name, length: f.size, bytesCompleted: model.fileBytesDone(t, i) })) : [],
      fileStats: t.metadata ? t.files.map((f, i) => ({ wanted: !!f.priority, priority: 0, bytesCompleted: model.fileBytesDone(t, i) })) : [],
      pieces: bitfield(t.pieces),
      pieceSize: t.pieceSize,
      pieceCount: t.pieces.length,
      labels: t.label ? [t.label] : [],
      sequential_download: t.sequential,
    };
    return Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
  };

  const server = serve(model, async (req, res, url, body, send) => {
    if (url.pathname !== '/transmission/rpc') return send(res, 404, 'Not Found');
    if (user && req.headers.authorization !== auth) return send(res, 401, 'Unauthorized');
    if (req.headers['x-transmission-session-id'] !== SESSION) {
      return send(res, 409, 'Conflict', { 'X-Transmission-Session-Id': SESSION });
    }
    const { method, arguments: args = {}, tag } = JSON.parse(body.toString() || '{}');
    model.calls.push(method);
    const ok = (a = {}) => send(res, 200, { result: 'success', arguments: a, tag });
    const pick = (ids) =>
      (ids == null ? [...model.torrents.values()] : ids.map((h) => model.torrents.get(String(h).toLowerCase())).filter(Boolean));

    switch (method) {
      case 'session-get':
        return ok({
          version,
          'rpc-version': 18,
          'incomplete-dir-enabled': !!incompleteDir,
          'incomplete-dir': incompleteDir || '/downloads/incomplete',
          'download-dir': '/downloads',
        });
      case 'torrent-get':
        return ok({ torrents: pick(args.ids).map((t) => fields(t, args.fields || [])) });
      case 'torrent-add': {
        const m = /btih:([0-9a-f]{40})/i.exec(args.filename || '');
        model.added.push({ magnet: args.filename, label: (args.labels || [])[0] || null, sequential: args.sequential_download === true, raw: args });
        if (!m) return send(res, 200, { result: 'invalid or corrupt torrent file', arguments: {}, tag });
        const hash = m[1].toLowerCase();
        if (model.torrents.has(hash)) {
          const t = model.torrents.get(hash);
          return ok({ 'torrent-duplicate': { hashString: hash, id: 1, name: t.name } });
        }
        if (model.onAdd) model.onAdd(hash, model.added.at(-1));
        const t = model.torrents.get(hash);
        if (t) {
          t.sequential = args.sequential_download === true;
          t.label = (args.labels || [])[0] || null;
          if (args['download-dir']) t.savePath = args['download-dir'];
        }
        return ok({ 'torrent-added': { hashString: hash, id: 1, name: t ? t.name : hash } });
      }
      case 'torrent-set':
        for (const t of pick(args.ids)) {
          // An empty files-wanted/unwanted list means "all files" in Transmission, so treat it like that here too.
          if (Array.isArray(args['files-wanted'])) {
            (args['files-wanted'].length ? args['files-wanted'] : t.files.map((_, i) => i)).forEach((i) => (t.files[i].priority = 1));
          }
          if (Array.isArray(args['files-unwanted'])) {
            (args['files-unwanted'].length ? args['files-unwanted'] : t.files.map((_, i) => i)).forEach((i) => (t.files[i].priority = 0));
          }
          if ('sequential_download' in args) t.sequential = !!args.sequential_download;
          if (Array.isArray(args.labels)) t.label = args.labels[0] || null;
        }
        return ok();
      case 'torrent-start':
      case 'torrent-stop':
        pick(args.ids).forEach((t) => (t.paused = method === 'torrent-stop'));
        return ok();
      case 'torrent-remove':
        for (const t of pick(args.ids)) {
          model.torrents.delete(t.hash);
          t.deletedFiles = !!args['delete-local-data'];
          model.lastRemoved = t;
        }
        return ok();
      default:
        return send(res, 200, { result: `method name not recognized`, arguments: {}, tag });
    }
  });

  return { mock: model, ...server };
}

module.exports = { createMockTransmission, bitfield };
