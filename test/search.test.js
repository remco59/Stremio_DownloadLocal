// Title search in the web UI, proxied to Cinemeta.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

let env;

test.before(async () => {
  env = await boot();
  env.mock.metas.tt0892769 = { id: 'tt0892769', imdb_id: 'tt0892769', type: 'movie', name: 'How to Train Your Dragon' };
});

test.after(() => env && env.close());

const search = () => fetch(`${env.base}/api/search?type=movie&q=dragons`);

test('search returns the Cinemeta results', async () => {
  const r = await search();
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).metas.map((m) => m.name), ['How to Train Your Dragon']);
});

test('a one-off Cinemeta error page is retried', async () => {
  env.mock.catalogFailures = 1;
  const before = env.mock.catalogCalls;
  const r = await search();
  assert.equal(r.status, 200);
  assert.equal((await r.json()).metas.length, 1);
  assert.equal(env.mock.catalogCalls - before, 2);
});

test('a lasting Cinemeta error page gives a readable error, not a JSON parse error', async () => {
  env.mock.catalogFailures = 2;
  const r = await search();
  assert.equal(r.status, 502);
  const { error } = await r.json();
  assert.match(error, /Cinemeta did not answer properly \(HTTP 504\)/);
});
