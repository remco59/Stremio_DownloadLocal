// Web player helpers that need no ffmpeg: which subtitle files belong to a video, conversions, codec strings.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADDON_TOKEN = process.env.ADDON_TOKEN || 'test-token-0123456789';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'subs-test-'));
const subs = require('../subtitles');
const { codecString, describe, streamArgs } = require('../player');

test('belongsTo: a movie folder', () => {
  const v = 'Movie.2019.1080p/Movie.2019.1080p.mkv';
  assert.ok(subs.belongsTo(v, 'Movie.2019.1080p/Movie.2019.1080p.en.srt'));
  assert.ok(subs.belongsTo(v, 'Movie.2019.1080p/English.srt'), 'the only video in its folder');
  assert.ok(subs.belongsTo(v, 'Movie.2019.1080p/Subs/2_English.srt'));
  assert.ok(subs.belongsTo(v, 'Movie.2019.1080p/subtitles/Dutch.ass'));
  assert.ok(!subs.belongsTo(v, 'Movie.2019.1080p/Movie.2019.1080p.nfo'));
  assert.ok(!subs.belongsTo(v, 'Movie.2019.1080p/Extras/English.srt'));
  assert.ok(!subs.belongsTo(v, 'Other/English.srt'));
  assert.ok(!subs.belongsTo(v, 'Movie.2019.1080p/English.srt', [v], { loose: false }), 'strict: only named after the video');
  assert.ok(subs.belongsTo('Movie.mkv', 'Movie.nl.srt', ['Movie.mkv'], { loose: false }));
});

test('belongsTo: a season pack tells episodes apart', () => {
  const eps = [1, 2, 3].map((e) => `Show.S01/Show.S01E0${e}.mkv`);
  const [e1, e2] = eps;
  assert.ok(subs.belongsTo(e1, 'Show.S01/Show.S01E01.srt', eps));
  assert.ok(!subs.belongsTo(e1, 'Show.S01/Show.S01E02.srt', eps));
  assert.ok(subs.belongsTo(e2, 'Show.S01/Subs/Show.S01E02/3_English.srt', eps));
  assert.ok(!subs.belongsTo(e1, 'Show.S01/Subs/Show.S01E02/3_English.srt', eps));
  assert.ok(subs.belongsTo(e1, 'Show.S01/Subs/s01e01.English.srt', eps), 'same episode code');
  assert.ok(!subs.belongsTo(e1, 'Show.S01/Subs/s01e02.English.srt', eps));
  assert.ok(!subs.belongsTo(e1, 'Show.S01/English.srt', eps), 'could be any episode');
});

test('sidecarIndexes picks the subtitle files of one video in a torrent', () => {
  const files = [
    { name: 'Show.S01\\Show.S01E01.mkv' },
    { name: 'Show.S01/Show.S01E02.mkv' },
    { name: 'Show.S01/Subs/Show.S01E01/2_English.srt' },
    { name: 'Show.S01/Subs/Show.S01E02/2_English.srt' },
    { name: 'Show.S01/Show.S01E02.nl.srt' },
    { name: 'Show.S01/readme.txt' },
  ];
  assert.deepEqual(subs.sidecarIndexes(files, 0), [2]);
  assert.deepEqual(subs.sidecarIndexes(files, 1), [3, 4]);
});

test('language codes and names', () => {
  assert.equal(subs.normLang('eng'), 'en');
  assert.equal(subs.normLang('dut'), 'nl');
  assert.equal(subs.normLang('NLD'), 'nl');
  assert.equal(subs.normLang('Nederlands'), 'nl');
  assert.equal(subs.normLang('pob'), 'pt-BR');
  assert.equal(subs.normLang('und'), '');
  assert.equal(subs.normLang('xyz'), '');
  assert.deepEqual(subs.describeFile('Subs/3_English.srt', 'Movie.mkv'), { lang: 'en', label: '3_English', forced: false, sdh: false });
  assert.deepEqual(subs.describeFile('Movie.nl.forced.srt', 'Movie.mkv'), { lang: 'nl', label: 'nl.forced', forced: true, sdh: false });
});

