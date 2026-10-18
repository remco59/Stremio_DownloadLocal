// Sync loop edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');

let env;
test.before(async () => {
  env = await boot({ SYNC_INTERVAL_MS: '600000' }); // rounds are run by hand here
});
test.after(() => env.close());

test('a record deleted during a sync round is not brought back', async () => {
  const id = 'tt2000001';
  env.db.set(id, {
    id, type: 'movie', status: 'complete', selected: true, infoHash: '5'.repeat(40), fileIndex: 0,
    fileName: 'Gone.mkv', fileSize: 10, savePath: '/downloads', createdAt: Date.now(),
  });
  const client = require('../clients');
  const info = client.info;
  // Simulate "Delete files" landing while the round waits for the client.
  client.info = async (hashes) => {
    const out = await info(hashes);
    env.db.delete(id);
    return out;
  };
  try {
    await env.dl.syncOnce();
  } finally {
    client.info = info;
  }
  assert.equal(fs.existsSync(path.join(env.downloads, 'Gone.mkv')), false);
  assert.equal(env.db.get(id), null);
});

test('update() only patches existing records', () => {
  assert.equal(env.db.update('tt2000404', { status: 'missing' }), null);
  assert.equal(env.db.get('tt2000404'), null);
  env.db.set('tt2000002', { status: 'queued' });
  assert.equal(env.db.update('tt2000002', { status: 'missing' }).status, 'missing');
});
