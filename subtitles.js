// Subtitles for the web player: subtitle files that came with the torrent (sidecars), conversion to WebVTT,
// language codes, and online subtitles from a Stremio subtitles add-on (OpenSubtitles v3 by default).
const path = require('path');
const cfg = require('./config');

const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts)$/i;
const SUBS_DIR = /^(subs?|subtitles?)$/i;
const EPISODE = /(?:^|[^a-z0-9])s(\d{1,3})[ ._-]?e(\d{1,4})(?![0-9])/i;
const stem = (name) => path.posix.basename(name).replace(/\.[^.]+$/, '');

/**
 * Does subtitle file `sub` belong to video `video`? Both are paths relative to the torrent root (or any common
 * root), '/'-separated; `videos` are all video files of the torrent, to tell episodes of a season pack apart.
 * Accepted: same folder or a Subs/ folder next to the video, and either named after the video
 * ("Movie.2019.en.srt"), in a folder named after it ("Subs/Movie.2019/2_English.srt"), or with no other video
 * in that folder it could belong to (`loose`; off where unrelated downloads sit side by side).
 */
function belongsTo(video, sub, videos = [video], { loose = true } = {}) {
  if (!SUB_EXT.test(sub)) return false;
  const dir = path.posix.dirname(video);
  const prefix = dir === '.' ? '' : dir + '/';
  if (!sub.startsWith(prefix)) return false;
  const parts = sub.slice(prefix.length).split('/');
  const own = stem(video).toLowerCase();
  const base = parts[parts.length - 1].toLowerCase();
  if (parts.length > 3 || (parts.length > 1 && !SUBS_DIR.test(parts[0]))) return false;
  if (parts.length === 3 && parts[1].toLowerCase() !== own) return false;
  if (parts.length === 3 || base.startsWith(own)) return true;
  if (!loose) return false;
  const others = videos.filter((v) => v !== video && path.posix.dirname(v) === dir && !/sample/i.test(v));
  if (others.some((v) => base.startsWith(stem(v).toLowerCase()))) return false;
  const ep = EPISODE.exec(own);
  const subEp = EPISODE.exec(base);
  if (subEp) return !!ep && +ep[1] === +subEp[1] && +ep[2] === +subEp[2];
  return others.length === 0;
}

/** Indexes of the subtitle files in a torrent's file list that belong to file `idx`. */
function sidecarIndexes(files, idx) {
  const names = files.map((f) => String(f.name).replace(/\\/g, '/'));
  const videos = names.filter((n) => VIDEO_EXT.test(n));
  const out = [];
  names.forEach((n, i) => {
    if (i !== idx && out.length < 30 && belongsTo(names[idx], n, videos)) out.push(i);
  });
  return out;
}

// ISO 639-2 (bibliographic and terminology codes) and English/native names -> ISO 639-1.
const LANGS = {
  en: 'eng english', nl: 'dut nld dutch nederlands flemish vlaams', de: 'ger deu german deutsch', fr: 'fre fra french francais français',
  es: 'spa spanish espanol español castellano', it: 'ita italian italiano', pt: 'por portuguese portugues português',
  'pt-BR': 'pob pb brazilian', ru: 'rus russian', pl: 'pol polish polski', cs: 'cze ces czech', sk: 'slo slk slovak',
  sv: 'swe swedish svenska', no: 'nor nob nno norwegian norsk', da: 'dan danish dansk', fi: 'fin finnish suomi',
  hu: 'hun hungarian magyar', ro: 'rum ron romanian', el: 'gre ell greek', tr: 'tur turkish turkce', ar: 'ara arabic',
  he: 'heb hebrew', zh: 'chi zho chinese', ja: 'jpn japanese', ko: 'kor korean', hi: 'hin hindi', th: 'tha thai',
  vi: 'vie vietnamese', id: 'ind indonesian', ms: 'may msa malay', uk: 'ukr ukrainian', bg: 'bul bulgarian',
  hr: 'hrv croatian', sr: 'srp scc serbian', sl: 'slv slovenian', et: 'est estonian', lv: 'lav latvian',
  lt: 'lit lithuanian', is: 'ice isl icelandic', fa: 'per fas persian farsi', ca: 'cat catalan', eu: 'baq eus basque',
  gl: 'glg galician', bn: 'ben bengali', ta: 'tam tamil', te: 'tel telugu', ml: 'mal malayalam', ur: 'urd urdu',
  bs: 'bos bosnian', mk: 'mac mkd macedonian', sq: 'alb sqi albanian',
};
const LANG_OF = new Map();
for (const [code, words] of Object.entries(LANGS)) {
  LANG_OF.set(code.toLowerCase(), code);
  for (const w of words.split(' ')) LANG_OF.set(w, code);
}

