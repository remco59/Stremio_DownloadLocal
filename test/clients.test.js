// Contract tests: both clients implement the same interface with the same normalized results.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const os = require('os');
const path = require('path');
const { createMockQb } = require('./helpers/mock-qb');
const { createMockTransmission, bitfield } = require('./helpers/mock-transmission');

process.env.ADDON_TOKEN = 'test-token-0123456789';
process.env.DATA_DIR = path.join(os.tmpdir(), `stremio-addon-unit-${process.pid}`);

const cfg = require('../config');
const clients = require('../clients');
const transmission = require('../clients/transmission');

const HASH = 'e'.repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Show`;
const FILES = [
  { name: 'Show/S01E01.mkv', size: 50000 },
  { name: 'Show/S01E02.mkv', size: 50000 },
  { name: 'Show/info.nfo', size: 100 },
];

/** A local port nothing listens on. */
function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const servers = [];
async function start(factory, opts) {
  const s = factory(opts);
  const url = await s.listen();
  servers.push(s);
  s.mock.onAdd = (hash) => s.mock.addTorrent({ hash, name: 'Show', pieceSize: 16384, files: FILES });
  return { url, mock: s.mock };
}
test.after(() => Promise.all(servers.map((s) => s.close())));

const SETUPS = {
  qbittorrent: async (opts) => {
    const { url, mock } = await start(createMockQb, opts);
    Object.assign(cfg, { torrentClient: 'qbittorrent', qbUrl: url, qbUser: 'admin', qbPass: 'secret', qbCategory: 'stremio' });
    return mock;
  },
  transmission: async (opts) => {
    const { url, mock } = await start(createMockTransmission, opts);
    Object.assign(cfg, { torrentClient: 'transmission', trUrl: url, trUser: 'admin', trPass: 'secret', trLabel: 'stremio' });
    return mock;
  },
};

for (const [name, setup] of Object.entries(SETUPS)) {
  test(`${name}: full interface round trip`, async () => {
    const mock = await setup();
    assert.equal(clients.active(), clients.CLIENTS[name]);

    assert.deepEqual(await clients.info([HASH]), []);
    assert.equal(await clients.files(HASH), null);

    await clients.add({ magnet: MAGNET, hash: HASH });
    assert.equal(mock.added.at(-1).sequential, true);
    assert.equal(mock.added.at(-1).label, 'stremio');
    await clients.add({ magnet: MAGNET, hash: HASH }); // duplicate is fine

    const [t] = await clients.info([HASH]);
    assert.equal(t.hash, HASH);
    assert.equal(t.name, 'Show');
    assert.equal(t.state, 'downloading');
    assert.equal(t.error, null);
    assert.equal(t.savePath, '/downloads');
    assert.equal(typeof t.progress, 'number');

    mock.havePieces(HASH, 0, 2);
    const files = await clients.files(HASH);
    assert.deepEqual(files.map((f) => [f.index, f.name, f.size]), FILES.map((f, i) => [i, f.name, f.size]));
    assert.equal(files[0].progress, 32768 / 50000);
    assert.equal(files[1].progress, 0);

    const { pieceSize, have } = await clients.pieces(HASH);
    assert.equal(pieceSize, 16384);
    assert.equal(have.length, Math.ceil(100100 / 16384));
    assert.deepEqual(have.slice(0, 3), [true, true, false]);

    await clients.setWanted(HASH, [1], FILES.length);
    assert.deepEqual(mock.torrents.get(HASH).files.map((f) => f.priority), [0, 1, 0]);
    await clients.setWanted(HASH, [0, 1, 2], FILES.length); // nothing unwanted
    assert.deepEqual(mock.torrents.get(HASH).files.map((f) => f.priority), [1, 1, 1]);

    await clients.stop(HASH);
    assert.equal((await clients.info([HASH]))[0].state, 'paused');
    await clients.start(HASH);
    assert.equal((await clients.info([HASH]))[0].state, 'downloading');

    mock.completeAll(HASH);
    assert.equal((await clients.info([HASH]))[0].state, 'seeding');

    await clients.remove(HASH, { deleteFiles: true });
    assert.equal(mock.lastRemoved.deletedFiles, true);
    assert.deepEqual(await clients.info([HASH]), []);
  });

  test(`${name}: broken torrent reports an error`, async () => {
    const mock = await setup();
    await clients.add({ magnet: MAGNET, hash: HASH });
    mock.torrents.get(HASH).error = 'missingFiles';
    const [t] = await clients.info([HASH]);
    assert.equal(t.state, 'error');
    assert.match(t.error, /missingFiles/);
  });

  test(`${name}: files are [] while metadata is missing`, async () => {
    const mock = await setup();
    mock.addTorrent({ hash: HASH, files: FILES, metadata: false });
    assert.deepEqual(await clients.files(HASH), []);
    assert.equal((await clients.info([HASH]))[0].state, 'metadata');
  });

  test(`${name}: remove without deleting files`, async () => {
    const mock = await setup();
    await clients.add({ magnet: MAGNET, hash: HASH });
    await clients.remove(HASH, { deleteFiles: false });
    assert.equal(mock.lastRemoved.deletedFiles, false);
  });

  test(`${name}: testConnection`, async () => {
    await setup();
    const ok = await clients.testConnection();
    assert.equal(ok.ok, true, ok.error);
    assert.match(ok.version, new RegExp(name, 'i'));

    const url = name === 'qbittorrent' ? cfg.qbUrl : cfg.trUrl;
    const bad = await clients.testConnection({ url, user: 'admin', pass: 'wrong' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /login failed/i);

    const down = await clients.testConnection({ url: `http://127.0.0.1:${await closedPort()}`, user: 'admin', pass: 'x' });
    assert.equal(down.ok, false);
    assert.match(down.error, /ECONNREFUSED/);
  });

  test(`${name}: new credentials are picked up without a restart`, async () => {
    await setup({ user: 'other', pass: 'pw2' });
    await assert.rejects(clients.info([HASH]), /login failed|401/i);
    if (name === 'qbittorrent') Object.assign(cfg, { qbUser: 'other', qbPass: 'pw2' });
    else Object.assign(cfg, { trUser: 'other', trPass: 'pw2' });
    assert.deepEqual(await clients.info([HASH]), []);
  });
}

