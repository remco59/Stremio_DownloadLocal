// Torrentio (or a compatible Stremio stream add-on) as a torrent source.
const cfg = require('../config');
const { resolution, parseSize, languages, isPack, magnetFor } = require('./parse');

const seeders = (t) => {
  const m = /👤\s*(\d+)/.exec(t);
  return m ? parseInt(m[1], 10) : 0;
};

/** @returns {Promise<object[]>} normalized candidates (see finder.js) */
async function search(type, id) {
  const res = await fetch(`${cfg.torrentioUrl}/stream/${type}/${id}.json`, {
    headers: { 'User-Agent': 'stremio-local-addon/0.1' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Torrentio lookup failed (${res.status})`);
  const { streams = [] } = await res.json();
  return streams
    .filter((s) => s.infoHash)
    .map((s) => {
      const text = `${s.name || ''}\n${s.title || ''}`;
      const title = (s.title || s.name || '').split('\n')[0];
      const infoHash = s.infoHash.toLowerCase();
      const trackers = (s.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => x.slice(8));
      return {
        source: 'Torrentio',
        title,
        infoHash,
        magnet: magnetFor(infoHash, title, trackers),
        fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
        size: parseSize(s.title || ''),
        seeders: seeders(text),
        res: resolution(text),
        languages: languages(text),
        pack: isPack(title),
      };
    });
}

module.exports = { name: 'torrentio', search };
