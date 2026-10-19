// Web UI login: setup through the token URL, login/logout, session cookies, changing the login, lockout.
// Boots without UI_PASSWORD, so the login lives in DATA_DIR/auth.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');

let env;
let cfg;
let security;
let ipN = 0;
const freshIp = () => `203.0.113.${++ipN}`; // via X-Forwarded-For from loopback (a trusted proxy)

test.before(async () => {
  env = await boot({ UI_PASSWORD: '' });
  cfg = require('../config');
  security = require('../security');
});
test.after(() => env.close());
test.beforeEach(() => {
  security.reset();
  cfg.tokenFailuresLockout = 0;
});

const req = (p, { cookie, ip, body, method } = {}) =>
  fetch(env.origin + p, {
    method: method || (body ? 'POST' : 'GET'),
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body && JSON.stringify(body),
  });
const sessionCookie = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const authFile = () => path.join(process.env.DATA_DIR, 'auth.json');

let cookie; // from the setup

test('without a login: the UI asks for setup on the token URL, and the API is closed', async () => {
  const root = await req('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /data-mode="none"/);
  assert.equal((await req('/api/downloads')).status, 401);
  assert.equal((await req('/login', { body: { user: 'admin', password: 'whatever-123' } })).status, 401);

  const setup = await req(`/${env.TOKEN}/`);
  assert.equal(setup.status, 200);
  assert.match(setup.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await setup.text(), /data-mode="setup"/);
});

test('setup creates the login once, needs the token, and logs in', async () => {
  assert.equal((await req('/wrong-token-0123456789/setup', { body: { user: 'me', password: 'long-enough-1' } })).status, 404);
  for (const bad of [{ user: 'me', password: 'short' }, { user: 'has space', password: 'long-enough-1' }, { user: '', password: 'long-enough-1' }, {}]) {
    const r = await req(`/${env.TOKEN}/setup`, { body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }

  const r = await req(`/${env.TOKEN}/setup`, { body: { user: 'me', password: 'long-enough-1' } });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Path=\//);
  cookie = sessionCookie(r);

  const again = await req(`/${env.TOKEN}/setup`, { body: { user: 'evil', password: 'long-enough-2' } });
  assert.equal(again.status, 409, 'only the first login can be made with the token');

  // The old UI URL now leads to the UI at /.
  const old = await req(`/${env.TOKEN}/`);
  assert.equal(old.status, 302);
  assert.equal(new URL(old.headers.get('location'), `${env.origin}/${env.TOKEN}/`).pathname, '/');
  assert.equal(new URL((await req(`/${env.TOKEN}`)).headers.get('location'), `${env.origin}/${env.TOKEN}`).pathname, '/');

  const saved = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
  assert.equal(saved.user, 'me');
  assert.match(saved.hash, /^scrypt\$/);
  assert.doesNotMatch(fs.readFileSync(authFile(), 'utf8'), /long-enough-1/);
  assert.equal(fs.statSync(authFile()).mode & 0o777, 0o600);
});

test('a session opens the UI and the API', async () => {
  const ui = await req('/', { cookie });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<nav aria-label="Sections">/);
  const s = await (await req('/api/session', { cookie })).json();
  assert.deepEqual({ user: s.user, token: s.token, fromEnv: s.fromEnv }, { user: 'me', token: env.TOKEN, fromEnv: false });
  assert.equal((await req('/api/downloads', { cookie })).status, 200);
});

test('Stremio needs only the token, never a login', async () => {
  assert.equal((await req(`/${env.TOKEN}/manifest.json`)).status, 200);
  assert.equal((await req(`/${env.TOKEN}/stream/movie/tt0000001.json`)).status, 200);
});

test('login: right and wrong passwords, wrong usernames', async () => {
  assert.equal((await req('/login', { body: { user: 'me', password: 'wrong-password' } })).status, 401);
  assert.equal((await req('/login', { body: { user: 'nobody', password: 'long-enough-1' } })).status, 401);
  assert.equal((await req('/login', { body: { user: 'me' } })).status, 401);
  const r = await req('/login', { body: { user: 'me', password: 'long-enough-1' } });
  assert.equal(r.status, 200);
  assert.equal((await req('/api/downloads', { cookie: sessionCookie(r) })).status, 200);
});

test('forged, tampered and expired cookies are refused', async () => {
  const [exp, sig] = cookie.split('=')[1].split('.');
  const later = `ldw_session=${Number(exp) + 1000}.${sig}`;
  const past = `ldw_session=${Date.now() - 1000}.${sig}`;
  for (const bad of ['ldw_session=', 'ldw_session=x', `ldw_session=${exp}.AAAA`, later, past, `ldw_session=${exp}.${sig}x`]) {
    assert.equal((await req('/api/downloads', { cookie: bad })).status, 401, bad);
  }
  const ui = await req('/', { cookie: later });
  assert.match(await ui.text(), /data-mode="login"/);
});

test('an old UI tab polling the former API under the token gets told to reload, without strikes', async () => {
  cfg.tokenFailuresLockout = 2;
  const ip = freshIp();
  for (let i = 0; i < 3; i++) assert.equal((await req(`/${env.TOKEN}/api/downloads`, { ip })).status, 410);
  assert.equal(security.lockedFor(ip), 0);
});

test('wrong passwords lock an IP out; add-on requests do not reset the count', async () => {
  cfg.tokenFailuresLockout = 3;
  const ip = freshIp();
  for (let i = 0; i < 2; i++) {
    assert.equal((await req('/login', { ip, body: { user: 'me', password: `guess-${i}-xxxx` } })).status, 401);
    assert.equal((await req(`/${env.TOKEN}/manifest.json`, { ip })).status, 200);
  }
  assert.equal(security.lockedFor(ip), 0);
  await req('/login', { ip, body: { user: 'me', password: 'guess-3-xxxx' } });
  assert.ok(security.lockedFor(ip) > 0);
  assert.equal((await req('/login', { ip, body: { user: 'me', password: 'long-enough-1' } })).status, 429, 'even the right password');
  assert.equal((await req(`/${env.TOKEN}/manifest.json`, { ip })).status, 429);
});

test('changing the login needs the current password and logs other sessions out', async () => {
  const other = sessionCookie(await req('/login', { body: { user: 'me', password: 'long-enough-1' } }));

  const wrong = await req('/api/account', { cookie, body: { currentPassword: 'nope-nope', user: 'me', password: 'new-password-1' } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).field, 'currentPassword');
  assert.equal((await req('/api/account', { cookie, body: { currentPassword: 'long-enough-1', user: 'me', password: 'short' } })).status, 400);

  const r = await req('/api/account', { cookie, body: { currentPassword: 'long-enough-1', user: 'me2', password: 'new-password-1' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user, 'me2');
  const fresh = sessionCookie(r);
  assert.equal((await req('/api/downloads', { cookie: fresh })).status, 200, 'this browser stays logged in');
  assert.equal((await req('/api/downloads', { cookie: other })).status, 401, 'other browsers are logged out');
  assert.equal((await req('/api/downloads', { cookie })).status, 401);

  assert.equal((await req('/login', { body: { user: 'me', password: 'long-enough-1' } })).status, 401);
  assert.equal((await req('/login', { body: { user: 'me2', password: 'new-password-1' } })).status, 200);
  cookie = fresh;
});

test('sessions survive a restart (the signing key is in auth.json)', async () => {
  require('../auth').reset();
  assert.equal((await req('/api/session', { cookie })).status, 200);
});

test('logging out clears the cookie', async () => {
  const r = await req('/api/logout', { cookie, method: 'POST' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^ldw_session=;.*Max-Age=0/);
});