test('qbittorrent 4.x: stop/start fall back to pause/resume', async () => {
  await SETUPS.qbittorrent({ v4: true });
  await clients.add({ magnet: MAGNET, hash: HASH });
  await clients.stop(HASH);
  assert.equal((await clients.info([HASH]))[0].state, 'paused');
  await clients.start(HASH);
  assert.equal((await clients.info([HASH]))[0].state, 'downloading');
});

test('transmission: the full RPC URL works too', async () => {
  await SETUPS.transmission();
  cfg.trUrl += '/transmission/rpc';
  assert.deepEqual(await clients.info([HASH]), []);
});

test('transmission: incomplete dir is reported as a partial dir', async () => {
  await SETUPS.transmission({ incompleteDir: '/downloads/incomplete/' });
  assert.deepEqual(await clients.partialDirs(), ['/downloads/incomplete']);
  assert.deepEqual(clients.partialSuffixes(), ['.part']);
  await SETUPS.transmission();
  assert.deepEqual(await clients.partialDirs(), []);
});

test('transmission: versions before 4.1 get a sequential-download warning', async () => {
  await SETUPS.transmission({ version: '4.0.6 (38c164933e)' });
  const r = await clients.testConnection();
  assert.equal(r.ok, true);
  assert.match(r.warning, /no sequential download/);
  assert.equal(transmission.sequentialWarning('4.1.0 (abc)'), null);
  assert.equal(transmission.sequentialWarning('5.0.0'), null);
  assert.match(transmission.sequentialWarning('3.00 (bb6b5a062e)'), /4\.1/);
});

test('transmission: piece bitfield decoding', () => {
  const have = [true, false, true, true, false, false, false, true, true, false, true];
  assert.deepEqual(transmission.decodeBitfield(bitfield(have), have.length), have);
  assert.deepEqual(transmission.decodeBitfield('', 3), [false, false, false]);
});

test('unknown client name gives a clear error', () => {
  cfg.torrentClient = 'deluge';
  assert.throws(() => clients.active(), /Unknown torrent client "deluge" \(known: qbittorrent, transmission\)/);
});
