const express = require('express');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const dl = require('./downloads');
const { serveFile } = require('./stream');

const ID_RE = /^tt\d+(:\d+:\d+)?$/;
const valid = (type, id) => (type === 'movie' || type === 'series') && ID_RE.test(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CINEMETA = 'https://v3-cinemeta.strem.io';

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
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const router = express.Router();
router.use(express.json());

const baseUrl = (req) => `${cfg.publicUrl || `${req.protocol}://${req.get('host')}`}/${cfg.token}`;

router.get('/manifest.json', (req, res) => res.json(manifest));

// What Stremio asks for on every title/episode page
router.get('/stream/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  res.set('Cache-Control', 'max-age=0, no-cache');
  if (!valid(type, id)) return res.json({ streams: [] });

  const rec = db.get(id);
  const url = `${baseUrl(req)}/play/${type}/${encodeURIComponent(id)}`;
  const hints = { notWebReady: true, bingeGroup: 'local-download' };
  let stream;

  if (rec && rec.status === 'complete') {
    stream = { name: '🏠 Your server', description: `Watch from your server\n${rec.title || ''}`, url, behaviorHints: hints };
  } else if (rec && (rec.status === 'downloading' || rec.status === 'queued')) {
    const pct = Math.round((rec.progress || 0) * 100);
    stream = {
      name: `⏳ Your server ${pct}%`,
      description: `Downloading... playable up to the downloaded part\n${rec.title || ''}`,
      url,
      behaviorHints: hints,
    };
  } else {
    stream = {
      name: '⬇️ Download',
      description: 'Download and watch\nStarts a download on your server',
      url,
      behaviorHints: hints,
    };
  }
  res.json({ streams: [stream], cacheMaxAge: 0 });
});

// Play URL: starts the download if needed, waits for metadata, then serves ranges
router.all('/play/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!valid(type, id)) return res.status(400).send('bad id');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);

  let gone = false;
  res.on('close', () => (gone = true));

  try {
    await dl.ensureDownload(type, id);
    const deadline = Date.now() + cfg.waitForStartMs;
    let rec = db.get(id);
    while (rec && !rec.selected && rec.status !== 'error' && Date.now() < deadline && !gone) {
      await sleep(1000);
      rec = db.get(id);
    }
    if (gone) return;
    if (!rec || !rec.selected) {
      return res
        .status(503)
        .set('Retry-After', '30')
        .send(rec && rec.error ? rec.error : 'Download started, still fetching torrent metadata. Try again in a minute.');
    }
    await serveFile(req, res, rec);
  } catch (e) {
    console.error('[play]', id, e.message);
    if (!res.headersSent) res.status(502).send(String(e.message));
    else res.destroy();
  }
});

// ---- Web UI + JSON API -------------------------------------------------------------------------
router.get('/', (req, res) => res.type('html').send(fs.readFileSync(path.join(__dirname, 'ui.html'))));

router.get('/api/downloads', (req, res) => {
  const list = db.all().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(dl.view);
  res.json(list);
});

router.post('/api/download', async (req, res) => {
  const { type, id } = req.body || {};
  if (!valid(type, id)) return res.status(400).json({ error: 'bad type/id' });
  try {
    res.json(dl.view(await dl.ensureDownload(type, id)));
  } catch (e) {
    res.status(502).json({ error: String(e.message) });
  }
});

async function cinemeta(p, res) {
  try {
    const r = await fetch(`${CINEMETA}${p}`);
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: String(e.message) });
  }
}
router.get('/api/search', (req, res) => {
  const type = req.query.type === 'series' ? 'series' : 'movie';
  cinemeta(`/catalog/${type}/top/search=${encodeURIComponent(String(req.query.q || ''))}.json`, res);
});
router.get('/api/meta/:type/:id', (req, res) => {
  if (!valid(req.params.type, req.params.id)) return res.status(400).json({ error: 'bad id' });
  cinemeta(`/meta/${req.params.type}/${req.params.id}.json`, res);
});

app.use(`/${cfg.token}`, router);

module.exports = app;

if (require.main === module) {
  dl.startSync();
  app.listen(cfg.port, () => {
    const shown = cfg.publicUrl || `http://<server-ip>:${cfg.port}`;
    console.log(`Listening on :${cfg.port}`);
    console.log(`Install in Stremio: ${shown}/${cfg.token}/manifest.json`);
    console.log(`Download UI:        ${shown}/${cfg.token}/`);
  });
}
