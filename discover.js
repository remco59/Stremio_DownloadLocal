// Discover: titles you might like, to download next. Add-ons get no watch history from Stremio, so what is on the
// server is the taste profile: the genres, directors, writers and cast of every title downloaded (newer ones
// count more, whole shows more than one episode, titles played in the web player more than unplayed ones).
// Candidates come from Cinemeta's catalogs (popular and top rated in your favourite genres, and this year's
// releases), scored against that profile. Titles already on the server, or hidden with "Not interested", never show.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');

const DAY = 86400000;
const META_TTL = 7 * DAY;
const CATALOG_TTL = DAY / 4;
const MAX_SEEDS = 30; // titles the profile is built from (the most important ones)
const ROW_SIZE = 20;
const MIN_ROW = 4; // rows with fewer titles are left out
const TT_RE = /^tt\d+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// ---- Cinemeta, cached: metas barely change, catalogs a few times a day ----
const cache = new Map(); // path -> { at, value: Promise }
function cinemeta(p, ttl) {
  const hit = cache.get(p);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = fetchJson(p);
  value.catch(() => cache.delete(p));
  cache.set(p, { at: Date.now(), value });
  return value;
}
// One retry on a 5xx or a timeout (Cinemeta is behind Cloudflare, see server.js); a 4xx is final.
async function fetchJson(p) {
  for (let attempt = 0; ; attempt++) {
    let final = false;
    try {
      const r = await fetch(`${cfg.cinemetaUrl}${p}`, { signal: AbortSignal.timeout(cfg.cinemetaTimeoutMs) });
      if (r.ok) return await r.json();
      final = r.status < 500;
      throw new Error(`Cinemeta answered HTTP ${r.status}`);
    } catch (e) {
      const pause = cfg.cinemetaRetryMs[attempt];
      if (final || attempt >= 1 || pause == null) throw e;
      await sleep(pause);
    }
  }
}
/** Runs `fn` over `items`, at most `n` at a time; failures become null. */
async function pool(items, n, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        /* left out */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---- "Not interested", kept in DATA_DIR/discover.json ----
const file = () => path.join(cfg.dataDir, 'discover.json');
let hiddenSet = null;
function hidden() {
  if (!hiddenSet) {
    try {
      hiddenSet = new Set(JSON.parse(fs.readFileSync(file(), 'utf8')).hidden || []);
    } catch {
      hiddenSet = new Set();
    }
  }
  return hiddenSet;
}
function saveHidden() {
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ hidden: [...hidden()] }, null, 2));
  fs.renameSync(tmp, file());
}
function hide(tt) {
  if (!TT_RE.test(tt)) throw Object.assign(new Error('bad id'), { status: 400 });
  hidden().add(tt);
  saveHidden();
}
function unhideAll() {
  hidden().clear();
  saveHidden();
}

// ---- the profile ----
/**
 * The titles the profile is built from, most important first. `played`: Stremio IDs (movies or episodes) the
 * web player has a position for.
 */
function seeds(played = []) {
  const now = Date.now();
  const byTt = new Map();
  const add = (id, type, at) => {
    const tt = id.split(':')[0];
    const s = byTt.get(tt) || { tt, type, items: 0, at: 0, played: false };
    s.items++;
    s.at = Math.max(s.at, at || 0);
    byTt.set(tt, s);
    return s;
  };
  for (const rec of db.all()) add(rec.id, rec.type || (rec.id.includes(':') ? 'series' : 'movie'), rec.createdAt || rec.updatedAt);
  for (const id of played) {
    const tt = id.split(':')[0];
    (byTt.get(tt) || add(id, id.includes(':') ? 'series' : 'movie', now)).played = true;
  }
  for (const s of byTt.values()) {
    // Half the weight per 180 days since the latest download, but old favourites never drop below a quarter.
    const recency = Math.max(0.25, 0.5 ** ((now - (s.at || now)) / (180 * DAY)));
    s.weight = (1 + Math.log2(s.items)) * (s.played ? 1.5 : 1) * recency;
  }
  return [...byTt.values()].sort((a, b) => b.weight - a.weight);
}

const people = (m) => [...list(m.director).map((p) => ['dir', p]), ...list(m.writer).slice(0, 2).map((p) => ['wri', p]), ...list(m.cast).slice(0, 4).map((p) => ['cast', p])];
const genresOf = (m) => list(m.genres || m.genre);

