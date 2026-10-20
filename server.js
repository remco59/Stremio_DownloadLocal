const express = require('express');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const dl = require('./downloads');
const batch = require('./batch');
const finder = require('./finder');
const settings = require('./settings');
const { serveFile, parseRange, availableUntil } = require('./stream');
const { decide } = require('./play');
const security = require('./security');
const auth = require('./auth');
const player = require('./player');
const subtitles = require('./subtitles');
const discover = require('./discover');
const statusclip = require('./statusclip');

const ID_RE = /^tt\d+(:\d+:\d+)?$/;
const valid = (type, id) => (type === 'movie' || type === 'series') && ID_RE.test(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The episode's own file name once it is known; the torrent name (a whole season pack, say) until then.
const label = (rec) => dl.fileLabel(rec) || rec.title || '';

const manifest = {
  id: 'community.local.download-and-watch',
  version: '0.1.0',
  name: 'Local Download & Watch',
  description: 'Adds a stream that downloads the title to your own server and plays it from there.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const app = express();
// Only a reverse proxy on a private/loopback address may set X-Forwarded-For (Nginx Proxy Manager on the Docker
// network). Trusting any proxy would let clients pick their own IP and dodge the per-IP limits.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
app.use((req, res, next) => {
  // Stremio (web) fetches the add-on from other origins; the web UI's API is same-origin only.
  if (!req.path.startsWith('/api/')) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer'); // the token is in every add-on URL: never leak it via Referer
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const locked = security.lockedFor(req.ip);
  if (locked) return res.status(429).set('Retry-After', String(Math.ceil(locked / 1000))).type('text').send('Too many requests');
  next();
});

// Two parts: the add-on for Stremio under /<token>/ (manifest, streams, playback), and the web UI at / with its
// JSON API under /api/, behind a username/password login (auth.js).
const addon = express.Router();
const router = express.Router();
const json = express.json({ limit: '32kb' });
addon.use(json);

// Per-IP limit on everything that changes something.
function limitWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const r = security.takeApiWrite(req.ip);
  if (r.ok) return next();
  res.status(429).set('Retry-After', String(Math.ceil(r.retryMs / 1000))).json({ error: 'Too many requests, try again in a minute' });
}

const baseUrl = (req) => `${cfg.publicUrl || `${req.protocol}://${req.get('host')}`}/${cfg.token}`;

addon.get('/manifest.json', (req, res) => res.json(manifest));

// What Stremio asks for on every title/episode page
addon.get('/stream/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  res.set('Cache-Control', 'max-age=0, no-cache');
  if (!valid(type, id)) return res.json({ streams: [] });

  const rec = db.get(id);
  const url = `${baseUrl(req)}/play/${type}/${encodeURIComponent(id)}`;
  // Only entries that play real video join the binge group: Stremio must never auto-play a "Download"
  // entry for the next episode (that would start a download and show a status clip, episode after episode).
  const hints = { notWebReady: true, bingeGroup: 'local-download' };
  const noBinge = { notWebReady: true };
  let stream;

  if (rec && rec.status === 'complete') {
    stream = { name: '🏠 Your server', description: `Watch from your server\n${label(rec)}`, url, behaviorHints: hints };
  } else if (rec && (rec.status === 'downloading' || rec.status === 'queued')) {
    const pct = Math.round((rec.progress || 0) * 100);
    const playable = Math.floor((rec.playable || 0) * 100);
    stream = {
      name: `⏳ Your server ${pct}%`,
      description: `${playable ? `Playable up to ${playable}%` : 'Downloading, not playable yet'}\n${label(rec)}`,
      url,
      behaviorHints: hints,
    };
  } else {
    stream = {
      name: '⬇️ Download',
      description: 'Download and watch\nStarts a download on your server',
      url,
      behaviorHints: noBinge,
    };
  }
  res.json({ streams: [stream], cacheMaxAge: 0 });
});

