// Release-name parsing and Torznab feed parsing.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.ADDON_TOKEN = 'test-token-0123456789';
process.env.DATA_DIR = path.join(os.tmpdir(), `stremio-addon-unit-${process.pid}`);

const p = require('../sources/parse');
const { parseFeed } = require('../sources/torznab');
const { isEpisode } = require('../downloads');
const { torznabXml } = require('./helpers/model');

test('resolution', () => {
  assert.equal(p.resolution('Movie.2010.2160p.UHD'), 2160);
  assert.equal(p.resolution('Movie 4K HDR'), 2160);
  assert.equal(p.resolution('Movie.1080p.WEB'), 1080);
  assert.equal(p.resolution('Movie.720p'), 720);
  assert.equal(p.resolution('Movie.DVDRip'), 0);
});

test('size', () => {
  assert.equal(p.parseSize('👤 5 💾 1.5 GB ⚙️ x'), 1.5 * 2 ** 30);
  assert.equal(p.parseSize('700 MB'), 700 * 2 ** 20);
  assert.equal(p.parseSize('2,5 GiB'), 2.5 * 2 ** 30);
  assert.equal(p.parseSize('no size'), null);
});

test('languages from words and flags', () => {
  assert.deepEqual(p.languages('Movie.2010.1080p.NL.Subs').sort(), ['nl']);
  assert.deepEqual(p.languages('Movie.2010.MULTi.1080p').sort(), ['multi']);
  assert.deepEqual(p.languages('Movie 2010 iTA ENG').sort(), ['en', 'it']);
  assert.deepEqual(p.languages('Movie\n🇳🇱 / 🇬🇧').sort(), ['en', 'nl']);
  assert.deepEqual(p.languages('Nightcrawler.2014.1080p'), [], 'no false positive inside words');
});

test('episode file matching inside season packs', () => {
  assert.equal(isEpisode('Show.S01/Show.S01E02.1080p.mkv', '1', '2'), true);
  assert.equal(isEpisode('show.s1e2.mkv', '1', '2'), true);
  assert.equal(isEpisode('Show 1x02.mkv', '1', '2'), true);
  assert.equal(isEpisode('Show.S01E12.mkv', '1', '2'), false);
  assert.equal(isEpisode('Show.S01E20.mkv', '1', '2'), false);
  assert.equal(isEpisode('Show.S11E02.mkv', '1', '2'), false);
});

test('Torznab feed: items, attrs, entities, CDATA', () => {
  const xml = torznabXml([{ title: 'A & B <1080p>', hash: 'a'.repeat(40), size: 123, seeders: 7 }])
    .replace('<title>A &amp; B &lt;1080p></title>', '<title><![CDATA[A & B <1080p>]]></title>');
  const { items, error } = parseFeed(xml);
  assert.equal(error, null);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'A & B <1080p>');
  assert.equal(items[0].size, '123');
  assert.equal(items[0].attrs.seeders, '7');
  assert.equal(items[0].attrs.infohash, 'a'.repeat(40));
  assert.match(items[0].attrs.magneturl, /^magnet:\?xt=urn:btih:a{40}&dn=A%20%26%20B/);
});

test('Torznab error responses', () => {
  assert.equal(parseFeed('<error code="100" description="Incorrect user credentials"/>').error, 'Incorrect user credentials');
});
