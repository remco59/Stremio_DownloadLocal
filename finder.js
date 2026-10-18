// Picks a torrent for a Stremio ID.
// PLACEHOLDER resolver: asks a Torrentio instance for candidates and takes the best-seeded one under MAX_RES.
// Swap this file out later (Jackett/Prowlarr, own scoring, etc.) as long as resolve() keeps its return shape.
const cfg = require('./config');

const RES = { '2160p': 2160, '4k': 2160, '1080p': 1080, '720p': 720, '480p': 480 };
const resolution = (t) => {
  const m = /(2160p|4k|1080p|720p|480p)/i.exec(t);
  return m ? RES[m[1].toLowerCase()] : 0;
};
const seeders = (t) => {
  const m = /👤\s*(\d+)/.exec(t);
  return m ? parseInt(m[1], 10) : 0;
};

// Season packs: "S01" / "Season 1" / "Complete" without a single-episode marker like "S01E02".
const isPack = (t) => /\b(s\d{1,2}(?!\s*e\d)|season\s*\d+|complete)\b/i.test(t) && !/\bs\d{1,2}\s*e\d{1,3}\b/i.test(t);

/**
 * @param {object} [opts]
 * @param {string[]} [opts.preferHashes] torrents already used for sibling episodes: reuse one if it has this episode
 * @param {boolean} [opts.preferPack] for batch downloads: favour a reasonably seeded season pack
 * @returns {Promise<{infoHash:string, fileIdx:number|null, title:string, magnet:string}>}
 */
async function resolve(type, id, { preferHashes = [], preferPack = false } = {}) {
  const res = await fetch(`${cfg.torrentioUrl}/stream/${type}/${id}.json`, {
    headers: { 'User-Agent': 'stremio-local-addon/0.1' },
  });
  if (!res.ok) throw new Error(`Torrentio lookup failed (${res.status})`);
  const { streams = [] } = await res.json();

  const cands = streams
    .filter((s) => s.infoHash)
    .map((s) => {
      const text = `${s.name || ''}\n${s.title || ''}`;
      return { s, res: resolution(text), seeders: seeders(text), pack: isPack(s.title || '') };
    });
  if (!cands.length) throw new Error(`No torrents found for ${id}`);

  const capped = cands.filter((c) => c.res <= cfg.maxRes);
  const pool = capped.length ? capped : cands;
  pool.sort((a, b) => b.seeders - a.seeders || b.res - a.res);

  // Same torrent as a sibling episode: keeps a season in one torrent (and one folder).
  const reuse = pool.find((c) => preferHashes.includes(c.s.infoHash.toLowerCase()));
  // A pack only wins if it is not much worse seeded than the best single release.
  const pack = preferPack && pool.find((c) => c.pack && c.seeders >= Math.max(1, pool[0].seeders / 4));
  const best = (reuse || pack || pool[0]).s;
  const title = (best.title || '').split('\n')[0];
  const trackers = (best.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => x.slice(8));
  const magnet =
    `magnet:?xt=urn:btih:${best.infoHash}&dn=${encodeURIComponent(title)}` +
    trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');

  return {
    infoHash: best.infoHash.toLowerCase(),
    fileIdx: Number.isInteger(best.fileIdx) ? best.fileIdx : null,
    title,
    magnet,
  };
}

module.exports = { resolve, isPack };
