// The status screen: what it says for each download state, the progress bar image, and the live stream end to end
// (real ffmpeg: the picture follows the download record while it plays).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { boot, waitFor } = require('./helpers/boot');
const ss = require('../statusscreen');
const { MIN_START_BYTES } = require('../play');

const MB = 2 ** 20;
const dl = (o) => ({ status: 'downloading', selected: true, progress: 0.4, playable: 0, fileSize: 4000 * MB, fileName: 'Show/Show.S01E02.1080p.mkv', title: 'Show.S01E02.1080p', ...o });

test('describe: no record yet, or a torrent still being added', () => {
  const none = ss.describe(null, null, 83000);
  assert.deepEqual([none.scene, none.head, none.right, none.bar], ['search', 'Looking for a torrent', '1:23', { fraction: null }]);
  const queued = ss.describe(dl({ status: 'queued', selected: false }), null, 5000);
  assert.deepEqual([queued.scene, queued.head, queued.sub, queued.bar], ['search', 'Starting the download', 'Show.S01E02.1080p', { fraction: null }]);
});

test('describe: errors show the reason; a retry in progress does not show the old error', () => {
  const err = ss.describe({ status: 'error', error: 'No usable torrent for tt1' }, null);
  assert.deepEqual([err.scene, err.head, err.sub, err.bar], ['error', 'Could not start the download', 'No usable torrent for tt1', null]);
  assert.equal(ss.describe({ status: 'error' }, null).sub, 'No usable torrent was found.');
  assert.equal(ss.describe({ status: 'missing' }, null).head, 'The download was removed');
  assert.equal(ss.describe({ status: 'error', error: 'old' }, null, 0, true).head, 'Looking for a torrent');
  assert.equal(ss.describe({ status: 'error', error: 'x'.repeat(500) }, null).sub.length, 90);
});

test('describe: downloading shows percentage, speed, time left and seeds', () => {
  const d = ss.describe(dl({ progress: 0.427 }), { label: 'Show.S01E02.1080p.mkv', dlSpeed: 12.4 * MB, eta: 520, seeds: 24 });
  assert.deepEqual([d.scene, d.head, d.sub, d.left, d.bar], ['download', 'Downloading', 'Show.S01E02.1080p.mkv', '42%', { fraction: 0.427 }]);
  assert.equal(d.right, '12.4 MB/s  ·  9 min left  ·  24 seeds');
  // Nothing has arrived yet: say so instead of an empty bar.
  const start = ss.describe(dl({ progress: 0 }), { dlSpeed: 0 });
  assert.deepEqual([start.left, start.right, start.bar], ['', 'Connecting to peers', { fraction: null }]);
  assert.equal(ss.describe(dl({ progress: 0.2 }), { paused: true }).right, 'Paused in your torrent client');
  assert.equal(ss.describe(dl({ progress: 0.2 }), { clientState: 'queued' }).right, 'Queued in your torrent client');
});

test('describe: ready once the start can play, like /play decides', () => {
  const justShort = dl({ progress: 0.01, fileSize: 1000 * MB, playable: (MIN_START_BYTES - 1) / (1000 * MB) });
  assert.equal(ss.describe(justShort, null).scene, 'download');
  const enough = dl({ progress: 0.01, fileSize: 1000 * MB, playable: MIN_START_BYTES / (1000 * MB) });
  const r = ss.describe(enough, { dlSpeed: 2 * MB, eta: 3600 });
  assert.deepEqual([r.scene, r.head, r.sub, r.left, r.bar], ['ready', 'Ready to watch', 'Press Back, then play “Your server”', '1%', { fraction: 0.01 }]);
  const done = ss.describe(dl({ status: 'complete', progress: 1, playable: 1 }), null);
  assert.deepEqual([done.scene, done.left, done.right, done.bar], ['ready', '100%', 'Download complete', { fraction: 1 }]);
  // A small file is playable as a whole.
  assert.equal(ss.describe(dl({ fileSize: MB, playable: 1, progress: 1 }), null).scene, 'ready');
});

test('describe: long and odd names are cleaned and cut', () => {
  const d = ss.describe(dl(), { label: `Line\nbreak\t${'x'.repeat(200)}` });
  assert.ok(d.sub.length <= 72 && d.sub.endsWith('…') && !/[\n\t]/.test(d.sub));
  assert.equal(ss.clean(null, 10), '');
  // Letters the bundled font has (Latin, Greek, Cyrillic) stay; the rest would draw as boxes.
  assert.equal(ss.clean('Amélie – Сезон 4 – Αθήνα', 99), 'Amélie – Сезон 4 – Αθήνα');
  assert.equal(ss.clean('千と千尋の神隠し 2001 🎬', 99), '? 2001 ?');
});

