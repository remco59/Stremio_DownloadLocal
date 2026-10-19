// Token check, rate limits and lockout after wrong tokens or passwords. In memory, no deps; limits come from settings (0 = off).
const crypto = require('crypto');
const cfg = require('./config');

const MINUTE = 60 * 1000;
const FAIL_WINDOW_MS = 10 * MINUTE;
const MAX_LOCK_MS = 60 * MINUTE;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time comparison with the current token (hashing first makes the lengths equal). */
function tokenOk(candidate) {
  return crypto.timingSafeEqual(sha(candidate), sha(cfg.token));
}

/** Fixed one-minute windows per key. */
class Limiter {
  constructor() {
    this.hits = new Map(); // key -> { start, n }
  }

  /** Counts a hit; false (with the ms until the window resets) when `limit` per minute is used up. */
  take(key, limit) {
    if (!limit) return { ok: true };
    const now = Date.now();
    if (this.hits.size > 10000) for (const [k, h] of this.hits) if (now - h.start >= MINUTE) this.hits.delete(k);
    let h = this.hits.get(key);
    if (!h || now - h.start >= MINUTE) {
      h = { start: now, n: 0 };
      this.hits.set(key, h);
    }
    if (h.n >= limit) return { ok: false, retryMs: h.start + MINUTE - now };
    h.n++;
    return { ok: true };
  }
}

const playStarts = new Limiter();
const apiWrites = new Limiter();

/** A new download started from /play: per IP and for everyone together. */
function takePlayStart(ip) {
  const own = playStarts.take(`ip:${ip}`, cfg.playStartsPerIpPerMin);
  if (!own.ok) return own;
  return playStarts.take('all', cfg.playStartsPerMin);
}

const takeApiWrite = (ip) => apiWrites.take(ip, cfg.apiWritesPerIpPerMin);

// Lockout: after `tokenFailuresLockout` misses within 10 minutes an IP is locked out for a minute, doubling with
// every further lockout up to an hour. Wrong URLs and wrong web UI passwords are counted apart (`kind`), so a
// request with the add-on token does not wipe out the count of wrong passwords.
const fails = new Map(); // `${kind}:${ip}` -> { n, first, strikes, until }

function noteFailure(ip, kind = 'url') {
  if (!cfg.tokenFailuresLockout) return;
  const now = Date.now();
  const key = `${kind}:${ip}`;
  const f = fails.get(key) || { n: 0, first: now, strikes: 0, until: 0 };
  if (now - f.first > FAIL_WINDOW_MS) Object.assign(f, { n: 0, first: now });
  f.n++;
  if (f.n >= cfg.tokenFailuresLockout) {
    f.strikes++;
    f.until = now + Math.min(MINUTE * 2 ** (f.strikes - 1), MAX_LOCK_MS);
    Object.assign(f, { n: 0, first: now });
  }
  fails.set(key, f);
  if (fails.size > 10000) for (const [k, v] of fails) if (v.until < now && now - v.first > FAIL_WINDOW_MS) fails.delete(k);
}

/** A request with the right token or password: forget earlier misses (the lockout itself still runs out on its own). */
function noteSuccess(ip, kind = 'url') {
  const f = fails.get(`${kind}:${ip}`);
  if (f) f.n = 0;
}

/** ms this IP is still locked out for (0 = not locked). */
function lockedFor(ip) {
  const now = Date.now();
  return Math.max(0, ...['url', 'login'].map((k) => (fails.get(`${k}:${ip}`)?.until || 0) - now));
}

function reset() {
  playStarts.hits.clear();
  apiWrites.hits.clear();
  fails.clear();
}

module.exports = { tokenOk, Limiter, takePlayStart, takeApiWrite, noteFailure, noteSuccess, lockedFor, reset };
