// Live configuration. Env vars give the defaults; DATA_DIR/settings.json (written by the settings page, see
// settings.js) overrides them. Modules read fields at call time, so updates apply without a restart.
const fs = require('fs');
const path = require('path');

const env = process.env;
const strip = (s) => (s || '').replace(/\/+$/, '');

const dataDir = env.DATA_DIR || '/data';
const settingsFile = path.join(dataDir, 'settings.json');

// Everything in here can be changed from the settings page.
const defaults = {
  // Secret path segment. Everything (manifest, streams, UI) lives under /<token>/
  token: env.ADDON_TOKEN || '',

  // Public HTTPS URL of this add-on (e.g. https://stremio.yourdomain.com). If empty, derived from request headers.
  publicUrl: strip(env.PUBLIC_URL),

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

  // Titles, seasons and episodes (search and season/show downloads)
  cinemetaUrl: strip(env.CINEMETA_URL || 'https://v3-cinemeta.strem.io'),

  // Where to look up torrents (see finder.js and sources/): torrentio | torznab | both
  sources: env.SOURCES || 'torrentio',
  torrentioUrl: strip(env.TORRENTIO_URL || 'https://torrentio.strem.fun'),
  torznabUrls: env.TORZNAB_URLS || '', // Jackett/Prowlarr Torznab URLs, comma or space separated
  torznabApiKey: env.TORZNAB_APIKEY || '',

  // How to choose between torrents (see finder.js score())
  maxRes: parseInt(env.MAX_RES || '1080', 10),
  preferredRes: parseInt(env.PREFERRED_RES || '0', 10), // 0 = no preference
  languages: env.LANGUAGES || '', // preferred language codes, e.g. "nl, multi"
  minSeeders: parseInt(env.MIN_SEEDERS || '0', 10),
  minSizeMb: parseInt(env.MIN_SIZE_MB || '0', 10), // 0 = no minimum
  maxSizeGb: parseInt(env.MAX_SIZE_GB || '0', 10), // 0 = no maximum (season packs are exempt)
  preferKeywords: env.PREFER_KEYWORDS || '',
  blockKeywords: env.BLOCK_KEYWORDS ?? 'cam, camrip, hdcam, telesync, hdts, telecine',

  // First tap: how long /play waits for the torrent before showing a "download started" clip instead.
  waitForStartMs: parseInt(env.WAIT_FOR_START_MS || '15000', 10),
  // Seek past the downloaded part: how long to wait for that spot before answering 503.
  seekWaitMs: parseInt(env.SEEK_WAIT_MS || '8000', 10),
  stallMs: parseInt(env.STALL_MS || '30000', 10), // while playing: how long to wait for the next pieces before dropping the connection
  syncIntervalMs: parseInt(env.SYNC_INTERVAL_MS || '5000', 10),

  // Abuse limits (0 = off), see security.js
  playStartsPerIpPerMin: parseInt(env.PLAY_STARTS_PER_IP_PER_MIN || '10', 10),
  playStartsPerMin: parseInt(env.PLAY_STARTS_PER_MIN || '30', 10),
  apiWritesPerIpPerMin: parseInt(env.API_WRITES_PER_IP_PER_MIN || '120', 10),
  tokenFailuresLockout: parseInt(env.TOKEN_FAILURES_LOCKOUT || '20', 10),
};

let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch {
  /* no saved settings yet */
}

const config = {
  port: parseInt(env.PORT || '7000', 10),
  dataDir,
  settingsFile,
  ...defaults,
};
for (const k of Object.keys(defaults)) if (k in saved) config[k] = saved[k];
Object.defineProperty(config, 'defaults', { value: Object.freeze(defaults) });

const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;
Object.defineProperty(config, 'TOKEN_RE', { value: TOKEN_RE });

if (!TOKEN_RE.test(config.token)) {
  console.error('ADDON_TOKEN is required: 16+ characters, letters/digits/-/_ only.');
  process.exit(1);
}

module.exports = config;
