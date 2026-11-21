'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { canonical, createMatcher, key } = require('../service/matcher');
const { createPackStore } = require('../service/pack');
const { createLookup } = require('../service/lookup');
const { createSubtitleFeed } = require('../service/translation');
const root = path.resolve(__dirname, '../..');
const mergedFile = process.env.MERGED_PACK || path.join(root, 'dist/merged/subtitle.json.gz');
const review = path.join(root, 'translations/merge-review');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const unpack = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const pack = unpack(mergedFile);
const old = unpack(path.join(review, 'legacy-subtitle.json.gz'));
const matcher = createMatcher(pack);
const conflicts = read(path.join(review, 'merge-conflicts.json'));
const conflictKeys = new Set(conflicts.map(row => row.key));
const lookup = createLookup(pack);
const table = Object.fromEntries(lookup.keys.map(hash => [hash, lookup.get(hash)]));

function body(row) {
  const names = new Set(row.speaker_labels.flatMap(label => [label.source, label.turkish]));
  return row.translation.split('\n').map(line => {
    for (const name of names) if (line.startsWith(name + ':')) return line.slice(name.length + 1).trimStart();
    return line;
  }).join('\n');
}

test('every different common pair has one explicit reviewed decision', function () {
  const all = read(path.join(review, 'review-units.json'));
  const decisions = [1, 2, 3].flatMap(i => read(path.join(review, `review-decisions-${i}.json`)).decisions);
  assert.equal(decisions.length, all.length);
  assert.equal(new Set(decisions.map(row => row.id)).size, all.length);
  assert.deepEqual(new Set(decisions.map(row => row.id)), new Set(all.map(row => row.id)));
  for (const decision of decisions) assert.ok(['old', 'new'].includes(decision.choice));
  const covered = new Set(all.flatMap(unit => unit.occurrences.flatMap(row => row.hashes)));
  for (const row of read(path.join(review, 'identical.json'))) for (const hash of row.hashes) covered.add(hash);
  const oldKeys = new Set([...Object.keys(old.entries), ...Object.keys(old.segments)]);
  const shared = new Set();
  for (let part = 1; part <= 9; part++) {
    const source = unpack(path.join(root, `translations/part-${String(part).padStart(2, '0')}/subtitle.json.gz`));
    for (const hash of [...Object.keys(source.entries), ...Object.keys(source.segments)]) {
      if (oldKeys.has(hash)) { assert.ok(covered.has(hash), hash); shared.add(hash); }
    }
  }
  assert.equal(shared.size, 7208);
});

test('repeated scenes and global synonym resolutions have complete independent audits', function () {
  const input = read(path.join(review, 'repeated-context-input.json'));
  const repeated = read(path.join(review, 'repeated-context-decisions.json'));
  assert.equal(repeated.reviewed_groups, input.length);
  assert.equal(repeated.reviewed_occurrences, input.reduce((sum, row) => sum + row.occurrences.length, 0));
  assert.deepEqual(new Set(repeated.decisions.map(row => row.id)), new Set(input.map(row => row.id)));
  assert.equal(repeated.decisions.length, input.length);
  const collisions = read(path.join(review, 'collision-review-input.json'));
  const byId = new Map(collisions.map(row => [row.id, row]));
  const reviews = [1, 2].map(i => read(path.join(review, `collision-decisions-${i}.json`)).decisions);
  for (const rows of reviews) {
    assert.equal(rows.length, collisions.length);
    assert.deepEqual(new Set(rows.map(row => row.id)), new Set(byId.keys()));
  }
  const indexed = reviews.map(rows => new Map(rows.map(row => [row.id, row])));
  const resolutions = read(path.join(review, 'collision-resolutions.json'));
  for (const [hash, row] of Object.entries(resolutions)) {
    const source = byId.get(row.id);
    assert.equal(source.key, hash);
    assert.equal(indexed[0].get(row.id).safe, true);
    assert.equal(indexed[1].get(row.id).safe, true);
    assert.ok(source.variants.some(variant => variant.tr === row.translation));
    assert.deepEqual(new Set(row.expected_values), new Set(source.variants.map(variant => canonical(variant.tr))));
  }
});

test('all 25,637 source records and every colour occurrence survive verbatim', function () {
  let records = 0;
  let occurrences = 0;
  for (let part = 1; part <= 9; part++) {
    const rows = read(path.join(root, `translations/part-${String(part).padStart(2, '0')}/dialogues.json`)).entries;
    for (const row of rows) {
      const copy = pack.speaker_metadata.records[`${part}:${row.id}`];
      assert.equal(copy.english, row.english);
      assert.equal(copy.source_frame, row.source_frame);
      assert.deepEqual(copy.speaker_labels, row.speaker_labels);
      occurrences += row.speaker_labels.reduce((sum, label) => sum + (label.color_occurrences || []).length, 0);
      records++;
    }
  }
  assert.equal(records, 25637);
  assert.equal(occurrences, 26624);
  const cops = pack.speaker_metadata.records['9:s09-10554500'].speaker_labels[0].color_occurrences;
  assert.deepEqual(cops.map(row => row.name_tr), ['Açık yeşil', 'Mor / lila']);
});

