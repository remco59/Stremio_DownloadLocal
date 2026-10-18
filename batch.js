// Season / whole-show downloads: a batch of per-episode downloads, so every episode keeps its own record
// (and shows up correctly in Stremio). Torrent lookups run one at a time in the background so a whole
// show does not hammer the torrent source, and episodes of one season prefer to share a season pack.
const cfg = require('./config');
const db = require('./db');
const dl = require('./downloads');

const SERIES_RE = /^tt\d+$/;
const ACTIVE = new Set(['queued', 'downloading', 'complete']);

const jobs = []; // { id, season } episodes waiting for their torrent lookup
let running = false;
const packs = new Map(); // "tt123:1" -> info hashes already used for that season

async function seriesMeta(id) {
  const res = await fetch(`${cfg.cinemetaUrl}/meta/series/${id}.json`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) throw Object.assign(new Error(`Unknown series ${id}`), { status: 404 });
  if (!res.ok) throw new Error(`Cinemeta lookup failed (${res.status})`);
  const { meta } = await res.json();
  if (!meta) throw new Error(`Unknown series ${id}`);
  return meta;
}

/**
 * Plans a batch: every released, non-special episode of the show (or of one season) that is not on the
 * server or on its way yet. `error` / `missing` episodes are retried.
 * @returns {Promise<{queued:string[], skipped:{id:string, reason:string}[]}>}
 */
async function queueBatch({ id, season }) {
  if (!SERIES_RE.test(id)) throw Object.assign(new Error('bad series id'), { status: 400 });
  if (season != null && !(Number.isInteger(season) && season >= 1)) {
    throw Object.assign(new Error('season must be a number >= 1'), { status: 400 });
  }
  const meta = await seriesMeta(id);
  const now = Date.now();
  const episodes = (meta.videos || [])
    .filter((v) => v.season > 0 && (season == null || v.season === season))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (!episodes.length) throw Object.assign(new Error(season ? `no episodes in season ${season}` : 'no episodes found'), { status: 404 });

  const queued = [];
  const skipped = [];
  for (const v of episodes) {
    const epId = v.id || `${id}:${v.season}:${v.episode}`;
    const rec = db.get(epId);
    if (rec && ACTIVE.has(rec.status)) skipped.push({ id: epId, reason: rec.status });
    else if (v.released && Date.parse(v.released) > now) skipped.push({ id: epId, reason: 'not released yet' });
    else if (jobs.some((j) => j.id === epId)) skipped.push({ id: epId, reason: 'already waiting' });
    else {
      jobs.push({ id: epId, season: v.season });
      queued.push(epId);
    }
  }
  run();
  return { queued, skipped };
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (jobs.length) {
      const job = jobs[0];
      const key = job.id.split(':').slice(0, 2).join(':');
      const used = packs.get(key) || [];
      try {
        const rec = await dl.ensureDownload('series', job.id, { preferHashes: used, preferPack: true });
        if (rec && rec.infoHash && !used.includes(rec.infoHash)) packs.set(key, [...used, rec.infoHash]);
      } catch (e) {
        // ensureDownload already stored the error on the episode's record.
        console.error('[batch]', job.id, e.message);
      }
      jobs.shift();
    }
  } finally {
    running = false;
  }
}

/** Episodes still waiting for their torrent lookup. */
const pending = () => jobs.map((j) => j.id);

module.exports = { queueBatch, pending, seriesMeta };
