// Web player end to end with real ffmpeg on a generated MKV (two audio tracks, two subtitle tracks, a Subs/ folder).
// Skipped when ffmpeg is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { boot, waitFor } = require('./helpers/boot');

let ffmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
}
const opts = { skip: !ffmpeg && 'ffmpeg is not installed' };

const HASH = 'e'.repeat(40);
const ID = 'tt0110912';
const PIECE = 65536;
const DIR = 'Pulp.Fiction.1994';
const MOVIE = `${DIR}/Pulp.Fiction.1994.mkv`;
const SUB = `${DIR}/Subs/2_Dutch.srt`;

/** 30 s test picture, keyframes every 5 s; audio: English AAC, Dutch AC-3 "Commentary"; English and forced Dutch subtitles. */
function makeMovie(file) {
  const tmp = path.dirname(file);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'en.srt'), '1\n00:00:01,000 --> 00:00:03,000\nHello <i>world</i>\n\n2\n00:00:12,500 --> 00:00:14,000\nSecond line\n');
  fs.writeFileSync(path.join(tmp, 'nl.srt'), '1\n00:00:02,000 --> 00:00:04,000\nHallo wereld\n');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=30', '-f', 'lavfi', '-i', 'sine=f=440:d=30', '-f', 'lavfi', '-i', 'sine=f=880:d=30',
    '-i', path.join(tmp, 'en.srt'), '-i', path.join(tmp, 'nl.srt'),
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4',
    '-c:v', 'libx264', '-g', '125', '-keyint_min', '125', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=dut', '-metadata:s:a:1', 'title=Commentary',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=dut', '-disposition:s:1', 'forced', file]);
  fs.rmSync(path.join(tmp, 'en.srt'));
  fs.rmSync(path.join(tmp, 'nl.srt'));
}

let env;
let size;
test.before(async () => {
  env = await boot();
  if (!ffmpeg) return;
  makeMovie(path.join(env.downloads, MOVIE));
  fs.mkdirSync(path.join(env.downloads, DIR, 'Subs'), { recursive: true });
  fs.writeFileSync(path.join(env.downloads, SUB), Buffer.from('1\r\n00:00:05,000 --> 00:00:06,000\r\nZo\xeb\r\n', 'latin1'));
  size = fs.statSync(path.join(env.downloads, MOVIE)).size;
  env.mock.torrentio[ID] = { streams: [{ name: 'Torrentio\n1080p', title: 'Pulp.Fiction.1994\n👤 50', infoHash: HASH }] };
  env.mock.onAdd = (hash) => env.mock.addTorrent({
    hash, name: DIR, pieceSize: PIECE,
    files: [{ name: MOVIE, size }, { name: SUB, size: 40 }, { name: `${DIR}/readme.txt`, size: 10 }],
  });
  env.mock.subtitles[ID] = [{ id: 501, lang: 'ger', text: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nGr\xfc\xdfe\n', 'latin1') }];
});
test.after(() => env && env.close());

const get = (p) => fetch(env.base + p);
const json = async (p) => {
  const r = await get(p);
  return { status: r.status, body: await r.json() };
};
const probe = (buf) => {
  const f = path.join(env.downloads, 'probe.mp4');
  fs.writeFileSync(f, buf);
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]));
  fs.rmSync(f);
  return out;
};

