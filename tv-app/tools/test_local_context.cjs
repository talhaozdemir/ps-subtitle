'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { canonical, key } = require('../service/matcher');
const { sourceBody } = require('../service/lookup');
const { describeRecord } = require('../service/speaker-display');
const { createContextIndex } = require('../service/local-context');
const { createPackStore } = require('../service/pack');
const root = path.resolve(__dirname, '../..');
const file = process.env.MERGED_PACK || path.join(root, 'dist/merged/subtitle.json.gz');
const pack = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const store = createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'context-real-')), file);
const loaded = store.load();
const baselineDir = path.join(root, 'translations/local-context/baseline');
const previous = require(path.join(baselineDir, 'pack.js')).createPackStore(
  fs.mkdtempSync(path.join(os.tmpdir(), 'context-reference-')), path.join(baselineDir, 'subtitle.json.gz'));
const previousLoaded = previous.load();

function stripNames(row) {
  return row.english.split('\n').map(line => {
    for (const label of row.speaker_labels) if (line.startsWith(label.source + ':')) return line.slice(label.source.length + 1).trimStart();
    return line;
  }).join('\n');
}

function entry(actor, english, turkish, time, color) {
  return { actor, english, turkish, time, color: color || '#EEEE99' };
}
const anchorA = [
  entry('Jason', 'The police are waiting outside the station.', 'Polisler karakolun dışında bekliyor.', 0),
  entry('Jason', 'We should leave through the rear entrance.', 'Arka kapıdan çıkmamız lazım.', 3)
];
const anchorB = [
  entry('Lucia', 'The hospital corridors are completely empty.', 'Hastanenin koridorları bomboş.', 0, '#99EEFF'),
  entry('Lucia', 'I can hear the guards behind the door.', 'Kapının arkasındaki korumaları duyuyorum.', 3, '#99EEFF')
];

function fixture(parts) {
  const records = {}, candidates = new Map(), sequence = {};
  for (const [part, rows] of Object.entries(parts)) {
    sequence[part] = [];
    rows.forEach((row, i) => {
      const ref = `${part}:${i}`;
      const english = row.actor ? row.actor + ': ' + row.english : row.english;
      records[ref] = { english, translation: row.actor ? row.actor + ': ' + row.turkish : row.turkish,
        source_frame: ref + '.jpg', speaker_labels: row.actor ? [{ source: row.actor, turkish: row.actor,
          color_occurrences: [{ status: 'measured', line_index: 0, hex: row.color,
            name_tr: row.color === '#99EEFF' ? 'Turkuaz / açık mavi' : 'Sarı' }] }] : [] };
      sequence[part].push([ref, row.time]);
      for (const text of new Set([english, row.english])) {
        const hash = key(canonical(text));
        if (!candidates.has(hash)) candidates.set(hash, []);
        candidates.get(hash).push({ ref, text: row.turkish });
      }
    });
  }
  const entries = {}, keys = {}, blocked = [];
  for (const [hash, values] of candidates) {
    if (new Set(values.map(row => row.text)).size > 1) { blocked.push(hash); continue; }
    entries[hash] = values[0].text;
    keys[hash] = values.map(row => row.ref);
  }
  return { format: 2, id: 'gta-6', entries, segments: {}, blocked_keys: blocked,
    speaker_metadata: { version: 1, records, keys }, local_context: { version: 1, parts: sequence }, merge_info: { version: 3 } };
}

async function fixtureStore(data) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-fixture-'));
  const file = path.join(directory, 'bundle.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data)));
  const local = createPackStore(directory, file);
  await local.load();
  return local;
}

function controlled(local) {
  let time = 1000;
  const session = local.createSession({ now: () => time });
  return { session, read(text, confidence = 100, minimum = 100) {
    time += 500;
    return session.match(text, confidence, minimum);
  }, wait: elapsed => { time += elapsed; } };
}
function prime(clock, anchors) {
  for (const row of anchors) clock.read(row.actor + ': ' + row.english);
}
function ambiguous() {
  return fixture({ A: [...anchorA, entry('Jason', 'Go.', 'Git.', 6)],
    B: [...anchorB, entry('Jason', 'Go.', 'Söyle.', 6, '#99EEFF')] });
}

test('source sequencing covers every reviewed record without changing dictionary, names, colours or fuzzy bytes', async function () {
  await loaded;
  const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(baselineDir, 'subtitle.json.gz'))));
  assert.deepEqual(pack.entries, old.entries);
  assert.deepEqual(pack.segments, old.segments);
  assert.deepEqual(pack.speaker_metadata, old.speaker_metadata);
  assert.deepEqual(pack.fuzzy, old.fuzzy);
  assert.deepEqual(pack.blocked_keys, old.blocked_keys);
  assert.equal(createContextIndex(pack).size, 25637);
});

