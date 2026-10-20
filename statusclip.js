// The live status screen /play sends Stremio to while a download cannot be played yet: a video that is drawn while
// it plays, so it shows what the server is doing right now (looking for a torrent, speed and ETA, ready to play).
// See statusscreen.js for how it is drawn. Where ffmpeg cannot draw it, the fixed clips in clips/ are used instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');
const db = require('./db');
const client = require('./clients');
const { view, searching } = require('./downloads');
const { Screen, FPS, describe, ffmpegArgs, spawnFfmpeg } = require('./statusscreen');

// Every open screen is an ffmpeg process; past this many, new ones get a fixed clip.
const MAX_STREAMS = 3;
const STATS_EVERY_MS = 2000;
const active = new Set();

let probe = null;
/** Can this machine draw the screen: live mode on, and an ffmpeg with the drawtext filter. Checked once. */
function available() {
  if (!cfg.liveStatus) return Promise.resolve(false);
  probe ||= new Promise((resolve) => {
    execFile(cfg.ffmpegPath, ['-hide_banner', '-filters'], { timeout: 10000 }, (err, out) => {
      const ok = !err && /\bdrawtext\b/.test(out) && /\boverlay\b/.test(out);
      if (!ok) console.warn('[status] no ffmpeg with the drawtext filter: /play shows the fixed status clips instead of the live screen');
      resolve(ok);
    });
  });
  return probe;
}

/** The fixed clip that says roughly the same as the live screen would for this record. */
function fixedClip(rec) {
  if (rec && (rec.status === 'error' || rec.status === 'missing')) return 'error';
  return rec && !rec.selected ? 'metadata' : 'started';
}

const HEADERS = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Accel-Buffering': 'no' };

/**
 * Streams the live screen for download `id` as a fragmented MP4 (no length, no seeking). It ends when the player
 * leaves, or after the clip's ten minutes.
 * @returns {Promise<boolean>} true when the response is dealt with; false when the screen could not be started (nothing
 *   was sent: answer with a fixed clip instead)
 */
async function stream(req, res, id) {
  if (active.size >= MAX_STREAMS) return false;
  const slot = { child: null };
  active.add(slot); // reserved before the first await, so concurrent requests cannot all slip past the limit
  let dir = null;
  let timer = null;
  const cleanup = () => {
    clearInterval(timer);
    if (slot.child) slot.child.kill('SIGKILL');
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    active.delete(slot);
  };

  try {
    if (!(await available())) {
      cleanup();
      return false;
    }
    // A player that wants to seek (a byte range past the start) cannot be served from a live stream.
    const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
    if (range && Number(range[1]) > 0) {
      res.status(416).set('Content-Range', 'bytes */*').end();
      cleanup();
      return true;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, HEADERS).end();
      cleanup();
      return true;
    }

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-screen-'));
    const screen = new Screen(dir);
    const since = Date.now();
    let stats = null; // downloads.view() of the record: speed, ETA, seeds, client state
    let fetching = false;
    const fetchStats = async () => {
      const rec = db.get(id);
      if (fetching || !rec || !rec.infoHash) return;
      fetching = true;
      try {
        const [t] = await client.info([rec.infoHash]);
        stats = view(rec, t || null);
      } catch {
        /* client hiccup: keep showing the last numbers */
      } finally {
        fetching = false;
      }
    };
    const show = () => screen.update(describe(db.get(id) || null, stats, Date.now() - since, searching(id)));
    await fetchStats();
    show();

    const child = spawnFfmpeg(cfg.ffmpegPath, ffmpegArgs(screen, { live: true, withBar: true, sound: !!cfg.statusSound }), ['ignore', 'pipe', 'pipe']);
    slot.child = child;
    let errors = '';
    child.stderr.on('data', (d) => (errors = (errors + d).slice(-2000)));

    return await new Promise((resolve) => {
      let started = false;
      let gone = false;
      res.on('close', () => {
        gone = true;
        cleanup();
        resolve(true);
      });
      res.on('error', () => {});
      child.on('error', (e) => {
        errors = e.message;
      });
      child.on('close', (code) => {
        cleanup();
        if (gone) return;
        if (started) return res.end();
        console.error('[status]', id, `ffmpeg gave no video (exit ${code}): ${errors.trim() || 'no output'}`);
        resolve(false);
      });
      // Wait for the first bytes before answering, so a failing ffmpeg can still fall back to a fixed clip.
      child.stdout.once('data', (first) => {
        started = true;
        if (res.socket) res.socket.setNoDelay(true);
        res.writeHead(200, HEADERS);
        res.write(first);
        child.stdout.pipe(res);
        let n = 0;
        timer = setInterval(() => {
          try {
            show();
            if (++n % Math.round((STATS_EVERY_MS / 1000) * FPS) === 0) fetchStats();
          } catch (e) {
            console.error('[status]', id, e.message);
          }
        }, 1000 / FPS);
      });
    });
  } catch (e) {
    cleanup();
    throw e;
  }
}

const activeCount = () => active.size;
// ffmpeg children must not outlive the server.
process.on('exit', () => active.forEach((s) => s.child && s.child.kill('SIGKILL')));

module.exports = { available, stream, fixedClip, activeCount, MAX_STREAMS };