test('every emitted source key matches its selected translation in the real matcher', function () {
  for (const [hash, refs] of Object.entries(pack.speaker_metadata.keys)) {
    assert.ok(refs.length);
    const resolution = pack.speaker_metadata.equivalent_keys[hash];
    for (const ref of refs) {
      const expected = resolution || body(pack.speaker_metadata.records[ref]);
      assert.equal(canonical(table[hash]), canonical(expected), ref);
    }
  }
  let tested = 0;
  for (const [ref, row] of Object.entries(pack.speaker_metadata.records)) {
    const full = key(canonical(row.english));
    if (pack.speaker_metadata.keys[full]) {
      assert.equal(canonical(matcher.exact(row.english)), canonical(pack.speaker_metadata.equivalent_keys[full] || body(row)), ref);
      tested++;
    }
  }
  assert.ok(tested > 15000);
});

test('legacy-only entries and segments retain their translation and fuzzy signature', function () {
  let retained = 0;
  for (const [hash, value] of Object.entries({ ...old.segments, ...old.entries })) {
    if (pack.speaker_metadata.keys[hash] || conflictKeys.has(hash)) continue;
    assert.equal(table[hash], value, hash);
    retained++;
  }
  assert.ok(retained > 100000);
  assert.equal(pack.fuzzy.count, Object.keys(table).length);
  assert.equal(Buffer.from(pack.fuzzy.mask, 'base64').length, Math.ceil(pack.fuzzy.count / 8));
  function signatures(source) {
    const keys = createLookup(source).keys.slice().sort();
    const mask = Buffer.from(source.fuzzy.mask, 'base64');
    const lengths = Buffer.from(source.fuzzy.lengths, 'base64');
    const blooms = Buffer.from(source.fuzzy.blooms, 'base64');
    let row = 0, offset = 0;
    const result = new Map();
    keys.forEach((hash, i) => {
      if (!(mask[i >> 3] & (1 << (i & 7)))) return;
      const length = lengths[row++];
      const bytes = length * 3 <= 64 ? 8 : length * 3 <= 128 ? 16 : 32;
      result.set(hash, { length, bits: blooms.subarray(offset, offset + bytes) });
      offset += bytes;
    });
    assert.equal(row, lengths.length);
    assert.equal(offset, blooms.length);
    return result;
  }
  const original = signatures(old), merged = signatures(pack);
  for (const [hash, sig] of original) {
    if (conflictKeys.has(hash)) continue;
    assert.deepEqual(merged.get(hash), sig, hash);
  }
});

test('the rebuilt fuzzy index searches new source text with the existing similarity engine', function () {
  const samples = Object.values(pack.speaker_metadata.records).filter(row => row.english.length > 100 &&
    pack.speaker_metadata.keys[key(canonical(row.english))]).slice(0, 40);
  let matched = 0;
  for (const row of samples) {
    const found = matcher.similar(row.english, 95);
    if (found && canonical(found.translation) === canonical(body(row))) matched++;
  }
  assert.ok(matched >= 30, `Only ${matched}/${samples.length} unambiguous long captions found`);
});

test('ambiguous known keys cannot be revived through the legacy table or OCR repair', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-pack-test-'));
  const store = createPackStore(dir, mergedFile);
  await store.load();
  for (const conflict of conflicts) {
    assert.equal(table[conflict.key], undefined);
    assert.equal(store.match(conflict.english_key, 100, 100), null);
  }
  // Contextual selections and an ordinary OCR confusion still use the same pipeline.
  assert.equal(store.match('Security Guard: Miss...', 100, 100).translation, 'Hanımefendi...');
  const row = Object.values(pack.speaker_metadata.records).find(row =>
    row.english.includes('Vice City') && canonical(row.english).length > 45 && pack.speaker_metadata.keys[key(canonical(row.english))]);
  assert.ok(row);
  const typo = row.english.replace('Vice', 'V1ce');
  const repaired = store.match(typo, 100, 90);
  assert.ok(repaired);
  assert.equal(canonical(repaired.translation), canonical(body(row)));
  assert.equal(repaired.approximate, true);
});

test('a cached pre-merge pack cannot shadow the new bundled dictionary', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-cache-test-'));
  fs.copyFileSync(path.join(review, 'legacy-subtitle.json.gz'), path.join(dir, 'gta-6.json.gz'));
  const store = createPackStore(dir, mergedFile);
  await store.load();
  assert.equal(store.match('Security Guard: Miss...', 100, 100).translation, 'Hanımefendi...');
  assert.equal(store.match('Lorena: I will.', 100, 100).translation, 'Öperim.');
});

test('legacy packs still load and a broken cache falls back to the bundled merged pack', async function () {
  const legacyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pack-test-'));
  const legacyFile = path.join(review, 'legacy-subtitle.json.gz');
  const legacyStore = createPackStore(legacyDirectory, legacyFile);
  await legacyStore.load();
  assert.equal(legacyStore.match('Lorena: I will.', 100, 100).translation, createMatcher(old).exact('Lorena: I will.'));
  const brokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-cache-test-'));
  fs.writeFileSync(path.join(brokenDirectory, 'gta-6.json.gz'), 'incomplete download');
  const store = createPackStore(brokenDirectory, mergedFile);
  await store.load();
  assert.equal(store.match('Lorena: I will.', 100, 100).translation, 'Öperim.');
});

test('pack-first feed displays local text without issuing an API request', function () {
  const displayed = [];
  const feed = createSubtitleFeed({ mode: 'pack', provider: 'gemini', similarity: 95, keys: { gemini: '', openai: '' } },
    text => matcher.exact(text), text => displayed.push(text), error => assert.fail(error));
  feed.read('Security Guard: Miss...', 100);
  assert.deepEqual(displayed, ['Hanımefendi...']);
  feed.reset();
});