test('disabled and freshly reset sessions preserve all original caption matches including their names and colours', async function () {
  await Promise.all([loaded, previousLoaded]);
  const disabled = store.createSession({ enabled: false });
  const cold = store.createSession();
  for (const row of Object.values(pack.speaker_metadata.records)) {
    const reference = previous.match(row.english, 100, 100);
    assert.deepEqual(disabled.match(row.english, 100, 100), reference, row.english);
    cold.reset();
    assert.deepEqual(cold.match(row.english, 100, 100), reference, row.english);
  }
});

test('the real address conversation resolves Go as Söyle with Lucia and her source colour', async function () {
  await loaded;
  const clock = controlled(store);
  assert.equal(clock.read('Go.'), null);
  clock.session.reset();
  for (const ref of ['8:s08-16841500', '8:s08-16843000']) clock.read(pack.speaker_metadata.records[ref].english);
  const result = clock.read('Go.');
  assert.equal(result.contextual, true);
  assert.equal(result.translation, 'Söyle.');
  assert.deepEqual(result.speakers, [{ offset: 0, name: 'Lucia', color: '#8CDEEB' }]);
  assert.equal(store.match('Go.', 100, 100), null);
});

test('two distinct reliable anchors are required; repeated OCR and one anchor do not manufacture context', async function () {
  const local = await fixtureStore(ambiguous()), clock = controlled(local);
  clock.read('Jason: ' + anchorA[0].english);
  const token = clock.session.cacheKey('Go.');
  for (let i = 0; i < 20; i++) clock.read('Jason ' + anchorA[0].english);
  assert.equal(clock.session.cacheKey('Go.'), token);
  assert.equal(clock.read('Go.'), null);
  clock.session.reset();
  prime(clock, anchorA);
  assert.equal(clock.read('Go.').translation, 'Git.');
});

test('the same actor and phrase can resolve to a different meaning and colour in another scene', async function () {
  const local = await fixtureStore(ambiguous()), clock = controlled(local);
  prime(clock, anchorA);
  const a = clock.read('Jason: Go.');
  assert.equal(a.translation, 'Git.');
  assert.deepEqual(a.speakers, [{ offset: 0, name: 'Jason', color: '#EEEE99' }]);
  clock.session.reset();
  prime(clock, anchorB);
  const b = clock.read('Jason: Go.');
  assert.equal(b.translation, 'Söyle.');
  assert.deepEqual(b.speakers, [{ offset: 0, name: 'Jason', color: '#99EEFF' }]);
});

test('a missing name can be restored while a safe existing translation and explicit name win unchanged', async function () {
  const data = fixture({ A: [...anchorA, entry('Jason', 'Take cover!', 'Siper al!', 6)],
    B: [...anchorB, entry('Lucia', 'Take cover!', 'Siper al!', 6, '#99EEFF')] });
  const local = await fixtureStore(data), clock = controlled(local);
  const baseline = local.match('Take cover!', 100, 100);
  assert.deepEqual(baseline.speakers, []);
  prime(clock, anchorA);
  const restored = clock.read('Take cover!');
  assert.equal(restored.translation, baseline.translation);
  assert.equal(restored.speakers[0].name, 'Jason');
  clock.session.reset();
  prime(clock, anchorB);
  assert.deepEqual(clock.read('Jason: Take cover!'), local.match('Jason: Take cover!', 100, 100));
  clock.session.reset();
  prime(clock, anchorB);
  assert.equal(clock.read('Take cover!').speakers[0].name, 'Lucia');
});

test('the same phrase returning after a blank gap cannot reuse a previous turn’s speaker', async function () {
  const local = await fixtureStore(fixture({ A: [...anchorA,
    entry('Jason', 'Go.', 'Git.', 6), entry('Lucia', 'Go.', 'Söyle.', 20, '#99EEFF')] }));
  const clock = controlled(local);
  prime(clock, anchorA);
  assert.equal(clock.read('Go.').speakers[0].name, 'Jason');
  assert.equal(clock.read('Go.').speakers[0].name, 'Jason');
  clock.read('');
  clock.wait(1500);
  assert.equal(clock.read('Go.'), null);
  assert.equal(clock.read('Go.'), null);
});

test('a shorter OCR fragment of the just-read caption is not treated as a fresh contextual reply', async function () {
  const fragment = 'Leave through the rear entrance.';
  const local = await fixtureStore(fixture({ A: [...anchorA, entry('Jason', fragment, 'Arka girişten çık.', 6)],
    B: [...anchorB, entry('Jason', fragment, 'Arka girişi kullan.', 6)] }));
  const clock = controlled(local);
  prime(clock, anchorA);
  assert.equal(clock.read(fragment), null);
});

