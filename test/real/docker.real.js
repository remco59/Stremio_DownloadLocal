// The add-on's own Docker image, run like docker-compose.yml does: next to a real qBittorrent container on one
// Docker network, sharing the downloads folder, with settings in a /data volume.
// If Docker Hub rate-limits the base image, pre-pull it from a mirror:
//   docker pull mirror.gcr.io/library/node:20-alpine && docker tag mirror.gcr.io/library/node:20-alpine node:20-alpine
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('./docker');

const REPO = path.join(__dirname, '..', '..');
const IMAGE = process.env.REAL_ADDON_IMAGE || 'stremio-local-addon:test';
const TOKEN = 'docker-test-token-0123456789';
const ADDON = 'real-addon';
const QB = 'real-addon-qb';
const PORT = 17000;
const base = `http://127.0.0.1:${PORT}/${TOKEN}`;
let root;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-real-docker-'));
  for (const p of ['downloads', 'data', 'qb-config']) fs.mkdirSync(path.join(root, p));
  // REAL_ADDON_IMAGE: use an image built beforehand (e.g. behind a proxy) instead of building here.
  if (!process.env.REAL_ADDON_IMAGE) await d.sh('docker', ['build', '--pull=false', '-t', IMAGE, REPO], { timeout: 900000 });
  await d.network();
}, { timeout: 900000 });

test.after(async () => {
  await Promise.all([ADDON, QB].map(d.rm));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function runAddon(envs) {
  await d.rm(ADDON);
  await d.sh('docker', [
    'run', '-d', '--name', ADDON, '--network', d.NETWORK, '-p', `${PORT}:7000`,
    ...Object.entries(envs).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${path.join(root, 'data')}:/data`, '-v', `${path.join(root, 'downloads')}:/downloads:rw`, IMAGE,
  ]);
  await d.waitFor(async () => (await fetch(`${base}/manifest.json`)).ok, 60000, 'add-on container');
}

test('compose file is valid', async () => {
  const out = await d.sh('docker', ['compose', '-f', path.join(REPO, 'docker-compose.yml'), 'config', '--quiet']).catch((e) => e.message);
  assert.equal(out, '');
});

test('add-on container talks to the qBittorrent container and keeps its settings', { timeout: 300000 }, async () => {
  const qb = await d.startQb({ name: QB, port: 18090, mounts: [`${path.join(root, 'downloads')}:/downloads`, `${path.join(root, 'qb-config')}:/config`] });
  await runAddon({ ADDON_TOKEN: TOKEN, TORRENT_CLIENT: 'qbittorrent', QB_URL: `http://${QB}:18090`, QB_USER: qb.user, QB_PASS: qb.pass });

  const logs = await d.sh('docker', ['logs', ADDON]);
  assert.match(logs, /torrent client: qbittorrent/);

  const m = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(m.id, 'community.local.download-and-watch');
  const ui = await fetch(`${base}/`);
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get('content-security-policy'), /default-src 'self'/);

  // Container to container, by service name.
  const t = await (await fetch(`${base}/api/settings/test-client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(t.ok, true, t.error);
  assert.match(t.version, /^qBittorrent v5/);

  // Settings land in the /data volume and survive a container restart.
  const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRes: 720 }) });
  assert.equal(put.status, 200);
  assert.ok(fs.existsSync(path.join(root, 'data', 'settings.json')));
  await d.sh('docker', ['restart', ADDON]);
  await d.waitFor(async () => (await fetch(`${base}/manifest.json`)).ok, 60000, 'restarted add-on');
  assert.equal((await (await fetch(`${base}/api/settings`)).json()).values.maxRes, 720);

  const clip = await fetch(`${base}/clip/started.mp4`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(clip.status, 206, 'status clips are in the image');
});

test('container refuses to start without a token', { timeout: 120000 }, async () => {
  await d.rm(ADDON);
  const out = await d.sh('docker', ['run', '--rm', '--name', ADDON, IMAGE]).catch((e) => e.message);
  assert.match(out, /ADDON_TOKEN is required/);
});
