// Title search and series metadata in the web UI, proxied to Cinemeta (with retries: Cinemeta is often slow).
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

let env;

test.before(async () => {
  env = await boot({ CINEMETA_RETRY_MS: '10,20,30', CINEMETA_TIMEOUT_MS: '200' });
  env.mock.metas.tt0892769 = { id: 'tt0892769', imdb_id: 'tt0892769', type: 'movie', name: 'How to Train Your Dragon' };
  env.mock.metas.tt2325846 = { id: 'tt2325846', type: 'series', name: 'Dragons: Riders of Berk', videos: [] };
  env.mock.hangMs = 600;
});

test.after(() => env && env.close());

const search = () => env.api(`/api/search?type=movie&q=dragons`);
const meta = (id) => env.api(`/api/meta/series/${id}`);
/** Runs `fn` and returns its response plus how many requests reached the mock Cinemeta. */
async function counted(fn) {
  const before = env.mock.cinemetaCalls;
  const r = await fn();
  return { r, body: await r.json(), calls: env.mock.cinemetaCalls - before };
}

test('search returns the Cinemeta results', async () => {
  const { r, body, calls } = await counted(search);
  assert.equal(r.status, 200);
  assert.deepEqual(body.metas.map((m) => m.name), ['How to Train Your Dragon']);
  assert.equal(calls, 1);
});

for (const failures of [1, 2, 3]) {
  test(`${failures} Cinemeta error page(s) in a row are retried`, async () => {
    env.mock.cinemetaFailures = failures;
    const { r, body, calls } = await counted(search);
    assert.equal(r.status, 200);
    assert.equal(body.metas.length, 1);
    assert.equal(calls, failures + 1);
  });
}

test('more error pages than attempts give a readable error, not a JSON parse error', async () => {
  env.mock.cinemetaFailures = 5;
  const { r, body, calls } = await counted(search);
  assert.equal(r.status, 502);
  assert.match(body.error, /Cinemeta did not answer properly \(HTTP 504\)/);
  assert.equal(calls, 4);
  env.mock.cinemetaFailures = 0;
});

test('a Cinemeta request that hangs past the timeout is retried', async () => {
  env.mock.cinemetaHangs = 1;
  const { r, body, calls } = await counted(search);
  assert.equal(r.status, 200);
  assert.equal(body.metas.length, 1);
  assert.equal(calls, 2);
});

test('Cinemeta hanging every time gives a timeout error', async () => {
  env.mock.cinemetaHangs = 4;
  const { r, body } = await counted(search);
  assert.equal(r.status, 502);
  assert.match(body.error, /did not answer in time/);
});

test('series metadata is retried the same way', async () => {
  env.mock.cinemetaFailures = 2;
  const { r, body, calls } = await counted(() => meta('tt2325846'));
  assert.equal(r.status, 200);
  assert.equal(body.meta.name, 'Dragons: Riders of Berk');
  assert.equal(calls, 3);
});

test('a 4xx from Cinemeta is passed on, not retried', async () => {
  const { r, calls } = await counted(() => meta('tt0000001'));
  assert.equal(r.status, 404);
  assert.equal(calls, 1);
});
