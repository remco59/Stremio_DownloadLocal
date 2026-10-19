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
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer'); // the token is in every URL: never leak it via Referer
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const locked = security.lockedFor(req.ip);
  if (locked) return res.status(429).set('Retry-After', String(Math.ceil(locked / 1000))).type('text').send('Too many requests');
  next();
});

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

// Per-IP limit on everything that changes something.
router.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const r = security.takeApiWrite(req.ip);
  if (r.ok) return next();
  res.status(429).set('Retry-After', String(Math.ceil(r.retryMs / 1000))).json({ error: 'Too many requests, try again in a minute' });
});

const baseUrl = (req) => `${cfg.publicUrl || `${req.protocol}://${req.get('host')}`}/${cfg.token}`;

router.get('/manifest.json', (req, res) => res.json(manifest));

// What Stremio asks for on every title/episode page
router.get('/stream/:type/:id.json', (req, res) => {
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

// Play URL: starts the download if needed, then plays the file as soon as its start is there. A first tap that
// would take too long gets a short status clip instead (Stremio would otherwise show a playback error).
router.all('/play/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.status(400).send('bad id');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);

  // Starting a new download is rate limited; playing what is already there is not.
  const known = db.get(id);
  if (!known || known.status === 'error' || known.status === 'missing') {
    const r = security.takePlayStart(req.ip);
    if (!r.ok) return res.status(429).set('Retry-After', String(Math.ceil(r.retryMs / 1000))).type('text').send('Too many new downloads, try again in a minute');
  }

  let gone = false;
  res.on('close', () => (gone = true));
  const since = Date.now();

  try {
    await dl.ensureDownload(type, id);
  } catch (e) {
    console.error('[play]', id, e.message);
    return clip(req, res, 'error');
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
        } catch {
          /* client hiccup: treat as not there yet */
        }
      }
      const next = decide({ rec, start, avail, elapsed: Date.now() - since, cfg });
      if (next.action === 'serve') return await serveFile(req, res, rec);
      if (next.action === 'clip') return clip(req, res, next.clip);
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

// Status clips (clips/*.mp4, see scripts/make-clips.sh). Redirecting keeps the player's range requests on the
// clip itself instead of mixing it up with the real file behind the same /play URL.
const CLIPS = new Set(['started', 'metadata', 'error']);
function clip(req, res, name) {
  res.set('Cache-Control', 'no-store').redirect(302, `${baseUrl(req)}/clip/${name}.mp4`);
}
router.get('/clip/:name.mp4', (req, res) => {
  if (!CLIPS.has(req.params.name)) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'clips', `${req.params.name}.mp4`));
});

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
router.get('/', (req, res) => {
  res.set({ 'Content-Security-Policy': UI_CSP, 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'ui.html')));
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
    const base = baseUrl(req);
    res.json({ token, uiUrl: `${base}/`, manifestUrl: `${base}/manifest.json` });
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

// The token is read per request so a rotation from the settings page applies immediately.
app.use('/:token', (req, res, next) => {
  if (!security.tokenOk(req.params.token)) return next();
  security.noteSuccess(req.ip);
  router(req, res, next);
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
  app.listen(cfg.port, () => {
    const shown = cfg.publicUrl || `http://<server-ip>:${cfg.port}`;
    console.log(`Listening on :${cfg.port} (torrent client: ${cfg.torrentClient})`);
    console.log(`Install in Stremio: ${shown}/${cfg.token}/manifest.json`);
    console.log(`Download UI:        ${shown}/${cfg.token}/`);
  });
}
