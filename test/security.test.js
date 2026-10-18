// Auth hardening: token check, plain 404s, headers, body limits, rate limits, wrong-token lockout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

let env;
let cfg;
let security;
let ipN = 0;
const freshIp = () => `203.0.113.${++ipN}`; // via X-Forwarded-For from loopback (a trusted proxy)

test.before(async () => {
  env = await boot();
  cfg = require('../config');
  security = require('../security');
});
test.after(() => env.close());
test.beforeEach(() => {
  security.reset();
  Object.assign(cfg, { playStartsPerIpPerMin: 0, playStartsPerMin: 0, apiWritesPerIpPerMin: 0, tokenFailuresLockout: 0 });
});

const as = (ip, p, opts = {}) => fetch(p.startsWith('http') ? p : env.base + p, { ...opts, headers: { 'X-Forwarded-For': ip, ...(opts.headers || {}) }, redirect: 'manual' });
const post = (ip, p, body) => as(ip, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('token comparison', () => {
  assert.equal(security.tokenOk(env.TOKEN), true);
  assert.equal(security.tokenOk(env.TOKEN + 'x'), false);
  assert.equal(security.tokenOk(env.TOKEN.slice(0, -1) + 'X'), false);
  assert.equal(security.tokenOk(''), false);
});

test('only private/loopback proxies may set the client IP', () => {
  const trust = env.app.get('trust proxy fn');
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('172.18.0.5', 0), true);
  assert.equal(trust('192.168.1.10', 0), true);
  assert.equal(trust('198.51.100.7', 0), false);
});

test('unknown paths get a plain 404 that does not echo the path', async () => {
  const r = await fetch(`${env.origin}/secret-guess-here/manifest.json`);
  assert.equal(r.status, 404);
  assert.equal(await r.text(), 'Not found');
  assert.equal((await fetch(`${env.origin}/`)).status, 404);
});

test('security headers', async () => {
  const ui = await fetch(`${env.base}/`);
  assert.match(ui.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(ui.headers.get('x-frame-options'), 'DENY');
  assert.equal(ui.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await ui.text(), /<meta name="referrer" content="no-referrer">/);
  const api = await fetch(`${env.base}/api/downloads`);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(api.headers.get('x-powered-by'), null);
});

test('request bodies are size limited; bad JSON gets no stack trace', async () => {
  const big = await post(freshIp(), '/api/settings', { languages: 'x'.repeat(40 * 1024) });
  assert.equal(big.status, 413);
  const bad = await as(freshIp(), '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await bad.text(), /at .*\.js/);
});

test('web UI actions are limited per IP', async () => {
  cfg.apiWritesPerIpPerMin = 3;
  const ip = freshIp();
  for (let i = 0; i < 3; i++) assert.notEqual((await post(ip, '/api/settings/test-client', {})).status, 429);
  const r = await post(ip, '/api/settings/test-client', {});
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await as(ip, '/api/downloads')).status, 200, 'reads are not limited');
  assert.notEqual((await post(freshIp(), '/api/settings/test-client', {})).status, 429, 'other IPs are not affected');
});

test('new downloads from /play are limited per IP and in total; playing known titles is not', async () => {
  cfg.playStartsPerIpPerMin = 2;
  cfg.playStartsPerMin = 3;
  const a = freshIp();
  // Lookups fail (no torrents in the mock), which still counts as starting a download.
  assert.equal((await as(a, '/play/movie/tt4000001')).status, 302);
  assert.equal((await as(a, '/play/movie/tt4000002')).status, 302);
  const limited = await as(a, '/play/movie/tt4000003');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  env.db.set('tt4000009', { id: 'tt4000009', type: 'movie', status: 'complete', selected: true, fileName: 'x', fileSize: 1, savePath: '/downloads' });
  assert.notEqual((await as(a, '/play/movie/tt4000009', { method: 'HEAD' })).status, 429, 'already there: not a new download');

  const b = freshIp();
  assert.equal((await as(b, '/play/movie/tt4000004')).status, 302);
  assert.equal((await as(b, '/play/movie/tt4000005')).status, 429, 'global limit (3) reached');
});

test('repeated wrong URLs lock an IP out, even with the right token', async () => {
  cfg.tokenFailuresLockout = 3;
  const ip = freshIp();
  for (let i = 0; i < 2; i++) await as(ip, `${env.origin}/guess-${i}/manifest.json`);
  await as(ip, `${env.origin}/favicon.ico`); // harmless, not counted
  assert.equal(security.lockedFor(ip), 0);
  await as(ip, `${env.origin}/guess-3/manifest.json`);
  assert.ok(security.lockedFor(ip) > 0);
  const r = await as(ip, '/manifest.json');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.equal((await as(freshIp(), '/manifest.json')).status, 200, 'other IPs are fine');
});

test('a correct request resets the miss count', async () => {
  cfg.tokenFailuresLockout = 3;
  const ip = freshIp();
  await as(ip, `${env.origin}/g1/x`);
  await as(ip, `${env.origin}/g2/x`);
  assert.equal((await as(ip, '/manifest.json')).status, 200);
  await as(ip, `${env.origin}/g3/x`);
  await as(ip, `${env.origin}/g4/x`);
  assert.equal((await as(ip, '/manifest.json')).status, 200);
});

test('lockouts double', () => {
  cfg.tokenFailuresLockout = 1;
  security.noteFailure('198.51.100.1');
  const first = security.lockedFor('198.51.100.1');
  security.noteFailure('198.51.100.1');
  const second = security.lockedFor('198.51.100.1');
  assert.ok(first > 55000 && first <= 60000, String(first));
  assert.ok(second > 115000 && second <= 120000, String(second));
});
