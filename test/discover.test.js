// Discover: recommendations from what is on the server, scored against Cinemeta catalogs (mocked).
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

let env;
const year = new Date().getFullYear();
const movie = (n, extra = {}) => ({ id: `tt9${String(n).padStart(6, '0')}`, type: 'movie', name: `Movie ${n}`, imdbRating: '7.0', released: '2001-01-01T00:00:00.000Z', ...extra });
const show = (n, extra = {}) => ({ id: `tt8${String(n).padStart(6, '0')}`, type: 'series', name: `Show ${n}`, imdbRating: '7.5', ...extra });

// On the server: two sci-fi movies by one director, and two episodes of a crime show.
const matrix = movie(1, { name: 'The Matrix', genres: ['Action', 'Sci-Fi'], director: ['Lana Wachowski'], cast: ['Keanu Reeves'] });
const arrival = movie(2, { name: 'Arrival', genres: ['Drama', 'Sci-Fi'], director: ['Denis Villeneuve'], cast: ['Amy Adams'] });
const bb = show(1, { name: 'Breaking Bad', genres: ['Crime', 'Drama', 'Thriller'], cast: ['Bryan Cranston'], videos: [] });

const scifi = Array.from({ length: 8 }, (_, i) => movie(100 + i, { genres: ['Sci-Fi'] }));
const dune = movie(200, { name: 'Dune', genres: ['Adventure', 'Sci-Fi'], director: ['Denis Villeneuve'] });
const romance = Array.from({ length: 8 }, (_, i) => movie(300 + i, { genres: ['Romance'], imdbRating: '7.9' }));
const future = movie(400, { name: 'Not out yet', genres: ['Sci-Fi'], released: `${year + 2}-01-01T00:00:00.000Z` });
const crime = Array.from({ length: 6 }, (_, i) => show(100 + i, { genres: ['Crime', 'Drama'] }));

test.before(async () => {
  env = await boot({ CINEMETA_RETRY_MS: '10', CINEMETA_TIMEOUT_MS: '500' });
  for (const m of [matrix, arrival, bb]) env.mock.metas[m.id] = m;
  env.mock.catalogs['movie/top'] = [...romance, dune, ...scifi, future, matrix];
  env.mock.catalogs['movie/top/genre=Sci-Fi'] = [...scifi, dune, future, arrival];
  env.mock.catalogs['series/top'] = [...crime, bb];
});
test.after(() => env && env.close());

const get = async (q = '') => {
  const r = await fetch(`${env.base}/api/discover${q}`);
  return { status: r.status, body: await r.json() };
};
const ids = (row) => row.items.map((x) => x.id);

test('with nothing on the server: popular titles, nothing personal', async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.basedOn, 0);
  assert.deepEqual(body.genres, []);
  const popular = body.rows.find((r) => r.key === 'popular-movie');
  assert.ok(popular, 'a popular movies row');
  assert.equal(popular.items[0].id, romance[0].id);
  assert.ok(!ids(popular).includes(future.id), 'unreleased titles are left out');
});

test('recommends what fits the library, and never what is already there', async () => {
  const now = Date.now();
  env.db.set(matrix.id, { id: matrix.id, type: 'movie', status: 'complete', createdAt: now });
  env.db.set(arrival.id, { id: arrival.id, type: 'movie', status: 'complete', createdAt: now });
  env.db.set(`${bb.id}:1:1`, { id: `${bb.id}:1:1`, type: 'series', status: 'complete', createdAt: now });
  env.db.set(`${bb.id}:1:2`, { id: `${bb.id}:1:2`, type: 'series', status: 'downloading', createdAt: now });

  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.basedOn, 3);
  // Drama is in Arrival and in both Breaking Bad episodes, Sci-Fi in both movies.
  assert.deepEqual(body.genres.slice(0, 2), ['Drama', 'Sci-Fi']);
  const movies = body.rows.find((r) => r.key === 'for-you-movie');
  assert.ok(movies, 'a movies-for-you row');
  // Same director as a movie on the server, and the favourite genre: first, with the reason.
  assert.equal(movies.items[0].id, dune.id);
  assert.equal(movies.items[0].reason, 'From Denis Villeneuve');
  // Sci-Fi before Romance, even though the romance titles rate higher.
  const at = (id) => ids(movies).indexOf(id);
  assert.ok(at(scifi[0].id) >= 0 && (at(romance[0].id) === -1 || at(scifi[0].id) < at(romance[0].id)));
  const all = body.rows.flatMap(ids);
  for (const id of [matrix.id, arrival.id, bb.id, future.id]) assert.ok(!all.includes(id), `${id} is not recommended`);
  assert.equal(new Set(all).size, all.length, 'a title shows in one row only');
  const series = body.rows.find((r) => r.key === 'for-you-series');
  assert.ok(series && ids(series).includes(crime[0].id), 'crime shows for a crime show fan');
});

test('Not interested hides a title until shown again', async () => {
  let r = await fetch(`${env.base}/api/discover/hidden`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: dune.id }) });
  assert.equal(r.status, 200);
  let { body } = await get();
  assert.ok(!body.rows.flatMap(ids).includes(dune.id));
  assert.equal(body.hidden, 1);

  r = await fetch(`${env.base}/api/discover/hidden`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  ({ body } = await get());
  assert.ok(body.rows.flatMap(ids).includes(dune.id));
  assert.equal(body.hidden, 0);
});

test('a bad id cannot be hidden', async () => {
  const r = await fetch(`${env.base}/api/discover/hidden`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '../x' }) });
  assert.equal(r.status, 400);
});

test('titles played in the web player weigh more than ones only downloaded', () => {
  const { seeds } = require('../discover');
  const plain = seeds().find((s) => s.tt === matrix.id).weight;
  const played = seeds([matrix.id]).find((s) => s.tt === matrix.id).weight;
  assert.ok(played > plain);
  // A whole show counts more than one movie downloaded at the same time.
  const s = seeds();
  assert.ok(s.find((x) => x.tt === bb.id).weight > s.find((x) => x.tt === arrival.id).weight);
});