test('equally supported source scenes remain unresolved', async function () {
  const shared = anchorA.map(row => ({ ...row }));
  const local = await fixtureStore(fixture({ A: [...shared, entry('Jason', 'Go.', 'Git.', 6)],
    B: [...shared, entry('Jason', 'Go.', 'Söyle.', 6)] }));
  const clock = controlled(local);
  prime(clock, shared);
  assert.equal(clock.read('Go.'), null);
});

test('expiry, explicit reset, a scene change and contradictory reads discard old context', async function () {
  const local = await fixtureStore(ambiguous()), clock = controlled(local);
  prime(clock, anchorA);
  clock.wait(46000);
  clock.read('Jason: ' + anchorA[1].english); // paused on the same old frame
  assert.equal(clock.read('Go.'), null);
  clock.session.reset();
  prime(clock, anchorA);
  clock.session.reset();
  assert.equal(clock.read('Go.'), null);
  prime(clock, anchorA);
  clock.read('Lucia: ' + anchorB[0].english);
  assert.equal(clock.read('Go.'), null);
  clock.session.reset();
  prime(clock, anchorA);
  clock.read('The unrelated television commercial just started.');
  clock.read('A completely different radio show is playing now.');
  assert.equal(clock.read('Go.'), null);
});

test('sessions are isolated and weak readings cannot seed anchors', async function () {
  const local = await fixtureStore(ambiguous()), one = controlled(local), two = controlled(local);
  prime(one, anchorA);
  assert.equal(one.read('Go.').translation, 'Git.');
  assert.equal(two.read('Go.'), null);
  two.session.reset();
  for (const row of anchorA) two.read('Jason: ' + row.english, 80);
  assert.equal(two.read('Go.'), null);
});

test('context rescues a close OCR read only inside the confirmed source window and respects exact-only mode', async function () {
  const english = 'Check the eastern delivery gate.';
  const local = await fixtureStore(fixture({ A: [...anchorA, entry('Jason', english, 'Doğu teslimat kapısını kontrol et.', 6)],
    B: [...anchorB, entry('Lucia', 'Check the western delivery gate.', 'Batı teslimat kapısını kontrol et.', 6, '#99EEFF')] }));
  const clock = controlled(local), typo = 'Check the eqstern delivery gate.';
  prime(clock, anchorA);
  assert.equal(local.match(typo, 100, 95), null);
  assert.equal(clock.read(typo, 100, 100), null);
  const found = clock.read(typo, 100, 95);
  assert.equal(found.contextual, true);
  assert.equal(found.approximate, true);
  assert.equal(found.translation, 'Doğu teslimat kapısını kontrol et.');
  assert.equal(found.speakers[0].name, 'Jason');
});

test('close competing OCR candidates retain the score margin even below the acceptance threshold', async function () {
  const local = await fixtureStore(fixture({ A: [...anchorA,
    entry('Jason', 'Open the north gate, right now.', 'Kuzey kapısını hemen aç.', 6),
    entry('Jason', 'Open the south gate, right now.', 'Güney kapısını hemen aç.', 7)] }));
  const clock = controlled(local);
  prime(clock, anchorA);
  assert.equal(clock.read('Open the xorth gate, right now.', 100, 95), null);
});

test('context-rescued long lines cannot become new positive anchors', async function () {
  const a = [...anchorA], b = [...anchorB];
  for (let i = 0; i < 12; i++) {
    const en = `The delivery code for crate number ${i + 1} is still pending.`;
    a.push(entry('Jason', en, `A bölümünün ${i + 1}. sandık kodu bekleniyor.`, 5 + i * 0.5));
    b.push(entry('Jason', en, `B bölümünün ${i + 1}. sandık kodu bekleniyor.`, 5 + i * 0.5));
  }
  const local = await fixtureStore(fixture({ A: a, B: b })), clock = controlled(local);
  prime(clock, anchorA);
  let resolved = 0;
  for (const row of a.slice(2)) if (clock.read('Jason: ' + row.english)) resolved++;
  assert.ok(resolved > 0 && resolved < 12);
});

test('missing or malformed optional sequencing leaves the original dictionary usable', async function () {
  const data = ambiguous();
  data.local_context.parts.A[0][0] = 'A:missing';
  assert.equal(createContextIndex(data), null);
  const local = await fixtureStore(data);
  const session = local.createSession();
  assert.deepEqual(session.match('Jason: ' + anchorA[0].english, 100, 100), local.match('Jason: ' + anchorA[0].english, 100, 100));
  assert.equal(session.cacheKey('Go.'), 'Go.');
  assert.equal(session.match('Go.', 100, 100), null);
});