// Play URL: starts the download if needed (answering with a status clip right away), then plays the file as soon
// as its start is there. A tap that would take too long gets a short status clip instead (Stremio would otherwise
// show a playback error).
addon.all('/play/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.status(400).send('bad id');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);

  // Starting a new download is rate limited; playing what is already there is not.
  const known = db.get(id);
  const isNew = !known || known.status === 'error' || known.status === 'missing';
  if (isNew) {
    const r = security.takePlayStart(req.ip);
    if (!r.ok) return res.status(429).set('Retry-After', String(Math.ceil(r.retryMs / 1000))).type('text').send('Too many new downloads, try again in a minute');
  }

  let gone = false;
  res.on('close', () => (gone = true));
  const since = Date.now();

  if (isNew) {
    // New download: the torrent search and the client round trip can take most of a minute, so do not make
    // Stremio wait for them. Show the status clip now; the next tap finds the record (or the error) in place.
    // A title whose last attempt failed is retried the same way, and shows that failure meanwhile.
    dl.ensureDownload(type, id).catch((e) => console.error('[play]', id, e.message));
    return clip(req, res, known && known.status === 'error' ? 'error' : 'started', { type, id });
  }
  try {
    await dl.ensureDownload(type, id);
  } catch (e) {
    console.error('[play]', id, e.message);
    return clip(req, res, 'error', { type, id });
  }
  try {
    for (;;) {
      if (gone) return;
      const rec = db.get(id);
      let start = 0;
      let avail = null;
      if (rec && rec.selected) {
        const range = parseRange(req.headers.range, rec.fileSize);
        if (!range) return res.status(416).set('Content-Range', `bytes */${rec.fileSize}`).end();
        start = range.start;
        try {
          avail = await availableUntil(rec, start);
          if (rec.status !== 'complete' && avail > start && (await dl.missingOnDisk(rec))) avail = start;
        } catch {
          /* client hiccup: treat as not there yet */
        }
      }
      const next = decide({ rec, start, avail, elapsed: Date.now() - since, cfg });
      if (next.action === 'serve') return await serveFile(req, res, rec);
      if (next.action === 'clip') return clip(req, res, next.clip, { type, id });
      if (next.action === 'unavailable') {
        return res
          .status(503)
          .set('Retry-After', '60')
          .type('text')
          .send('Not downloaded this far yet. Play from an earlier point, or wait for the download to get here.');
      }
      await sleep(500);
    }
  } catch (e) {
    console.error('[play]', id, e.message);
    if (!res.headersSent) res.status(502).send(String(e.message));
    else res.destroy();
  }
});

// What Stremio is sent to while a download cannot play yet. Redirecting keeps the player's range requests on the
// clip itself instead of mixing it up with the real file behind the same /play URL. Normally that is the live status
// screen of the title (statusclip.js); where ffmpeg cannot draw it, a fixed clip (clips/*.mp4, scripts/make-clips.js).
const CLIPS = new Set(['started', 'metadata', 'error']);
async function clip(req, res, name, { type, id }) {
  res.set('Cache-Control', 'no-store');
  if (await statusclip.available()) return res.redirect(302, `${baseUrl(req)}/clip/live/${type}/${encodeURIComponent(id)}.mp4`);
  res.redirect(302, `${baseUrl(req)}/clip/${name}.mp4`);
}
addon.get('/clip/live/:type/:id.mp4', async (req, res) => {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.sendStatus(404);
  try {
    if (await statusclip.stream(req, res, id)) return;
  } catch (e) {
    console.error('[status]', id, e.message);
    if (res.headersSent) return res.destroy();
  }
  res.set('Cache-Control', 'no-store').redirect(302, `${baseUrl(req)}/clip/${statusclip.fixedClip(db.get(id))}.mp4`);
});
addon.get('/clip/:name.mp4', (req, res) => {
  if (!CLIPS.has(req.params.name)) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'clips', `${req.params.name}.mp4`));
});

