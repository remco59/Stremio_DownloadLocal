// Sync loop edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');

let env;
test.before(async () => {
  env = await boot({ SYNC_INTERVAL_MS: '600000' }); // rounds are run by hand here
});
test.after(() => env.close());

test('a record deleted during a sync round is not brought back', async () => {
  const id = 'tt2000001';
  env.db.set(id, {
    id, type: 'movie', status: 'complete', selected: true, infoHash: '5'.repeat(40), fileIndex: 0,
    fileName: 'Gone.mkv', fileSize: 10, savePath: '/downloads', createdAt: Date.now(),
  });
  const client = require('../clients');
  const info = client.info;
  // Simulate "Delete files" landing while the round waits for the client.
  client.info = async (hashes) => {
    const out = await info(hashes);
    env.db.delete(id);
    return out;
  };
  try {
    await env.dl.syncOnce();
  } finally {
    client.info = info;
  }
  assert.equal(fs.existsSync(path.join(env.downloads, 'Gone.mkv')), false);
  assert.equal(env.db.get(id), null);
});

test('update() only patches existing records', () => {
  assert.equal(env.db.update('tt2000404', { status: 'missing' }), null);
  assert.equal(env.db.get('tt2000404'), null);
  env.db.set('tt2000002', { status: 'queued' });
  assert.equal(env.db.update('tt2000002', { status: 'missing' }).status, 'missing');
});

test('a download removed during a sync round stays removed', async () => {
  const id = 'tt2000003';
  const hash = '6'.repeat(40);
  env.mock.addTorrent({ hash, files: [{ name: 'R.mkv', size: 2048 }] });
  env.db.set(id, {
    id, type: 'movie', status: 'downloading', selected: true, infoHash: hash, fileIndex: 0,
    fileName: 'R.mkv', fileSize: 2048, fileOffset: 0, pieceSize: 16384, savePath: '/downloads', createdAt: Date.now(),
  });
  const client = require('../clients');
  const files = client.files;
  // "Remove" lands while the round waits for the file list.
  client.files = async (h) => {
    const out = await files(h);
    env.db.update(id, { status: 'missing' });
    return out;
  };
  try {
    await env.dl.syncOnce();
  } finally {
    client.files = files;
  }
  assert.equal(env.db.get(id).status, 'missing');
});

// Stuck at 0%: the sync loop moves to the next torrent that was not tried yet.
const STALE = () => Date.now() - 11 * 60000; // past the default 10-minute limit
const hashOf = (c) => c.repeat(40);

function stuck(id, hash, extra = {}) {
  env.mock.addTorrent({ hash, files: [{ name: `${hash}.mkv`, size: 2048 }], metadata: false });
  env.db.set(id, {
    id, type: 'movie', status: 'queued', selected: false, infoHash: hash, progress: 0,
    createdAt: STALE(), progressAt: STALE(), tried: [], ...extra,
  });
}

test('a download stuck at 0% switches to the next torrent and never back', async () => {
  const id = 'tt2000010';
  env.mock.torrentio[id] = {
    streams: ['a', 'b', 'c'].map((c, i) => ({ name: '1080p', title: `S${c} 1080p\n👤 ${30 - i * 10}`, infoHash: hashOf(c) })),
  };
  env.mock.onAdd = (h) => env.mock.addTorrent({ hash: h, files: [{ name: `${h}.mkv`, size: 2048 }], metadata: false });
  stuck(id, hashOf('a'));

  await env.dl.syncOnce();
  let rec = env.db.get(id);
  assert.equal(rec.infoHash, hashOf('b'));
  assert.deepEqual(rec.tried, [hashOf('a')]);
  assert.equal(env.mock.torrents.has(hashOf('a')), false, 'the dead torrent left the client');

  env.db.update(id, { progressAt: STALE() });
  await env.dl.syncOnce();
  rec = env.db.get(id);
  assert.equal(rec.infoHash, hashOf('c'), 'skips the best-seeded one, already tried');
  assert.deepEqual(rec.tried, [hashOf('a'), hashOf('b')]);

  // Nothing left: keep the current torrent and wait another round.
  env.db.update(id, { progressAt: STALE() });
  await env.dl.syncOnce();
  rec = env.db.get(id);
  assert.equal(rec.infoHash, hashOf('c'));
  assert.equal(rec.status, 'queued');
  assert.ok(Date.now() - rec.progressAt < 60000);
  assert.deepEqual(rec.tried, [hashOf('a'), hashOf('b'), hashOf('c')]);
  env.mock.onAdd = null;
});