function buildProfile(known) {
  const genres = new Map();
  const persons = new Map(); // name -> { weight, role, seeds: [seed] }
  const types = { movie: 0, series: 0 };
  for (const { seed, meta } of known) {
    types[seed.type] += seed.weight;
    const gs = genresOf(meta);
    for (const g of gs) genres.set(g, (genres.get(g) || 0) + seed.weight / Math.sqrt(gs.length));
    for (const [role, name] of people(meta)) {
      const p = persons.get(name) || { weight: 0, role, seeds: [] };
      p.weight += seed.weight;
      if (role === 'dir') p.role = 'dir';
      p.seeds.push(seed);
      persons.set(name, p);
    }
  }
  const top = Math.max(...genres.values(), 1e-9);
  for (const [g, w] of genres) genres.set(g, w / top);
  const best = Math.max(...known.map((k) => k.seed.weight), 1e-9);
  for (const p of persons.values()) p.weight /= best;
  const total = types.movie + types.series || 1;
  return { genres, persons, share: { movie: types.movie / total, series: types.series / total } };
}

// ---- candidates ----
const rating = (m) => parseFloat(m.imdbRating) || 0;
function released(m, now) {
  const t = m.released ? Date.parse(m.released) : NaN;
  return Number.isNaN(t) || t <= now;
}

/** How well `m` fits the profile, with the strongest reason. */
function score(m, profile, rank) {
  const gs = genresOf(m);
  let g = 0;
  for (const x of gs) g += profile.genres.get(x) || 0;
  g = gs.length ? g / Math.sqrt(gs.length) : 0;
  let p = 0;
  let who = null;
  for (const [role, name] of people(m)) {
    const hit = profile.persons.get(name);
    if (!hit) continue;
    const w = hit.weight * (role === 'dir' ? 1.4 : role === 'wri' ? 1 : 0.8);
    p += w;
    if (!who || w > who.w) who = { w, role, name };
  }
  const r = rating(m);
  return {
    // A 9.6 from a few dozen votes should not beat a well-known 8.5: the rating counts up to 8.8.
    score: 2 * g + Math.min(p, 2.5) + (r ? (Math.min(r, 8.8) - 6.5) * 0.35 : -0.2) + 0.3 * (1 - rank),
    who,
  };
}

/** How alike two titles are (for "Because you have ..."). */
function similarity(a, b) {
  const ga = new Set(genresOf(a));
  const gb = genresOf(b);
  const shared = gb.filter((g) => ga.has(g)).length;
  const union = new Set([...ga, ...gb]).size || 1;
  const pa = new Set(people(a).map(([, n]) => n));
  const sharedPeople = people(b).filter(([, n]) => pa.has(n)).length;
  return shared / union + 0.6 * Math.min(sharedPeople, 3);
}

function item(m, type, reason) {
  return {
    id: m.imdb_id || m.id,
    type,
    name: m.name || '',
    poster: m.poster || '',
    year: m.releaseInfo || m.year || '',
    rating: m.imdbRating || '',
    genres: genresOf(m).slice(0, 3),
    reason,
  };
}

function whoText(who) {
  return who.role === 'dir' ? `From ${who.name}` : who.role === 'wri' ? `Written by ${who.name}` : `With ${who.name}`;
}

/**
 * Rows of recommendations. With nothing on the server yet: what is popular and top rated.
 * @param {{played?: string[]}} opts
 */
