// Web player backend: what is in a file (ffprobe), and ffmpeg conversions for what the browser cannot do itself:
// another audio track, video codecs or containers it cannot play (copied into fragmented MP4, or re-encoded),
// subtitles burned in, and subtitle tracks as WebVTT.
//
// Files that are still downloading are read through this server's own /play URL, so ffmpeg only ever gets
// bytes that are really there (and waits for the rest, like a player would).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { localCandidates } = require('./downloads');
const subs = require('./subtitles');

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const MAX_JOBS = 4; // ffmpeg conversions at once; a new one ends the oldest (usually a stream the player just left)

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---- running ffmpeg/ffprobe -----------------------------------------------------------------------------
/** Runs a tool to completion and returns stdout. Rejects on a non-zero exit or after `timeout` ms. */
function exec(bin, args, { timeout = 60000, maxBytes = 32 * 2 ** 20 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) child.kill('SIGKILL');
      else out.push(c);
    });
    child.stderr.on('data', (c) => (err = (err + c).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error((err.trim().split('\n').pop() || `${path.basename(bin)} ${signal ? 'was stopped' : `exited with ${code}`}`).slice(0, 300)));
    });
  });
}

let ffChecked = null; // { ok, at }
/** Whether ffmpeg and ffprobe can be run (checked once a minute at most while they are missing). */
async function available() {
  if (ffChecked && (ffChecked.ok || Date.now() - ffChecked.at < 60000)) return ffChecked.ok;
  let ok = true;
  try {
    await exec(cfg.ffprobePath, ['-version'], { timeout: 10000 });
    await exec(cfg.ffmpegPath, ['-version'], { timeout: 10000 });
  } catch {
    ok = false;
  }
  ffChecked = { ok, at: Date.now() };
  return ok;
}

