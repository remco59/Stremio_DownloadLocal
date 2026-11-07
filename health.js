// Health: is the torrent client reachable, and is there room on the downloads disk?
const fs = require('fs');
const cfg = require('./config');
const client = require('./clients');

const GB = 1024 ** 3;
const CLIENT_CACHE_MS = 15000;

/**
 * Free and total bytes of the disk holding the downloads, as this container sees it. `lowAt` is the configured
 * threshold in bytes (0 = guard off). `null` where the disk cannot be read (the folder is missing, or the
 * platform has no statfs): the guard then stays out of the way instead of blocking every download.
 */
async function disk() {
  const lowAt = Math.max(0, cfg.minFreeGb || 0) * GB;
  try {
    const s = await fs.promises.statfs(cfg.localPathPrefix);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    return { freeBytes: free, totalBytes: total, minFreeBytes: lowAt, low: lowAt > 0 && free < lowAt };
  } catch {
    return null;
  }
}

const fmt = (b) => `${(b / GB).toFixed(1)} GB`;

/** Throws (HTTP 507) when free space is under the configured minimum, so no new download is started. */
async function assertSpace() {
  const d = await disk();
  if (d && d.low) {
    throw Object.assign(
      new Error(`Not enough free disk space: ${fmt(d.freeBytes)} left, at least ${fmt(d.minFreeBytes)} must stay free (Settings > Disk)`),
      { status: 507 }
    );
  }
}

let cached = { at: 0, result: null };

/** Torrent client reachability, cached for a few seconds so a healthcheck every few seconds is cheap. */
async function clientStatus() {
  if (cached.result && Date.now() - cached.at < CLIENT_CACHE_MS && cached.name === cfg.torrentClient) return cached.result;
  let result;
  try {
    const r = await client.testConnection();
    result = r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'not reachable' };
  } catch (e) {
    result = { ok: false, error: String(e.message || e) };
  }
  cached = { at: Date.now(), result, name: cfg.torrentClient };
  return result;
}

/** Forget the cached client status (the settings changed). */
const forget = () => (cached = { at: 0, result: null });

/** What /healthz answers. `ok` is false only when the torrent client cannot be reached. */
async function check() {
  const [c, d] = await Promise.all([clientStatus(), disk()]);
  return { ok: c.ok, client: { name: cfg.torrentClient, ...c }, disk: d };
}

module.exports = { disk, assertSpace, check, forget };