test('srtToVtt and decodeText', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n{\\an8}Hello <i>there</i>\r\n\r\n2\r\n1:02:03,5 --> 1:02:04,25\r\nLine\r\n';
  assert.equal(subs.srtToVtt(srt), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <i>there</i>\n\n01:02:03.500 --> 01:02:04.250\nLine\n');
  assert.equal(subs.srtToVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nx\n'), 'WEBVTT\n\n00:01.000 --> 00:02.000\nx\n');
  assert.equal(subs.decodeText(Buffer.from('caf\xe9', 'latin1')), 'café', 'Windows-1252 fallback');
  assert.equal(subs.decodeText(Buffer.from('﻿café', 'utf8')), 'café');
  assert.equal(subs.decodeText(Buffer.from([0xff, 0xfe, 0x68, 0, 0x69, 0])), 'hi');
  assert.equal(subs.decodeText(Buffer.from('a\0\0b')), 'ab');
});

test('codecString: what the browser is asked about', () => {
  assert.equal(codecString({ codec_name: 'h264', profile: 'High', level: 41 }), 'avc1.640029');
  assert.equal(codecString({ codec_name: 'h264', profile: 'Main', level: 31 }), 'avc1.4d001f');
  assert.equal(codecString({ codec_name: 'h264', profile: 'High 10', level: 51, pix_fmt: 'yuv420p10le' }), 'avc1.6e0033');
  assert.equal(codecString({ codec_name: 'hevc', profile: 'Main 10', level: 153 }), 'hvc1.2.4.L153.B0');
  assert.equal(codecString({ codec_name: 'hevc', profile: 'Main', level: 120 }), 'hvc1.1.6.L120.B0');
  assert.equal(codecString({ codec_name: 'aac', profile: 'LC' }), 'mp4a.40.2');
  assert.equal(codecString({ codec_name: 'eac3' }), 'ec-3');
  assert.equal(codecString({ codec_name: 'dts' }), null);
  assert.equal(codecString({ codec_name: 'mpeg4' }), null);
});

const probe = (formatName, streams) => ({ format: { format_name: formatName, duration: '5400.5', start_time: '0.000000' }, streams });
const H264 = { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, width: 1920, height: 1080 };

test('describe: tracks, and when the browser can play the file as it is', () => {
  const m = describe(probe('matroska,webm', [
    H264,
    { index: 1, codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng', title: 'Surround' }, disposition: { default: 1 } },
    { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { LANGUAGE: 'dut' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'dut' }, disposition: { forced: 1 } },
    { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' }, disposition: { hearing_impaired: 1 } },
    { index: 5, codec_type: 'subtitle', codec_name: 'eia_608' },
    { index: 6, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
  ]), 'Movie.mkv');
  assert.equal(m.duration, 5400.5);
  assert.equal(m.video.index, 0);
  assert.equal(m.direct, null, 'mkv: never as it is');
  assert.deepEqual(m.audio.map((a) => [a.index, a.lang, a.title, a.channels, a.default]), [[1, 'en', 'Surround', 6, true], [2, 'nl', '', 2, false]]);
  assert.deepEqual(m.subtitles.map((s) => [s.key, s.kind, s.lang, s.forced, s.sdh]), [['e3', 'text', 'nl', true, false], ['e4', 'image', 'en', false, true]]);

  const mp4 = describe(probe('mov,mp4,m4a,3gp,3g2,mj2', [H264, { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 }]), 'Movie.mp4');
  assert.deepEqual(mp4.direct, { mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"', audio: 1 });
  const dts = describe(probe('mov,mp4,m4a,3gp,3g2,mj2', [H264, { index: 1, codec_type: 'audio', codec_name: 'dts', channels: 6 }]), 'Movie.mp4');
  assert.equal(dts.direct, null, 'an audio codec no browser plays');
});

test('streamArgs: copy, re-encode, burn-in, other audio track', () => {
  const meta = describe(probe('matroska,webm', [
    H264,
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6 },
    { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
  ]), 'Movie.mkv');
  const str = (o) => streamArgs({ input: '/d/Movie.mkv', local: true, meta, maxHeight: 720, ...o }).join(' ');

  const copy = str({ audio: 1, t: 10, copyVideo: true });
  assert.match(copy, /-ss 10\.200 -i \/d\/Movie\.mkv -map 0:0 -c:v copy -map 0:1 -c:a aac -b:a 192k -ac 2 /, 'just past the keyframe');
  assert.match(copy, /-f mp4 -movflags frag_keyframe\+empty_moov\+default_base_moof .*pipe:1$/);
  assert.doesNotMatch(copy, /-reconnect/);

  const enc = str({ audio: 2, t: 10 });
  assert.match(enc, /-ss 10\.000 -i /);
  assert.match(enc, /-vf scale=-2:'min\(720,ih\)'/);
  assert.match(enc, /-c:v libx264 /);
  assert.match(enc, /-map 0:2 -c:a aac -b:a 192k -ac 2 /, '5.1 AC-3 becomes stereo AAC');

  const webm = str({ audio: 2, format: 'webm', copyVideo: true });
  assert.match(webm, /-c:v libvpx-vp9 .*-c:a libopus .*-f webm /, 'H.264 does not go into WebM: converted');
  assert.doesNotMatch(webm, /-c:v copy/);

  const burn = str({ audio: 1, copyVideo: true, burn: 3 });
  assert.match(burn, /-filter_complex \[0:0\]\[0:3\]overlay=eof_action=pass,scale=-2:'min\(720,ih\)'[^ ]*\[v\] -map \[v\] -c:v libx264/);
  assert.doesNotMatch(burn, /-ss/);

  assert.match(streamArgs({ input: 'http://127.0.0.1:1/x', local: false, meta, audio: 1 }).join(' '), /^-hide_banner .*-reconnect 1 /, 'a download in progress');
});
