// The status screen Stremio shows while a download cannot be played yet: what it says for a given download state
// (describe), how it is drawn (ffmpeg: a backdrop from assets/, text and a progress bar on top) and how the bits that
// change while it plays are fed to ffmpeg (Screen). No config or database in here, so scripts/make-clips.js can use it.
//
// A running ffmpeg re-reads small files on every frame: the text lines (drawtext reload), the progress bar (an image
// loop) and the backdrop. Rewriting such a file (atomically, by renaming a new one over it) changes the picture at once.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MIN_START_BYTES } = require('./play');

const FPS = 4;
// Long on purpose: a clip that ends lets Stremio auto-play the next episode.
const SECONDS = 600;

// Pixels, 1920x1080. The icon (drawn into the backdrops by scripts/make-scenes.py) sits at 960,318.
const LAYOUT = {
  bar: { x: 410, y: 706, w: 1100, h: 12 },
  head: { size: 72, y: 462 },
  sub: { size: 34, y: 566 },
  under: { baseline: 802 }, // percentage (left) and stats (right) under the bar
  hint: { size: 28, y: 968 },
};
// The web UI's palette.
const COLORS = { fg: 'e6e8ec', mut: '8b93a1', dim: '5f6777' };
const RGB = {
  track: [42, 47, 58],
  accent: { from: [108, 80, 245], to: [164, 143, 255] },
  ok: { from: [46, 170, 118], to: [98, 230, 177] },
};
const BAR_FOR = { search: 'accent', download: 'accent', ready: 'ok' };

const FONTS = { regular: 'assets/fonts/Inter-Regular.otf', semi: 'assets/fonts/Inter-SemiBold.otf' };
const ROOT = __dirname; // ffmpeg runs from here, so asset paths stay relative and odd characters in the install path never reach a filter

// --- what to say -------------------------------------------------------------------------------------------------

// What the bundled Inter subset can draw (see scripts/make-scenes.py); anything else would show as an empty box.
const NOT_IN_FONT = /[^\u0020-\u007e\u00a0-\u024f\u0370-\u03ff\u0400-\u04ff\u2010-\u2027\u2030\u2190-\u2193\u2212]+/g;

