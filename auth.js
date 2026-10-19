// Web UI login: one account (username + scrypt password hash) and signed session cookies. Stremio itself keeps
// using the URL token (security.js); this only guards the web UI and its API.
//
// The account comes from UI_USER/UI_PASSWORD when UI_PASSWORD is set, otherwise from DATA_DIR/auth.json (created
// on the setup page or changed on the settings page). A session cookie is signed with a key derived from the
// account, so changing the username or password logs every other session out.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const COOKIE = 'ldw_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // sliding: a cookie older than a day gets a fresh 30 days
const USER_RE = /^[^\s:]{1,64}$/;
const MIN_PASSWORD = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const file = () => path.join(cfg.dataDir, 'auth.json');
const env = process.env;

let state = null; // { secret, user, hash }
function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    state = {};
  }
  if (!state.secret) {
    state.secret = crypto.randomBytes(32).toString('base64url');
    save();
  }
  return state;
}
function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

const scrypt = (password, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 32, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))));

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(password, salt)).toString('base64url')}`;
}
async function checkPassword(password, stored) {
  const [kind, salt, key] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const fromEnv = () => !!env.UI_PASSWORD;

// The env password is hashed once per process, with a salt derived from the secret so the session key (and with it
// everyone's sessions) stays the same across restarts.
let envAccount = null;
async function account() {
  const s = load();
  if (!fromEnv()) return s.user && s.hash ? { user: s.user, hash: s.hash } : null;
  if (!envAccount || envAccount.password !== env.UI_PASSWORD || envAccount.user !== (env.UI_USER || 'admin')) {
    const salt = crypto.createHmac('sha256', s.secret).update('env-password-salt').digest().subarray(0, 16);
    envAccount = { user: env.UI_USER || 'admin', password: env.UI_PASSWORD, hash: await hashPassword(env.UI_PASSWORD, salt) };
  }
  return { user: envAccount.user, hash: envAccount.hash };
}

/** Whether a login exists yet (none: the web UI shows the setup page on the token URL). */
async function configured() {
  return !!(await account());
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// Wrong usernames take as long as wrong passwords, so the response time does not tell which one was wrong.
let dummyHash = null;

/** The account for a username/password pair, or null. */
async function login(user, password) {
  const acc = await account();
  if (!acc || typeof user !== 'string' || typeof password !== 'string') return null;
  if (!sameText(user, acc.user)) {
    dummyHash = dummyHash || (await hashPassword('x'));
    await checkPassword(password, dummyHash);
    return null;
  }
  return (await checkPassword(password, acc.hash)) ? acc : null;
}

function validate(user, password) {
  if (typeof user !== 'string' || !USER_RE.test(user)) return 'Username: 1-64 characters, no spaces or colons';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Password: at least ${MIN_PASSWORD} characters`;
  if (password.length > 1024) return 'Password: at most 1024 characters';
  return null;
}

/** Creates or replaces the stored account. Errors carry a status for the HTTP answer. */
async function setAccount(user, password) {
  if (fromEnv()) throw Object.assign(new Error('The login is set with UI_USER/UI_PASSWORD; change it there'), { status: 409 });
  const bad = validate(user, password);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  const s = load();
  s.user = user;
  s.hash = await hashPassword(password);
  save();
  return { user: s.user, hash: s.hash };
}

// ---- session cookies: "<expires>.<signature>" ----
const sign = (acc, expires) =>
  crypto.createHmac('sha256', load().secret).update(`${expires}\0${acc.user}\0${acc.hash}`).digest('base64url');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(req, value, maxAgeMs) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Logs `acc` in on this browser. */
function startSession(req, res, acc) {
  const expires = Date.now() + SESSION_MS;
  res.append('Set-Cookie', cookie(req, `${expires}.${sign(acc, expires)}`, SESSION_MS));
}

function endSession(req, res) {
  res.append('Set-Cookie', cookie(req, '', 0));
}

/** The logged-in username, or null. Renews a cookie that is more than a day old. */
async function sessionUser(req, res) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const [exp, sig] = raw.split('.');
  const expires = Number(exp);
  if (!sig || !Number.isSafeInteger(expires) || expires < Date.now()) return null;
  const acc = await account();
  if (!acc) return null;
  const want = Buffer.from(sign(acc, expires));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (res && expires - Date.now() < SESSION_MS - RENEW_AFTER_MS) startSession(req, res, acc);
  return acc.user;
}

/** For tests: forget the cached file state (after deleting auth.json, say). */
function reset() {
  state = null;
  envAccount = null;
}

module.exports = { configured, login, setAccount, validate, startSession, endSession, sessionUser, fromEnv, reset, MIN_PASSWORD };
