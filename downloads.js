// Download state machine: queued -> downloading -> complete (or error / missing).
// db is the source of truth for the add-on; the torrent client (clients/) is polled to keep it current.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const client = require('./clients');
const finder = require('./finder');

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts)$/i;
const inflight = new Map();

/** Maps a path as the torrent client sees it to the path inside this container. */
function toLocal(clientPath) {
  const pre = cfg.clientPathPrefix;
  if (clientPath === pre || clientPath.startsWith(pre + '/')) return cfg.localPathPrefix + clientPath.slice(pre.length);
  return clientPath;
}

/** Where the finished file lives. */
function localPath(rec) {
  return toLocal(path.posix.join(rec.savePath || '', rec.fileName || ''));
}

/** Every place the file may be while downloading: final dir or the client's incomplete dir, with or without the partial suffix. */
async function localCandidates(rec) {
  let extra = [];
  try {
    extra = await client.partialDirs();
  } catch {
    /* client hiccup: just try the final location */
  }
  const out = [];
  for (const dir of [rec.savePath || '', ...extra]) {
    const base = toLocal(path.posix.join(dir, rec.fileName || ''));
    out.push(base, ...client.partialSuffixes().map((s) => base + s));
  }
  return [...new Set(out)];
}

/** Start (or reuse) a download for a Stremio ID. Safe to call repeatedly. */
async function ensureDownload(type, id) {
  const existing = db.get(id);
  if (existing && existing.status !== 'error' && existing.status !== 'missing') return existing;
  if (inflight.has(id)) return inflight.get(id);

  const p = (async () => {
    try {
      const pick = await finder.resolve(type, id);
      const rec = db.set(id, {
        id,
        type,
        infoHash: pick.infoHash,
        fileIdx: pick.fileIdx,
        title: pick.title,
        status: 'queued',
        selected: false,
        progress: 0,
        error: null,
        createdAt: Date.now(),
        fileIndex: null,
        fileName: null,
        fileSize: null,
        fileOffset: null,
        pieceSize: null,
        savePath: null,
      });
      await client.add({ magnet: pick.magnet, hash: pick.infoHash });
      return rec;
    } catch (e) {
      db.set(id, { id, type, status: 'error', error: String(e.message || e) });
      throw e;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

async function selectFile(rec, files, t) {
  let idx = Number.isInteger(rec.fileIdx) && files[rec.fileIdx] ? rec.fileIdx : -1;
  if (idx < 0) {
    const all = files.map((f, i) => ({ f, i }));
    const vids = all.filter((x) => VIDEO.test(x.f.name));
    idx = (vids.length ? vids : all).sort((a, b) => b.f.size - a.f.size)[0].i;
  }

  // Only download the file we need - but keep files other records (same season pack) rely on.
  const wanted = new Set([idx]);
  for (const r of db.all()) {
    if (r.id !== rec.id && r.infoHash === rec.infoHash && r.selected && r.fileIndex != null &&
        r.status !== 'error' && r.status !== 'missing') wanted.add(r.fileIndex);
  }
  await client.setWanted(rec.infoHash, [...wanted], files.length);

  const { pieceSize } = await client.pieces(rec.infoHash);
  const fileOffset = files.slice(0, idx).reduce((s, f) => s + f.size, 0);
  return db.set(rec.id, {
    selected: true,
    status: 'downloading',
    fileIndex: idx,
    fileName: files[idx].name,
    fileSize: files[idx].size,
    fileOffset,
    pieceSize,
    savePath: t.savePath,
  });
}

async function syncOnce() {
  const recs = db.all().filter((r) => r.infoHash && r.status !== 'error' && r.status !== 'missing');
  if (!recs.length) return;

  const infos = await client.info([...new Set(recs.map((r) => r.infoHash))]);
  const byHash = new Map(infos.map((t) => [t.hash, t]));

  for (let rec of recs) {
    const t = byHash.get(rec.infoHash);

    if (rec.status === 'complete') {
      // Finished files stay playable even if the torrent is later removed from the client.
      if (!t && !fs.existsSync(localPath(rec))) db.set(rec.id, { status: 'missing' });
      continue;
    }
    if (!t) {
      if (Date.now() - rec.createdAt > 60000) db.set(rec.id, { status: 'missing' });
      continue;
    }
    if (t.error) {
      db.set(rec.id, { status: 'error', error: t.error });
      continue;
    }

    let files;
    try {
      files = await client.files(rec.infoHash);
    } catch {
      continue; // client hiccup: try again next round
    }
    if (!Array.isArray(files) || !files.length) continue;

    if (!rec.selected) rec = await selectFile(rec, files, t);
    const f = files[rec.fileIndex];
    if (!f) continue;
    const progress = Math.round(f.progress * 1000) / 1000;
    db.set(rec.id, { progress, status: progress >= 1 ? 'complete' : 'downloading', savePath: t.savePath });
  }
}

/** Polls the torrent client forever; the interval is re-read from settings each round. Returns a stop function. */
function startSync() {
  let timer = null;
  let stopped = false;
  const tick = async () => {
    try {
      await syncOnce();
    } catch (e) {
      console.error('[sync]', e.message);
    }
    if (!stopped) timer = setTimeout(tick, cfg.syncIntervalMs);
  };
  timer = setTimeout(tick, cfg.syncIntervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const ACTIVE = (r) => r.status !== 'error' && r.status !== 'missing';

/** Other records that still need this record's torrent (same season pack). */
function sharers(rec) {
  return db.all().filter((r) => r.id !== rec.id && r.infoHash === rec.infoHash && r.selected && ACTIVE(r));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function need(id) {
  const rec = db.get(id);
  if (!rec) throw httpError(404, 'unknown download');
  return rec;
}

async function torrentOf(rec) {
  if (!rec.infoHash) return null;
  const [t] = await client.info([rec.infoHash]);
  return t || null;
}

async function pause(id) {
  const rec = need(id);
  if (!(await torrentOf(rec))) throw httpError(409, 'not in the torrent client');
  await client.stop(rec.infoHash);
}

async function resume(id) {
  const rec = need(id);
  if (!(await torrentOf(rec))) throw httpError(409, 'not in the torrent client');
  await client.start(rec.infoHash);
}

/**
 * Stops downloading this item but keeps whatever is on disk. A shared torrent (season pack) stays in the
 * client for the other episodes; only this file is dropped from it. A complete file stays playable.
 */
async function removeFromClient(id) {
  const rec = need(id);
  if (await torrentOf(rec)) {
    const others = sharers(rec);
    if (others.length) await dropFile(rec, others);
    else await client.remove(rec.infoHash, { deleteFiles: false });
  }
  if (rec.status !== 'complete') db.set(id, { status: 'missing' });
  return db.get(id);
}

async function dropFile(rec, others) {
  if (rec.fileIndex == null) return;
  const files = await client.files(rec.infoHash);
  if (files && files.length) await client.setWanted(rec.infoHash, others.map((r) => r.fileIndex), files.length);
}

/** True if `p` is inside the local downloads dir (symlinks resolved), so we never delete anything else. */
function insideDownloads(p) {
  let root;
  let real;
  try {
    root = fs.realpathSync(cfg.localPathPrefix);
    real = path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return false;
  }
  return real.startsWith(root + path.sep);
}

/** Deletes this record's file(s) straight from disk, then empty parent dirs up to the downloads root. */
async function unlinkLocal(rec) {
  let deleted = 0;
  if (!rec.fileName) return deleted; // never got as far as picking a file
  for (const p of await localCandidates(rec)) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!insideDownloads(p)) throw httpError(400, `refusing to delete outside the downloads folder: ${p}`);
    try {
      fs.unlinkSync(p);
      deleted++;
    } catch (e) {
      if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
        throw httpError(500, `cannot delete ${p} (${e.code}): mount the downloads folder read-write in the add-on container`);
      }
      throw e;
    }
    const root = fs.realpathSync(cfg.localPathPrefix);
    for (let dir = path.dirname(p); insideDownloads(dir) && dir !== root; dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir); // only succeeds when empty
      } catch {
        break;
      }
    }
  }
  return deleted;
}

/**
 * Deletes the downloaded file and forgets the record. Through the client while it owns the torrent alone;
 * for a shared torrent, or one that is already gone from the client, this file is deleted directly.
 */
async function deleteFiles(id) {
  const rec = need(id);
  const t = await torrentOf(rec);
  const others = t ? sharers(rec) : [];
  if (t && !others.length) {
    await client.remove(rec.infoHash, { deleteFiles: true });
  } else {
    if (t) await dropFile(rec, others);
    await unlinkLocal(rec);
  }
  db.delete(id);
}

/** Starts over for an item whose download failed or disappeared. */
async function redownload(id) {
  const rec = need(id);
  if (ACTIVE(rec)) throw httpError(409, `already ${rec.status}`);
  return ensureDownload(rec.type, id);
}

/** Drops the record only; the torrent client and the disk are left alone. */
function forget(id) {
  need(id);
  db.delete(id);
}

const view = (r, t) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  status: r.status,
  progress: r.progress || 0,
  error: r.error || null,
  fileName: r.fileName || null,
  size: r.fileSize || null,
  createdAt: r.createdAt || null,
  // Live torrent state, when the client knows the torrent.
  inClient: !!t,
  paused: !!t && t.state === 'paused',
  clientState: t ? t.state : null,
  dlSpeed: t && r.status !== 'complete' ? t.dlSpeed : null,
  eta: t && r.status !== 'complete' && t.eta > 0 && t.eta < 8640000 ? t.eta : null,
  shared: !!r.infoHash && sharers(r).length > 0,
});

/** All records, newest first, merged with live client state (best effort: records still list if the client is down). */
async function list() {
  const recs = db.all().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  let byHash = new Map();
  const hashes = [...new Set(recs.map((r) => r.infoHash).filter(Boolean))];
  let clientError = null;
  if (hashes.length) {
    try {
      byHash = new Map((await client.info(hashes)).map((t) => [t.hash, t]));
    } catch (e) {
      clientError = e.message;
    }
  }
  return { items: recs.map((r) => view(r, byHash.get(r.infoHash))), clientError };
}

module.exports = {
  ensureDownload,
  startSync,
  syncOnce,
  localPath,
  localCandidates,
  view,
  list,
  pause,
  resume,
  removeFromClient,
  deleteFiles,
  redownload,
  forget,
};