test('no switch while paused, after progress, or for records from before the watchdog', async () => {
  const id = 'tt2000011';
  const adds = env.mock.added.length;
  env.mock.torrentio[id] = { streams: [{ name: '1080p', title: 'Other 1080p\n👤 9', infoHash: hashOf('e') }] };

  stuck(id, hashOf('d'));
  env.mock.torrents.get(hashOf('d')).paused = true;
  await env.dl.syncOnce();
  assert.equal(env.db.get(id).infoHash, hashOf('d'), 'paused');
  assert.ok(Date.now() - env.db.get(id).progressAt < 60000, 'paused time does not count');

  env.db.update(id, { progressAt: STALE(), progress: 0.2 });
  env.mock.torrents.get(hashOf('d')).paused = false;
  await env.dl.syncOnce();
  assert.equal(env.db.get(id).infoHash, hashOf('d'), 'already has data');

  env.db.update(id, { progressAt: undefined, progress: 0 });
  await env.dl.syncOnce();
  assert.equal(env.db.get(id).infoHash, hashOf('d'), 'no progressAt yet');
  assert.ok(env.db.get(id).progressAt, 'the clock starts now');
  assert.equal(env.mock.added.length, adds);
});

// The client's piece map can claim a file the disk no longer has (deleted behind its back).
function claimedDone(id, hash, extra = {}) {
  env.mock.addTorrent({ hash, files: [{ name: 'Season/Ep.mkv', size: 2048 }] });
  env.mock.completeAll(hash);
  env.db.set(id, {
    id, type: 'movie', status: 'downloading', selected: true, infoHash: hash, fileIndex: 0, fileName: 'Season/Ep.mkv',
    fileSize: 2048, fileOffset: 0, pieceSize: 16384, savePath: '/downloads', progress: 0.5, createdAt: Date.now(), ...extra,
  });
}

test('a file the client calls complete is only complete once it is on disk', async () => {
  const id = 'tt2000020';
  const hash = hashOf('7');
  claimedDone(id, hash);

  await env.dl.syncOnce();
  let rec = env.db.get(id);
  assert.equal(rec.status, 'downloading');
  assert.equal(rec.progress, 0);
  assert.deepEqual(env.mock.rechecked, [hash], 'the client was asked to verify');

  await env.dl.syncOnce();
  assert.deepEqual(env.mock.rechecked, [hash], 'not again within the cooldown');

  fs.mkdirSync(path.join(env.downloads, 'Season'));
  fs.writeFileSync(path.join(env.downloads, 'Season/Ep.mkv'), Buffer.alloc(2048));
  await env.dl.syncOnce();
  rec = env.db.get(id);
  assert.equal(rec.status, 'complete');
  assert.equal(rec.verifies, 0);
});

test('a complete record whose file vanished is verified and shows as downloading again', async () => {
  const id = 'tt2000021';
  const hash = hashOf('8');
  env.mock.rechecked.length = 0;
  claimedDone(id, hash, { status: 'complete', progress: 1, playable: 1, fileName: 'Season/Gone.mkv' });

  await env.dl.syncOnce();
  const rec = env.db.get(id);
  assert.equal(rec.status, 'downloading');
  assert.deepEqual(env.mock.rechecked, [hash]);
});

test('a client that keeps claiming a missing file ends in an error naming the path', async () => {
  const id = 'tt2000022';
  const hash = hashOf('9');
  claimedDone(id, hash, { fileName: 'Season/Nowhere.mkv', verifies: 2, verifiedAt: Date.now() - 6 * 60000 });

  await env.dl.syncOnce();
  const rec = env.db.get(id);
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /not on disk: check the path mapping/);
  assert.equal(env.mock.rechecked.includes(hash), false, 'no endless verifying');
});
