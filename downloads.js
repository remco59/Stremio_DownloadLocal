// Download state machine: queued -> downloading -> complete (or error / missing).
// db is the source of truth for the add-on; the torrent client (clients/) is polled to keep it current.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const client = require('./clients');
const finder = require('./finder');
const { sidecarIndexes } = require('./subtitles');

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

/**
 * Start (or reuse) a download for a Stremio ID. Safe to call repeatedly.
 * `opts.pick` is a torrent chosen by hand in the web UI: it replaces the current torrent if that differs
 * (the old one is removed from the client, its files stay). Other opts go to finder.resolve.
 */
async function ensureDownload(type, id, opts = {}) {
  const existing = db.get(id);
  const replace = opts.pick && existing && ACTIVE(existing) && existing.infoHash !== opts.pick.infoHash;
  if (existing && ACTIVE(existing) && !replace) return existing;
  if (inflight.has(id)) return inflight.get(id);

  const p = (async () => {
    try {
      if (replace) await removeFromClient(id);
      const pick = opts.pick || (await finder.resolve(type, id, opts));
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
        progressAt: Date.now(),
        tried: opts.tried || [],
        fileIndex: null,
        fileName: null,
        subFiles: null,
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

/** Exclusive end (within the file) of the downloaded run starting at `pos`, given the piece map. `pos` if none. */
function availableFrom(rec, have, pos) {
  const ps = rec.pieceSize;
  let p = Math.floor((rec.fileOffset + pos) / ps);
  if (!have[p]) return pos;
  while (p < have.length && have[p]) p++;
  return Math.min(rec.fileSize, p * ps - rec.fileOffset);
}

/** Does a file name belong to season `s`, episode `e`? (S01E02, s1e2, 1x02) */
function isEpisode(name, s, e) {
  const n = path.posix.basename(name);
  return new RegExp(`(?:^|[^a-z0-9])(?:s0*${s}[ ._-]?e0*${e}|0*${s}x0*${e})(?![0-9])`, 'i').test(n);
}

/** File indexes a record needs from its torrent: the video and its subtitle files. */
const wantedBy = (r) => [r.fileIndex, ...(r.subFiles || []).map((f) => f.index)];

async function selectFile(rec, files, t) {
  let idx = Number.isInteger(rec.fileIdx) && files[rec.fileIdx] ? rec.fileIdx : -1;
  if (idx < 0) {
    const all = files.map((f, i) => ({ f, i }));
    let vids = all.filter((x) => VIDEO.test(x.f.name));
    // Episode inside a season pack without a known file index: find it by name.
    const [, season, episode] = rec.id.split(':');
    if (episode) {
      const match = vids.filter((x) => isEpisode(x.f.name, season, episode));
      if (match.length) vids = match;
    }
    idx = (vids.length ? vids : all).sort((a, b) => b.f.size - a.f.size)[0].i;
  }

  // Only download the file we need, plus subtitle files that come with it (for the web player) - but keep
  // files other records (same season pack) rely on.
  const subFiles = sidecarIndexes(files, idx).map((i) => ({ index: i, name: files[i].name }));
  const wanted = new Set([idx, ...subFiles.map((f) => f.index)]);
  for (const r of db.all()) {
    if (r.id !== rec.id && r.infoHash === rec.infoHash && r.selected && r.fileIndex != null &&
        r.status !== 'error' && r.status !== 'missing') wantedBy(r).forEach((i) => wanted.add(i));
  }
  await client.setWanted(rec.infoHash, [...wanted], files.length);

  const { pieceSize } = await client.pieces(rec.infoHash);
  const fileOffset = files.slice(0, idx).reduce((s, f) => s + f.size, 0);
  return syncPatch(rec, {
    selected: true,
    status: 'downloading',
    fileIndex: idx,
    subFiles,
    fileName: files[idx].name,
    fileSize: files[idx].size,
    fileOffset,
    pieceSize,
    savePath: t.savePath,
  });
}

/**
 * Applies a sync result to `rec` (the round's snapshot), unless a user action changed the record while the
 * round was waiting on the client: Delete files / Forget (gone), Remove (status), a hand-picked torrent
 * (info hash). Check and write happen in one synchronous step, so nothing can slip in between.
 */
function syncPatch(rec, patch) {
  const cur = db.get(rec.id);
  if (!cur || cur.infoHash !== rec.infoHash || cur.status !== rec.status) return null;
  return db.update(rec.id, patch);
}

async function syncOnce() {
  const recs = db.all().filter((r) => r.infoHash && r.status !== 'error' && r.status !== 'missing');
  if (!recs.length) return;

  const infos = await client.info([...new Set(recs.map((r) => r.infoHash))]);
  const byHash = new Map(infos.map((t) => [t.hash, t]));
  const haves = new Map(); // piece maps fetched this round (episodes of one pack share one)

  for (let rec of recs) {
    const t = byHash.get(rec.infoHash);

    if (rec.status === 'complete') {
      // Finished files stay playable even if the torrent is later removed from the client.
      // (It may still sit in the client's incomplete dir if the torrent was removed right after finishing.)
      if (!t && !(await localCandidates(rec)).some((p) => fs.existsSync(p))) syncPatch(rec, { status: 'missing' });
      continue;
    }
    if (!t) {
      if (Date.now() - rec.createdAt > 60000) syncPatch(rec, { status: 'missing' });
      continue;
    }
    if (t.error) {
      syncPatch(rec, { status: 'error', error: t.error });
      continue;
    }
    // Time spent paused or waiting on the client does not count as a stall (nor time before this check existed).
    if (IDLE.has(t.state) || !rec.progressAt) {
      rec = syncPatch(rec, { progressAt: Date.now() });
      if (!rec) continue;
    } else if (stuckAtZero(rec)) {
      await switchTorrent(rec);
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
    if (!rec) continue; // deleted while we were busy
    const f = files[rec.fileIndex];
    if (!f) continue;
    const progress = Math.round(f.progress * 1000) / 1000;
    // How far it plays from the start (sequential download keeps this close to `progress`).
    let playable = progress >= 1 ? 1 : rec.playable || 0;
    if (progress < 1 && rec.fileSize) {
      try {
        if (!haves.has(rec.infoHash)) haves.set(rec.infoHash, (await client.pieces(rec.infoHash)).have);
        playable = Math.round((availableFrom(rec, haves.get(rec.infoHash), 0) / rec.fileSize) * 1000) / 1000;
      } catch {
        /* keep the last value */
      }
    }
    const progressAt = progress > (rec.progress || 0) ? Date.now() : rec.progressAt;
    syncPatch(rec, { progress, playable, progressAt, status: progress >= 1 ? 'complete' : 'downloading', savePath: t.savePath });
  }
}

const IDLE = new Set(['paused', 'queued', 'checking']);

/** Nothing of the file has arrived for `stallSwitchMin` minutes. */
function stuckAtZero(rec) {
  return cfg.stallSwitchMin > 0 && !rec.progress && Date.now() - rec.progressAt > cfg.stallSwitchMin * 60000;
}

/**
 * Replaces a torrent that never got going (dead swarm, no metadata) with the next best one that was not tried
 * yet for this title. Without one, the current torrent keeps going and the next attempt waits another round.
 */
async function switchTorrent(rec) {
  const tried = [...new Set([...(rec.tried || []), rec.infoHash])];
  let pick;
  try {
    pick = await finder.resolve(rec.type, rec.id, { exclude: tried });
  } catch (e) {
    console.error('[stall]', rec.id, `no other torrent to try: ${e.message}`);
    syncPatch(rec, { progressAt: Date.now(), tried });
    return;
  }
  // Same check as syncPatch: the user may have removed, deleted or re-picked it while we searched.
  const cur = db.get(rec.id);
  if (!cur || cur.infoHash !== rec.infoHash || cur.status !== rec.status) return;
  console.log('[stall]', rec.id, `no progress for ${cfg.stallSwitchMin} min, switching to ${pick.title}`);
  await ensureDownload(rec.type, rec.id, { pick, tried }).catch((e) => console.error('[stall]', rec.id, e.message));
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
  if (rec.status !== 'complete') db.update(id, { status: 'missing' });
  return db.get(id);
}

async function dropFile(rec, others) {
  if (rec.fileIndex == null) return;
  const files = await client.files(rec.infoHash);
  if (files && files.length) await client.setWanted(rec.infoHash, others.flatMap(wantedBy), files.length);
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
  const paths = await localCandidates(rec);
  for (const f of rec.subFiles || []) paths.push(...(await localCandidates({ ...rec, fileName: f.name })));
  for (const p of paths) {
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

/**
 * Deletes several items (a season, a whole show) one after the other, never in parallel: episodes of one season
 * pack share a torrent, and each delete decides from the ones still left whether the torrent goes too.
 */
async function deleteMany(ids) {
  const deleted = [];
  const failed = [];
  for (const id of new Set(ids)) {
    try {
      await deleteFiles(id);
      deleted.push(id);
    } catch (e) {
      failed.push({ id, error: String(e.message) });
    }
  }
  return { deleted, failed };
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

/** The file a record plays, without the torrent's folders: the episode itself inside a season pack. */
const fileLabel = (r) => (r.fileName ? path.posix.basename(r.fileName.replace(/\\/g, '/')) : null);

const view = (r, t) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  label: fileLabel(r),
  status: r.status,
  progress: r.progress || 0,
  // How far it plays from the start (what Stremio shows as "Playable up to N%").
  playable: r.status === 'complete' ? 1 : r.playable || 0,
  progressAt: r.progressAt || null,
  tried: (r.tried || []).length,
  error: r.error || null,
  fileName: r.fileName || null,
  size: r.fileSize || null,
  createdAt: r.createdAt || null,
  // Live torrent state, when the client knows the torrent.
  inClient: !!t,
  paused: !!t && t.state === 'paused',
  clientState: t ? t.state : null,
  dlSpeed: t && r.status !== 'complete' ? t.dlSpeed : null,
  seeds: t && r.status !== 'complete' ? t.seeds ?? null : null,
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
  availableFrom,
  isEpisode,
  ensureDownload,
  startSync,
  syncOnce,
  localPath,
  localCandidates,
  view,
  fileLabel,
  list,
  pause,
  resume,
  removeFromClient,
  deleteFiles,
  deleteMany,
  redownload,
  forget,
};
