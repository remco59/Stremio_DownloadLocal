// Runtime-editable settings: schema, validation and persistence to DATA_DIR/settings.json.
// Saved values override the env defaults in config.js and are applied to it in place.
// Each torrent client declares its own connection fields (clients/<name>.js `settings`).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { CLIENTS } = require('./clients');

const strip = (s) => s.replace(/\/+$/, '');

// type: url | text | path | int | secret | choice. `optional` allows an empty value.
// `client` marks a field that only matters when that torrent client is selected.
const FIELDS = [
  { key: 'publicUrl', group: 'Add-on', label: 'Public URL', type: 'url', optional: true,
    help: 'HTTPS URL Stremio reaches this add-on on. Empty = derived from the request.' },

  { key: 'torrentClient', group: 'Torrent client', label: 'Client', type: 'choice',
    options: Object.entries(CLIENTS).map(([value, c]) => ({ value, label: c.label })) },
  ...Object.entries(CLIENTS).flatMap(([name, c]) => c.settings.fields.map((f) => ({ ...f, group: c.label, client: name }))),

  { key: 'clientPathPrefix', group: 'Paths', label: 'Downloads path in the torrent client', type: 'path' },
  { key: 'localPathPrefix', group: 'Paths', label: 'Downloads path in this container', type: 'path' },

  { key: 'torrentioUrl', group: 'Torrent source', label: 'Torrentio URL', type: 'url' },
  { key: 'maxRes', group: 'Torrent source', label: 'Max resolution', type: 'int',
    options: [480, 720, 1080, 2160].map((v) => ({ value: v, label: `${v}p` })) },

  { key: 'waitForStartMs', group: 'Timeouts', label: 'Wait for torrent metadata (ms)', type: 'int', min: 1000, max: 600000 },
  { key: 'stallMs', group: 'Timeouts', label: 'Wait for missing pieces (ms)', type: 'int', min: 1000, max: 600000 },
  { key: 'syncIntervalMs', group: 'Timeouts', label: 'Client poll interval (ms)', type: 'int', min: 1000, max: 600000 },
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