async function recommend({ played = [] } = {}) {
  const now = Date.now();
  const all = seeds(played);
  const onServer = new Set(all.map((s) => s.tt));
  const skip = hidden();
  const year = new Date(now).getFullYear();

  const seedMetas = (await pool(all.slice(0, MAX_SEEDS), 4, async (seed) => {
    const { meta } = await cinemeta(`/meta/${seed.type}/${seed.tt}.json`, META_TTL);
    return meta ? { seed, meta } : null;
  })).filter(Boolean);
  const cold = !seedMetas.length;
  const profile = buildProfile(seedMetas);
  const favGenres = [...profile.genres].sort((a, b) => b[1] - a[1]).map(([g]) => g);

  // Which catalogs to pull: both types when starting cold, else the ones you download (any share worth noting).
  const types = cold ? ['movie', 'series'] : ['movie', 'series'].filter((t) => profile.share[t] >= 0.15);
  const wanted = [];
  for (const t of types) {
    wanted.push({ t, p: `/catalog/${t}/top.json`, kind: 'top' });
    wanted.push({ t, p: `/catalog/${t}/imdbRating.json`, kind: 'rated' });
    wanted.push({ t, p: `/catalog/${t}/year/genre=${year}.json`, kind: 'new' });
    for (const g of favGenres.slice(0, 3)) {
      wanted.push({ t, p: `/catalog/${t}/top/genre=${encodeURIComponent(g)}.json`, kind: 'top', genre: g });
      wanted.push({ t, p: `/catalog/${t}/imdbRating/genre=${encodeURIComponent(g)}.json`, kind: 'rated', genre: g });
    }
  }
  const catalogs = await pool(wanted, 4, async (w) => ({ ...w, metas: ((await cinemeta(w.p, CATALOG_TTL)).metas || []) }));
  if (catalogs.every((c) => c == null)) throw Object.assign(new Error('Cinemeta did not answer, try again in a moment'), { status: 502 });

  // Every candidate once per type, with where it was found.
  const cands = new Map(); // 'type:tt' -> { m, type, rank, from: Set }
  for (const c of catalogs) {
    if (!c) continue;
    c.metas.forEach((m, i) => {
      const tt = m.imdb_id || m.id;
      if (!TT_RE.test(tt || '') || onServer.has(tt) || skip.has(tt) || !released(m, now)) return;
      const k = `${c.t}:${tt}`;
      const e = cands.get(k) || { m, type: c.t, rank: 1, from: new Set() };
      e.rank = Math.min(e.rank, i / Math.max(c.metas.length, 1));
      e.from.add(c.kind + (c.genre ? ':' + c.genre : ''));
      cands.set(k, e);
    });
  }
  const candidates = [...cands.values()];
  for (const e of candidates) Object.assign(e, score(e.m, profile, e.rank));

  const shown = new Set();
  const rows = [];
  const pushRow = (key, title, picked, reason) => {
    const items = [];
    for (const e of picked) {
      const tt = e.m.imdb_id || e.m.id;
      if (shown.has(tt)) continue;
      items.push(item(e.m, e.type, reason(e)));
      if (items.length >= ROW_SIZE) break;
    }
    if (items.length < MIN_ROW) return;
    items.forEach((x) => shown.add(x.id));
    rows.push({ key, title, items });
  };
  const byScore = (a, b) => b.score - a.score;
  const typeName = { movie: 'Movies', series: 'Series' };

  if (cold) {
    for (const t of types) pushRow(`popular-${t}`, `Popular ${typeName[t].toLowerCase()}`, candidates.filter((e) => e.type === t && e.from.has('top')).sort((a, b) => a.rank - b.rank), () => '');
    for (const t of types) pushRow(`new-${t}`, `New ${typeName[t].toLowerCase()} this year`, candidates.filter((e) => e.type === t && e.from.has('new')).sort((a, b) => a.rank - b.rank), () => '');
    for (const t of types) pushRow(`rated-${t}`, `Top rated ${typeName[t].toLowerCase()}`, candidates.filter((e) => e.type === t && e.from.has('rated')).sort((a, b) => rating(b.m) - rating(a.m)), () => '');
    return { basedOn: 0, genres: [], rows, hidden: skip.size };
  }

  const genreReason = (e) => genresOf(e.m).filter((g) => profile.genres.get(g) >= 0.3).slice(0, 2).join(' · ');
  const reason = (e) => (e.who ? whoText(e.who) : genreReason(e));
  const favType = types.slice().sort((a, b) => profile.share[b] - profile.share[a]);

  for (const t of favType) pushRow(`for-you-${t}`, `${typeName[t]} for you`, candidates.filter((e) => e.type === t).sort(byScore), reason);

  // "Because you have X" for the strongest titles on the server.
  for (const { seed, meta } of seedMetas.slice(0, 3)) {
    const near = candidates
      .filter((e) => e.type === seed.type)
      .map((e) => ({ e, s: similarity(meta, e.m) + 0.15 * e.score }))
      .filter((x) => x.s > 0.65)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
    pushRow(`because-${seed.tt}`, `Because you have ${meta.name}`, near, (e) => (e.who ? whoText(e.who) : genresOf(e.m).slice(0, 2).join(' · ')));
  }

  for (const t of favType) pushRow(`new-${t}`, `New ${typeName[t].toLowerCase()} for you`, candidates.filter((e) => e.type === t && e.from.has('new')).sort(byScore), reason);

  for (const g of favGenres.slice(0, 2)) {
    for (const t of favType) {
      pushRow(`rated-${t}-${g}`, `Top rated ${g} ${typeName[t].toLowerCase()}`, candidates.filter((e) => e.type === t && genresOf(e.m).includes(g) && rating(e.m) >= 7).sort((a, b) => rating(b.m) - rating(a.m) || b.score - a.score), reason);
    }
  }

  return { basedOn: seedMetas.length, genres: favGenres.slice(0, 5), rows, hidden: skip.size };
}

module.exports = { recommend, hide, unhideAll, seeds };
