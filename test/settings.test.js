// Settings page API: validation, persistence, runtime client switching, connection test, token rotation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { boot, waitFor } = require('./helpers/boot');
const { createMockTransmission } = require('./helpers/mock-transmission');

let env;
let tr;
let trUrl;

test.before(async () => {
  env = await boot();
  tr = createMockTransmission({ version: '4.0.6 (old)' });
  trUrl = await tr.listen();
});
test.after(async () => {
  await env.close();
  await tr.close();
});

const call = (method, p, body) =>
  env.api(p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const json = async (method, p, body) => {
  const r = await call(method, p, body);
  return { status: r.status, body: await r.json() };
};
const saved = () => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.json'), 'utf8'));

test('GET lists every field, per-client groups and no passwords', async () => {
  const { body } = await json('GET', '/api/settings');
  const keys = body.fields.map((f) => f.key);
  for (const k of ['publicUrl', 'torrentClient', 'qbUrl', 'qbPass', 'trUrl', 'trLabel', 'clientPathPrefix', 'maxRes', 'stallMs']) {
    assert.ok(keys.includes(k), k);
  }
  const client = body.fields.find((f) => f.key === 'torrentClient');
  assert.deepEqual(client.options.map((o) => o.value), ['qbittorrent', 'transmission']);
  assert.equal(body.fields.find((f) => f.key === 'qbUrl').client, 'qbittorrent');
  assert.equal(body.fields.find((f) => f.key === 'trUrl').client, 'transmission');
  assert.equal(body.values.torrentClient, 'qbittorrent');
  assert.equal(body.values.qbPass, '');
  assert.equal(body.secretsSet.qbPass, true);
  assert.equal(body.values.qbUrl, env.mockUrl);
});

test('invalid values are rejected and nothing is applied', async () => {
  const { status, body } = await json('PUT', '/api/settings', { maxRes: 720, qbUrl: 'ftp://nope' });
  assert.equal(status, 400);
  assert.equal(body.field, 'qbUrl');
  assert.equal((await json('GET', '/api/settings')).body.values.maxRes, 1080);

  for (const bad of [{ maxRes: 1081 }, { stallMs: 5 }, { torrentClient: 'deluge' }, { clientPathPrefix: 'relative' }, { qbCategory: ' ' }, { nope: 1 }]) {
    assert.equal((await call('PUT', '/api/settings', bad)).status, 400, JSON.stringify(bad));
  }
});

test('valid values are saved, applied and can be reset to the env default', async () => {
  let { status, body } = await json('PUT', '/api/settings', { maxRes: 720, publicUrl: 'https://stremio.example.com/' });
  assert.equal(status, 200);
  assert.equal(body.values.maxRes, 720);
  assert.equal(body.values.publicUrl, 'https://stremio.example.com');
  assert.deepEqual(body.overridden.sort(), ['maxRes', 'publicUrl']);
  assert.equal(saved().maxRes, 720);

  // The stream URL now uses the public URL.
  const s = await (await fetch(`${env.base}/stream/movie/tt0000001.json`)).json();
  assert.match(s.streams[0].url, /^https:\/\/stremio\.example\.com\//);

  ({ body } = await json('PUT', '/api/settings', { publicUrl: null }));
  assert.equal(body.values.publicUrl, '');
  assert.deepEqual(body.overridden, ['maxRes']);
  assert.equal('publicUrl' in saved(), false);
});

test('survives a restart', () => {
  const out = execFileSync(process.execPath, ['-e', "console.log(require('./config').maxRes)"], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });
  assert.equal(String(out).trim(), '720');
});

test('passwords are write-only', async () => {
  const { body } = await json('PUT', '/api/settings', { trPass: 'tr-secret' });
  assert.equal(body.values.trPass, '');
  assert.equal(body.secretsSet.trPass, true);
  assert.equal(saved().trPass, 'tr-secret');
});

test('connection test per client, with form values or the saved ones', async () => {
  let { body } = await json('POST', '/api/settings/test-client', { client: 'qbittorrent' });
  assert.equal(body.ok, true, body.error);
  assert.match(body.version, /qBittorrent/);

  ({ body } = await json('POST', '/api/settings/test-client', { client: 'qbittorrent', values: { qbPass: 'wrong' } }));
  assert.equal(body.ok, false);
  assert.match(body.error, /login failed/i);

  // A blank password means "use the saved one".
  ({ body } = await json('POST', '/api/settings/test-client', { client: 'qbittorrent', values: { qbUrl: env.mockUrl, qbUser: 'admin', qbPass: '' } }));
  assert.equal(body.ok, true);

  ({ body } = await json('POST', '/api/settings/test-client', {
    client: 'transmission',
    values: { trUrl, trUser: 'admin', trPass: 'secret' },
  }));
  assert.equal(body.ok, true, body.error);
  assert.match(body.version, /Transmission 4\.0\.6/);
  assert.match(body.warning, /no sequential download/);

  ({ body } = await json('POST', '/api/settings/test-client', { client: 'transmission', values: { trUrl: 'not a url' } }));
  assert.equal(body.ok, false);
  assert.match(body.error, /valid URL/);

  assert.equal((await call('POST', '/api/settings/test-client', { client: 'deluge' })).status, 400);
});

test('switching the client applies without a restart', async () => {
  const id = 'tt0000777';
  const hash = 'f'.repeat(40);
  env.mock.torrentio[id] = { streams: [{ name: '1080p', title: 'X 1080p\n👤 5', infoHash: hash }] };
  tr.mock.onAdd = (h) => tr.mock.addTorrent({ hash: h, files: [{ name: 'X.mkv', size: 1000 }] });

  const { status } = await json('PUT', '/api/settings', { torrentClient: 'transmission', trUrl, trUser: 'admin', trPass: 'secret' });
  assert.equal(status, 200);

  assert.equal((await call('POST', '/api/download', { type: 'movie', id })).status, 200);
  assert.equal(tr.mock.added.at(-1).sequential, true);
  assert.ok(!env.mock.added.some((a) => a.magnet.includes(hash)), 'went to Transmission, not qBittorrent');
  const rec = await waitFor(() => env.db.get(id)?.selected && env.db.get(id));
  assert.equal(rec.fileName, 'X.mkv');

  await json('PUT', '/api/settings', { torrentClient: null });
  assert.equal((await json('GET', '/api/settings')).body.values.torrentClient, 'qbittorrent');
});

test('poll interval changes apply to the running sync loop', async () => {
  // Something to sync, so every round asks the client for torrent info.
  env.db.set('tt0000888', { id: 'tt0000888', type: 'movie', infoHash: '9'.repeat(40), status: 'downloading', createdAt: Date.now() });
  const polls = () => env.mock.calls.filter((c) => c.endsWith('/torrents/info')).length;
  await waitFor(() => polls() > 0);

  await json('PUT', '/api/settings', { syncIntervalMs: 60000 });
  await new Promise((r) => setTimeout(r, 100)); // let the round already scheduled at the old 50 ms run
  const before = polls();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(polls(), before, 'no polls at the new 60 s interval');

  await json('PUT', '/api/settings', { syncIntervalMs: null });
  assert.equal((await json('GET', '/api/settings')).body.values.syncIntervalMs, 50);
});

test('token rotation: the old URL stops working, the new one works', async () => {
  assert.equal((await call('POST', '/api/settings/rotate-token', { token: 'short' })).status, 400);

  const { status, body } = await json('POST', '/api/settings/rotate-token');
  assert.equal(status, 200);
  assert.match(body.token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(body.manifestUrl.endsWith(`/${body.token}/manifest.json`));
  assert.equal(saved().token, body.token);

  assert.equal((await fetch(`${env.base}/manifest.json`)).status, 404);
  const m = await fetch(`${env.origin}/${body.token}/manifest.json`);
  assert.equal(m.status, 200);
  env.base = `${env.origin}/${body.token}`;
});
