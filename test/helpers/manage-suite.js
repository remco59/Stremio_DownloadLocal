// Download management (pause/resume, remove, delete files, re-download, forget) through the client interface.
// Run once per client by manage.<client>.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, waitFor, pattern } = require('./boot');

module.exports = function manageSuite({ client }) {
  let env;
  let n = 0;

  test.before(async () => {
    env = await boot({}, { client });
  });
  test.after(() => env && env.close());

  const call = (method, p) => fetch(env.base + p, { method });
  const act = async (id, action, method = 'POST') => {
    const r = await call(method, `/api/downloads/${encodeURIComponent(id)}${action ? '/' + action : ''}`);
    return { status: r.status, body: await r.json() };
  };
  const item = async (id) => (await (await call('GET', '/api/downloads')).json()).items.find((d) => d.id === id);
  const onDisk = (name) => path.join(env.downloads, name);

  /** Queues `ids` (all served by one new torrent with `files`) and waits until each has picked its file. */
  async function queue(ids, files) {
    const hash = (++n).toString(16).padStart(40, '0');
    ids.forEach((id, i) => {
      env.mock.torrentio[id] = { streams: [{ name: '1080p', title: `T${n} 1080p\n👤 9`, infoHash: hash, fileIdx: i }] };
    });
    env.mock.onAdd = (h) => env.mock.addTorrent({ hash: h, name: `T${n}`, pieceSize: 1024, files });
    for (const id of ids) {
      const type = id.includes(':') ? 'series' : 'movie';
      const r = await fetch(`${env.base}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id }),
      });
      assert.equal(r.status, 200);
      await waitFor(() => env.db.get(id)?.selected);
    }
    return hash;
  }

  function writeFiles(files) {
    for (const f of files) {
      fs.mkdirSync(path.dirname(onDisk(f.name)), { recursive: true });
      fs.writeFileSync(onDisk(f.name), pattern(f.size));
    }
  }

  test('list shows size, live speed/ETA and client state', async () => {
    const id = 'tt1000001';
    await queue([id], [{ name: 'A/A.mkv', size: 4096 }]);
    const d = await item(id);
    assert.equal(d.size, 4096);
    assert.equal(d.status, 'downloading');
    assert.equal(d.inClient, true);
    assert.equal(d.paused, false);
    assert.equal(d.dlSpeed, 1234);
    assert.equal(d.eta, 60);
    assert.equal(d.seeds, 3);
    assert.equal(d.shared, false);
  });

  test('pause and resume', async () => {
    const id = 'tt1000001';
    const hash = env.db.get(id).infoHash;
    assert.equal((await act(id, 'pause')).status, 200);
    assert.equal(env.mock.torrents.get(hash).paused, true);
    assert.equal((await item(id)).paused, true);
    assert.equal((await act(id, 'resume')).status, 200);
    assert.equal(env.mock.torrents.get(hash).paused, false);
    assert.equal((await item(id)).paused, false);
  });

  test('remove an unfinished download: gone from the client, Download is offered again, re-download works', async () => {
    const id = 'tt1000001';
    const hash = env.db.get(id).infoHash;
    const { status, body } = await act(id, 'remove');
    assert.equal(status, 200);
    assert.equal(body.item.status, 'missing');
    assert.equal(env.mock.torrents.has(hash), false);
    assert.equal(env.mock.lastRemoved.deletedFiles, false);
    const s = await (await call('GET', `/stream/movie/${id}.json`)).json();
    assert.match(s.streams[0].name, /Download/);

    assert.equal((await act(id, 'pause')).status, 409);
    assert.equal((await act(id, 'redownload')).status, 200);
    assert.equal(env.mock.torrents.has(hash), true);
    await waitFor(() => env.db.get(id).status === 'downloading');
    assert.equal((await act(id, 'redownload')).status, 409); // already downloading
  });

  test('remove a finished download: stays playable from disk', async () => {
    const id = 'tt1000002';
    const files = [{ name: 'B/B.mkv', size: 3000 }];
    const hash = await queue([id], files);
    writeFiles(files);
    env.mock.completeAll(hash);
    await waitFor(() => env.db.get(id).status === 'complete');

    const { body } = await act(id, 'remove');
    assert.equal(body.item.status, 'complete');
    assert.equal(body.item.inClient, false);
    const r = await call('GET', `/play/movie/${id}`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), pattern(3000));
  });

  test('delete files of a download no longer in the client: unlinked from disk, empty folder removed', async () => {
    const id = 'tt1000002';
    assert.ok(fs.existsSync(onDisk('B/B.mkv')));
    assert.equal((await act(id, 'delete-files')).status, 200);
    assert.equal(fs.existsSync(onDisk('B/B.mkv')), false);
    assert.equal(fs.existsSync(onDisk('B')), false);
    assert.ok(fs.existsSync(env.downloads), 'the downloads root itself stays');
    assert.equal(env.db.get(id), null);
    assert.equal(await item(id), undefined);
  });

  test('delete files of a download the client owns alone: deleted through the client', async () => {
    const id = 'tt1000003';
    const hash = await queue([id], [{ name: 'C/C.mkv', size: 2000 }]);
    assert.equal((await act(id, 'delete-files')).status, 200);
    assert.equal(env.mock.torrents.has(hash), false);
    assert.equal(env.mock.lastRemoved.deletedFiles, true);
    assert.equal(env.db.get(id), null);
  });

  test('season pack: deleting one episode keeps the torrent and the other episode', async () => {
    const e1 = 'tt0944947:1:1';
    const e2 = 'tt0944947:1:2';
    const files = [
      { name: 'GoT.S01/E01.mkv', size: 2048 },
      { name: 'GoT.S01/E02.mkv', size: 2048 },
      { name: 'GoT.S01/E03.mkv', size: 2048 },
    ];
    const hash = await queue([e1, e2], files);
    writeFiles(files.slice(0, 2));
    const t = env.mock.torrents.get(hash);
    assert.deepEqual(t.files.map((f) => f.priority), [1, 1, 0]);
    assert.equal((await item(e1)).shared, true);
    assert.equal((await item(e2)).label, 'E02.mkv', 'the episode file, not the pack name');

    assert.equal((await act(e1, 'delete-files')).status, 200);
    assert.equal(env.mock.torrents.has(hash), true, 'torrent stays for episode 2');
    assert.deepEqual(t.files.map((f) => f.priority), [0, 1, 0]);
    assert.equal(fs.existsSync(onDisk(files[0].name)), false);
    assert.equal(fs.existsSync(onDisk(files[1].name)), true);
    assert.equal(env.db.get(e2).status, 'downloading');

    // Episode 2 is now the only user: removing it removes the torrent.
    assert.equal((await act(e2, 'remove')).status, 200);
    assert.equal(env.mock.torrents.has(hash), false);
  });

  test('season pack: removing one episode only drops its file from the torrent', async () => {
    const e1 = 'tt0944947:2:1';
    const e2 = 'tt0944947:2:2';
    const hash = await queue([e1, e2], [{ name: 'S2/E1.mkv', size: 1024 }, { name: 'S2/E2.mkv', size: 1024 }]);
    assert.equal((await act(e1, 'remove')).status, 200);
    const t = env.mock.torrents.get(hash);
    assert.ok(t, 'torrent stays');
    assert.deepEqual(t.files.map((f) => f.priority), [0, 1]);
    assert.equal(env.db.get(e1).status, 'missing');
  });

  test('never deletes outside the downloads folder (symlink escape)', async () => {
    const outside = fs.mkdtempSync(path.join(path.dirname(env.downloads), 'outside-'));
    fs.writeFileSync(path.join(outside, 'victim.mkv'), 'keep me');
    fs.symlinkSync(outside, onDisk('evil'));
    const id = 'tt1000009';
    env.db.set(id, {
      id, type: 'movie', title: 'evil', status: 'complete', selected: true, infoHash: '7'.repeat(40),
      fileIndex: 0, fileName: 'evil/victim.mkv', fileSize: 7, savePath: '/downloads', createdAt: Date.now(),
    });
    const { status, body } = await act(id, 'delete-files');
    assert.equal(status, 400);
    assert.match(body.error, /outside the downloads folder/);
    assert.equal(fs.readFileSync(path.join(outside, 'victim.mkv'), 'utf8'), 'keep me');
  });

  test('forget drops only the record', async () => {
    const id = 'tt1000010';
    const hash = await queue([id], [{ name: 'F.mkv', size: 100 }]);
    assert.equal((await act(id, '', 'DELETE')).status, 200);
    assert.equal(env.db.get(id), null);
    assert.equal(env.mock.torrents.has(hash), true);
  });

  const libDelete = async (body) => {
    const r = await fetch(`${env.base}/api/library/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  test('library: deleting a whole season pack at once removes the torrent and every file', async () => {
    const ids = ['tt0944947:3:1', 'tt0944947:3:2'];
    const files = [{ name: 'GoT.S03/E01.mkv', size: 1024 }, { name: 'GoT.S03/E02.mkv', size: 1024 }];
    const hash = await queue(ids, files);
    writeFiles(files);
    env.mock.completeAll(hash);
    await waitFor(() => ids.every((id) => env.db.get(id).status === 'complete'));

    const { status, body } = await libDelete({ ids: [...ids, 'tt404404'] });
    assert.equal(status, 200);
    assert.deepEqual(body.deleted, ids);
    assert.deepEqual(body.failed.map((f) => f.id), ['tt404404']);
    assert.equal(env.mock.torrents.has(hash), false);
    assert.equal(env.mock.lastRemoved.deletedFiles, true);
    assert.equal(fs.existsSync(onDisk(files[0].name)), false, 'the first episode was unlinked while the torrent was still shared');
    ids.forEach((id) => assert.equal(env.db.get(id), null));
  });

  test('library: bad delete requests', async () => {
    assert.equal((await libDelete({})).status, 400);
    assert.equal((await libDelete({ ids: [] })).status, 400);
    assert.equal((await libDelete({ ids: ['tt1', '../etc'] })).status, 400);
    assert.equal((await libDelete({ ids: 'tt1000001' })).status, 400);
  });

  test('bad requests', async () => {
    assert.equal((await act('tt404404', 'pause')).status, 404);
    assert.equal((await act('nope', 'pause')).status, 400);
    assert.equal((await act('tt1000001', 'explode')).status, 404);
  });
};