/** A language code or name as found in files and add-ons ("eng", "dut", "English", "pt-br") -> "en", "nl", "pt-BR"; '' if unknown. */
function normLang(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v || v === 'und') return '';
  return LANG_OF.get(v) || '';
}

/** Language and a short label from a subtitle file name: "Subs/2_English.srt" -> { lang: 'en', label: '2_English' }. */
function describeFile(rel, video) {
  const own = stem(video).toLowerCase();
  let label = stem(rel);
  if (label.toLowerCase().startsWith(own)) label = label.slice(own.length);
  label = label.replace(/^[ ._-]+/, '');
  const words = label.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  const lang = words.map(normLang).find(Boolean) || '';
  return { lang, label, forced: words.includes('forced'), sdh: words.includes('sdh') || words.includes('hi') };
}

/** Subtitle file bytes as text: UTF-8 (with or without BOM, or UTF-16 with BOM), else Windows-1252. */
function decodeText(buf) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf.subarray(2));
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be').decode(buf.subarray(2));
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
    } catch {
      text = new TextDecoder('windows-1252').decode(buf);
    }
  }
  return text.replace(/\0/g, ''); // a file the torrent client only partly wrote
}

/** SubRip to WebVTT (WebVTT is passed through). */
function srtToVtt(text) {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(t)) return t;
  const body = t
    .replace(/(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})/g, (m, a, am, b, bm) =>
      `${a.padStart(8, '0')}.${am.padEnd(3, '0')} --> ${b.padStart(8, '0')}.${bm.padEnd(3, '0')}`)
    .replace(/\{\\[^}]*\}/g, '') // ASS-style override tags some SRT files carry, e.g. {\an8}
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3} -->)/gm, '');
  return 'WEBVTT\n\n' + body.trim() + '\n';
}

// ---- online subtitles ------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onlineCache = new Map(); // `${type}/${id}` -> { at, list }
const ONLINE_TTL = 30 * 60000;

/** GET JSON with a retry on error pages (the add-ons sit behind Cloudflare, which times out on new queries). */
async function fetchJson(url, pauses = [2000, 4000]) {
  let error;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      if (r.ok) return JSON.parse(text);
      error = new Error(`HTTP ${r.status}`);
    } catch (e) {
      error = e.name === 'TimeoutError' ? new Error('no answer in time') : e;
    }
    if (attempt >= pauses.length || (r && r.status < 500)) throw error;
    await sleep(pauses[attempt]);
  }
}

/** Online subtitles for a title: [{ key, lang, label, url }], best known languages first. [] when switched off. */
async function online(type, id) {
  if (!cfg.subtitlesUrl) return [];
  const k = `${cfg.subtitlesUrl}|${type}/${id}`;
  const hit = onlineCache.get(k);
  if (hit && Date.now() - hit.at < ONLINE_TTL) return hit.list;
  const data = await fetchJson(`${cfg.subtitlesUrl}/subtitles/${type}/${encodeURIComponent(id)}.json`);
  const seen = new Set();
  const list = (Array.isArray(data && data.subtitles) ? data.subtitles : [])
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
    .map((s, i) => ({
      key: 'o' + (String(s.id || i).replace(/[^A-Za-z0-9_-]/g, '') || i),
      lang: normLang(s.lang) || String(s.lang || '').slice(0, 12),
      label: String(s.subtitleFileName || s.movieReleaseName || '').slice(0, 120),
      url: s.url,
    }))
    .filter((s) => !seen.has(s.key) && seen.add(s.key))
    .slice(0, 200);
  onlineCache.set(k, { at: Date.now(), list });
  return list;
}

/** One online subtitle as WebVTT text. */
async function onlineVtt(type, id, key) {
  const s = (await online(type, id)).find((x) => x.key === key);
  if (!s) throw Object.assign(new Error('unknown subtitle'), { status: 404 });
  const r = await fetch(s.url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`subtitle download failed (HTTP ${r.status})`), { status: 502 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 10 * 2 ** 20) throw Object.assign(new Error('subtitle file too large'), { status: 502 });
  return srtToVtt(decodeText(buf));
}

module.exports = { belongsTo, sidecarIndexes, normLang, describeFile, decodeText, srtToVtt, online, onlineVtt, SUB_EXT, VIDEO_EXT };
