// Torrent choice: resolution cap, seeders, and the season-pack preferences used by batch downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { createMockQb } = require('./helpers/mock-qb');

let server;
let finder;
test.before(async () => {
  server = createMockQb();
  const url = await server.listen();
  Object.assign(process.env, { ADDON_TOKEN: 'test-token-0123456789', DATA_DIR: path.join(os.tmpdir(), `stremio-addon-unit-${process.pid}`), TORRENTIO_URL: url });
  finder = require('../finder');
});
test.after(() => server.close());

const h = (c) => c.repeat(40);
function streams(id, list) {
  server.mock.torrentio[id] = { streams: list.map(([title, hash, extra]) => ({ name: 'Torrentio', title, infoHash: hash, ...extra })) };
}

test('most seeders within the resolution cap', async () => {
  streams('tt1', [['A 2160p\n👤 500', h('a')], ['B 1080p\n👤 40', h('b')], ['C 720p\n👤 90', h('c')]]);
  const pick = await finder.resolve('movie', 'tt1');
  assert.equal(pick.infoHash, h('c'));
  assert.match(pick.magnet, new RegExp(`^magnet:\\?xt=urn:btih:${h('c')}&dn=C%20720p`));
});

test('preferPack picks a reasonably seeded season pack', async () => {
  streams('tt2:1:1', [['Show.S01E01.1080p\n👤 40', h('a')], ['Show.S01.1080p\n👤 12', h('b'), { fileIdx: 0 }]]);
  assert.equal((await finder.resolve('series', 'tt2:1:1')).infoHash, h('a'));
  const pick = await finder.resolve('series', 'tt2:1:1', { preferPack: true });
  assert.equal(pick.infoHash, h('b'));
  assert.equal(pick.fileIdx, 0);
});

test('a poorly seeded pack loses', async () => {
  streams('tt3:1:1', [['Show.S01E01.1080p\n👤 40', h('a')], ['Show.S01.1080p\n👤 3', h('b')]]);
  assert.equal((await finder.resolve('series', 'tt3:1:1', { preferPack: true })).infoHash, h('a'));
});

test('a torrent already used by a sibling episode wins', async () => {
  streams('tt4:1:2', [['Show.S01E02.1080p\n👤 40', h('a')], ['Show.S01E01-E03.1080p\n👤 2', h('e'), { fileIdx: 1 }]]);
  assert.equal((await finder.resolve('series', 'tt4:1:2', { preferHashes: [h('e')] })).infoHash, h('e'));
});

test('season pack detection', () => {
  assert.equal(finder.isPack('Game.of.Thrones.S01.1080p'), true);
  assert.equal(finder.isPack('Game of Thrones Season 1'), true);
  assert.equal(finder.isPack('The.Complete.Series.720p'), true);
  assert.equal(finder.isPack('GoT.S01E02.1080p'), false);
  assert.equal(finder.isPack('Movie.2010.1080p'), false);
});
