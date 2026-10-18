// End-to-end: Stremio protocol + /play range serving against a mock torrent client.
// Run once per client by addon.<client>.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot, waitFor, pattern } = require('./boot');

const HASH = 'a'.repeat(40);
const ID = 'tt0133093';
const PIECE = 16384;
const EXTRA = { name: 'The.Matrix/sample.txt', size: 10000 };
const MOVIE = { name: 'The.Matrix/The.Matrix.1999.1080p.mkv', size: 100000 };
const CONTENT = pattern(MOVIE.size);

module.exports = function addonSuite({ client, mockOpts, partial }) {
  let env;

  test.before(async () => {
    env = await boot({}, { client, mockOpts });
    env.mock.torrentio[ID] = {
      streams: [
        { name: 'Torrentio\n2160p', title: 'The.Matrix.2160p\n👤 900', infoHash: 'b'.repeat(40), fileIdx: 0 },
        { name: 'Torrentio\n1080p', title: 'The.Matrix.1999.1080p\n👤 50 💾 100 KB', infoHash: HASH, fileIdx: 1, sources: ['tracker:udp://t.example:1337'] },
        { name: 'Torrentio\n720p', title: 'The.Matrix.720p\n👤 10', infoHash: 'c'.repeat(40) },
      ],
    };
    env.mock.onAdd = (hash) => env.mock.addTorrent({ hash, name: 'The.Matrix', pieceSize: PIECE, files: [EXTRA, MOVIE] });
  });

  test.after(() => env && env.close());

  const get = (p, opts) => fetch(env.base + p, opts);
  const stream = async () => (await (await get(`/stream/movie/${ID}.json`)).json()).streams;
  const movieOnDisk = () => path.join(env.downloads, MOVIE.name);
  // Where the client keeps the file while it downloads (partial suffix, maybe an incomplete dir).
  const partialOnDisk = () => path.join(env.downloads, partial.dir || '', MOVIE.name + partial.suffix);

  /** Raw GET that collects whatever bytes arrive before the server ends or drops the connection. */
  function rawGet(p, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(env.base + p, { headers }, (res) => {
        const chunks = [];
        let aborted = false;
        res.on('data', (c) => chunks.push(c));
        res.on('aborted', () => (aborted = true));
        res.on('error', () => (aborted = true));
        res.on('close', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete && !aborted })
        );
      });
      req.on('error', reject);
    });
  }

  test('manifest is served under the token and nowhere else', async () => {
    const m = await (await get('/manifest.json')).json();
    assert.equal(m.id, 'community.local.download-and-watch');
    assert.deepEqual(m.resources, ['stream']);
    assert.equal((await fetch(`${env.origin}/manifest.json`)).status, 404);
    assert.equal((await fetch(`${env.origin}/wrong-token-0123456789/manifest.json`)).status, 404);
  });

  test('bad ids get no streams', async () => {
    assert.deepEqual((await (await get('/stream/movie/notanid.json')).json()).streams, []);
    assert.deepEqual((await (await get('/stream/channel/tt1.json')).json()).streams, []);
    assert.equal((await get('/play/movie/evil')).status, 400);
  });

  test('unknown title shows the Download entry', async () => {
    const [s] = await stream();
    assert.match(s.name, /Download/);
    assert.equal(s.url, `${env.base}/play/movie/${ID}`);
  });

  test('queueing picks the best <= MAX_RES torrent and selects only the needed file', async () => {
    const r = await get('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', id: ID }),
    });
    assert.equal(r.status, 200);

    const add = env.mock.added.at(-1);
    assert.match(add.magnet, new RegExp(`btih:${HASH}`));
    assert.match(add.magnet, /&tr=udp%3A%2F%2Ft\.example%3A1337/);
    assert.equal(add.label, 'stremio');
    assert.equal(add.sequential, true);
    if (client === 'qbittorrent') assert.equal(add.raw.firstLastPiecePrio, 'true');

    const rec = await waitFor(() => env.db.get(ID)?.selected && env.db.get(ID));
    assert.equal(rec.status, 'downloading');
    assert.equal(rec.fileIndex, 1);
    assert.equal(rec.fileOffset, EXTRA.size);
    assert.equal(rec.pieceSize, PIECE);
    const t = env.mock.torrents.get(HASH);
    assert.deepEqual(t.files.map((f) => f.priority), [0, 1]);
  });

  test('downloading entry shows the percentage', async () => {
    const t = env.mock.torrents.get(HASH);
    // Pieces covering the extra file and the first ~half of the movie.
    env.mock.havePieces(HASH, 0, 4);
    const until = 4 * PIECE - EXTRA.size; // exclusive end of the downloaded run inside the movie file
    fs.mkdirSync(path.dirname(partialOnDisk()), { recursive: true });
    fs.writeFileSync(partialOnDisk(), CONTENT);
    await waitFor(() => env.db.get(ID).progress > 0);
    const [s] = await stream();
    assert.equal(s.name, `⏳ Your server ${Math.round((until / MOVIE.size) * 100)}%`);
    assert.ok(t);
  });

  test(`range inside the downloaded part is served exactly (from the ${partial.suffix} file)`, async () => {
    const r = await rawGet(`/play/movie/${ID}`, { Range: 'bytes=100-4099' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes 100-4099/${MOVIE.size}`);
    assert.equal(r.headers['content-type'], 'video/x-matroska');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.ok(r.complete);
    assert.deepEqual(r.body, CONTENT.subarray(100, 4100));
  });

  test('reading past the downloaded edge sends only real bytes, then drops the connection', async () => {
    const until = 4 * PIECE - EXTRA.size;
    const r = await rawGet(`/play/movie/${ID}`, { Range: 'bytes=0-' });
    assert.equal(r.status, 206);
    assert.equal(Number(r.headers['content-length']), MOVIE.size);
    assert.equal(r.complete, false);
    assert.equal(r.body.length, until);
    assert.deepEqual(r.body, CONTENT.subarray(0, until));
  });

  test('HEAD returns headers only', async () => {
    const r = await get(`/play/movie/${ID}`, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers.get('content-length')), MOVIE.size);
  });

  test('unsatisfiable range gets 416', async () => {
    const r = await rawGet(`/play/movie/${ID}`, { Range: `bytes=${MOVIE.size}-` });
    assert.equal(r.status, 416);
    assert.equal(r.headers['content-range'], `bytes */${MOVIE.size}`);
  });

  test('completed download shows "Your server" and serves the whole file', async () => {
    env.mock.completeAll(HASH);
    fs.mkdirSync(path.dirname(movieOnDisk()), { recursive: true });
    fs.renameSync(partialOnDisk(), movieOnDisk());
    await waitFor(() => env.db.get(ID).status === 'complete');
    const [s] = await stream();
    assert.equal(s.name, '🏠 Your server');

    const r = await rawGet(`/play/movie/${ID}`);
    assert.equal(r.status, 200);
    assert.ok(r.complete);
    assert.deepEqual(r.body, CONTENT);
  });

  test('a complete file stays playable after the torrent is removed from the client', async () => {
    env.mock.torrents.delete(HASH);
    await new Promise((r) => setTimeout(r, 200)); // a few sync rounds
    assert.equal(env.db.get(ID).status, 'complete');
    const r = await rawGet(`/play/movie/${ID}`, { Range: 'bytes=0-9' });
    assert.deepEqual(r.body, CONTENT.subarray(0, 10));
  });

  test('torrent and file both gone -> missing -> Download is offered again', async () => {
    fs.rmSync(movieOnDisk());
    await waitFor(() => env.db.get(ID).status === 'missing');
    const [s] = await stream();
    assert.match(s.name, /Download/);
  });

  test('/play on a new title starts the download and plays once metadata is in', async () => {
    const id = 'tt0000002';
    const hash = 'd'.repeat(40);
    const file = { name: 'Short.mp4', size: 3000 };
    const data = pattern(file.size, 3);
    env.mock.torrentio[id] = { streams: [{ name: '1080p', title: 'Short 1080p\n👤 5', infoHash: hash }] };
    fs.writeFileSync(path.join(env.downloads, file.name), data);
    env.mock.onAdd = (h) => {
      env.mock.addTorrent({ hash: h, pieceSize: PIECE, files: [file] });
      env.mock.completeAll(h);
    };

    const r = await rawGet(`/play/movie/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.deepEqual(r.body, data);
  });

  test('/play reports a lookup failure without hanging', async () => {
    const r = await get('/play/movie/tt0000404');
    assert.equal(r.status, 502);
    assert.match(await r.text(), /No torrents found/);
    assert.equal(env.db.get('tt0000404').status, 'error');
  });
};