/** Control characters and letters the font lacks out, spaces collapsed, cut to `max` characters with an ellipsis. */
function clean(s, max) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(NOT_IN_FONT, '?').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function fmtSpeed(bytesPerSec) {
  if (!(bytesPerSec > 0)) return '';
  return bytesPerSec >= 1048576 ? `${(bytesPerSec / 1048576).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

function fmtEta(seconds) {
  if (!(seconds > 0)) return '';
  if (seconds < 60) return 'under a minute left';
  const min = Math.round(seconds / 60);
  return min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min left`;
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const HINT_BACK = 'Press Back to close this screen';
const HINT_WAIT = 'Press Back whenever you like  ·  Stremio lists it as “Your server” while it downloads';

/**
 * What the screen shows for a download.
 * @param {object|null} rec    download record (db), null while the torrent is still being looked up
 * @param {object|null} live   downloads.view(rec, torrent): speed, ETA, seeds, client state (null when unknown)
 * @param {number} elapsedMs   how long this screen has been up
 * @param {boolean} searching  a torrent is being looked up right now (a retry after an error: do not show the old error)
 * @returns {{scene:'search'|'download'|'ready'|'error', head:string, sub:string, hint:string, left:string, right:string,
 *            bar: null | {fraction:number|null}}}  bar.fraction null = indeterminate
 */
function describe(rec, live, elapsedMs = 0, searching = false) {
  const waiting = { scene: 'search', left: '', right: fmtElapsed(elapsedMs), bar: { fraction: null }, hint: HINT_WAIT };
  if (!rec || (searching && (rec.status === 'error' || rec.status === 'missing'))) return { ...waiting, head: 'Looking for a torrent', sub: 'Searching for the best match for your title' };

  if (rec.status === 'error') {
    return { scene: 'error', head: 'Could not start the download', sub: clean(rec.error, 90) || 'No usable torrent was found.',
      hint: 'Press Back, then tap Download to try again', left: '', right: '', bar: null };
  }
  if (rec.status === 'missing') {
    return { scene: 'error', head: 'The download was removed', sub: 'It is no longer in your torrent client.',
      hint: 'Press Back, then tap Download to start it again', left: '', right: '', bar: null };
  }
  if (!rec.selected) return { ...waiting, head: 'Starting the download', sub: clean(rec.title, 72) || 'Connecting to peers' };

  const label = clean((live && live.label) || rec.fileName || rec.title, 72);
  const progress = Math.min(1, Math.max(0, rec.progress || 0));
  const pct = progress >= 1 ? '100%' : `${Math.floor(progress * 100)}%`;
  const complete = rec.status === 'complete';
  const speed = fmtSpeed(live && live.dlSpeed);
  const stats = complete
    ? 'Download complete'
    : live && live.paused
      ? 'Paused in your torrent client'
      : live && live.clientState === 'queued'
        ? 'Queued in your torrent client'
        : [speed, fmtEta(live && live.eta), live && live.seeds > 0 ? `${live.seeds} seeds` : ''].filter(Boolean).join('  ·  ');

  const playable = rec.fileSize ? (rec.playable || 0) * rec.fileSize : 0;
  if (complete || (rec.fileSize && playable >= Math.min(MIN_START_BYTES, rec.fileSize))) {
    return { scene: 'ready', head: 'Ready to watch', sub: 'Press Back, then play “Your server”', hint: HINT_BACK,
      left: pct, right: stats, bar: { fraction: progress } };
  }
  const gettingStarted = progress < 0.005 && !(live && live.dlSpeed > 0);
  return { scene: 'download', head: 'Downloading', sub: label, hint: HINT_WAIT,
    left: gettingStarted ? '' : pct, right: gettingStarted ? 'Connecting to peers' : stats, bar: { fraction: gettingStarted ? null : progress } };
}

/** The fixed clips /play falls back on when it cannot stream a live screen (clips/*.mp4, see scripts/make-clips.js). */
const STATIC = {
  started: { scene: 'download', head: 'Download started', sub: 'Come back in a bit - Stremio then shows it as “Your server”.', hint: HINT_BACK },
  metadata: { scene: 'search', head: 'Looking for the torrent', sub: 'The download is being set up. Try again in a minute.', hint: HINT_BACK },
  error: { scene: 'error', head: 'Could not start the download', sub: 'No usable torrent was found. Check the add-on web page.', hint: HINT_BACK },
};

// --- the progress bar ---------------------------------------------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;

/**
 * The bar as an RGBA image in the PAM format (ffmpeg reads it; no PNG encoder needed): a rounded track with the
 * fill on top. `fraction` null draws a pill sweeping back and forth instead. `tick` (frame count) moves the animation.
 */
function barImage(scene, fraction, tick = 0) {
  const { w, h } = LAYOUT.bar;
  const r = h / 2;
  const pal = RGB[BAR_FOR[scene] || 'accent'];
  const seconds = tick / FPS;

  let from = 0;
  let to = 0;
  if (fraction == null) {
    const len = 300;
    const phase = (seconds / 1.7) % 2;
    const t = phase < 1 ? phase : 2 - phase;
    from = Math.round((w - len) * (t * t * (3 - 2 * t))); // smoothstep: eases at both ends
    to = from + len;
  } else if (fraction > 0) {
    to = Math.min(w, Math.max(h, Math.round(w * fraction)));
  }
  // A soft sheen travelling over the fill, so a bar that grows slowly still looks alive.
  const sheenAt = ((seconds % 2.6) / 2.6) * (to + 360) - 180;

  const capsule = (x, y, a, b) => clamp01(r + 0.5 - Math.hypot(x + 0.5 - Math.min(Math.max(x + 0.5, a + r), b - r), y + 0.5 - r));
  const header = Buffer.from(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ta = capsule(x, y, 0, w);
      const fa = to > from ? capsule(x, y, from, to) : 0;
      const alpha = fa + ta * (1 - fa);
      if (alpha <= 0) continue;
      const k = to > from ? clamp01((x - from) / (to - from)) : 0;
      const sheen = fraction == null ? 0 : Math.max(0, 1 - Math.abs(x - sheenAt) / 140) * 0.28;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const fill = mix(mix(pal.from[c], pal.to[c], k), 255, sheen);
        px[i + c] = Math.round((fill * fa + RGB.track[c] * ta * (1 - fa)) / alpha);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return Buffer.concat([header, px]);
}

/** No bar (an error screen): the same size, fully transparent. The size must not change while ffmpeg runs. */
function blankBar() {
  const { w, h } = LAYOUT.bar;
  return Buffer.concat([Buffer.from(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`), Buffer.alloc(w * h * 4)]);
}

// --- feeding ffmpeg -----------------------------------------------------------------------------------------------

const { bar } = LAYOUT;
// One entry per text line: the file ffmpeg re-reads, its font, size, colour and where it goes (ffmpeg expressions).
const LINES = [
  { id: 'head', font: 'semi', size: LAYOUT.head.size, color: COLORS.fg, x: '(w-text_w)/2', y: LAYOUT.head.y },
  { id: 'sub', font: 'regular', size: LAYOUT.sub.size, color: COLORS.mut, x: '(w-text_w)/2', y: LAYOUT.sub.y },
  // y = baseline - ascent, so a big and a small line share a baseline.
  { id: 'left', font: 'semi', size: 60, color: COLORS.fg, x: bar.x, y: `${LAYOUT.under.baseline}-ascent` },
  { id: 'right', font: 'regular', size: 30, color: COLORS.mut, x: `${bar.x + bar.w}-text_w`, y: `${LAYOUT.under.baseline}-ascent` },
  { id: 'hint', font: 'regular', size: LAYOUT.hint.size, color: COLORS.dim, x: '(w-text_w)/2', y: LAYOUT.hint.y },
];

const esc = (s) => String(s).replace(/[\\:']/g, '\\$&'); // inside a filter option value

/**
 * Writes the files an ffmpeg run reads, and updates them while it runs. Every write goes to a temporary name and is
 * renamed into place, so ffmpeg never sees half a file.
 */
class Screen {
  constructor(dir) {
    this.dir = dir;
    this.last = new Map();
    this.tick = 0;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  put(name, data) {
    const tmp = this.file(`.${name}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file(name));
  }

  /** Writes `data` unless it is what was written last. */
  putIfChanged(name, key, make) {
    if (this.last.get(name) === key) return;
    this.last.set(name, key);
    this.put(name, make());
  }

  /** Shows `model` (from describe() or STATIC). Call once before ffmpeg starts, then again whenever it may have changed. */
  update(model) {
    this.putIfChanged('scene.png', model.scene, () => fs.readFileSync(path.join(ROOT, 'assets', `scene-${model.scene}.png`)));
    for (const { id } of LINES) {
      const text = model[id] || '';
      this.putIfChanged(`${id}.txt`, text, () => text || ' ');
    }
    if (model.bar) {
      const animated = model.bar.fraction == null || model.bar.fraction < 1;
      // Rewritten every frame while it animates (an indeterminate bar always does; a growing one slowly sweeps a sheen).
      const key = `${model.scene}|${model.bar.fraction}|${animated ? this.tick : ''}`;
      this.putIfChanged('bar.pam', key, () => barImage(model.scene, model.bar.fraction, this.tick));
    } else {
      this.putIfChanged('bar.pam', 'none', blankBar);
    }
    this.tick++;
  }
}

/** ffmpeg arguments. Live: paced like a real-time stream, fragmented MP4 on stdout. Not live: one 10-minute file. */
function ffmpegArgs(screen, { live, withBar, out }) {
  const dir = screen.dir;
  // analyzeduration 0: ffmpeg would otherwise read (and replay) the first five seconds of an image before starting,
  // and a live screen would show them as they were then.
  const images = (file, fps) => ['-analyzeduration', '0', '-probesize', '32', '-thread_queue_size', '1', '-f', 'image2', '-loop', '1', '-framerate', String(fps), '-i', file];
  const pace = live ? ['-re'] : [];
  const fps = live ? FPS : 2;
  const inputs = [...pace, ...images(screen.file('scene.png'), fps)];
  if (withBar) inputs.push(...pace, ...images(screen.file('bar.pam'), fps));
  inputs.push(...pace, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  const audio = withBar ? 2 : 1;

  const lines = LINES.map(
    (l) => `drawtext=fontfile=${esc(FONTS[l.font])}:textfile=${esc(path.join(dir, `${l.id}.txt`))}:reload=1:expansion=none` +
      `:fontcolor=0x${l.color}:fontsize=${l.size}:x=${l.x}:y=${l.y}`
  );
  const base = withBar ? `[0:v][1:v]overlay=${bar.x}:${bar.y}:shortest=0:format=auto` : '[0:v]null';
  const graph = `${base},${lines.join(',')},format=yuv420p[v]`;

  const encode = live
    // A long keyframe interval: the one noisy keyframe (the backdrop's glow is dithered) is sent once, the rest is tiny.
    ? ['-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '21', '-g', String(FPS * 15), '-movflags', 'empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1']
    : ['-preset', 'veryslow', '-tune', 'stillimage', '-crf', '21', '-g', String(fps * SECONDS), '-movflags', '+faststart', out];
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[v]', '-map', `${audio}:a`,
    '-t', String(SECONDS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', ...encode];
}

function spawnFfmpeg(ffmpegPath, args, stdio) {
  return spawn(ffmpegPath, args, { cwd: ROOT, stdio });
}

/** Renders one fixed clip (STATIC[name]) to the file `out`. */
function renderStatic(ffmpegPath, name, out, tmpDir) {
  const model = STATIC[name];
  const screen = new Screen(tmpDir);
  screen.update({ left: '', right: '', bar: null, ...model });
  return new Promise((resolve, reject) => {
    const child = spawnFfmpeg(ffmpegPath, ffmpegArgs(screen, { live: false, withBar: false, out }), ['ignore', 'inherit', 'inherit']);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

module.exports = { LAYOUT, FPS, SECONDS, STATIC, describe, clean, fmtSpeed, fmtEta, fmtElapsed, barImage, Screen, ffmpegArgs, spawnFfmpeg, renderStatic };
