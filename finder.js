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

/** @returns {Promise<{infoHash:string, fileIdx:number|null, title:string, magnet:string}>} */
async function resolve(type, id) {
  const res = await fetch(`${cfg.torrentioUrl}/stream/${type}/${id}.json`, {
    headers: { 'User-Agent': 'stremio-local-addon/0.1' },
  });
  if (!res.ok) throw new Error(`Torrentio lookup failed (${res.status})`);
  const { streams = [] } = await res.json();

  const cands = streams
    .filter((s) => s.infoHash)
    .map((s) => {
      const text = `${s.name || ''}\n${s.title || ''}`;
      return { s, res: resolution(text), seeders: seeders(text) };
    });
  if (!cands.length) throw new Error(`No torrents found for ${id}`);

  const capped = cands.filter((c) => c.res <= cfg.maxRes);
  const pool = capped.length ? capped : cands;
  pool.sort((a, b) => b.seeders - a.seeders || b.res - a.res);

  const best = pool[0].s;
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

module.exports = { resolve };
