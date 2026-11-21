'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { createLookup } = require('../service/lookup');
const { createMatcher, canonical, key } = require('../service/matcher');
const { createPackStore } = require('../service/pack');
const root = path.resolve(__dirname, '../..');
const baselineDir = path.join(root, 'translations/key-dedup/baseline');
const baselineFile = path.join(baselineDir, 'subtitle.json.gz');
const candidateFile = process.env.MERGED_PACK || path.join(root, 'dist/merged/subtitle.json.gz');
const unpack = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const original = unpack(baselineFile), candidate = unpack(candidateFile);
const oldTable = { ...original.segments, ...original.entries };
const newTable = { ...candidate.segments, ...candidate.entries };
const lookup = createLookup(candidate);
const oldCode = require(path.join(baselineDir, 'pack.js'));
const oldMatcher = require(path.join(baselineDir, 'matcher.js'));
const before = oldCode.createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-before-')), baselineFile);
const after = createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-after-')), candidateFile);
const loaded = Promise.all([before.load(), after.load()]);

test('the independent reference really is the untouched pre-dedup code and dictionary', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(baselineDir, 'manifest.json'), 'utf8'));
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(sha(baselineFile), manifest.sha256);
  for (const [file, expected] of Object.entries(manifest.files)) assert.equal(sha(path.join(baselineDir, file)), expected);
  assert.equal(original.key_compaction, undefined);
  assert.equal(manifest.keys, Object.keys(oldTable).length);
});

test('only redundant values disappear; every historical lookup key still returns the exact same translation', function () {
  assert.equal(Object.keys(oldTable).length, 156118);
  assert.equal(original.format, 2);
  assert.equal(candidate.format, 3);
  assert.equal(Object.keys(newTable).length, 132496);
  assert.equal(lookup.compacted, 23622);
  assert.deepEqual(new Set(lookup.keys), new Set(Object.keys(oldTable)));
  for (const [hash, value] of Object.entries(oldTable)) assert.equal(lookup.get(hash), value, hash);
  const removed = JSON.parse(fs.readFileSync(path.join(root, 'translations/key-dedup/compacted-keys.json'), 'utf8'));
  assert.equal(Object.keys(removed).length, lookup.compacted);
  for (const [named, plain] of Object.entries(removed)) {
    assert.equal(newTable[named], undefined);
    assert.equal(newTable[plain], oldTable[named]);
    assert.notEqual(named, plain);
  }
});

test('speaker names, colours, source records, ambiguity rules and all fuzzy bytes stay unchanged', function () {
  assert.deepEqual(candidate.speaker_metadata, original.speaker_metadata);
  assert.deepEqual(candidate.blocked_keys, original.blocked_keys);
  assert.deepEqual(candidate.fuzzy, original.fuzzy);
});

test('all 25,637 original captions keep their complete match including speaker colours, also without colons or line breaks', async function (t) {
  await loaded;
  let queries = 0;
  for (const row of Object.values(original.speaker_metadata.records)) {
    const variants = new Set([row.english, row.english.replace(/:/g, ''), row.english.replace(/\n/g, ' '),
      row.english.replace(/^[\wÀ-ž][\wÀ-ž .'’\-]{0,23}:\s+/, '')]);
    for (const text of variants) {
      assert.deepEqual(after.match(text, 100, 100), before.match(text, 100, 100), text);
      queries++;
    }
  }
  assert.ok(queries > 70000);
  t.diagnostic(`dedup_caption_probes=${queries}`);
});

test('OCR mistakes and fuzzy scores agree with the frozen original engine at multiple thresholds', async function (t) {
  await loaded;
  const long = Object.values(original.speaker_metadata.records).filter(row => row.english.length >= 70 && row.english.length <= 330);
  let queries = 0;
  const step = Math.max(1, Math.floor(long.length / 120));
  for (let i = 0; i < long.length && queries < 720; i += step) {
    const text = long[i].english;
    const start = text.indexOf(':') + 2;
    const at = Math.max(start, Math.floor(text.length * 0.6));
    const mutations = [text.slice(0, at) + 'q' + text.slice(at + 1), text.replace(/i/, '1')];
    for (const value of mutations) {
      for (const minimum of [85, 95, 100]) {
        assert.deepEqual(after.match(value, 100, minimum), before.match(value, 100, minimum), `${minimum}: ${value}`);
        queries++;
      }
    }
  }
  assert.equal(queries, 720);
  t.diagnostic(`dedup_noisy_probes=${queries}`);
  const old = oldMatcher.createMatcher(original), next = createMatcher(candidate);
  for (let i = 0; i < long.length; i += 251) {
    assert.deepEqual(next.similar(long[i].english, 90), old.similar(long[i].english, 90));
  }
});

test('an older cache cannot hide the current compacted bundled pack', async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-upgrade-'));
  fs.copyFileSync(baselineFile, path.join(directory, 'gta-6.json.gz'));
  const store = createPackStore(directory, candidateFile);
  const installed = await store.load();
  assert.equal(installed.mergeVersion, candidate.merge_info.version);
  assert.deepEqual(store.match('Security Guard: Miss...', 100, 100), after.match('Security Guard: Miss...', 100, 100));
});

test('older applications safely retain their bundled dictionary instead of misreading the new layout', async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-old-reader-'));
  fs.copyFileSync(candidateFile, path.join(directory, 'gta-6.json.gz'));
  const store = oldCode.createPackStore(directory, baselineFile);
  const installed = await store.load();
  assert.equal(installed.mergeVersion, 1);
  assert.deepEqual(store.match('Security Guard: Miss...', 100, 100), before.match('Security Guard: Miss...', 100, 100));
});

test('malformed compaction metadata fails closed and a broken cache falls back safely', async function () {
  const english = 'Jason: Leave now.', plain = 'Leave now.';
  const namedHash = key(canonical(english)), plainHash = key(canonical(plain));
  const minimal = { format: 3, id: 'gta-6', entries: { [plainHash]: 'Gidelim.' }, segments: {}, merge_info: { version: 2 },
    key_compaction: { version: 1, removed_key_count: 1, source_key_count: 2 },
    speaker_metadata: { version: 1, keys: { [namedHash]: ['cue'] }, records: {
      cue: { english, translation: 'Jason: Gidelim.', speaker_labels: [{ source: 'Jason', turkish: 'Jason' }] }
    } } };
  assert.equal(createMatcher(minimal).exact(english), 'Gidelim.');
  const bad = JSON.parse(JSON.stringify(minimal));
  bad.speaker_metadata.records.cue.translation = 'Jason: Başka bir anlam.';
  assert.throws(() => createLookup(bad));
  const wrongCount = JSON.parse(JSON.stringify(minimal));
  wrongCount.key_compaction.removed_key_count++;
  assert.throws(() => createLookup(wrongCount));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-bad-cache-'));
  fs.writeFileSync(path.join(directory, 'gta-6.json.gz'), zlib.gzipSync(JSON.stringify(bad)));
  const store = createPackStore(directory, candidateFile);
  await store.load();
  assert.equal(store.match('Security Guard: Miss...', 100, 100).translation, 'Hanımefendi...');
});
