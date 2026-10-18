// HTTP range streaming of a file that may still be downloading.
// Uses qBittorrent's piece map so we only ever read bytes that are really on disk;
// if the player asks for something not downloaded yet, the response simply waits (player shows buffering).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const qb = require('./qbittorrent');
const { localPath } = require('./downloads');

const MIME = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pieceCache = new Map();

async function pieceStates(hash) {
  const c = pieceCache.get(hash);
  if (c && Date.now() - c.at < 1000) return c.states;
  const states = await qb.pieceStates(hash);
  pieceCache.set(hash, { at: Date.now(), states });
  return states;
}

/** Exclusive end offset (within the file) of the contiguous downloaded run starting at `pos`. Returns `pos` if nothing is available. */
async function availableUntil(rec, pos) {
  if (rec.status === 'complete') return rec.fileSize;
  const states = await pieceStates(rec.infoHash);
  const ps = rec.pieceSize;
  let p = Math.floor((rec.fileOffset + pos) / ps);
  if (states[p] !== 2) return pos;
  while (p < states.length && states[p] === 2) p++;
  return Math.min(rec.fileSize, p * ps - rec.fileOffset);
}

async function openFile(rec) {
  const p = localPath(rec);
  for (const candidate of [p, p + '.!qB']) {
    try {
      return await fs.promises.open(candidate, 'r');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw Object.assign(new Error('file not on disk yet'), { code: 'ENOENT' });
}

async function serveFile(req, res, rec) {
  const size = rec.fileSize;
  let start = 0;
  let end = size - 1;
  let partial = false;

  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    if (m[1] === '') {
      start = Math.max(0, size - parseInt(m[2], 10));
    } else {
      start = parseInt(m[1], 10);
      if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
    }
    if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    partial = true;
  }

  const headers = {
    'Content-Type': MIME[path.extname(rec.fileName).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  let closed = false;
  res.on('close', () => (closed = true));
  let pos = start;
  let fh = null;
  let stalledSince = 0;
  let gaveUp = false;

  try {
    while (pos <= end && !closed && !gaveUp) {
      rec = db.get(rec.id) || rec;
      let avail = pos;
      try {
        avail = await availableUntil(rec, pos);
      } catch {
        /* qBittorrent hiccup: treat as not available yet */
      }

      if (avail <= pos) {
        stalledSince = stalledSince || Date.now();
        if (Date.now() - stalledSince > cfg.stallMs) break;
        await sleep(1000);
        continue;
      }
      stalledSince = 0;

      const until = Math.min(avail, end + 1);
      while (pos < until && !closed) {
        const len = Math.min(1 << 20, until - pos);
        const buf = Buffer.allocUnsafe(len);
        let n = 0;
        try {
          fh = fh || (await openFile(rec));
          n = (await fh.read(buf, 0, len, pos)).bytesRead;
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        if (n === 0) {
          // file was renamed (.!qB removed) or not flushed yet: reopen and retry
          if (fh) await fh.close().catch(() => {});
          fh = null;
          stalledSince = stalledSince || Date.now();
          if (Date.now() - stalledSince > cfg.stallMs) {
            gaveUp = true;
            break;
          }
          await sleep(500);
          continue;
        }
        stalledSince = 0;
        pos += n;
        const ok = res.write(n === len ? buf : buf.subarray(0, n));
        if (!ok) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
      }
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
    if (pos > end) res.end();
    else res.destroy(); // truncated: make the player see an error and retry
  }
}

module.exports = { serveFile };
