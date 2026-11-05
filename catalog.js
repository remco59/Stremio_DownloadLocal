// Stremio catalogs: one home-screen row of downloaded movies and one of downloaded series, most recently
// downloaded first. Only finished downloads count. A series shows once, ranked by its newest finished episode.
// Stremio shows what we return as is, so names and posters come from Cinemeta (cached, see discover.js).
const db = require('./db');
const { cinemeta, pool, META_TTL } = require('./discover');

const PAGE = 100; // Stremio pages with skip=<n>
const CATALOGS = [
  { type: 'movie', id: 'local-movies', name: 'Recently downloaded', extra: [{ name: 'skip' }] },
  { type: 'series', id: 'local-series', name: 'Recently downloaded', extra: [{ name: 'skip' }] },
];

/** Finished titles of `type`, newest first: [{ id: 'tt…', at, title }]. */
function titles(type) {
  const byTt = new Map();
  for (const r of db.all()) {
    if (r.status !== 'complete') continue;
    const isEpisode = r.id.includes(':');
    if (isEpisode !== (type === 'series')) continue;
    const tt = r.id.split(':')[0];
    const at = r.completedAt || r.createdAt || 0;
    const cur = byTt.get(tt);
    if (!cur || at > cur.at) byTt.set(tt, { id: tt, at, title: isEpisode ? '' : r.title || '' });
  }
  return [...byTt.values()].sort((a, b) => b.at - a.at);
}

async function metas(type, catalogId, skip = 0) {
  if (!CATALOGS.some((c) => c.type === type && c.id === catalogId)) return [];
  const page = titles(type).slice(skip, skip + PAGE);
  const found = await pool(page, 6, (t) => cinemeta(`/meta/${type}/${t.id}.json`, META_TTL));
  // Cinemeta not answering: still list the title (Stremio loads the details itself), just without a poster.
  return page.map((t, i) => {
    const m = (found[i] && found[i].meta) || {};
    return {
      id: t.id,
      type,
      name: m.name || t.title || t.id,
      ...(m.poster && { poster: m.poster }),
      ...(m.releaseInfo && { releaseInfo: m.releaseInfo }),
      posterShape: 'poster',
    };
  });
}

module.exports = { CATALOGS, metas, titles };