// The web UI used to live here (/<token>/): send it to / once there is a login, show the page that creates one until
// then. Holding the token proves this is the owner, so only the first login can be made this way.
const toRoot = (req) => (req.originalUrl.split('?')[0].endsWith('/') ? '../' : './');
addon.get('/', async (req, res, next) => {
  try {
    if (await auth.configured()) return res.redirect(302, toRoot(req));
    page(res, 'login.html', 'setup');
  } catch (e) {
    next(e);
  }
});
addon.post('/setup', limitWrites, async (req, res, next) => {
  const { user, password } = req.body || {};
  try {
    if (await auth.configured()) return res.status(409).json({ error: 'A login already exists' });
    auth.startSession(req, res, await auth.setAccount(user, password));
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
// An old web UI tab still polling its former API: answer instead of counting towards the wrong-URL lockout.
addon.use('/api', (req, res) => res.status(410).json({ error: 'The web UI moved: reload the page', login: true }));

// ---- Web UI + JSON API -------------------------------------------------------------------------
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:", // posters come from Cinemeta's image hosts
  "connect-src 'self'",
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// Favicon, PWA manifest, icons and service worker: public (browsers fetch them without the login cookie).
router.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: '1d',
  setHeaders: (res, file) => {
    if (path.basename(file) === 'sw.js') res.set('Cache-Control', 'no-cache');
  },
}));
function page(res, file, mode) {
  res.set({ 'Content-Security-Policy': UI_CSP, 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
  let html = fs.readFileSync(path.join(__dirname, file), 'utf8');
  if (mode) html = html.replace('data-mode="login"', `data-mode="${mode}"`);
  res.type('html').send(html);
}
router.get('/', async (req, res, next) => {
  try {
    if (await auth.sessionUser(req, res)) return page(res, 'ui.html');
    page(res, 'login.html', (await auth.configured()) ? 'login' : 'none');
  } catch (e) {
    next(e);
  }
});

router.post('/login', json, limitWrites, async (req, res, next) => {
  const { user, password } = req.body || {};
  try {
    const acc = await auth.login(user, password);
    if (!acc) {
      security.noteFailure(req.ip, 'login');
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    security.noteSuccess(req.ip, 'login');
    auth.startSession(req, res, acc);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.use('/api', json, async (req, res, next) => {
  try {
    if (await auth.sessionUser(req, res)) return next();
  } catch (e) {
    return next(e);
  }
  res.status(401).json({ error: 'Not logged in', login: true });
}, limitWrites);

router.post('/api/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

// Who is logged in, and the add-on token (the UI shows the Stremio install URL and plays through /<token>/play).
router.get('/api/session', async (req, res) => {
  res.json({ user: await auth.sessionUser(req), token: cfg.token, fromEnv: auth.fromEnv(), minPassword: auth.MIN_PASSWORD });
});

// Changes the login. Needs the current password; logs every other session out.
router.post('/api/account', async (req, res, next) => {
  const { currentPassword, user, password } = req.body || {};
  try {
    const current = await auth.login(await auth.sessionUser(req), currentPassword);
    if (!current) {
      security.noteFailure(req.ip, 'login');
      return res.status(403).json({ error: 'Current password is wrong', field: 'currentPassword' });
    }
    const acc = await auth.setAccount(typeof user === 'string' && user.trim() ? user.trim() : current.user, password);
    auth.startSession(req, res, acc);
    res.json({ ok: true, user: acc.user });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/api/downloads', async (req, res) => res.json({ ...(await dl.list()), batchPending: batch.pending() }));

// Per-item actions from the downloads page. :id is a Stremio ID (URL-encoded, episodes contain ':').
const ACTIONS = {
  pause: dl.pause,
  resume: dl.resume,
  remove: dl.removeFromClient,
  'delete-files': dl.deleteFiles,
  redownload: dl.redownload,
};
async function act(fn, req, res) {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  try {
    await fn(req.params.id);
    const item = (await dl.list()).items.find((d) => d.id === req.params.id) || null;
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message) });
  }
}
router.post('/api/downloads/:id/:action', (req, res) => {
  const fn = ACTIONS[req.params.action];
  if (!fn) return res.status(404).json({ error: 'unknown action' });
  act(fn, req, res);
});
router.delete('/api/downloads/:id', (req, res) => act(dl.forget, req, res));

// Library: deletes the files of many items in one request (a whole season or show). Per-item failures are
// reported next to what did get deleted.
router.post('/api/library/delete', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((id) => typeof id === 'string' && ID_RE.test(id))) {
    return res.status(400).json({ error: 'ids must be a list of Stremio IDs' });
  }
  res.json(await dl.deleteMany(ids));
});

// Ranked torrents for the manual picker (rejected ones last, with the reason).
router.get('/api/candidates/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.status(400).json({ error: 'bad type/id' });
  try {
    const current = db.get(id);
    const list = (await finder.candidates(type, id)).slice(0, 60);
    res.json({ current: current && current.infoHash, candidates: list.map(({ magnet, ...c }) => c) });
  } catch (e) {
    res.status(502).json({ error: String(e.message) });
  }
});

// { type, id } downloads the best torrent; with infoHash, that torrent from the picker list.
router.post('/api/download', async (req, res) => {
  const { type, id, infoHash } = req.body || {};
  if (!valid(type, id)) return res.status(400).json({ error: 'bad type/id' });
  try {
    let pick;
    if (infoHash != null) {
      pick = await finder.findCandidate(type, id, infoHash);
      if (!pick) return res.status(404).json({ error: 'that torrent is not in the search results (anymore)' });
    }
    res.json(dl.view(await dl.ensureDownload(type, id, { pick })));
  } catch (e) {
    res.status(502).json({ error: String(e.message) });
  }
});

// ---- web player (player.js) ----
// What a file holds (audio and subtitle tracks, whether the browser can play it as it is), conversions for
// what it cannot, and subtitles as WebVTT. Only for items whose file is (partly) on the server.
async function playerRoute(req, res, fn) {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.status(400).json({ error: 'bad type/id' });
  try {
    if (!(await player.available())) return res.status(501).json({ error: 'ffmpeg is not installed on the server', ffmpeg: false });
    await fn(db.get(id));
  } catch (e) {
    if (!e.status) console.error('[player]', id, e.message);
    if (!res.headersSent) res.status(e.status || 502).json({ error: String(e.message) });
    else res.destroy();
  }
}
const num = (v, max) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : NaN;
};
router.get('/api/player/:type/:id', (req, res) => playerRoute(req, res, async (rec) => res.json(await player.details(rec, req))));
router.get('/api/player/:type/:id/keyframe', (req, res) => playerRoute(req, res, async (rec) => {
  const t = num(req.query.t, 1e6);
  if (!(t >= 0)) return res.status(400).json({ error: 'bad t' });
  res.json({ t: await player.keyframe(rec, req, t) });
}));
// stream.mp4 or stream.webm ?audio=<stream>&t=<seconds>&copy=1 (the browser plays the video codec)&burn=<image subtitle stream>
router.get('/api/player/:type/:id/stream.:format(mp4|webm)', (req, res) => playerRoute(req, res, async (rec) => {
  const q = { audio: num(req.query.audio, 999), t: num(req.query.t, 1e6) ?? 0, format: req.params.format, copyVideo: req.query.copy === '1', burn: num(req.query.burn, 999) };
  if (Number.isNaN(q.audio) || Number.isNaN(q.burn) || Number.isNaN(q.t)) return res.status(400).json({ error: 'bad parameters' });
  await player.stream(req, res, rec, q);
}));
router.get('/api/player/:type/:id/subtitles/:key.vtt', (req, res) => {
  const { key } = req.params;
  if (!/^(e\d{1,3}|x\d{1,2})$/.test(key)) return res.status(400).json({ error: 'bad subtitle' });
  playerRoute(req, res, (rec) => player.subtitle(req, res, rec, key));
});
// Online subtitles (a Stremio subtitles add-on) need neither the file nor ffmpeg.
router.get('/api/subtitles/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.status(400).json({ error: 'bad type/id' });
  try {
    res.json({ subtitles: (await subtitles.online(type, id)).map(({ url, ...s }) => s) }); // eslint-disable-line no-unused-vars
  } catch (e) {
    res.status(502).json({ error: `online subtitles: ${e.message}` });
  }
});
router.get('/api/subtitles/:type/:id/:key.vtt', async (req, res) => {
  const { type, id, key } = req.params;
  if (!valid(type, id) || !/^o[A-Za-z0-9_-]{1,64}$/.test(key)) return res.status(400).json({ error: 'bad subtitle' });
  try {
    res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' }).send(await subtitles.onlineVtt(type, id, key));
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message) });
  }
});