test('a cached pre-context dictionary cannot hide the bundled sequencing data', async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-upgrade-'));
  fs.copyFileSync(path.join(baselineDir, 'subtitle.json.gz'), path.join(directory, 'gta-6.json.gz'));
  const local = createPackStore(directory, file);
  const installed = await local.load();
  assert.equal(installed.mergeVersion, 3);
  assert.equal(installed.contextIndex.size, 25637);
});

test('real source replay preserves safe matches and validates rescued translations/names with and without OCR names', async function (t) {
  await loaded;
  const counts = [];
  for (const named of [true, false]) {
    let now = 1000, offset = 0, added = 0, namedOnly = 0, safe = 0;
    for (const samples of Object.values(pack.local_context.parts)) {
      const session = store.createSession({ now: () => now });
      for (const [ref, time] of samples) {
        now = offset + time * 1000;
        const row = pack.speaker_metadata.records[ref];
        const text = named ? row.english : stripNames(row);
        const base = store.match(text, 100, 100);
        const found = session.match(text, 100, 100);
        if (base && (base.approximate || base.speakers.length)) { assert.deepEqual(found, base, ref); safe++; }
        if (found && found.contextual) {
          added++;
          if (base && found.translation === base.translation) namedOnly++;
          else assert.equal(canonical(found.translation), canonical(sourceBody(row)), ref);
          const expected = describeRecord(row);
          if (found.speakers.length && expected) assert.deepEqual(found.speakers.map(span => span.name), expected.speakers.map(span => span.name), ref);
        }
      }
      offset = now + 100000;
    }
    assert.ok(added > 0);
    counts.push({ named, added, namedOnly, safe });
  }
  t.diagnostic('context_source_replays=' + JSON.stringify(counts));
});

test('the short-reply rewind case never attaches Lucia to Jason’s second identical answer', async function () {
  await loaded;
  let now = 0;
  const session = store.createSession({ now: () => now });
  for (const [ref, time] of pack.local_context.parts['9']) {
    if (time < 1830) continue;
    now = time * 1000;
    const row = pack.speaker_metadata.records[ref];
    const found = session.match(stripNames(row), 100, 100);
    if (ref === '9:s09-01885500') {
      assert.equal(found.translation, 'Evet, iyiyim.');
      assert.equal(found.speakers.some(span => span.name === 'Lucia'), false);
      return;
    }
  }
  assert.fail('Fixture cue not found');
});

test('API fallback cache/pending jobs are scoped to context and lifecycle reset without changing API input', async function () {
  const jobs = [], shown = [];
  const fakeHttps = { Agent: class {}, request(options, callback) {
    const request = new EventEmitter();
    request.end = body => jobs.push({ request, callback, body: JSON.parse(body) });
    request.destroy = () => { request.destroyed = true; };
    return request;
  } };
  const context = vm.createContext({ module: { exports: {} }, Buffer, setTimeout: () => 1, clearTimeout() {}, require(name) {
    if (name === 'https') return fakeHttps;
    if (name === './settings') return require('../service/settings');
    if (name === './speaker-display') return require('../service/speaker-display');
    return require(name);
  } });
  vm.runInContext(fs.readFileSync(path.join(root, 'tv-app/service/translation.js'), 'utf8'), context);
  let scope = 0;
  const lifecycle = { reset: () => scope++, cacheKey: source => scope + ':' + source };
  const config = { mode: 'pack', provider: 'gemini', similarity: 95, keys: { gemini: 'test-only', openai: '' } };
  const feed = context.module.exports.createSubtitleFeed(config, () => null, text => shown.push(text), assert.fail, lifecycle);
  async function respond(index, text) {
    const response = new EventEmitter(); response.statusCode = 200;
    jobs[index].callback(response);
    response.emit('data', Buffer.from(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] })));
    response.emit('end');
    await new Promise(setImmediate);
  }
  feed.read('Go.', 100);
  await respond(0, 'Söyle.');
  feed.read('Go.', 100);
  assert.equal(jobs.length, 1);
  scope++;
  feed.read('Go.', 100);
  await respond(1, 'Git.');
  assert.equal(shown[shown.length - 1], 'Git.');
  feed.reset();
  feed.read('Go.', 100);
  scope++;
  feed.read('Go.', 100);
  assert.equal(jobs[2].request.destroyed, true);
  await respond(2, 'Eski bağlam.');
  assert.notEqual(shown[shown.length - 1], 'Eski bağlam.');
  await respond(3, 'Yeni bağlam.');
  assert.equal(shown[shown.length - 1], 'Yeni bağlam.');
  assert.ok(jobs.every(job => job.body.input === 'Go.'));
  const oldScope = scope;
  feed.update(config);
  assert.equal(scope, oldScope + 1);
});
