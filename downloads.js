// Download state machine: queued -> downloading -> complete (or error / missing).
// db is the source of truth for the add-on; qBittorrent is polled to keep it current.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const qb = require('./qbittorrent');
const finder = require('./finder');

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts)$/i;
const inflight = new Map();

function localPath(rec) {
  const full = path.posix.join(rec.savePath || '', rec.fileName || '');
  return full.startsWith(cfg.qbPathPrefix) ? cfg.localPathPrefix + full.slice(cfg.qbPathPrefix.length) : full;
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
      const ok = await qb.addMagnet(pick.magnet);
      if (!ok) {
        // "Fails." usually means the torrent is already in qBittorrent - fine if so.
        const present = await qb.info([pick.infoHash]);
        if (!present.length) throw new Error('qBittorrent rejected the torrent');
      }
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
  const drop = files.map((_, i) => i).filter((i) => !wanted.has(i));
  if (drop.length) await qb.setFilePriority(rec.infoHash, drop, 0);
  await qb.setFilePriority(rec.infoHash, [...wanted], 1);

  const props = await qb.properties(rec.infoHash);
  const fileOffset = files.slice(0, idx).reduce((s, f) => s + f.size, 0);
  return db.set(rec.id, {
    selected: true,
    status: 'downloading',
    fileIndex: idx,
    fileName: files[idx].name,
    fileSize: files[idx].size,
    fileOffset,
    pieceSize: props.piece_size,
    savePath: t.save_path,
  });
}

async function syncOnce() {
  const recs = db.all().filter((r) => r.infoHash && r.status !== 'error' && r.status !== 'missing');
  if (!recs.length) return;

  const infos = await qb.info([...new Set(recs.map((r) => r.infoHash))]);
  const byHash = new Map(infos.map((t) => [t.hash.toLowerCase(), t]));

  for (let rec of recs) {
    const t = byHash.get(rec.infoHash);

    if (rec.status === 'complete') {
      // Finished files stay playable even if the torrent is later removed from qBittorrent.
      if (!t && !fs.existsSync(localPath(rec))) db.set(rec.id, { status: 'missing' });
      continue;
    }
    if (!t) {
      if (Date.now() - rec.createdAt > 60000) db.set(rec.id, { status: 'missing' });
      continue;
    }
    if (/error|missingFiles/i.test(t.state)) {
      db.set(rec.id, { status: 'error', error: `qBittorrent state: ${t.state}` });
      continue;
    }

    let files;
    try {
      files = await qb.files(rec.infoHash);
    } catch {
      continue; // metadata not fetched yet
    }
    if (!Array.isArray(files) || !files.length) continue;

    if (!rec.selected) rec = await selectFile(rec, files, t);
    const f = files[rec.fileIndex];
    if (!f) continue;
    const progress = Math.round(f.progress * 1000) / 1000;
    db.set(rec.id, { progress, status: progress >= 1 ? 'complete' : 'downloading', savePath: t.save_path });
  }
}

function startSync() {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (e) {
      console.error('[sync]', e.message);
    } finally {
      running = false;
    }
  }, cfg.syncIntervalMs);
}

const view = (r) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  status: r.status,
  progress: r.progress || 0,
  error: r.error || null,
});

module.exports = { ensureDownload, startSync, syncOnce, localPath, view };
