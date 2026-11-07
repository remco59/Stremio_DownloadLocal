// /healthz and the free-disk-space guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, waitFor } = require('./helpers/boot');

const MOVIE = 'tt0133093';
let env;
let cfg;

test.before(async () => {
  env = await boot();
  cfg = require('../config');
  env.mock.torrentio[MOVIE] = { streams: [{ name: '1080p', title: 'The.Matrix.1080p\n👤 50', infoHash: 'a'.repeat(40) }] };
  env.mock.onAdd = (hash) => env.mock.addTorrent({ hash, name: 'm', pieceSize: 1024, files: [{ name: 'm.mkv', size: 4096 }] });
});
test.after(() => env.close());

const post = () =>
  env.api('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', id: MOVIE }) });

test('/healthz is open, reveals only booleans and is 200 while the client answers', async () => {
  const r = await fetch(`${env.origin}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, client: true, diskLow: false });
});

test('/api/downloads reports the disk', async () => {
  const { disk } = await (await env.api('/api/downloads')).json();
  assert.ok(disk.freeBytes > 0 && disk.totalBytes >= disk.freeBytes);
  assert.equal(disk.low, false);
});

test('below the minimum free space a new download is refused (507) and nothing reaches the client', async () => {
  cfg.minFreeGb = 1e9;
  try {
    const { disk } = await (await env.api('/api/downloads')).json();
    assert.equal(disk.low, true);
    assert.equal((await (await fetch(`${env.origin}/healthz`)).json()).diskLow, true);

    const r = await post();
    assert.equal(r.status, 507);
    assert.match((await r.json()).error, /Not enough free disk space/);
    assert.equal(env.db.get(MOVIE).status, 'error');
    assert.equal(env.mock.torrents.size, 0);
  } finally {
    cfg.minFreeGb = 5;
  }
});

test('minFreeGb 0 switches the guard off', async () => {
  cfg.minFreeGb = 0;
  try {
    assert.equal((await post()).status, 200);
    await waitFor(() => env.db.get(MOVIE).status !== 'error');
  } finally {
    cfg.minFreeGb = 5;
  }
});

test('/healthz is 503 when the torrent client cannot be reached', async () => {
  const keep = cfg.qbUrl;
  const put = (body) => env.api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put({ qbUrl: 'http://127.0.0.1:1' })).status, 200);
  try {
    const r = await fetch(`${env.origin}/healthz`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, client: false, diskLow: false });
  } finally {
    await put({ qbUrl: keep });
  }
  assert.equal((await fetch(`${env.origin}/healthz`)).status, 200);
});
