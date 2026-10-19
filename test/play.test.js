// Playback UX: first-tap decisions, status clips, seeking past the downloaded part.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, waitFor, pattern } = require('./helpers/boot');
const { decide, MIN_START_BYTES } = require('../play');

const CFG = { waitForStartMs: 15000, seekWaitMs: 8000 };
const MB = 2 ** 20;
const rec = (o) => ({ status: 'downloading', selected: true, fileSize: 100 * MB, ...o });

test('decide: errors and finished files', () => {
  assert.deepEqual(decide({ rec: null, start: 0, avail: null, elapsed: 0, cfg: CFG }), { action: 'clip', clip: 'error' });
  assert.deepEqual(decide({ rec: rec({ status: 'error' }), start: 0, avail: null, elapsed: 0, cfg: CFG }).clip, 'error');
  assert.deepEqual(decide({ rec: rec({ status: 'complete' }), start: 5, avail: null, elapsed: 0, cfg: CFG }), { action: 'serve' });
});

test('decide: waiting for metadata, then the metadata clip', () => {
  const r = rec({ selected: false, status: 'queued' });
  assert.equal(decide({ rec: r, start: 0, avail: null, elapsed: 14999, cfg: CFG }).action, 'wait');
  assert.deepEqual(decide({ rec: r, start: 0, avail: null, elapsed: 15000, cfg: CFG }), { action: 'clip', clip: 'metadata' });
});

test('decide: first tap plays once enough of the start is there', () => {
  assert.equal(decide({ rec: rec(), start: 0, avail: MIN_START_BYTES, elapsed: 0, cfg: CFG }).action, 'serve');
  assert.equal(decide({ rec: rec(), start: 0, avail: MB, elapsed: 0, cfg: CFG }).action, 'wait');
  // Small file: all of it is enough.
  assert.equal(decide({ rec: rec({ fileSize: MB }), start: 0, avail: MB, elapsed: 0, cfg: CFG }).action, 'serve');
  // At the deadline: a little is better than a clip, nothing at all gets the clip.
  assert.equal(decide({ rec: rec(), start: 0, avail: MB, elapsed: 15000, cfg: CFG }).action, 'serve');
  assert.deepEqual(decide({ rec: rec(), start: 0, avail: 0, elapsed: 15000, cfg: CFG }), { action: 'clip', clip: 'started' });
});

test('decide: seeking', () => {
  assert.equal(decide({ rec: rec(), start: 50 * MB, avail: 50 * MB + 1, elapsed: 0, cfg: CFG }).action, 'serve');
  assert.equal(decide({ rec: rec(), start: 50 * MB, avail: 50 * MB, elapsed: 7999, cfg: CFG }).action, 'wait');
  assert.equal(decide({ rec: rec(), start: 50 * MB, avail: 50 * MB, elapsed: 8000, cfg: CFG }).action, 'unavailable');
});

// ---- against the add-on + mock client ----
let env;
let cfg;
let n = 0;
test.before(async () => {
  env = await boot();
  cfg = require('../config');
  Object.assign(cfg, { waitForStartMs: 400, seekWaitMs: 400 });
});
test.after(() => env.close());

const PIECE = MB;
const SIZE = 8 * MB;
const DATA = pattern(SIZE, 5);

/** Queues a fresh title whose single 8 MB file sits on disk; `pieces` of it are "downloaded". */
async function title({ pieces = 0, metadata = true } = {}) {
  const id = `tt30000${++n}`;
  const hash = String(n).padStart(40, '7');
  const name = `Play${n}.mkv`;
  env.mock.torrentio[id] = { streams: [{ name: '1080p', title: `Play${n} 1080p\n👤 3`, infoHash: hash }] };
  env.mock.onAdd = (h) => {
    env.mock.addTorrent({ hash: h, pieceSize: PIECE, files: [{ name, size: SIZE }], metadata });
    env.mock.havePieces(h, 0, pieces);
  };
  fs.writeFileSync(path.join(env.downloads, name), DATA);
  return { id, hash };
}
const queue = (id) =>
  fetch(`${env.base}/api/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', id }) });
const play = (id, headers = {}) => fetch(`${env.base}/play/movie/${id}`, { headers, redirect: 'manual' });

test('tap on a title not looked up yet: the "download started" clip at once, the download starts in the background', async () => {
  const { id, hash } = await title({ pieces: 3 });
  const t0 = Date.now();
  const r = await play(id);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${env.base}/clip/started.mp4`);
  assert.ok(Date.now() - t0 < 300, 'does not wait for the search');
  await waitFor(() => env.db.get(id)?.infoHash === hash);
});

test('first tap without metadata: the "looking for the torrent" clip', async () => {
  const { id } = await title({ metadata: false });
  await queue(id);
  const r = await play(id);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${env.base}/clip/metadata.mp4`);
});

test('first tap with nothing downloaded yet: the "download started" clip', async () => {
  const { id } = await title({ pieces: 0 });
  await queue(id);
  const r = await play(id);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${env.base}/clip/started.mp4`);
});

test('first tap with the start downloaded: plays right away', async () => {
  const { id } = await title({ pieces: 3 });
  await queue(id);
  const t0 = Date.now();
  const r = await play(id, { Range: 'bytes=0-1023' });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), DATA.subarray(0, 1024));
  assert.ok(Date.now() - t0 < 2000);
});

test('seek past the downloaded part: 503 after the seek wait; inside it: plays', async () => {
  const { id } = await title({ pieces: 3 });
  await queue(id);
  await waitFor(() => env.db.get(id)?.selected);
  let r = await play(id, { Range: `bytes=${6 * MB}-` });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '60');
  r = await play(id, { Range: `bytes=${2 * MB}-${2 * MB + 99}` });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), DATA.subarray(2 * MB, 2 * MB + 100));
});

test('stream entry says how far it plays', async () => {
  const { id } = await title({ pieces: 2 });
  await queue(id);
  await waitFor(() => env.db.get(id)?.playable > 0);
  const s = (await (await fetch(`${env.base}/stream/movie/${id}.json`)).json()).streams[0];
  assert.match(s.description, /^Playable up to 25%/);
  // The web UI shows the same on the downloads page.
  const item = (await (await fetch(`${env.base}/api/downloads`)).json()).items.find((d) => d.id === id);
  assert.equal(item.playable, 0.25);
});

test('clips support ranges; unknown clips 404', async () => {
  const r = await fetch(`${env.base}/clip/started.mp4`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${env.base}/clip/nope.mp4`)).status, 404);
  assert.equal((await fetch(`${env.base}/clip/..%2Fserver.js.mp4`)).status, 404);
});
