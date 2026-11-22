'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { createTurnIndex } = require('../service/turn-index');
const { describeRecord } = require('../service/speaker-display');

function record(reply = 'Tamam.') {
  return { english: 'Jason: Take the back road.\nMeet me outside.\nLucia: All right.',
    translation: 'Jason: Arka yoldan git.\nDışarıda buluşalım.\nLucia: ' + reply,
    speaker_labels: [{ source: 'Jason', turkish: 'Jason' }, { source: 'Lucia', turkish: 'Lucia' }] };
}
function index(records, overrides = {}) {
  return createTurnIndex({ speaker_metadata: { version: 1, records } }, {
    exactDetails(text) { const row = Object.values(records).find(row => row.english === text);
      return row ? { translation: describeRecord(row).body } : null; },
    blocked: () => false, ...overrides
  });
}

test('only complete reviewed turns are indexed with aligned translation and source speaker', () => {
  const turns = index({ a: record() });
  const result = turns.match('Jason: Take the back road.\nMeet me outside.');
  assert.equal(result.translation, 'Arka yoldan git.\nDışarıda buluşalım.');
  assert.equal(result.speakers[0].name, 'Jason');
  assert.equal(turns.match('Take the back road.'), null, 'A wrapped half-turn is not translated');
  assert.equal(turns.match('Lucia: All right.').translation, 'Tamam.');
  assert.equal(turns.match('All right.').translation, 'Tamam.');
});

test('conflicting source meanings, blocked keys and changed dictionary resolutions stay unresolved', () => {
  const variant = record('Pekâlâ.');
  variant.english = variant.english.replace('Take the back road.', 'Use the bridge.');
  const turns = index({ a: record(), b: variant });
  assert.equal(turns.match('All right.'), null);
  assert.equal(index({ a: record() }, { blocked: () => true }).match('All right.'), null);
  assert.equal(index({ a: record() }, { exactDetails: () => ({ translation: 'Başka bir karar.' }) }).match('All right.'), null);
});

test('uncertain speaker alignment and legacy packs cannot invent a turn mapping', () => {
  const row = record(); row.speaker_labels[1].source = 'Unknown';
  assert.equal(index({ a: row }).match('All right.'), null);
  assert.equal(createTurnIndex({}, { blocked: () => false }).match('All right.'), null);
});

test('the webOS Node 8 string API can build the reviewed turn index', () => {
  const child = spawnSync(process.execPath, ['-e', `
    String.prototype.trimEnd = undefined;
    const assert = require('assert');
    const { createTurnIndex } = require(${JSON.stringify(require.resolve('../service/turn-index'))});
    const { describeRecord } = require(${JSON.stringify(require.resolve('../service/speaker-display'))});
    const row = ${JSON.stringify(record())};
    const index = createTurnIndex({speaker_metadata:{version:1,records:{a:row}}}, {
      exactDetails: () => ({translation:describeRecord(row).body}), blocked: () => false
    });
    assert.strictEqual(index.match('Lucia: All right.').translation, 'Tamam.');
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
