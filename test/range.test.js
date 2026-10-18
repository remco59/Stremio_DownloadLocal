const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.ADDON_TOKEN = 'test-token-0123456789';
process.env.DATA_DIR = path.join(os.tmpdir(), `stremio-addon-unit-${process.pid}`);

const { parseRange } = require('../stream');

test('no Range header means the whole file', () => {
  assert.deepEqual(parseRange(undefined, 1000), { start: 0, end: 999, partial: false });
});

test('bytes=a-b', () => {
  assert.deepEqual(parseRange('bytes=10-19', 1000), { start: 10, end: 19, partial: true });
});

test('bytes=a- runs to the end', () => {
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999, partial: true });
});

test('end past the file is clamped', () => {
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999, partial: true });
});

test('suffix range bytes=-n', () => {
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999, partial: true });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999, partial: true });
});

test('whitespace around the header is tolerated', () => {
  assert.deepEqual(parseRange('  bytes=0-0 ', 1000), { start: 0, end: 0, partial: true });
});

test('unsatisfiable or malformed ranges return null', () => {
  for (const h of ['bytes=-', 'bytes=1000-', 'bytes=20-10', 'bytes=abc', 'items=0-10', 'bytes=0-10,20-30']) {
    assert.equal(parseRange(h, 1000), null, h);
  }
});