test('formatting', () => {
  assert.equal(ss.fmtSpeed(0), '');
  assert.equal(ss.fmtSpeed(300), '1 KB/s');
  assert.equal(ss.fmtSpeed(512 * 1024), '512 KB/s');
  assert.equal(ss.fmtSpeed(1.5 * MB), '1.5 MB/s');
  assert.equal(ss.fmtEta(0), '');
  assert.equal(ss.fmtEta(30), 'under a minute left');
  assert.equal(ss.fmtEta(90), '2 min left');
  assert.equal(ss.fmtEta(3600 + 300), '1 h 05 min left');
  assert.equal(ss.fmtElapsed(9000), '0:09');
});

test('bar image: PAM header, fill, track and rounded ends', () => {
  const { w, h } = ss.LAYOUT.bar;
  const header = `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
  const pixel = (img, x, y) => [...img.subarray(header.length + (y * w + x) * 4, header.length + (y * w + x) * 4 + 4)];

  const half = ss.barImage('download', 0.5);
  assert.equal(half.subarray(0, header.length).toString(), header);
  assert.equal(half.length, header.length + w * h * 4);
  assert.ok(pixel(half, 200, 6)[2] > 200 && pixel(half, 200, 6)[3] === 255, 'fill is the accent colour');
  assert.deepEqual(pixel(half, 900, 6), [42, 47, 58, 255], 'the rest is the track');
  assert.ok(pixel(half, 0, 0)[3] < 128, 'rounded end');

  assert.deepEqual(pixel(ss.barImage('download', 0), 100, 6), [42, 47, 58, 255], 'nothing downloaded: only the track');
  assert.ok(pixel(ss.barImage('ready', 1), w - 20, 6)[1] > 150, 'complete: filled to the end, green for ready');

  // Indeterminate: a pill that moves with the frame count, from the left end to the right end and back.
  const pillStart = (tick) => {
    const b = ss.barImage('search', null, tick);
    for (let x = 0; x < w; x++) if (pixel(b, x, 6)[2] > 200) return x;
    return -1;
  };
  assert.ok(pillStart(0) <= 2, 'starts at the left');
  assert.ok(pillStart(Math.round(ss.FPS * 1.7)) > 700, 'ends at the right');
  assert.notEqual(pillStart(3), pillStart(6));
});

// ---- the live stream: needs an ffmpeg that can draw text ----
let skip = false;
try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  if (!/drawtext/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString())) skip = 'ffmpeg has no drawtext filter';
} catch {
  skip = 'ffmpeg/ffprobe not installed';
}

let env;
let cfg;
let statusclip;
test.before(async () => {
  env = await boot({ LIVE_STATUS: '1' });
  cfg = require('../config');
  statusclip = require('../statusclip');
});
test.after(() => env.close());

const record = (id, o = {}) => env.db.set(id, { id, type: 'movie', ...dl(), ...o });
const get = (p, headers = {}) => fetch(`${env.base}${p}`, { headers, redirect: 'manual' });

/** Opens the live screen and collects its bytes until `until(bytes, elapsedMs)` says to leave. */
function watch(id, until) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const chunks = [];
    const req = http.get(`${env.base}/clip/live/movie/${id}.mp4`, (res) => {
      res.on('data', (c) => chunks.push(c));
      const poll = setInterval(() => {
        const body = Buffer.concat(chunks);
        if (!until(body, Date.now() - t0)) return;
        clearInterval(poll);
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body });
      }, 100);
    });
    req.on('error', (e) => e.code === 'ECONNRESET' || reject(e));
  });
}

/** Opens the live screen and keeps it open; destroy the returned request to leave. */
function hold(id) {
  const req = http.get(`${env.base}/clip/live/movie/${id}.mp4`, (res) => res.resume());
  req.on('error', () => {});
  return req;
}

/** Mean volume (dB) of the audio in a (cut off) live stream. */
function meanVolume(body) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', 'pipe:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { input: body, encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  assert.ok(m, 'measured the audio');
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

/** Width of the bar's fill in the last picture of a (cut off) live stream. */
function fillWidth(body) {
  const { bar } = ss.LAYOUT;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `crop=${bar.w}:2:${bar.x}:${bar.y + 4},format=rgb24`, '-f', 'rawvideo', 'pipe:1'],
    { input: body, maxBuffer: 1 << 28 });
  const rows = r.stdout.length / (bar.w * 3 * 2);
  assert.ok(rows >= 1, 'decoded at least one picture');
  const last = r.stdout.subarray((rows - 1) * bar.w * 6);
  let w = 0;
  while (w < bar.w && last[w * 3 + 2] > 150 && last[w * 3] > 80) w++; // accent fill: bright blue, not the dark track
  return w;
}

test('/play points Stremio at the live screen when it can be drawn, else at a fixed clip', { skip }, async () => {
  const r = await get('/play/movie/tt7770001');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${env.base}/clip/live/movie/tt7770001.mp4`);
  cfg.liveStatus = 0;
  try {
    assert.equal((await get('/play/movie/tt7770002')).headers.get('location'), `${env.base}/clip/started.mp4`);
  } finally {
    cfg.liveStatus = 1;
  }
});

