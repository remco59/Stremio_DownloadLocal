// The Stremio catalogs: downloaded movies and series, newest first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

let env;
test.before(async () => {
  env = await boot({ CINEMETA_RETRY_MS: '10', CINEMETA_TIMEOUT_MS: '500' });
  env.mock.metas.tt1111111 = { id: 'tt1111111', type: 'movie', name: 'Old Movie', poster: 'http://p/1.jpg' };
  env.mock.metas.tt2222222 = { id: 'tt2222222', type: 'movie', name: 'New Movie', poster: 'http://p/2.jpg' };
  env.mock.metas.tt3333333 = { id: 'tt3333333', type: 'series', name: 'Some Show', poster: 'http://p/3.jpg' };
  env.mock.metas.tt4444444 = { id: 'tt4444444', type: 'series', name: 'Other Show' };
  const rec = (id, type, status, completedAt) => env.db.set(id, { id, type, status, completedAt, title: id, createdAt: completedAt });
  rec('tt1111111', 'movie', 'complete', 1000);
  rec('tt2222222', 'movie', 'complete', 3000);
  rec('tt9999999', 'movie', 'downloading', 4000); // not finished: not listed
  rec('tt3333333:1:1', 'series', 'complete', 2000);
  rec('tt3333333:1:2', 'series', 'complete', 5000);
  rec('tt4444444:1:1', 'series', 'complete', 4000);
});
test.after(() => env && env.close());

const cat = async (p) => (await (await fetch(`${env.base}/catalog/${p}`)).json()).metas;

test('the manifest offers one movie row and one series row', async () => {
  const m = await (await fetch(`${env.base}/manifest.json`)).json();
  assert.ok(m.resources.includes('catalog'));
  assert.deepEqual(m.catalogs.map((c) => [c.type, c.id]), [['movie', 'local-movies'], ['series', 'local-series']]);
});

test('movies: finished ones only, newest first, with Cinemeta name and poster', async () => {
  const metas = await cat('movie/local-movies.json');
  assert.deepEqual(metas.map((m) => m.id), ['tt2222222', 'tt1111111']);
  assert.equal(metas[0].name, 'New Movie');
  assert.equal(metas[0].poster, 'http://p/2.jpg');
});

test('series: one entry per show, ranked by its newest finished episode', async () => {
  const metas = await cat('series/local-series.json');
  assert.deepEqual(metas.map((m) => m.id), ['tt3333333', 'tt4444444']);
});

test('skip paging, and unknown catalogs are empty', async () => {
  assert.deepEqual((await cat('movie/local-movies/skip=1.json')).map((m) => m.id), ['tt1111111']);
  assert.deepEqual(await cat('movie/nope.json'), []);
});
