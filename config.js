const env = process.env;
const strip = (s) => (s || '').replace(/\/+$/, '');

const config = {
  port: parseInt(env.PORT || '7000', 10),

  // Secret path segment. Everything (manifest, streams, UI) lives under /<ADDON_TOKEN>/
  token: env.ADDON_TOKEN || '',

  // Public HTTPS URL of this add-on (e.g. https://stremio.yourdomain.com). If empty, derived from request headers.
  publicUrl: strip(env.PUBLIC_URL),

  dataDir: env.DATA_DIR || '/data',

  qb: {
    url: strip(env.QB_URL || 'http://qbittorrent:8080'),
    user: env.QB_USER || '',
    pass: env.QB_PASS || '',
    category: env.QB_CATEGORY || 'stremio',
  },

  // Path remap: how qBittorrent sees the downloads dir vs. how THIS container sees it.
  // If you mount the same host folder at /downloads in both containers, leave both as /downloads.
  qbPathPrefix: strip(env.QB_PATH_PREFIX || '/downloads'),
  localPathPrefix: strip(env.LOCAL_PATH_PREFIX || '/downloads'),

  // Where to look up torrents (placeholder resolver, see finder.js)
  torrentioUrl: strip(env.TORRENTIO_URL || 'https://torrentio.strem.fun'),
  maxRes: parseInt(env.MAX_RES || '1080', 10),

  waitForStartMs: 45000, // how long /play holds the request while waiting for torrent metadata
  stallMs: 30000, // how long a stream waits for the next pieces before giving up
  syncIntervalMs: 5000,
};

if (!/^[A-Za-z0-9_-]{16,}$/.test(config.token)) {
  console.error('ADDON_TOKEN is required: 16+ characters, letters/digits/-/_ only.');
  process.exit(1);
}

module.exports = config;