test('the live screen is a video stream that follows the download', { skip, timeout: 60000 }, async () => {
  const id = 'tt7770010';
  record(id, { progress: 0.25 });
  setTimeout(() => record(id, { progress: 0.75 }), 1500);
  const got = await watch(id, (body, ms) => ms > 6000);

  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'video/mp4');
  assert.equal(got.headers['content-length'], undefined, 'no length: it is drawn as it plays');
  assert.equal(got.body.subarray(4, 8).toString(), 'ftyp');
  assert.ok(got.body.includes('moof'), 'fragments follow the header');

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-'], { input: got.body }));
  const [video, audio] = ['video', 'audio'].map((t) => probe.streams.find((s) => s.codec_type === t));
  assert.deepEqual([video.codec_name, video.width, video.height], ['h264', 1920, 1080]);
  assert.equal(audio.codec_name, 'aac');
  assert.ok(meanVolume(got.body) > -60, 'the ambient sound is there');

  // 75% of the 1100 px bar; the picture lags the record by a second or two, so the 25% it started at is long gone.
  const w = fillWidth(got.body);
  assert.ok(Math.abs(w - 0.75 * ss.LAYOUT.bar.w) < 60, `bar fill ${w}px`);

  await waitFor(() => statusclip.activeCount() === 0, { timeout: 5000 });
});

test('STATUS_SOUND=0 makes the live screen silent', { skip, timeout: 30000 }, async () => {
  record('tt7770013');
  cfg.statusSound = 0;
  try {
    const got = await watch('tt7770013', (body, ms) => ms > 3500);
    assert.ok(meanVolume(got.body) < -80, 'silence');
  } finally {
    cfg.statusSound = 1;
  }
  await waitFor(() => statusclip.activeCount() === 0, { timeout: 5000 });
});

test('leaving the screen stops its ffmpeg', { skip, timeout: 30000 }, async () => {
  record('tt7770011');
  await watch('tt7770011', (body) => body.length > 20000);
  await waitFor(() => statusclip.activeCount() === 0, { timeout: 5000 });
});

test('HEAD answers without starting ffmpeg; a seek past the start is refused', { skip }, async () => {
  record('tt7770012');
  const head = await fetch(`${env.base}/clip/live/movie/tt7770012.mp4`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(statusclip.activeCount(), 0);
  const seek = await get('/clip/live/movie/tt7770012.mp4', { Range: 'bytes=5000-' });
  assert.equal(seek.status, 416);
  assert.equal(statusclip.activeCount(), 0);
});

test('a screen that cannot start falls back to the fixed clip that fits the record', { skip }, async () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'no-ffmpeg-')), 'ffmpeg');
  fs.writeFileSync(bad, '#!/bin/sh\necho "broken ffmpeg" >&2\nexit 1\n', { mode: 0o755 });
  const real = cfg.ffmpegPath;
  cfg.ffmpegPath = bad;
  try {
    record('tt7770020', { status: 'error', error: 'x' });
    record('tt7770021', { selected: false, status: 'queued' });
    record('tt7770022');
    for (const [id, clip] of [['tt7770020', 'error'], ['tt7770021', 'metadata'], ['tt7770022', 'started'], ['tt7770023', 'started']]) {
      const r = await get(`/clip/live/movie/${id}.mp4`);
      assert.equal(r.status, 302, id);
      assert.equal(r.headers.get('location'), `${env.base}/clip/${clip}.mp4`, id);
    }
    assert.equal(statusclip.activeCount(), 0);
  } finally {
    cfg.ffmpegPath = real;
    fs.rmSync(path.dirname(bad), { recursive: true, force: true });
  }
});

test('bad ids are refused; too many open screens get a fixed clip', { skip, timeout: 30000 }, async () => {
  assert.equal((await get('/clip/live/movie/..%2Fx.mp4')).status, 404);
  assert.equal((await get('/clip/live/nope/tt1.mp4')).status, 404);

  record('tt7770030');
  const open = Array.from({ length: statusclip.MAX_STREAMS }, () => hold('tt7770030'));
  try {
    await waitFor(() => statusclip.activeCount() === statusclip.MAX_STREAMS, { timeout: 10000 });
    const over = await get('/clip/live/movie/tt7770030.mp4');
    assert.equal(over.status, 302);
    assert.equal(over.headers.get('location'), `${env.base}/clip/started.mp4`);
  } finally {
    open.forEach((r) => r.destroy());
    await waitFor(() => statusclip.activeCount() === 0, { timeout: 5000 });
  }
});