const jobs = new Set();
/** Starts ffmpeg for a response; it is stopped when the response closes. Returns the child process. */
function job(args, res) {
  while (jobs.size >= MAX_JOBS) {
    const oldest = jobs.values().next().value;
    jobs.delete(oldest);
    oldest.kill('SIGKILL');
  }
  const child = spawn(cfg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  jobs.add(child);
  child.errText = '';
  child.stderr.on('data', (c) => (child.errText = (child.errText + c).slice(-2000)));
  const stop = () => {
    jobs.delete(child);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  res.on('close', stop);
  child.on('close', () => jobs.delete(child));
  child.on('error', () => jobs.delete(child));
  return child;
}

// ---- input ----------------------------------------------------------------------------------------------
/**
 * What ffmpeg reads: the file itself once it is complete, otherwise this server's /play URL (which only serves
 * downloaded bytes). `req` is the request being handled, for the port this server listens on.
 */
async function inputFor(rec, req) {
  if (!rec || !rec.selected || !rec.fileName || !(rec.status === 'complete' || rec.status === 'downloading' || rec.status === 'queued')) {
    throw httpError(409, 'not on the server (yet)');
  }
  if (rec.status === 'complete') {
    for (const p of await localCandidates(rec)) if (fs.existsSync(p)) return { input: p, local: true };
    throw httpError(404, 'the file is not on disk');
  }
  // Before its start is there, /play would answer with a status clip instead of the file.
  if (!(rec.playable > 0)) throw httpError(409, 'nothing of it is downloaded yet');
  return { input: `http://127.0.0.1:${req.socket.localPort}/${cfg.token}/play/${rec.type}/${encodeURIComponent(rec.id)}`, local: false };
}

// ---- probing --------------------------------------------------------------------------------------------
const probes = new Map(); // `${id}|${infoHash}|${fileName}|${status}` -> Promise<info>

/** Codec string for a MIME type (`codecs="..."`), so the browser can tell whether it plays it. null = unknown. */
function codecString(s) {
  const tenBit = /10/.test(s.pix_fmt || '') || s.bits_per_raw_sample === '10';
  switch (s.codec_name) {
    case 'h264': {
      const profiles = { Baseline: '42', 'Constrained Baseline': '42', Main: '4d', Extended: '58', High: '64', 'High 10': '6e', 'High 4:2:2': '7a', 'High 4:4:4 Predictive': 'f4' };
      const p = profiles[s.profile] || '64';
      const level = s.level > 0 ? s.level : 40;
      return `avc1.${p}${s.profile === 'Constrained Baseline' ? 'e0' : '00'}${level.toString(16).padStart(2, '0')}`;
    }
    case 'hevc': {
      const main10 = /10/.test(s.profile || '') || tenBit;
      return `hvc1.${main10 ? '2.4' : '1.6'}.L${s.level > 0 ? s.level : 120}.B0`;
    }
    case 'vp8': return 'vp8';
    case 'vp9': return `vp09.0${tenBit ? 2 : 0}.40.${tenBit ? '10' : '08'}`;
    case 'av1': return `av01.0.08M.${tenBit ? '10' : '08'}`;
    case 'aac': return s.profile === 'HE-AAC' || s.profile === 'HE-AACv2' ? 'mp4a.40.5' : 'mp4a.40.2';
    case 'mp3': return 'mp4a.69';
    case 'opus': return 'opus';
    case 'vorbis': return 'vorbis';
    case 'flac': return 'flac';
    case 'ac3': return 'ac-3';
    case 'eac3': return 'ec-3';
    default: return null;
  }
}

const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '';
const flag = (s, k) => !!(s.disposition && s.disposition[k]);

/** The parts of ffprobe's output the player needs. */
function describe(probe, fileName) {
  const streams = probe.streams || [];
  const fmt = probe.format || {};
  const v = streams.find((s) => s.codec_type === 'video' && !flag(s, 'attached_pic'));
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
    index: s.index,
    codec: s.codec_name || '',
    codecString: codecString(s),
    lang: subs.normLang(tag(s, 'language')),
    title: tag(s, 'title').slice(0, 120),
    channels: s.channels || 0,
    default: flag(s, 'default'),
  }));
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle' && (TEXT_SUBS.has(s.codec_name) || IMAGE_SUBS.has(s.codec_name))).map((s) => ({
    key: 'e' + s.index,
    index: s.index,
    source: 'embedded',
    kind: TEXT_SUBS.has(s.codec_name) ? 'text' : 'image',
    codec: s.codec_name,
    lang: subs.normLang(tag(s, 'language')),
    title: tag(s, 'title').slice(0, 120),
    forced: flag(s, 'forced'),
    sdh: flag(s, 'hearing_impaired'),
    default: flag(s, 'default'),
  }));
  const video = v ? { index: v.index, codec: v.codec_name || '', codecString: codecString(v), width: v.width || 0, height: v.height || 0, hdr: /smpte2084|arib-std-b67/.test(v.color_transfer || '') } : null;

  // The browser can play the file as it is if it understands the container and codecs; it then plays the first
  // audio track and shows no embedded subtitles (the player adds those itself).
  const ext = path.extname(fileName || '').toLowerCase();
  const formats = String(fmt.format_name || '').split(',');
  const container = formats.includes('mp4') || formats.includes('mov') ? (['.mp4', '.m4v', '.mov'].includes(ext) ? 'video/mp4' : null)
    : formats.includes('webm') && ext === '.webm' ? 'video/webm' : null;
  let direct = null;
  if (container && video && video.codecString) {
    const codecs = [video.codecString, audio[0] && audio[0].codecString].filter(Boolean);
    if (!audio[0] || audio[0].codecString) direct = { mime: `${container}; codecs="${codecs.join(', ')}"`, audio: audio[0] ? audio[0].index : null };
  }
  return {
    duration: Number(fmt.duration) > 0 ? Number(fmt.duration) : null,
    startTime: Number(fmt.start_time) || 0, // ffmpeg's output (streams, subtitles) counts from here
    container: formats[0] || '',
    video,
    audio,
    subtitles,
    direct,
  };
}

/** Probed details of a record's file (cached per file and status: a download that finishes is probed again). */
async function info(rec, req) {
  if (!rec) throw httpError(409, 'not on the server (yet)');
  const k = `${rec.id}|${rec.infoHash}|${rec.fileName}|${rec.status === 'complete'}`;
  if (!probes.has(k)) {
    const p = (async () => {
      const { input } = await inputFor(rec, req);
      let out;
      try {
        out = await exec(cfg.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { timeout: 45000 });
      } catch (e) {
        throw httpError(422, `cannot read this file${rec.status === 'complete' ? '' : ' yet'}: ${e.message}`);
      }
      return describe(JSON.parse(out.toString('utf8')), rec.fileName);
    })();
    probes.set(k, p);
    p.catch(() => probes.delete(k)); // try again next time (more may be downloaded by then)
    if (probes.size > 200) probes.delete(probes.keys().next().value);
  }
  return probes.get(k);
}

// ---- seeking --------------------------------------------------------------------------------------------
/**
 * When the video is copied (not re-encoded) a stream can only start on a keyframe. Returns the last keyframe at or
 * before `t` (seconds from the start), so the player knows exactly where the stream it asks for begins.
 */
async function keyframe(rec, req, t) {
  const meta = await info(rec, req);
  if (!meta.video || t <= 0) return 0;
  const { input } = await inputFor(rec, req);
  const at = meta.startTime + t;
  let out;
  try {
    out = await exec(cfg.ffprobePath, ['-v', 'error', '-select_streams', String(meta.video.index), '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0', '-read_intervals', `${Math.max(0, at - 20).toFixed(3)}%${(at + 0.5).toFixed(3)}`, input], { timeout: 30000 });
  } catch {
    return t; // could not look: start where asked (at most a few seconds off)
  }
  let best = null;
  let first = null;
  for (const line of out.toString('utf8').split('\n')) {
    const [pts, flags] = line.split(',');
    const x = parseFloat(pts);
    if (!Number.isFinite(x) || !/K/.test(flags || '')) continue;
    if (first === null || x < first) first = x;
    if (x <= at + 0.001 && (best === null || x > best)) best = x;
  }
  const k = best ?? first;
  return k === null ? t : Math.max(0, k - meta.startTime);
}

