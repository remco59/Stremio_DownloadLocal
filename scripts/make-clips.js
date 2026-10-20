#!/usr/bin/env node
// Regenerates the fixed status clips in clips/ that /play falls back on when it cannot draw the live status screen
// (see statusclip.js). They look like the live screen, with fixed text and no progress bar.
// Needs ffmpeg with libx264, aac and drawtext.   node scripts/make-clips.js   (FFMPEG_PATH=... to pick another ffmpeg)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATIC, renderStatic } = require('../statusscreen');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const out = path.join(__dirname, '..', 'clips');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'make-clips-'));
  try {
    for (const name of Object.keys(STATIC)) {
      const file = path.join(out, `${name}.mp4`);
      await renderStatic(ffmpeg, name, file, tmp);
      console.log(`clips/${name}.mp4 ${fs.statSync(file).size} bytes`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
