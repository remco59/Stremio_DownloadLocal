// Release-name parsing shared by all torrent sources: resolution, size, languages, season packs.

const RES = { '2160p': 2160, '4k': 2160, uhd: 2160, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480 };
function resolution(text) {
  const m = /\b(2160p|4k|uhd|1080p|720p|576p|480p)\b/i.exec(text);
  return m ? RES[m[1].toLowerCase()] : 0;
}

/** "1.4 GB" / "700 MB" -> bytes, or null */
function parseSize(text) {
  const m = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|TiB|GiB|MiB|KiB)\b/i.exec(text);
  if (!m) return null;
  const mult = { k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 }[m[2][0].toLowerCase()];
  return Math.round(parseFloat(m[1].replace(',', '.')) * mult);
}

// Language tags in release names and Torrentio's flag emoji, as short codes.
const WORDS = [
  [/\b(dutch|nl|nlsubs?|vlaams|flemish)\b/i, 'nl'],
  [/\b(english|eng)\b/i, 'en'],
  [/\b(german|ger|deutsch)\b/i, 'de'],
  [/\b(french|truefrench|vostfr|vff|vf)\b/i, 'fr'],
  [/\b(spanish|esp|castellano|latino)\b/i, 'es'],
  [/\b(italian|ita)\b/i, 'it'],
  [/\b(portuguese|por|dublado)\b/i, 'pt'],
  [/\b(russian|rus)\b/i, 'ru'],
  [/\b(polish|pol|pl)\b/i, 'pl'],
  [/\b(multi|dual|dual[\s.-]?audio)\b/i, 'multi'],
];
const FLAGS = {
  '🇬🇧': 'en', '🇺🇸': 'en', '🇳🇱': 'nl', '🇧🇪': 'nl', '🇩🇪': 'de', '🇫🇷': 'fr', '🇪🇸': 'es', '🇲🇽': 'es',
  '🇮🇹': 'it', '🇵🇹': 'pt', '🇧🇷': 'pt', '🇷🇺': 'ru', '🇵🇱': 'pl', '🇯🇵': 'ja', '🇰🇷': 'ko', '🇨🇳': 'zh',
  '🇸🇪': 'sv', '🇳🇴': 'no', '🇩🇰': 'da', '🇫🇮': 'fi', '🇹🇷': 'tr', '🇮🇳': 'hi', '🌐': 'multi',
};
function languages(text) {
  // Separators in release names (dots, dashes, underscores) count as word boundaries.
  const t = text.replace(/[._\-[\]()]/g, ' ');
  const out = new Set(WORDS.filter(([re]) => re.test(t)).map(([, code]) => code));
  for (const [flag, code] of Object.entries(FLAGS)) if (text.includes(flag)) out.add(code);
  return [...out];
}

// Season packs: "S01" / "Season 1" / "Complete" without a single-episode marker like "S01E02".
const isPack = (t) => /\b(s\d{1,2}(?!\s*e\d)|season\s*\d+|complete)\b/i.test(t) && !/\bs\d{1,2}\s*e\d{1,3}\b/i.test(t);

function magnetFor(infoHash, title, trackers = []) {
  return (
    `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` +
    trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  );
}

module.exports = { resolution, parseSize, languages, isPack, magnetFor };
