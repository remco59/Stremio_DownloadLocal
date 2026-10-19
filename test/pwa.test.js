// Favicon, PWA manifest, icons and service worker: public, and linked from both pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

let env;
test.before(async () => {
  env = await boot({ UI_PASSWORD: '' });
});
test.after(() => env.close());

const get = (p) => fetch(env.origin + p, { redirect: 'manual' });

test('manifest, icons and service worker are served without a login', async () => {
  const m = await get('/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json|json/);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const r = await get(icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get('content-type').split(';')[0], icon.type, icon.src);
  }
  for (const p of ['/favicon.ico', '/apple-touch-icon.png']) assert.equal((await get(p)).status, 200, p);

  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
});

test('the login page links the manifest and favicon and registers the service worker', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="icon" href="\/favicon\.svg"/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js'\)/);
});
