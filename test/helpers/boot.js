// Boots the add-on in-process against the mock qBittorrent, with fresh temp data/download dirs.
// Config is read from env at require time, so call boot() once per test file (node --test isolates files).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockQb } = require('./mock-qb');
const { createMockTransmission } = require('./mock-transmission');

const TOKEN = 'test-token-0123456789';

/**
 * @param {object} env extra env vars
 * @param {{client?: 'qbittorrent'|'transmission', mockOpts?: object}} opts which mock client to run against
 */
async function boot(env = {}, { client = 'qbittorrent', mockOpts = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-addon-test-'));
  const dataDir = path.join(root, 'data');
  const downloads = path.join(root, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });

  const qb = client === 'transmission' ? createMockTransmission(mockOpts) : createMockQb(mockOpts);
  const mockUrl = await qb.listen();

  Object.assign(process.env, {
    ADDON_TOKEN: TOKEN,
    DATA_DIR: dataDir,
    TORRENT_CLIENT: client,
    QB_URL: mockUrl,
    QB_USER: 'admin',
    QB_PASS: 'secret',
    TR_URL: mockUrl, // bare host: the client appends /transmission/rpc
    TR_USER: 'admin',
    TR_PASS: 'secret',
    CLIENT_PATH_PREFIX: '/downloads',
    LOCAL_PATH_PREFIX: downloads,
    TORRENTIO_URL: mockUrl,
    CINEMETA_URL: mockUrl,
    WAIT_FOR_START_MS: '3000',
    STALL_MS: '300',
    SYNC_INTERVAL_MS: '50',
    ...env,
  });

  const app = require('../../server');
  const dl = require('../../downloads');
  const db = require('../../db');
  const stopSync = dl.startSync();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    TOKEN,
    client,
    mockUrl,
    origin,
    base: `${origin}/${TOKEN}`,
    downloads,
    mock: qb.mock,
    db,
    dl,
    async close() {
      stopSync();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await qb.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Polls `fn` until it returns truthy or the timeout passes. */
async function waitFor(fn, { timeout = 3000, interval = 20 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Deterministic file contents so tests can check exact byte ranges. */
function pattern(size, seed = 0) {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 255;
  return b;
}

module.exports = { boot, waitFor, pattern, TOKEN };
