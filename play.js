// What /play does at a given moment: serve the file, keep waiting, redirect to a status clip, or give up
// on a seek past the downloaded part. Pure, so the timing rules are easy to test.

// On a first tap from the start of the file, wait for at least this much (or the whole file) before playing,
// so the player does not start and immediately stall.
const MIN_START_BYTES = 2 * 2 ** 20;

/**
 * @param {object} p
 * @param {object|null} p.rec     download record (after ensureDownload)
 * @param {number} p.start        first requested byte (0 without a Range header)
 * @param {number|null} p.avail   exclusive end of the downloaded run starting at `start`, if known
 * @param {number} p.elapsed      ms since the request came in
 * @param {{waitForStartMs:number, seekWaitMs:number}} p.cfg
 * @returns {{action:'serve'} | {action:'wait'} | {action:'clip', clip:'error'|'metadata'|'started'} | {action:'unavailable'}}
 */
function decide({ rec, start, avail, elapsed, cfg }) {
  if (!rec || rec.status === 'error' || rec.status === 'missing') return { action: 'clip', clip: 'error' };
  if (rec.status === 'complete') return { action: 'serve' };
  if (!rec.selected) return elapsed >= cfg.waitForStartMs ? { action: 'clip', clip: 'metadata' } : { action: 'wait' };

  const have = avail != null && avail > start ? avail - start : 0;
  if (start > 0) {
    // A seek (or resume) somewhere in the file: play if that spot is there, otherwise give up after a short wait.
    if (have > 0) return { action: 'serve' };
    return elapsed >= cfg.seekWaitMs ? { action: 'unavailable' } : { action: 'wait' };
  }
  if (have >= Math.min(MIN_START_BYTES, rec.fileSize)) return { action: 'serve' };
  if (elapsed < cfg.waitForStartMs) return { action: 'wait' };
  return have > 0 ? { action: 'serve' } : { action: 'clip', clip: 'started' };
}

module.exports = { decide, MIN_START_BYTES };