// ---- streams --------------------------------------------------------------------------------------------
/**
 * ffmpeg arguments for a stream of `meta`'s video with one audio track, starting at `t` seconds (a keyframe when
 * the video is copied). `format`: fragmented MP4 (H.264/AAC when converting, what nearly every browser plays) or
 * WebM (VP9/Opus, for browsers without H.264). `copyVideo`: the browser plays the video codec as it is (ignored
 * when the container cannot hold it). `burn`: index of an image subtitle stream to draw onto the video.
 */
const COPYABLE = { mp4: new Set(['h264', 'hevc', 'av1', 'vp9']), webm: new Set(['vp8', 'vp9', 'av1']) };

function streamArgs({ input, local, meta, audio, t = 0, format = 'mp4', copyVideo = false, burn = null, maxHeight = cfg.playerMaxHeight }) {
  const a = meta.audio.find((x) => x.index === audio) || null;
  const webm = format === 'webm';
  const encode = !copyVideo || burn != null || !meta.video || !COPYABLE[webm ? 'webm' : 'mp4'].has(meta.video.codec);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (!local) args.push('-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30');
  // Copied video starts on the keyframe ffmpeg seeks to, and with B-frames ffmpeg aims a little before the
  // time asked for: just past the keyframe (from keyframe()) makes it land on that keyframe, not the one before.
  if (t > 0) args.push('-ss', (encode ? t : t + 0.2).toFixed(3));
  args.push('-i', input);
  const scale = `scale=-2:'min(${maxHeight},ih)':flags=bicubic,format=yuv420p`;
  if (meta.video) {
    if (burn != null) {
      args.push('-filter_complex', `[0:${meta.video.index}][0:${burn}]overlay=eof_action=pass,${scale}[v]`, '-map', '[v]');
    } else {
      args.push('-map', `0:${meta.video.index}`);
      if (encode) args.push('-vf', scale);
    }
    if (!encode) args.push('-c:v', 'copy', ...(meta.video.codec === 'hevc' && !webm ? ['-tag:v', 'hvc1'] : []));
    else if (webm) args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '32', '-b:v', '4M', '-g', '48');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-g', '48', '-bf', '2');
  }
  // Audio is always re-encoded: cheap, plays everywhere, and a copied track would not start where the video does.
  if (a) args.push('-map', `0:${a.index}`, ...(webm ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k']), '-ac', '2');
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '4096');
  if (webm) args.push('-f', 'webm', '-cluster_time_limit', '2000', 'pipe:1');
  else args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', 'pipe:1');
  return args;
}

/**
 * Pipes a conversion to the response once its first bytes are there, so a conversion that fails right away
 * (a broken file, a spot that is not downloaded yet) still gets a proper error status and message.
 */
function pipeJob(child, res, type, what) {
  let started = false;
  child.stdout.once('data', (c) => {
    started = true;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.write(c);
    child.stdout.pipe(res);
  });
  child.on('close', (code) => {
    const why = child.errText.trim().split('\n').pop() || `ffmpeg exited with ${code}`;
    if (code && !res.destroyed) console.error(`[player] ${what}:`, why);
    if (started || res.headersSent) return res.end();
    if (code === 0) return res.status(200).type(type).end();
    res.status(502).type('text').send(why.slice(0, 300));
  });
}

/** Streams `rec` converted for the browser. `q`: { audio, t, format, copyVideo, burn } as validated by the route. */
async function stream(req, res, rec, q) {
  const meta = await info(rec, req);
  if (q.audio != null && !meta.audio.some((a) => a.index === q.audio)) throw httpError(400, 'unknown audio track');
  if (q.burn != null && !meta.subtitles.some((s) => s.index === q.burn && s.kind === 'image')) throw httpError(400, 'unknown subtitle track');
  const { input, local } = await inputFor(rec, req);
  const type = q.format === 'webm' ? 'video/webm' : 'video/mp4';
  if (req.method === 'HEAD') return res.status(200).set({ 'Content-Type': type, 'Cache-Control': 'no-store' }).end();
  const audio = q.audio ?? (meta.audio.find((a) => a.default) || meta.audio[0] || {}).index;
  pipeJob(job(streamArgs({ input, local, meta, audio, t: q.t, format: q.format, copyVideo: q.copyVideo, burn: q.burn }), res), res, type, 'stream');
}

