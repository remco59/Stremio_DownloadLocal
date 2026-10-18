// Picks a torrent for a Stremio ID: asks the enabled sources (sources/), merges and de-duplicates their
// results by info hash, filters and scores them against the settings, and returns them best first.
const cfg = require('./config');
const { isPack } = require('./sources/parse');

const SOURCES = {
  torrentio: require('./sources/torrentio'),
  torznab: require('./sources/torznab'),
};

const list = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[,\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// Matches whole words in a release name, where dots/dashes/underscores/brackets also separate words.
function hasWord(title, word) {
  const t = ` ${title.toLowerCase().replace(/[._\-[\]()]/g, ' ')} `;
  return t.includes(` ${word.replace(/[._\-[\]()]/g, ' ')} `);
}

function enabledSources() {
  if (cfg.sources === 'both') return [SOURCES.torrentio, SOURCES.torznab];
  return [SOURCES[cfg.sources] || SOURCES.torrentio];
}

/**
 * Scores one candidate; `reasons` explain the score in the manual picker.
 * Hard filters (blocked words, size bounds, min seeders) set `rejected` instead.
 */
function score(c, { preferHashes = [], preferPack = false } = {}) {
  const reasons = [];
  let s = Math.log2(c.seeders + 1) * 10;
  reasons.push(`${c.seeders} seeders`);

  const blocked = list(cfg.blockKeywords).find((w) => hasWord(c.title, w));
  if (blocked) return { ...c, score: -Infinity, rejected: `blocked word "${blocked}"`, reasons };
  if (c.size != null && cfg.minSizeMb && c.size < cfg.minSizeMb * 2 ** 20) {
    return { ...c, score: -Infinity, rejected: `smaller than ${cfg.minSizeMb} MB`, reasons };
  }
  // A season pack is big by nature, so the max size only applies to single files.
  if (c.size != null && cfg.maxSizeGb && !c.pack && c.size > cfg.maxSizeGb * 2 ** 30) {
    return { ...c, score: -Infinity, rejected: `larger than ${cfg.maxSizeGb} GB`, reasons };
  }
  if (c.seeders < cfg.minSeeders) return { ...c, score: -Infinity, rejected: `fewer than ${cfg.minSeeders} seeders`, reasons };

  if (c.res > cfg.maxRes) {
    s -= 1000; // only picked when nothing fits the cap
    reasons.push(`above ${cfg.maxRes}p`);
  } else if (cfg.preferredRes && c.res === cfg.preferredRes) {
    s += 30;
    reasons.push(`${c.res}p preferred`);
  } else if (c.res) {
    s += c.res / 100; // tie-breaker: higher resolution within the cap
  }

  const langs = list(cfg.languages);
  const lang = langs.find((l) => c.languages.includes(l));
  if (lang) {
    s += 60; // strong: a watchable release in your language beats a better seeded one in another
    reasons.push(`language ${lang}`);
  }
  const kw = list(cfg.preferKeywords).filter((w) => hasWord(c.title, w));
  if (kw.length) {
    s += 15 * kw.length;
    reasons.push(`prefers ${kw.join(', ')}`);
  }
  if (preferPack && c.pack) {
    s += 25;
    reasons.push('season pack');
  }
  if (preferHashes.includes(c.infoHash)) {
    s += 10000;
    reasons.push('same torrent as other episodes');
  }
  return { ...c, score: Math.round(s * 10) / 10, rejected: null, reasons };
}

/**
 * All candidates for a title, best first (rejected ones last, with the reason).
 * @param {object} [opts] { preferHashes, preferPack } - see score()
 */
async function candidates(type, id, opts = {}) {
  const scored = (await fetchAll(type, id)).map((c) => score(c, opts));
  scored.sort((a, b) => (a.rejected ? 1 : 0) - (b.rejected ? 1 : 0) || b.score - a.score || b.seeders - a.seeders);
  return scored;
}

// Results of the last searches, so a torrent picked from the list can be downloaded without searching again.
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map(); // "type/id" -> { at, list }

async function fetchAll(type, id) {
  const results = await Promise.allSettled(enabledSources().map((src) => src.search(type, id)));
  const found = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (!found.length && errors.length) throw new Error(errors.join('; '));
  errors.forEach((e) => console.error('[finder]', id, e)); // one source failed, the others still count

  // Same torrent from several sources: keep the most informative entry.
  const byHash = new Map();
  for (const c of found) {
    const prev = byHash.get(c.infoHash);
    if (!prev) byHash.set(c.infoHash, c);
    else byHash.set(c.infoHash, {
      ...prev,
      seeders: Math.max(prev.seeders, c.seeders),
      size: prev.size || c.size,
      fileIdx: prev.fileIdx ?? c.fileIdx,
      languages: [...new Set([...prev.languages, ...c.languages])],
      source: prev.source.includes(c.source) ? prev.source : `${prev.source} + ${c.source}`,
    });
  }
  const merged = [...byHash.values()];
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  cache.set(`${type}/${id}`, { at: now, list: merged });
  return merged;
}

/** A specific torrent from the picker list (from the cache, or by searching again). */
async function findCandidate(type, id, infoHash) {
  const hit = cache.get(`${type}/${id}`);
  const all = hit && Date.now() - hit.at < CACHE_MS ? hit.list : await fetchAll(type, id);
  return all.find((c) => c.infoHash === String(infoHash).toLowerCase()) || null;
}

/**
 * @param {object} [opts] candidates() options, plus `exclude`: info hashes not to pick (torrents already tried)
 * @returns {Promise<{infoHash:string, fileIdx:number|null, title:string, magnet:string}>} the best candidate
 */
async function resolve(type, id, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const all = (await candidates(type, id, opts)).filter((c) => !exclude.has(c.infoHash));
  const best = all.find((c) => !c.rejected);
  if (!best) {
    if (!all.length && exclude.size) throw new Error(`No untried torrents left for ${id}`);
    throw new Error(all.length ? `No torrent for ${id} passed the filters (${all[0].rejected})` : `No torrents found for ${id}`);
  }
  return { infoHash: best.infoHash, fileIdx: best.fileIdx, title: best.title, magnet: best.magnet };
}

module.exports = { resolve, candidates, findCandidate, score, isPack, SOURCES };
