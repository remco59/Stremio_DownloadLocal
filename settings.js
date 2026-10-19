// Runtime-editable settings: schema, validation and persistence to DATA_DIR/settings.json.
// Saved values override the env defaults in config.js and are applied to it in place.
// Each torrent client declares its own connection fields (clients/<name>.js `settings`).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { CLIENTS } = require('./clients');

const strip = (s) => s.replace(/\/+$/, '');

// type: url | urls (comma separated) | text | path | int | secret | choice. `optional` allows an empty value.
// `client` marks a field that only matters when that torrent client is selected.
const FIELDS = [
  { key: 'publicUrl', group: 'Add-on', label: 'Public URL', type: 'url', optional: true,
    help: 'HTTPS URL Stremio reaches this add-on on. Empty = derived from the request.' },

  { key: 'torrentClient', group: 'Torrent client', label: 'Client', type: 'choice',
    options: Object.entries(CLIENTS).map(([value, c]) => ({ value, label: c.label })) },
  ...Object.entries(CLIENTS).flatMap(([name, c]) => c.settings.fields.map((f) => ({ ...f, group: c.label, client: name }))),

  { key: 'clientPathPrefix', group: 'Paths', label: 'Downloads path in the torrent client', type: 'path' },
  { key: 'localPathPrefix', group: 'Paths', label: 'Downloads path in this container', type: 'path' },

  { key: 'sources', group: 'Torrent source', label: 'Search', type: 'choice',
    options: [
      { value: 'torrentio', label: 'Torrentio' },
      { value: 'torznab', label: 'Jackett / Prowlarr (Torznab)' },
      { value: 'both', label: 'Both' },
    ] },
  { key: 'torrentioUrl', group: 'Torrent source', label: 'Torrentio URL', type: 'url' },
  { key: 'torznabUrls', group: 'Torrent source', label: 'Torznab URLs', type: 'urls', optional: true,
    help: 'Jackett: http://jackett:9117/api/v2.0/indexers/all/results/torznab/ . Prowlarr: one URL per indexer, e.g. http://prowlarr:9696/1/api . Separate several with commas.' },
  { key: 'torznabApiKey', group: 'Torrent source', label: 'Torznab API key', type: 'secret', optional: true },

  { key: 'maxRes', group: 'Torrent choice', label: 'Max resolution', type: 'int',
    options: [480, 720, 1080, 2160].map((v) => ({ value: v, label: `${v}p` })) },
  { key: 'preferredRes', group: 'Torrent choice', label: 'Preferred resolution', type: 'int',
    options: [{ value: 0, label: 'No preference' }, ...[480, 720, 1080, 2160].map((v) => ({ value: v, label: `${v}p` }))] },
  { key: 'languages', group: 'Torrent choice', label: 'Preferred languages', type: 'text', optional: true,
    help: 'Language codes, comma separated: nl, en, de, fr, es, it, multi (multi-audio). Matched against release names and flags.' },
  { key: 'minSeeders', group: 'Torrent choice', label: 'Minimum seeders', type: 'int', min: 0, max: 100000 },
  { key: 'minSizeMb', group: 'Torrent choice', label: 'Minimum size (MB, 0 = none)', type: 'int', min: 0, max: 1000000 },
  { key: 'maxSizeGb', group: 'Torrent choice', label: 'Maximum size (GB, 0 = none)', type: 'int', min: 0, max: 10000,
    help: 'Season packs are exempt.' },
  { key: 'preferKeywords', group: 'Torrent choice', label: 'Preferred words / release groups', type: 'text', optional: true,
    help: 'Comma separated, e.g. x265, remux, ntb' },
  { key: 'blockKeywords', group: 'Torrent choice', label: 'Blocked words / release groups', type: 'text', optional: true,
    help: 'Comma separated. Releases containing any of these are never picked.' },
  { key: 'stallSwitchMin', group: 'Torrent choice', label: 'Try another torrent when stuck at 0% for (minutes)', type: 'int', min: 0, max: 10080,
    help: 'Dead swarms: the next best torrent is picked, never one already tried for that title. Time paused or queued in the client does not count. 0 = never.' },

  { key: 'subtitlesUrl', group: 'Player', label: 'Online subtitles add-on', type: 'url', optional: true,
    help: 'Stremio subtitles add-on the web player gets online subtitles from (OpenSubtitles v3 by default). Empty = off.' },
  { key: 'playerMaxHeight', group: 'Player', label: 'Max resolution when converting video', type: 'int',
    options: [480, 720, 1080, 2160].map((v) => ({ value: v, label: `${v}p` })),
    help: 'Video the browser cannot play as it is gets converted on the fly; lower is easier on the server CPU.' },

  { key: 'waitForStartMs', group: 'Timeouts', label: 'First tap: wait before showing the status clip (ms)', type: 'int', min: 1000, max: 600000,
    help: 'If the start of the file is there by then it plays right away; otherwise Stremio shows a short "download started" clip.' },
  { key: 'seekWaitMs', group: 'Timeouts', label: 'Seek past the downloaded part: wait (ms)', type: 'int', min: 1000, max: 600000 },
  { key: 'stallMs', group: 'Timeouts', label: 'While playing: wait for missing pieces (ms)', type: 'int', min: 1000, max: 600000 },
  { key: 'syncIntervalMs', group: 'Timeouts', label: 'Client poll interval (ms)', type: 'int', min: 1000, max: 600000 },

  { key: 'playStartsPerIpPerMin', group: 'Security', label: 'New downloads from Stremio per minute, per IP', type: 'int', min: 0, max: 10000,
    help: '0 = no limit. Playing what is already downloading or downloaded is never limited.' },
  { key: 'playStartsPerMin', group: 'Security', label: 'New downloads from Stremio per minute, everyone together', type: 'int', min: 0, max: 10000 },
  { key: 'apiWritesPerIpPerMin', group: 'Security', label: 'Web UI actions per minute, per IP', type: 'int', min: 0, max: 100000 },
  { key: 'tokenFailuresLockout', group: 'Security', label: 'Wrong URLs before an IP is locked out', type: 'int', min: 0, max: 100000,
    help: 'Within 10 minutes. The lockout starts at 1 minute and doubles up to an hour. 0 = never.' },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

class SettingsError extends Error {
  constructor(field, message) {
    super(`${field.label}: ${message}`);
    this.field = field.key;
  }
}

function normalize(field, value) {
  const fail = (m) => {
    throw new SettingsError(field, m);
  };
  const allowed = field.options && field.options.map((o) => o.value);
  if (field.type === 'int') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(n)) fail('must be a whole number');
    if (allowed && !allowed.includes(n)) fail(`must be one of ${allowed.join(', ')}`);
    if (field.min != null && n < field.min) fail(`must be at least ${field.min}`);
    if (field.max != null && n > field.max) fail(`must be at most ${field.max}`);
    return n;
  }
  if (typeof value !== 'string') fail('must be text');
  if (field.type === 'secret') return value;
  const v = value.trim();
  if (field.type === 'choice') {
    if (!allowed.includes(v)) fail(`must be one of ${allowed.join(', ')}`);
    return v;
  }
  if (!v) {
    if (field.optional) return '';
    fail('is required');
  }
  if (field.type === 'urls') {
    const parts = v.split(/[\s,]+/).filter(Boolean);
    for (const p of parts) normalize({ ...field, type: 'url' }, p);
    return parts.map(strip).join(', ');
  }
  if (field.type === 'url') {
    let u;
    try {
      u = new URL(v);
    } catch {
      fail('is not a valid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('must start with http:// or https://');
    return strip(v);
  }
  if (field.type === 'path') {
    if (!v.startsWith('/')) fail('must be an absolute path');
    return strip(v) || '/';
  }
  return v;
}

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(cfg.settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSaved(data) {
  fs.mkdirSync(path.dirname(cfg.settingsFile), { recursive: true });
  const tmp = cfg.settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cfg.settingsFile);
}

/** Settings as shown on the settings page. Passwords are never sent back, only whether one is set. */
function view() {
  const saved = readSaved();
  const values = {};
  const defaults = {};
  for (const f of FIELDS) {
    values[f.key] = f.type === 'secret' ? '' : cfg[f.key];
    defaults[f.key] = f.type === 'secret' ? '' : cfg.defaults[f.key];
  }
  return {
    fields: FIELDS,
    values,
    defaults,
    overridden: FIELDS.map((f) => f.key).filter((k) => k in saved),
    secretsSet: Object.fromEntries(FIELDS.filter((f) => f.type === 'secret').map((f) => [f.key, !!cfg[f.key]])),
  };
}

/**
 * Validates and applies a patch. Unknown keys are rejected, `null` resets a field to its env default,
 * and an omitted key is left unchanged. All-or-nothing: nothing is applied if any value is invalid.
 */
function update(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('expected an object');
  const next = {};
  for (const [k, v] of Object.entries(patch)) {
    const field = BY_KEY.get(k);
    if (!field) throw new Error(`unknown setting: ${k}`);
    next[k] = v === null ? null : normalize(field, v);
  }
  const saved = readSaved();
  for (const [k, v] of Object.entries(next)) {
    if (v === null) delete saved[k];
    else saved[k] = v;
  }
  writeSaved(saved);
  for (const [k, v] of Object.entries(next)) cfg[k] = v === null ? cfg.defaults[k] : v;
  return view();
}

/**
 * Tests a client's connection with the values from the form, falling back to the saved ones for missing
 * fields. A blank password means "keep the saved one", like on save.
 */
async function testClient(name, values = {}) {
  const c = CLIENTS[name];
  if (!c) throw new Error(`unknown torrent client: ${name}`);
  const { url, user, pass } = c.settings.connection;
  const pick = (k) => {
    const v = values[k];
    if (typeof v !== 'string' || (BY_KEY.get(k).type === 'secret' && v === '')) return cfg[k];
    return normalize(BY_KEY.get(k), v);
  };
  let conn;
  try {
    conn = { url: pick(url), user: pick(user), pass: pick(pass) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return c.testConnection(conn);
}

/** Replaces the URL token. The old one stops working immediately. */
function rotateToken(token) {
  const next = token == null ? crypto.randomBytes(24).toString('base64url') : String(token).trim();
  if (!cfg.TOKEN_RE.test(next)) throw new Error('Token: 16+ characters, letters/digits/-/_ only');
  const saved = readSaved();
  saved.token = next;
  writeSaved(saved);
  cfg.token = next;
  return next;
}

module.exports = { FIELDS, view, update, testClient, rotateToken, SettingsError };
