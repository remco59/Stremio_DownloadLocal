// Torznab (Jackett / Prowlarr) as a torrent source. Searches by IMDb ID, plus season/episode for series.
// Jackett: one URL for all indexers (.../api/v2.0/indexers/all/results/torznab/).
// Prowlarr: one URL per indexer (http://prowlarr:9696/<id>/api) - list several, they are searched in parallel.
const cfg = require('../config');
const { resolution, parseSize, languages, isPack, magnetFor } = require('./parse');

const urls = () =>
  String(cfg.torznabUrls || '')
    .split(/[\s,]+/)
    .filter(Boolean);

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Minimal Torznab RSS parser: enough for title/size/link/enclosure and torznab:attr values. */
function parseFeed(xml) {
  const items = [];
  for (const [, body] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const tag = (name) => {
      const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(body);
      return m ? decode(m[1]).trim() : '';
    };
    const attrs = {};
    for (const [, k, v] of body.matchAll(/<(?:torznab|newznab):attr\s+name="([^"]+)"\s+value="([^"]*)"/g)) attrs[k] = decode(v);
    const enclosure = /<enclosure\b[^>]*\burl="([^"]+)"/.exec(body);
    items.push({ title: tag('title'), size: tag('size'), link: tag('link'), enclosure: enclosure ? decode(enclosure[1]) : '', attrs });
  }
  const error = /<error\b[^>]*description="([^"]*)"/.exec(xml);
  return { items, error: error ? decode(error[1]) : null };
}

function toCandidate(it, indexer) {
  const magnet = [it.attrs.magneturl, it.link, it.enclosure].find((u) => u && u.startsWith('magnet:'));
  let infoHash = (it.attrs.infohash || '').toLowerCase();
  if (!infoHash && magnet) infoHash = ((/btih:([0-9a-z]{32,40})/i.exec(magnet) || [])[1] || '').toLowerCase();
  // Without an info hash the add-on cannot track the download (a .torrent-only result), so skip it.
  if (!/^[0-9a-f]{40}$/.test(infoHash)) return null;
  const size = Number(it.size || it.attrs.size) || parseSize(it.title);
  return {
    source: indexer ? `Torznab (${indexer})` : 'Torznab',
    title: it.title,
    infoHash,
    magnet: magnet || magnetFor(infoHash, it.title),
    fileIdx: null,
    size: size || null,
    seeders: parseInt(it.attrs.seeders || '0', 10) || 0,
    res: resolution(it.title),
    languages: languages(it.title),
    pack: isPack(it.title),
  };
}

async function searchOne(base, type, id) {
  const [imdb, season, episode] = id.split(':');
  const u = new URL(base);
  if (!u.pathname.endsWith('/api')) u.pathname = u.pathname.replace(/\/?$/, '/api');
  u.searchParams.set('apikey', cfg.torznabApiKey || '');
  u.searchParams.set('t', type === 'movie' ? 'movie' : 'tvsearch');
  u.searchParams.set('imdbid', imdb);
  if (season) u.searchParams.set('season', season);
  if (episode) u.searchParams.set('ep', episode);
  u.searchParams.set('limit', '100');
  const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Torznab ${u.host} -> ${res.status}`);
  const { items, error } = parseFeed(text);
  if (error) throw new Error(`Torznab ${u.host}: ${error}`);
  return items.map((it) => toCandidate(it, u.host)).filter(Boolean);
}

/** @returns {Promise<object[]>} normalized candidates from every configured Torznab URL (failures only logged) */
async function search(type, id) {
  const list = urls();
  if (!list.length) throw new Error('No Torznab URL configured');
  const results = await Promise.allSettled(list.map((u) => searchOne(u, type, id)));
  const ok = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === results.length) throw failed[0].reason;
  failed.forEach((r) => console.error('[torznab]', r.reason.message));
  return ok;
}

module.exports = { name: 'torznab', search, parseFeed };