router.get('/api/settings', (req, res) => res.json(settings.view()));

router.put('/api/settings', (req, res) => {
  try {
    res.json(settings.update(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message, field: e.field || null });
  }
});

// Tests the chosen client with the values from the form (missing ones and a blank password = saved values).
router.post('/api/settings/test-client', async (req, res) => {
  const { client = cfg.torrentClient, values } = req.body || {};
  try {
    res.json(await settings.testClient(client, values));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/settings/rotate-token', (req, res) => {
  try {
    const token = settings.rotateToken((req.body || {}).token);
    res.json({ token, manifestUrl: `${baseUrl(req)}/manifest.json` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Whole show (no season) or one season: queues every episode that is not on the server yet.
router.post('/api/download/batch', async (req, res) => {
  const { id, season } = req.body || {};
  try {
    res.json(await batch.queueBatch({ id, season: season == null ? undefined : season }));
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message) });
  }
});

// Discover: recommendations from what is on the server. ?played= lists the Stremio IDs the web player has a
// position for (kept in the browser), which count as watched.
router.get('/api/discover', async (req, res) => {
  const played = String(req.query.played || '').split(',').filter((id) => ID_RE.test(id)).slice(0, 500);
  try {
    res.json(await discover.recommend({ played }));
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message) });
  }
});
// "Not interested": { id } hides a title from Discover; DELETE shows every hidden title again.
router.post('/api/discover/hidden', (req, res) => {
  try {
    discover.hide(String((req.body || {}).id || ''));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message) });
  }
});
router.delete('/api/discover/hidden', (req, res) => {
  discover.unhideAll();
  res.json({ ok: true });
});

