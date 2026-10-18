// Torrent choice across Torrentio + Torznab: merging, scoring settings, the manual picker API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, waitFor } = require('./helpers/boot');

let env;
const h = (c) => c.repeat(40);
const GB = 2 ** 30;

test.before(async () => {
  env = await boot({ SOURCES: 'both', TORZNAB_APIKEY: 'tz-key', TORZNAB_URLS: '' });
  // The Torznab URL points at the mock (Jackett-style path; /api is appended).
  process.env.TORZNAB_URLS = '';
  await put({ torznabUrls: `${env.mockUrl}/torznab` });
  env.mock.onAdd = (hash) => env.mock.addTorrent({ hash, name: hash, pieceSize: 1024, files: [{ name: `${hash}.mkv`, size: 4096 }] });

  env.mock.torrentio.tt1 = {
    streams: [
      { name: 'Torrentio\n1080p', title: 'Movie.2010.1080p.WEB\n👤 80 💾 2 GB', infoHash: h('a') },
      { name: 'Torrentio\n1080p', title: 'Movie.2010.1080p.HDCAM\n👤 900 💾 1 GB', infoHash: h('b') },
      { name: 'Torrentio\n720p', title: 'Movie.2010.720p\n👤 5 💾 900 MB\n🇳🇱', infoHash: h('c') },
    ],
  };
  env.mock.torznab.tt1 = [
    { title: 'Movie.2010.1080p.WEB', hash: h('a'), size: 2 * GB, seeders: 120 }, // same torrent as Torrentio's
    { title: 'Movie.2010.1080p.REMUX', hash: h('d'), size: 30 * GB, seeders: 60 },
    { title: 'Movie.2010.1080p.torrent.only', hash: h('e'), size: GB, seeders: 999, magnet: '', withHash: false },
  ];
});
test.after(() => env.close());

async function put(patch) {
  const r = await fetch(`${env.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const cands = async (type, id) => (await fetch(`${env.base}/api/candidates/${type}/${encodeURIComponent(id)}`)).json();
const download = (body) =>
  fetch(`${env.base}/api/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('both sources are merged and de-duplicated by info hash', async () => {
  const { candidates } = await cands('movie', 'tt1');
  const hashes = candidates.map((c) => c.infoHash);
  assert.deepEqual([...hashes].sort(), [h('a'), h('b'), h('c'), h('d')]);
  const a = candidates.find((c) => c.infoHash === h('a'));
  assert.equal(a.seeders, 120);
  assert.match(a.source, /Torrentio \+ Torznab/);
  assert.equal('magnet' in a, false, 'magnets are not sent to the browser');
  const q = env.mock.torznabQueries.at(-1);
  assert.deepEqual([q.t, q.imdbid, q.apikey], ['movie', 'tt1', 'tz-key']);
});

test('blocked words are rejected; the best of the rest wins', async () => {
  const { candidates } = await cands('movie', 'tt1');
  assert.equal(candidates[0].infoHash, h('a'));
  const cam = candidates.find((c) => c.infoHash === h('b'));
  assert.match(cam.rejected, /blocked word "hdcam"/);
  assert.equal(candidates.at(-1).infoHash, h('b'), 'rejected ones are listed last');
});

test('language preference, size limit and preferred words change the order', async () => {
  await put({ languages: 'nl' });
  assert.equal((await cands('movie', 'tt1')).candidates[0].infoHash, h('c'));
  await put({ languages: '', preferKeywords: 'remux' });
  assert.equal((await cands('movie', 'tt1')).candidates[0].infoHash, h('d'));
  await put({ maxSizeGb: 20 });
  const { candidates } = await cands('movie', 'tt1');
  assert.match(candidates.find((c) => c.infoHash === h('d')).rejected, /larger than 20 GB/);
  assert.equal(candidates[0].infoHash, h('a'));
  await put({ preferKeywords: null, maxSizeGb: null });
});

test('downloading a hand-picked torrent, then switching to another one', async () => {
  let r = await download({ type: 'movie', id: 'tt1', infoHash: h('c') });
  assert.equal(r.status, 200);
  await waitFor(() => env.db.get('tt1')?.selected);
  assert.equal(env.db.get('tt1').infoHash, h('c'));

  // Same pick again: nothing changes.
  assert.equal((await download({ type: 'movie', id: 'tt1', infoHash: h('c') })).status, 200);
  assert.equal(env.mock.added.filter((a) => a.magnet.includes(h('c'))).length, 1);

  r = await download({ type: 'movie', id: 'tt1', infoHash: h('a') });
  assert.equal(r.status, 200);
  assert.equal(env.mock.torrents.has(h('c')), false, 'old torrent removed from the client');
  assert.equal(env.mock.lastRemoved.deletedFiles, false, '...but its files are kept');
  await waitFor(() => env.db.get('tt1')?.selected && env.db.get('tt1').infoHash === h('a'));

  assert.equal((await download({ type: 'movie', id: 'tt1', infoHash: h('9') })).status, 404);
});

test('Torznab season pack: the episode file is found by name', async () => {
  await put({ sources: 'torznab' });
  const id = 'tt5:1:2';
  env.mock.torznab[id] = [{ title: 'Show.S01.1080p.WEB', hash: h('f'), size: 3 * GB, seeders: 30 }];
  env.mock.onAdd = (hash) =>
    env.mock.addTorrent({
      hash,
      name: 'Show.S01',
      pieceSize: 1024,
      files: [
        { name: 'Show.S01/Show.S01E01.mkv', size: 9000 },
        { name: 'Show.S01/Show.S01E02.mkv', size: 4000 },
        { name: 'Show.S01/Show.S01E03.mkv', size: 8000 },
      ],
    });
  assert.equal((await download({ type: 'series', id })).status, 200);
  const rec = await waitFor(() => env.db.get(id)?.selected && env.db.get(id));
  assert.equal(rec.fileName, 'Show.S01/Show.S01E02.mkv');
  const q = env.mock.torznabQueries.at(-1);
  assert.deepEqual([q.t, q.imdbid, q.season, q.ep], ['tvsearch', 'tt5', '1', '2']);
});

test('Torznab errors are reported', async () => {
  await put({ torznabApiKey: 'wrong' });
  const r = await fetch(`${env.base}/api/candidates/movie/tt1`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Incorrect user credentials/);
  await put({ torznabApiKey: 'tz-key', sources: null });
});
