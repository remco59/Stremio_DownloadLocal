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

// Episodes of one season pack that have not picked their file yet still need the torrent: Dragons S4E1 dropped
// a wrong pack, and S4E2-E13 (queued on the same pack) all went missing with it.
test('dropping a season pack for one episode keeps it for episodes still waiting on it', async () => {
  const hash = 'c'.repeat(40);
  env.mock.addTorrent({ hash, files: [{ name: 'S01E01.mkv', size: 2048 }, { name: 'S01E02.mkv', size: 2048 }] });
  const queued = (id, extra = {}) => env.db.set(id, {
    id, type: 'series', status: 'queued', selected: false, infoHash: hash, fileIndex: null, progress: 0,
    createdAt: Date.now(), progressAt: Date.now(), tried: [], ...extra,
  });
  queued('tt2000010:1:1', { status: 'downloading', selected: true, fileIndex: 0, fileName: 'S01E01.mkv' });
  queued('tt2000010:1:2');
  queued('tt2000010:1:3');

  await env.dl.removeFromClient('tt2000010:1:1');
  assert.equal(env.mock.torrents.has(hash), true, 'the pack stays for the waiting episodes');
  await env.dl.deleteFiles('tt2000010:1:2');
  assert.equal(env.mock.torrents.has(hash), true, 'still needed by 1:3');
  await env.dl.syncOnce();
  assert.notEqual(env.db.get('tt2000010:1:3').status, 'missing');
});

// Few seeders spread over a whole season pack fill every episode a little; episodesAtOnce makes the earliest go first.
test('episodes of a season pack take turns, earliest first; playing one moves it up', async () => {
  const cfg = require('../config');
  const hash = 'd'.repeat(40);
  const names = ['S01E01.mkv', 'S01E02.mkv', 'S01E03.mkv'];
  const t = env.mock.addTorrent({ hash, pieceSize: 1024, files: names.map((name) => ({ name, size: 2048 })) });
  names.forEach((name, i) => env.db.set(`tt2000020:1:${i + 1}`, {
    id: `tt2000020:1:${i + 1}`, type: 'series', status: 'queued', selected: false, infoHash: hash, fileIdx: i, progress: 0,
    createdAt: Date.now() - i, progressAt: Date.now(), tried: [],
  }));
  const wanted = () => t.files.map((f) => (f.priority ? 1 : 0)).join('');
  const waiting = () => [1, 2, 3].map((e) => (env.dl.view(env.db.get(`tt2000020:1:${e}`)).waiting ? 'w' : '-')).join('');
  cfg.episodesAtOnce = 1;
  try {
    await env.dl.syncOnce();
    assert.equal(wanted(), '100', 'only the first episode downloads');
    assert.equal(waiting(), '-ww');

    env.mock.havePieces(hash, 0, 2); // E1 done
    await env.dl.syncOnce();
    assert.equal(env.db.get('tt2000020:1:1').status, 'complete');
    assert.equal(wanted(), '110', 'E2 takes its turn; E1 keeps its file');
    assert.equal(waiting(), '--w');

    await env.dl.prioritize('tt2000020:1:3'); // someone presses play on E3
    assert.equal(wanted(), '101');
    assert.equal(waiting(), '-w-');

    cfg.episodesAtOnce = 0;
    await env.dl.syncOnce();
    assert.equal(wanted(), '111', 'no limit: everything downloads');
    assert.equal(waiting(), '---');
  } finally {
    cfg.episodesAtOnce = 0;
  }
});

test('an episode waiting for its turn is not a stalled download', async () => {
  const cfg = require('../config');
  const hash = 'e'.repeat(40);
  env.mock.addTorrent({ hash, pieceSize: 1024, files: [{ name: 'S01E01.mkv', size: 2048 }, { name: 'S01E02.mkv', size: 2048 }] });
  for (const e of [1, 2]) {
    env.db.set(`tt2000030:1:${e}`, {
      id: `tt2000030:1:${e}`, type: 'series', status: 'queued', selected: false, infoHash: hash, fileIdx: e - 1, progress: 0,
      createdAt: STALE(), progressAt: Date.now(), tried: [],
    });
  }
  cfg.episodesAtOnce = 1;
  try {
    await env.dl.syncOnce();
    env.db.update('tt2000030:1:2', { progressAt: STALE() }); // waited longer than the stall limit
    await env.dl.syncOnce();
    const rec = env.db.get('tt2000030:1:2');
    assert.equal(rec.infoHash, hash, 'no switch to another torrent');
    assert.deepEqual(rec.tried, []);
    assert.equal(rec.waiting, true);
  } finally {
    cfg.episodesAtOnce = 0;
  }
});