// ---- subtitles ------------------------------------------------------------------------------------------
const cacheDir = () => path.resolve(cfg.dataDir, 'subtitles');
const cacheFile = (rec, key) => path.join(cacheDir(), crypto.createHash('sha1').update(`${rec.infoHash}|${rec.fileName}|${key}`).digest('hex') + '.vtt');

/** Drops cached subtitles nobody asked for in 30 days. */
function pruneCache() {
  try {
    for (const f of fs.readdirSync(cacheDir())) {
      const p = path.join(cacheDir(), f);
      if (Date.now() - fs.statSync(p).atimeMs > 30 * 86400000) fs.unlinkSync(p);
    }
  } catch {
    /* nothing cached yet */
  }
}

/** Subtitle files next to the video on disk, as `{ key, source: 'file', path, lang, title, ... }`. */
async function sidecars(rec) {
  const out = [];
  const seen = new Set();
  const video = path.basename(rec.fileName.replace(/\\/g, '/'));
  for (const candidate of await localCandidates(rec)) {
    const dir = path.dirname(candidate);
    if (seen.has(dir)) continue;
    seen.add(dir);
    // Straight in the downloads folder, next to everything else: only files named after the video count.
    const root = path.resolve(dir) === path.resolve(cfg.localPathPrefix);
    let names;
    try {
      names = listDir(dir, root ? 0 : 2);
    } catch {
      continue;
    }
    const videos = names.map((n) => n.replace(/\.(!qB|part)$/, '')).filter((n) => subs.VIDEO_EXT.test(n));
    for (const n of names) {
      if (!subs.belongsTo(video, n, [video, ...videos], { loose: !root })) continue;
      const d = subs.describeFile(n, video);
      out.push({ key: 'x' + out.length, source: 'file', kind: 'text', path: path.join(dir, n), lang: d.lang, title: d.label, forced: d.forced, sdh: d.sdh, default: false });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/** Relative paths of the files in `dir`, `depth` levels of subfolders deep, '/'-separated. */
function listDir(dir, depth, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isFile()) out.push(rel);
    else if (e.isDirectory() && depth > 0) out.push(...listDir(dir, depth - 1, rel));
  }
  return out;
}

/** Sends a subtitle track as WebVTT: embedded (`e<stream>`) or a file next to the video (`x<n>`). */
async function subtitle(req, res, rec, key) {
  const send = (vtt) => res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' }).send(vtt);
  await inputFor(rec, req); // only for files that are on the server
  if (key.startsWith('x')) {
    const s = (await sidecars(rec)).find((x) => x.key === key);
    if (!s) throw httpError(404, 'unknown subtitle');
    if (/\.(srt|vtt)$/i.test(s.path)) return send(subs.srtToVtt(subs.decodeText(await fs.promises.readFile(s.path))));
    return send((await exec(cfg.ffmpegPath, ['-v', 'error', '-nostdin', '-i', s.path, '-f', 'webvtt', 'pipe:1'], { timeout: 30000 })).toString('utf8'));
  }
  const meta = await info(rec, req);
  const s = meta.subtitles.find((x) => x.key === key && x.kind === 'text');
  if (!s) throw httpError(404, 'unknown subtitle');

  const cached = rec.status === 'complete' ? cacheFile(rec, key) : null;
  if (cached && fs.existsSync(cached)) {
    const now = new Date();
    fs.utimesSync(cached, now, now);
    return res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' }).sendFile(cached);
  }
  // Embedded subtitles are spread over the whole file, so this reads all of it: stream the cues as they come
  // (the player adds them as they arrive) and keep the result for next time.
  const { input } = await inputFor(rec, req);
  const child = job(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], res);
  if (cached) {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`;
    let sink = fs.createWriteStream(tmp);
    sink.on('error', () => (sink = null));
    child.stdout.on('data', (c) => sink && sink.write(c));
    child.on('close', (code) => {
      if (!sink) return fs.rm(tmp, { force: true }, () => {});
      sink.end(() => {
        if (code !== 0) return fs.rm(tmp, { force: true }, () => {});
        fs.rename(tmp, cached, () => {});
        pruneCache();
      });
    });
  }
  pipeJob(child, res, 'text/vtt; charset=utf-8', 'subtitles');
}

/** Everything the player shows in its menus for one record. */
async function details(rec, req) {
  const meta = await info(rec, req);
  const files = await sidecars(rec);
  return {
    duration: meta.duration,
    container: meta.container,
    video: meta.video,
    audio: meta.audio,
    subtitles: [...meta.subtitles, ...files.map((f) => ({ ...f, path: undefined }))],
    direct: meta.direct,
    online: !!cfg.subtitlesUrl,
  };
}

module.exports = { available, details, info, keyframe, stream, subtitle, describe, codecString, streamArgs, sidecars };