// Cinemeta sits behind Cloudflare, which gives up on a query Cinemeta has not cached yet after ~6 s and sends a
// 504 error page (not JSON); sometimes nothing comes back at all. Cinemeta finishes and caches the answer anyway,
// so retrying with growing pauses gets it. A 4xx is final, and the whole thing stops after CINEMETA_DEADLINE_MS.
const CINEMETA_DEADLINE_MS = 45000;
async function cinemeta(p, res) {
  const deadline = Date.now() + CINEMETA_DEADLINE_MS;
  let error;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${cfg.cinemetaUrl}${p}`, { signal: AbortSignal.timeout(Math.max(1, Math.min(cfg.cinemetaTimeoutMs, deadline - Date.now()))) });
      const text = await r.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        error = `Cinemeta did not answer properly (HTTP ${r.status}), try again in a moment`;
      }
      if (body !== undefined) return res.status(r.status).json(body);
    } catch (e) {
      error = e.name === 'TimeoutError' ? 'Cinemeta did not answer in time, try again in a moment' : String(e.message);
    }
    const pause = cfg.cinemetaRetryMs[attempt];
    if (pause == null || (r && r.status < 500) || Date.now() + pause >= deadline) break;
    await sleep(pause);
  }
  res.status(502).json({ error });
}
router.get('/api/search', (req, res) => {
  const type = req.query.type === 'series' ? 'series' : 'movie';
  cinemeta(`/catalog/${type}/top/search=${encodeURIComponent(String(req.query.q || ''))}.json`, res);
});
router.get('/api/meta/:type/:id', (req, res) => {
  if (!valid(req.params.type, req.params.id)) return res.status(400).json({ error: 'bad id' });
  cinemeta(`/meta/${req.params.type}/${req.params.id}.json`, res);
});

app.use(router);
// The token is read per request so a rotation from the settings page applies immediately.
app.use('/:token', (req, res, next) => {
  if (!security.tokenOk(req.params.token)) return next();
  security.noteSuccess(req.ip);
  addon(req, res, next);
});

// Anything else: a plain 404 that does not echo the path, and a strike towards the wrong-token lockout.
const HARMLESS = new Set(['/favicon.ico', '/robots.txt', '/apple-touch-icon.png']);
app.use((req, res) => {
  if (!HARMLESS.has(req.path)) security.noteFailure(req.ip);
  res.status(404).type('text').send('Not found');
});
// Errors (e.g. a JSON body that is too large or malformed) without stack traces.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 500).type('text').send(err.status && err.status < 500 ? err.message : 'Server error');
});

module.exports = app;

if (require.main === module) {
  try {
    require('./clients').active();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  dl.startSync();
  app.listen(cfg.port, async () => {
    const shown = cfg.publicUrl || `http://<server-ip>:${cfg.port}`;
    console.log(`Listening on :${cfg.port} (torrent client: ${cfg.torrentClient})`);
    console.log(`Install in Stremio: ${shown}/${cfg.token}/manifest.json`);
    console.log(`Web UI:             ${shown}/`);
    if (!(await auth.configured())) console.log(`No web UI login yet, create one at ${shown}/${cfg.token}/`);
  });
}
