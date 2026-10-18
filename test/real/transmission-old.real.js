// Transmission before 4.1 has no sequential download: the connection test must say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const d = require('./docker');

process.env.ADDON_TOKEN = 'test-token-0123456789';
process.env.DATA_DIR = path.join(os.tmpdir(), `stremio-real-old-${process.pid}`);
const transmission = require('../../clients/transmission');

const IMAGE = process.env.REAL_TR_OLD_IMAGE || 'lscr.io/linuxserver/transmission:4.0.6';

test.after(() => d.rm('real-tr-old'));

test('Transmission 4.0: connection works, with a warning about sequential download', { timeout: 300000 }, async () => {
  await d.network();
  const c = await d.startTr({ name: 'real-tr-old', port: 19093, mounts: [], image: IMAGE });
  const r = await transmission.testConnection({ url: c.url, user: c.user, pass: c.pass });
  assert.equal(r.ok, true, r.error);
  assert.match(r.version, /^Transmission 4\.0\./);
  assert.match(r.warning, /no sequential download/);
});
