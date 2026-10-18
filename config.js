const env = process.env;
const strip = (s) => (s || '').replace(/\/+$/, '');

const config = {
  port: parseInt(env.PORT || '7000', 10),

  // Secret path segment. Everything (manifest, streams, UI) lives under /<ADDON_TOKEN>/
  token: env.ADDON_TOKEN || '',

  // Public HTTPS URL of this add-on (e.g. https://stremio.yourdomain.com). If empty, derived from request headers.
  publicUrl: strip(env.PUBLIC_URL),

  dataDir: env.DATA_DIR || '/data',

  // Which torrent client to use: a name registered in clients/index.js
  torrentClient: (env.TORRENT_CLIENT || 'qbittorrent').toLowerCase(),

  qbUrl: strip(env.QB_URL || 'http://qbittorrent:8080'),
  qbUser: env.QB_USER || '',
  qbPass: env.QB_PASS || '',
  qbCategory: env.QB_CATEGORY || 'stremio',

  // Transmission RPC endpoint; a bare http://host:9091 gets /transmission/rpc appended.
  trUrl: strip(env.TR_URL || 'http://transmission:9091/transmission/rpc'),
  trUser: env.TR_USER || '',
  trPass: env.TR_PASS || '',
  trLabel: env.TR_LABEL || 'stremio',
  trDownloadDir: strip(env.TR_DOWNLOAD_DIR), // empty = Transmission's own default

  // Path remap: how the torrent client sees the downloads dir vs. how THIS container sees it.
  // If you mount the same host folder at /downloads in both containers, leave both as /downloads.
  clientPathPrefix: strip(env.CLIENT_PATH_PREFIX || env.QB_PATH_PREFIX || '/downloads'),
  localPathPrefix: strip(env.LOCAL_PATH_PREFIX || '/downloads'),

  // Where to look up torrents (placeholder resolver, see finder.js)
  torrentioUrl: strip(env.TORRENTIO_URL || 'https://torrentio.strem.fun'),
  maxRes: parseInt(env.MAX_RES || '1080', 10),

  waitForStartMs: parseInt(env.WAIT_FOR_START_MS || '45000', 10), // how long /play holds the request while waiting for torrent metadata
  stallMs: parseInt(env.STALL_MS || '30000', 10), // how long a stream waits for the next pieces before giving up
  syncIntervalMs: parseInt(env.SYNC_INTERVAL_MS || '5000', 10),
};

if (!/^[A-Za-z0-9_-]{16,}$/.test(config.token)) {
  console.error('ADDON_TOKEN is required: 16+ characters, letters/digits/-/_ only.');
  process.exit(1);
}

module.exports = config;