test('online subtitles are listed and converted for anything, downloaded or not', async () => {
  const { status, body } = await json(`/api/subtitles/movie/${ID}`);
  assert.equal(status, 200);
  assert.deepEqual(body.subtitles, [{ key: 'o501', lang: 'de', label: '501.srt' }]);
  const r = await get(`/api/subtitles/movie/${ID}/o501.vtt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/vtt/);
  assert.equal(await r.text(), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nGrüße\n');
  assert.equal((await get(`/api/subtitles/movie/${ID}/o999.vtt`)).status, 404);
  assert.equal((await get(`/api/subtitles/movie/${ID}/..%2Fx.vtt`)).status, 400);
});

test('nothing to play before the download exists', opts, async () => {
  const { status, body } = await json(`/api/player/movie/${ID}`);
  assert.equal(status, 409);
  assert.match(body.error, /not on the server/);
  assert.equal((await get('/api/player/movie/evil')).status, 400);
});

test('the subtitle files that come with the video are downloaded too', opts, async () => {
  await fetch(env.base + '/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', id: ID }) });
  const rec = await waitFor(() => env.db.get(ID)?.selected && env.db.get(ID));
  assert.deepEqual(rec.subFiles, [{ index: 1, name: SUB }]);
  assert.deepEqual(env.mock.torrents.get(HASH).files.map((f) => f.priority), [1, 1, 0]);
  // Nothing downloaded yet: /play would answer with a status clip, so the player does not even try.
  const { status, body } = await json(`/api/player/movie/${ID}`);
  assert.equal(status, 409);
  assert.match(body.error, /nothing of it is downloaded yet/);
});

test('a download in progress is read through /play: tracks are there once its start is', opts, async () => {
  env.mock.havePieces(HASH, 0, Math.ceil(size / PIECE) - 1); // all but the last piece
  await waitFor(() => env.db.get(ID).playable > 0.5);
  assert.equal(env.db.get(ID).status, 'downloading');
  const { status, body } = await json(`/api/player/movie/${ID}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(Math.abs(body.duration - 30) < 0.5, String(body.duration));
  assert.equal(body.video.codec, 'h264');
  assert.equal(body.direct, null);
});

test('when complete: tracks, audio languages, embedded, sidecar and online subtitles', opts, async () => {
  env.mock.completeAll(HASH);
  await waitFor(() => env.db.get(ID).status === 'complete');
  const { status, body } = await json(`/api/player/movie/${ID}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.container, 'matroska');
  assert.match(body.video.codecString, /^avc1\.64/);
  assert.deepEqual(body.audio.map((a) => [a.index, a.codec, a.lang, a.title]), [[1, 'aac', 'en', ''], [2, 'ac3', 'nl', 'Commentary']]);
  assert.deepEqual(body.subtitles.map((s) => [s.key, s.source, s.lang, s.forced]), [['e3', 'embedded', 'en', false], ['e4', 'embedded', 'nl', true], ['x0', 'file', 'nl', false]]);
  assert.equal(body.subtitles[2].path, undefined, 'no server paths');
  assert.equal(body.online, true);
});

test('embedded subtitles as WebVTT, cached after the first time', opts, async () => {
  const first = await get(`/api/player/movie/${ID}/subtitles/e3.vtt`);
  assert.equal(first.status, 200);
  const text = await first.text();
  assert.match(text, /^WEBVTT/);
  // Times count from the start of ffmpeg's output, like the player's streams (here the AAC priming shifts both).
  assert.match(text, /\n00:01\.0\d\d --> 00:03\.0\d\d\nHello <i>world<\/i>/);
  assert.match(text, /\n00:12\.5\d\d --> 00:14\.0\d\d\nSecond line/);
  await waitFor(() => fs.existsSync(path.join(process.env.DATA_DIR, 'subtitles')) && fs.readdirSync(path.join(process.env.DATA_DIR, 'subtitles')).some((f) => f.endsWith('.vtt')));
  assert.equal(await (await get(`/api/player/movie/${ID}/subtitles/e3.vtt`)).text(), text);
  assert.match(await (await get(`/api/player/movie/${ID}/subtitles/x0.vtt`)).text(), /00:00:05\.000 --> 00:00:06\.000\nZoë/);
  assert.equal((await get(`/api/player/movie/${ID}/subtitles/e1.vtt`)).status, 404, 'an audio stream');
  assert.equal((await get(`/api/player/movie/${ID}/subtitles/x7.vtt`)).status, 404);
  assert.equal((await get(`/api/player/movie/${ID}/subtitles/zz.vtt`)).status, 400);
});

test('keyframe: where a copied stream starting near t really starts', opts, async () => {
  const near = (a, b) => Math.abs(a - b) < 0.05;
  assert.ok(near((await json(`/api/player/movie/${ID}/keyframe?t=12`)).body.t, 10));
  assert.ok(near((await json(`/api/player/movie/${ID}/keyframe?t=4.9`)).body.t, 0));
  assert.equal((await get(`/api/player/movie/${ID}/keyframe?t=-1`)).status, 400);
});

test('stream: copied video with the other audio track, from a keyframe', opts, async () => {
  const r = await get(`/api/player/movie/${ID}/stream.mp4?audio=2&t=10&copy=1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const out = probe(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(out.streams.map((s) => [s.codec_type, s.codec_name]), [['video', 'h264'], ['audio', 'aac']]);
  assert.equal(out.streams[1].channels, 2);
  assert.ok(Math.abs(Number(out.format.duration) - 20) < 0.5, out.format.duration);
});

test('stream: re-encoded video starts exactly where asked', opts, async () => {
  const r = await get(`/api/player/movie/${ID}/stream.mp4?audio=1&t=12`);
  assert.equal(r.status, 200);
  const out = probe(Buffer.from(await r.arrayBuffer()));
  assert.ok(Math.abs(Number(out.format.duration) - 18) < 0.5, out.format.duration);
  assert.equal(out.streams[0].height, 90);
});

test('stream: WebM (VP9/Opus) for browsers without H.264', opts, async () => {
  const r = await get(`/api/player/movie/${ID}/stream.webm?audio=1&t=25&copy=1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/webm');
  const out = probe(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(out.streams.map((s) => s.codec_name), ['vp9', 'opus']);
  assert.equal((await get(`/api/player/movie/${ID}/stream.avi`)).status, 404);
});

test('stream: bad parameters are refused before ffmpeg starts', opts, async () => {
  assert.equal((await get(`/api/player/movie/${ID}/stream.mp4?audio=3`)).status, 400, 'a subtitle stream');
  assert.equal((await get(`/api/player/movie/${ID}/stream.mp4?burn=3`)).status, 400, 'a text subtitle cannot be burned in');
  assert.equal((await get(`/api/player/movie/${ID}/stream.mp4?t=abc`)).status, 400);
});

test('deleting the files also deletes the subtitle files that came with it', opts, async () => {
  // Torrent gone from the client: the add-on deletes the files itself.
  env.mock.torrents.delete(HASH);
  const r = await fetch(`${env.base}/api/downloads/${ID}/delete-files`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(env.downloads, MOVIE)));
  assert.ok(!fs.existsSync(path.join(env.downloads, SUB)));
});
