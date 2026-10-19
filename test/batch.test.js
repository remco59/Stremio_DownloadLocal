// Season / whole-show downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, waitFor } = require('./helpers/boot');

const SHOW = 'tt0944947';
const PACK = 'a'.repeat(40);
const hashFor = (s, e) => `${s}${e}`.padStart(40, 'c');
let env;

const ep = (season, episode, released = '2011-04-17T00:00:00.000Z') => ({
  id: `${SHOW}:${season}:${episode}`, season, episode, name: `S${season}E${episode}`, released,
});

test.before(async () => {
  env = await boot();
  env.mock.metas[SHOW] = {
    id: SHOW,
    name: 'Game of Thrones',
    videos: [ep(0, 1), ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2, '2999-01-01T00:00:00.000Z')],
  };
  // Season 1: every episode has its own release (50 seeders) and is also in a season pack (20 seeders).
  for (const e of [1, 2, 3]) {
    env.mock.torrentio[`${SHOW}:1:${e}`] = {
      streams: [
        { name: '1080p', title: `GoT.S01E0${e}.1080p\n👤 50`, infoHash: hashFor(1, e) },
        { name: '1080p', title: `Game.of.Thrones.S01.1080p\n👤 20`, infoHash: PACK, fileIdx: e - 1 },
      ],
    };
  }
  env.mock.torrentio[`${SHOW}:2:1`] = { streams: [{ name: '1080p', title: 'GoT.S02E01.1080p\n👤 9', infoHash: hashFor(2, 1) }] };
  env.mock.onAdd = (hash) =>
    env.mock.addTorrent(
      hash === PACK
        ? { hash, name: 'GoT.S01', pieceSize: 1024, files: [1, 2, 3].map((e) => ({ name: `GoT.S01/E0${e}.mkv`, size: 4096 })) }
        : { hash, name: hash, pieceSize: 1024, files: [{ name: `${hash}.mkv`, size: 4096 }] }
    );
  // Episode 2 is already on the server.
  env.db.set(`${SHOW}:1:2`, { id: `${SHOW}:1:2`, type: 'series', status: 'complete', infoHash: hashFor(1, 2), createdAt: Date.now() });
});
test.after(() => env.close());

const post = async (body) => {
  const r = await env.api(`/api/download/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const pending = async () => (await (await env.api(`/api/downloads`)).json()).batchPending;

test('a season queues the missing episodes and shares one season pack', async () => {
  const { status, body } = await post({ id: SHOW, season: 1 });
  assert.equal(status, 200);
  assert.deepEqual(body.queued, [`${SHOW}:1:1`, `${SHOW}:1:3`]);
  assert.deepEqual(body.skipped, [{ id: `${SHOW}:1:2`, reason: 'complete' }]);

  await waitFor(async () => !(await pending()).length && env.db.get(`${SHOW}:1:3`)?.selected);
  const e1 = env.db.get(`${SHOW}:1:1`);
  const e3 = env.db.get(`${SHOW}:1:3`);
  assert.equal(e1.infoHash, PACK);
  assert.equal(e3.infoHash, PACK);
  assert.equal(e1.fileName, 'GoT.S01/E01.mkv');
  assert.equal(e3.fileName, 'GoT.S01/E03.mkv');
  // Only the two queued episodes are downloaded from the pack.
  assert.deepEqual(env.mock.torrents.get(PACK).files.map((f) => f.priority), [1, 0, 1]);
  assert.equal(env.mock.added.filter((a) => a.magnet.includes(PACK)).length, 2);
});

test('the whole show skips specials, unreleased and already queued episodes', async () => {
  const { body } = await post({ id: SHOW });
  assert.deepEqual(body.queued, [`${SHOW}:2:1`]);
  assert.deepEqual(
    body.skipped.map((s) => `${s.id} ${s.reason}`),
    [`${SHOW}:1:1 downloading`, `${SHOW}:1:2 complete`, `${SHOW}:1:3 downloading`, `${SHOW}:2:2 not released yet`]
  );
  await waitFor(() => env.db.get(`${SHOW}:2:1`)?.selected);
  assert.equal(env.db.get(`${SHOW}:2:1`).infoHash, hashFor(2, 1));
  assert.equal(env.db.get(`${SHOW}:0:1`), null);
});

test('failed episodes are retried by the next batch', async () => {
  const show = 'tt0000123';
  env.mock.metas[show] = { id: show, videos: [{ id: `${show}:1:1`, season: 1, episode: 1 }] };
  await post({ id: show });
  await waitFor(() => env.db.get(`${show}:1:1`)?.status === 'error');
  env.mock.torrentio[`${show}:1:1`] = { streams: [{ name: '720p', title: 'X.S01E01\n👤 3', infoHash: 'd'.repeat(40) }] };
  const { body } = await post({ id: show, season: 1 });
  assert.deepEqual(body.queued, [`${show}:1:1`]);
  await waitFor(() => env.db.get(`${show}:1:1`)?.selected);
});

test('bad requests', async () => {
  assert.equal((await post({ id: 'nope' })).status, 400);
  assert.equal((await post({ id: `${SHOW}:1:1` })).status, 400);
  assert.equal((await post({ id: SHOW, season: 0 })).status, 400);
  assert.equal((await post({ id: SHOW, season: '1' })).status, 400);
  assert.equal((await post({ id: SHOW, season: 9 })).status, 404);
  assert.equal((await post({ id: 'tt7777777' })).status, 404);
});
