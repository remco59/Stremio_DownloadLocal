// Episode titles from Cinemeta, to tell which episode a file in a season pack really is. Release groups number
// seasons their own way: Race to the Edge packs count 26 episodes per season where Cinemeta has 13, so
// "[S04E02] Crash Course.mkv" is Cinemeta's S5E2. The title in the file name gives that away.
const cfg = require('./config');

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // "tt123" -> { at, eps: Promise<object[]|null> }

/** Lower case, accents dropped, everything but letters and digits as single spaces. */
const norm = (s) =>
  ` ${String(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

// Part of a two-parter: "Night of the Hunters (1)", "... - Part 1", "...Pt1".
const PART_RE = /(?:\b(?:part|pt)[ ._-]*(\d{1,2})|\((\d{1,2})\))/i;
const partOf = (s) => {
  const m = PART_RE.exec(s);
  return m ? +(m[1] || m[2]) : null;
};

/** One Cinemeta video -> { season, episode, base, part }, or null when its title says nothing ("Episode 3"). */
function entry(v, show) {
  const name = String(v.name || v.title || '');
  const base = norm(name.replace(PART_RE, ' '));
  if (base.trim().length < 5 || /^ (episode|chapter|part) \d+ $/.test(base) || base === show) return null;
  return { season: v.season, episode: v.episode, base, part: partOf(name) };
}

/** A Cinemeta series meta -> its titled episodes. */
function fromMeta(meta) {
  const show = norm(meta?.name || '');
  return (meta?.videos || []).filter((v) => v.season > 0).map((v) => entry(v, show)).filter(Boolean);
}

async function load(tt) {
  try {
    const res = await fetch(`${cfg.cinemetaUrl}/meta/series/${tt}.json`, { signal: AbortSignal.timeout(cfg.cinemetaTimeoutMs) });
    if (!res.ok) return null;
    return fromMeta((await res.json()).meta);
  } catch {
    return null; // no titles: the check is skipped, the season/episode codes still count
  }
}

/** The titled episodes of a series (cached), or null when Cinemeta did not answer. */
function episodesOf(tt) {
  const hit = cache.get(tt);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.eps;
  const eps = load(tt);
  cache.set(tt, { at: Date.now(), eps });
  eps.then((list) => list || cache.delete(tt)); // try again next time after a failure
  return eps;
}

/**
 * Whose title does this file name carry? 'own' (episode s/e), 'other' (another episode of the show), or null
 * (no title, or one several episodes share). The longest title found wins, so "Gold" does not hide "Gold Rush".
 */
function titleMatch(eps, fileName, s, e) {
  if (!eps) return null;
  const base = String(fileName).split('/').pop().replace(/\.[a-z0-9]{2,4}$/i, '');
  const name = norm(base);
  const part = partOf(base);
  const found = eps.filter((x) => name.includes(x.base) && (x.part == null || x.part === part));
  if (!found.length) return null;
  const longest = Math.max(...found.map((x) => x.base.length));
  const top = found.filter((x) => x.base.length === longest);
  const own = top.filter((x) => x.season === s && x.episode === e);
  if (own.length === top.length) return 'own';
  return own.length ? null : 'other';
}

module.exports = { episodesOf, titleMatch, fromMeta };
