const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.ADDON_TOKEN = 'test-token-0123456789';
process.env.DATA_DIR = path.join(os.tmpdir(), `stremio-addon-unit-${process.pid}`);

const qb = require('../qbittorrent');
const { availableUntil } = require('../stream');

const maps = {};
qb.pieceStates = async (hash) => maps[hash];

let n = 0;
// Each case gets its own hash so stream.js's 1 s piece-map cache never leaks between cases.
function rec(states, fields) {
  const infoHash = `hash${n++}`;
  maps[infoHash] = states;
  return { id: 'tt1', infoHash, status: 'downloading', pieceSize: 100, fileOffset: 0, fileSize: 1000, ...fields };
}

test('complete records are fully available without asking qBittorrent', async () => {
  const r = { status: 'complete', fileSize: 1234, infoHash: 'nope' };
  assert.equal(await availableUntil(r, 0), 1234);
});

test('nothing downloaded at pos returns pos', async () => {
  const r = rec([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(await availableUntil(r, 0), 0);
  assert.equal(await availableUntil(r, 450), 450);
});

test('a piece being downloaded (1) does not count', async () => {
  const r = rec([2, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(await availableUntil(r, 0), 100);
  assert.equal(await availableUntil(r, 150), 150);
});

test('contiguous run from pos ends at the first missing piece', async () => {
  const r = rec([2, 2, 2, 0, 2, 2, 0, 0, 0, 0]);
  assert.equal(await availableUntil(r, 0), 300);
  assert.equal(await availableUntil(r, 250), 300);
  assert.equal(await availableUntil(r, 300), 300);
  assert.equal(await availableUntil(r, 420), 600);
});

test('all pieces present caps at the file size', async () => {
  const r = rec(new Array(10).fill(2));
  assert.equal(await availableUntil(r, 0), 1000);
});

test('second file in a multi-file torrent uses the file offset', async () => {
  // file 0: 250 bytes (pieces 0-2), file 1 starts at byte 250 (inside piece 2) and is 500 bytes (to byte 750, piece 7).
  const states = [0, 0, 2, 2, 2, 0, 2, 2];
  const r = rec(states, { fileOffset: 250, fileSize: 500 });
  // file pos 0 = torrent byte 250 = piece 2; run covers pieces 2..4 -> torrent byte 500 -> file pos 250
  assert.equal(await availableUntil(r, 0), 250);
  assert.equal(await availableUntil(r, 250), 250); // piece 5 missing
  // file pos 300 = torrent byte 550 = piece 5: missing
  assert.equal(await availableUntil(r, 300), 300);
  // file pos 400 = torrent byte 650 = piece 6; run 6..7 -> torrent byte 800 -> clamp to file size 500
  assert.equal(await availableUntil(r, 400), 500);
});

test('partial last piece is clamped to the file size', async () => {
  const r = rec([2, 2, 2, 2, 2, 2, 2, 2, 2, 2], { fileSize: 950 });
  assert.equal(await availableUntil(r, 900), 950);
});
