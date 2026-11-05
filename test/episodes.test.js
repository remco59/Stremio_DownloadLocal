// Telling episodes apart by the title in a file name.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.ADDON_TOKEN = 'test-token-0123456789';
process.env.DATA_DIR = path.join(os.tmpdir(), `stremio-addon-unit-${process.pid}`);

const { fromMeta, titleMatch } = require('../episodes');

// Cinemeta's Dragons: Race to the Edge in seasons of 13; the packs below count 26 per season.
const eps = fromMeta({
  name: 'Dragons: Riders of Berk',
  videos: [
    { season: 3, episode: 1, name: 'Dragon Eye of the Beholder (1)' },
    { season: 3, episode: 2, name: 'Dragon Eye of the Beholder (2)' },
    { season: 4, episode: 1, name: 'Team Astrid' },
    { season: 4, episode: 2, name: 'Night of the Hunters (1)' },
    { season: 4, episode: 3, name: 'Night of the Hunters (2)' },
    { season: 5, episode: 1, name: 'Enemy of My Enemy' },
    { season: 5, episode: 2, name: 'Crash Course' },
    { season: 6, episode: 5, name: 'Episode 5' },
    { season: 7, episode: 1, name: 'Snow Way' },
    { season: 7, episode: 2, name: 'Snow Way Out' },
  ],
});

test('a title of another episode beats a matching season/episode code', () => {
  assert.equal(titleMatch(eps, 'Pack/[S04E02] Crash Course.mkv', 4, 2), 'other');
  assert.equal(titleMatch(eps, '[S04E01] Enemy of My Enemy.mkv', 4, 1), 'other');
  assert.equal(titleMatch(eps, '[S03E14] Team Astrid.mkv', 4, 1), 'own');
  assert.equal(titleMatch(eps, 'Dreamworks.Dragons.S05E01.Enemy.of.my.enemy.1080p.WEBRip.mkv', 5, 1), 'own');
});

test('two-parters are told apart by their part number', () => {
  assert.equal(titleMatch(eps, '[S03E15] Night of the Hunters - Part 1.mkv', 4, 2), 'own');
  assert.equal(titleMatch(eps, '[S03E16] Night of the Hunters - Part 2.mkv', 4, 2), 'other');
  assert.equal(titleMatch(eps, 'Dragons.S03E02.Dragon.Eye.of.the.Beholder.Pt2.mkv', 3, 2), 'own');
  // No part in the name: either half could be meant.
  assert.equal(titleMatch(eps, 'Night.of.the.Hunters.mkv', 4, 2), null);
});

test('the longest title wins; no title or no titles means no verdict', () => {
  assert.equal(titleMatch(eps, 'Dragons.S07E02.Snow.Way.Out.mkv', 7, 2), 'own');
  assert.equal(titleMatch(eps, 'Dragons.S07E02.Snow.Way.Out.mkv', 7, 1), 'other');
  assert.equal(titleMatch(eps, 'Dragons.S06E05.1080p.mkv', 6, 5), null, '"Episode 5" is not a title');
  assert.equal(titleMatch(eps, 'Dragons.Riders.of.Berk.S01E01.mkv', 1, 1), null, 'the show name is not a title');
  assert.equal(titleMatch(null, '[S04E02] Crash Course.mkv', 4, 2), null);
});
