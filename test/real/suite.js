// End to end against a REAL torrent client in Docker: the client under test downloads a generated video from
// a second container (the other client) that seeds it through a tiny local tracker, rate limited so the
// partial-download states can be observed. Run with `npm run test:real` (needs Docker; pulls the images).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('./docker');
const { makeTorrent, startTracker } = require('./torrent');
const { boot } = require('../helpers/boot');

const ID = 'tt0000001';
const NAME = 'Real.Movie.2020';
const MOVIE = `${NAME}.1080p.mkv`;
const TRACKER_PORT = 16969;
const UP_KBS = 1024; // seeder upload cap: ~12 s for the ~12 MB movie

/** @param {{client: 'qbittorrent'|'transmission', image?: string}} opts image: the downloader's image */
module.exports = function realSuite({ client, image }) {
  const seederKind = client === 'qbittorrent' ? 'transmission' : 'qbittorrent';
  let root, downloads, seedDir, tracker, dl, seeder, env, t, movie;
  const timeout = { timeout: 180000 };

  test.before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), `stremio-real-${client}-`));
    downloads = path.join(root, 'downloads');
    seedDir = path.join(root, 'seed');
    for (const p of [downloads, path.join(seedDir, NAME), path.join(root, 'cfg-dl'), path.join(root, 'cfg-seed')]) fs.mkdirSync(p, { recursive: true });

    // Content: a real video plus an extra file the add-on must not download.
    await d.sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=25:d=40',
      '-f', 'lavfi', '-i', 'sine=d=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2300k', '-c:a', 'aac',
      path.join(seedDir, NAME, MOVIE)]);
    fs.writeFileSync(path.join(seedDir, NAME, 'sample.txt'), crypto.randomBytes(300 * 1024));
    movie = fs.readFileSync(path.join(seedDir, NAME, MOVIE));

    const net = await d.network();
    tracker = await startTracker(TRACKER_PORT);
    const announce = `http://${net.gateway}:${TRACKER_PORT}/announce`;
    t = makeTorrent(path.join(seedDir, NAME), ['sample.txt', MOVIE], { name: NAME, announce });

    const dlMounts = [`${downloads}:/downloads`, `${path.join(root, 'cfg-dl')}:/config`];
    const seedMounts = [`${seedDir}:/seed`, `${path.join(root, 'cfg-seed')}:/config`];
    [dl, seeder] = await Promise.all([
      client === 'qbittorrent'
        ? d.startQb({ name: 'real-dl-qb', port: 18080, mounts: dlMounts, image })
        : d.startTr({ name: 'real-dl-tr', port: 19091, mounts: dlMounts, image }),
      seederKind === 'qbittorrent'
        ? d.startQb({ name: 'real-seed-qb', port: 18081, mounts: seedMounts })
        : d.startTr({ name: 'real-seed-tr', port: 19092, mounts: seedMounts }),
    ]);
    if (client === 'qbittorrent') {
      // Exercise the incomplete-files folder and the .!qB suffix.
      await d.qbPrefs(dl, { temp_path_enabled: true, temp_path: '/downloads/incomplete', incomplete_files_ext: true });
    }
    if (seederKind === 'qbittorrent') await d.qbSeed(seeder, { torrent: t.torrent, savePath: '/seed', upKBs: UP_KBS });
    else await d.trSeed(seeder, { torrent: t.torrent, savePath: '/seed', upKBs: UP_KBS });

    const conn =
      client === 'qbittorrent'
        ? { QB_URL: dl.url, QB_USER: dl.user, QB_PASS: dl.pass }
        : { TR_URL: dl.url, TR_USER: dl.user, TR_PASS: dl.pass };
    env = await boot(
      { ...conn, LOCAL_PATH_PREFIX: downloads, CLIENT_PATH_PREFIX: '/downloads', SYNC_INTERVAL_MS: '500', WAIT_FOR_START_MS: '20000', STALL_MS: '5000', SEEK_WAIT_MS: '1500' },
      { client }
    );
    env.mock.torrentio[ID] = {
      streams: [{ name: 'Real\n1080p', title: `${NAME}.1080p\n👤 1`, infoHash: t.infoHash, fileIdx: 1, sources: [`tracker:${announce}`] }],
    };
  }, { timeout: 600000 });

  test.after(async () => {
    if (env) await env.close();
    if (process.env.REAL_KEEP) return console.log(`REAL_KEEP: containers and ${root} left in place`);
    if (tracker) await tracker.close();
    await Promise.all(['real-dl-qb', 'real-dl-tr', 'real-seed-qb', 'real-seed-tr'].map(d.rm));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const api = (p, method = 'GET', body) =>
    env.api(p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const item = async () => (await (await api('/api/downloads')).json()).items.find((x) => x.id === ID);
  const range = async (a, b) => {
    const res = await fetch(`${env.base}/play/movie/${ID}`, { headers: { Range: `bytes=${a}-${b}` } });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };
  const rawClient = () => require('../../clients').active();
  // Where the add-on thinks the finished file is (client save path mapped into this machine).
  const finalPath = () => env.dl.localPath(env.db.get(ID));

  test(`${client}: connection test reports the real version`, async () => {
    const r = await (await api('/api/settings/test-client', 'POST', { client })).json();
    assert.equal(r.ok, true, r.error);
    assert.match(r.version, client === 'qbittorrent' ? /^qBittorrent v\d/ : /^Transmission \d/);
    if (client === 'transmission') assert.equal(r.warning, undefined, 'this image has sequential download');
  });

  test(`${client}: queueing adds the torrent with category/label and sequential download`, timeout, async () => {
    assert.equal((await api('/api/download', 'POST', { type: 'movie', id: ID })).status, 200);
    await d.waitFor(() => env.db.get(ID)?.selected, 60000, 'file selection');
    const rec = env.db.get(ID);
    assert.equal(rec.fileName, `${NAME}/${MOVIE}`);
    if (client === 'qbittorrent') {
      const qb = await d.qbSession(dl);
      const [info] = await qb(`/torrents/info?hashes=${t.infoHash}`);
      assert.equal(info.category, 'stremio');
      assert.equal(info.seq_dl, true);
      assert.equal(info.f_l_piece_prio, true);
      const files = await qb(`/torrents/files?hash=${t.infoHash}`);
      assert.deepEqual(files.map((f) => f.priority), [0, 1], 'sample.txt is not downloaded');
    } else {
      const { torrents: [info] } = await d.trRpc(dl, 'torrent-get', { ids: [t.infoHash], fields: ['labels', 'sequential_download', 'fileStats'] });
      assert.deepEqual(info.labels, ['stremio']);
      assert.equal(info.sequential_download, true);
      assert.deepEqual(info.fileStats.map((f) => f.wanted), [false, true], 'sample.txt is not downloaded');
    }
  });

  test(`${client}: plays the downloaded part while downloading (incomplete dir + partial suffix)`, timeout, async () => {
    const rec = await d.waitFor(() => {
      const r = env.db.get(ID);
      return r.playable > 0.1 && r.progress < 0.8 && r;
    }, 120000, 'partial download');
    const partial = path.join(downloads, 'incomplete', NAME, MOVIE + (client === 'qbittorrent' ? '.!qB' : '.part'));
    assert.ok(fs.existsSync(partial), `partial file at ${partial}`);
    const n = Math.floor(rec.playable * rec.fileSize) - 1;
    const r = await range(0, n - 1);
    assert.equal(r.status, 206);
    assert.equal(r.body.length, n);
    assert.ok(r.body.equals(movie.subarray(0, n)), 'bytes match the source');
    // Far past the downloaded part (if the download has not got there yet): a clean 503.
    const now = env.db.get(ID);
    if (now.status !== 'complete' && now.playable < 0.75) {
      const far = await fetch(`${env.base}/play/movie/${ID}`, { headers: { Range: `bytes=${Math.floor(movie.length * 0.92)}-` } });
      assert.equal(far.status, 503);
    }
    const [s] = (await (await api(`/stream/movie/${ID}.json`)).json()).streams;
    assert.match(s.name, /^⏳ Your server \d+%$/);
    assert.match(s.description, /^Playable up to \d+%/);
  });

  test(`${client}: pause and resume`, timeout, async () => {
    if ((await item()).status === 'complete') return; // too fast to pause; covered by the mock tests
    assert.equal((await api(`/api/downloads/${ID}/pause`, 'POST')).status, 200);
    await d.waitFor(async () => (await item()).paused, 20000, 'paused');
    assert.equal((await api(`/api/downloads/${ID}/resume`, 'POST')).status, 200);
    await d.waitFor(async () => !(await item()).paused, 20000, 'resumed');
  });

  test(`${client}: completes; the whole file plays from its final place`, timeout, async () => {
    await d.waitFor(() => env.db.get(ID).status === 'complete', 150000, 'complete');
    // The client moves the file out of its incomplete dir into its download dir (e.g. /downloads/complete).
    await d.waitFor(() => fs.existsSync(finalPath()), 30000, 'file in its final place');
    const [s] = (await (await api(`/stream/movie/${ID}.json`)).json()).streams;
    assert.equal(s.name, '🏠 Your server');
    const r = await fetch(`${env.base}/play/movie/${ID}`);
    assert.equal(r.status, 200);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(movie));
  });

  test(`${client}: remove keeps the file playable; delete files removes it from disk`, timeout, async () => {
    assert.equal((await api(`/api/downloads/${ID}/remove`, 'POST')).status, 200);
    await d.waitFor(async () => !(await rawClient().info([t.infoHash])).length, 20000, 'torrent removed');
    const file = finalPath();
    assert.ok(fs.existsSync(file));
    assert.equal((await range(0, 99)).body.length, 100);

    assert.equal((await api(`/api/downloads/${ID}/delete-files`, 'POST')).status, 200);
    assert.equal(fs.existsSync(file), false);
    assert.equal(env.db.get(ID), null);
  });

  test(`${client}: delete files through the client while it still has the torrent`, timeout, async () => {
    assert.equal((await api('/api/download', 'POST', { type: 'movie', id: ID })).status, 200);
    await d.waitFor(() => env.db.get(ID)?.status === 'complete', 150000, 'complete again');
    await d.waitFor(() => fs.existsSync(finalPath()), 30000, 'file in its final place');
    const file = finalPath();
    assert.equal((await api(`/api/downloads/${ID}/delete-files`, 'POST')).status, 200);
    await d.waitFor(() => !fs.existsSync(file), 20000, 'client deleted the file');
    assert.deepEqual(await rawClient().info([t.infoHash]), []);
  });
};
