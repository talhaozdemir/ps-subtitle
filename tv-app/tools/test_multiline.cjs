'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { canonical, key } = require('../service/matcher');
const { createPackStore } = require('../service/pack');
const { matchMultiline } = require('../service/multiline');
const { createSubtitleFeed } = require('../service/translation');
const settings = require('../service/settings');
const renderer = require('../app/subtitle-renderer');
const root = path.resolve(__dirname, '../..');

async function fixture(rows, blocked = []) {
  const entries = {}, records = {}, keys = {};
  rows.forEach((row, i) => {
    const hash = key(canonical(row.en));
    entries[hash] = row.tr;
    const labels = row.name ? [{ source: row.name, turkish: row.name,
      color_occurrences: [{ status: 'measured', hex: row.color, name_tr: row.family || 'Sarı' }] }] : [];
    records[i] = { english: row.en, translation: row.name ? row.name + ': ' + row.tr : row.tr, speaker_labels: labels };
    keys[hash] = [String(i)];
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multiline-'));
  const file = path.join(directory, 'bundle.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ format: 2, id: 'gta-6', entries, segments: {},
    blocked_keys: blocked.map(text => key(canonical(text))), speaker_metadata: { version: 1, records, keys } })));
  const store = createPackStore(directory, file);
  await store.load();
  return store;
}

test('six physical OCR rows are matched as complete wrapped turns with independent colours', async () => {
  const rows = [
    { en: 'Jason: The police are outside.\nTake the back door.', tr: 'Polisler dışarıda.\nArka kapıyı kullan.', name: 'Jason', color: '#D4DF98' },
    { en: 'Lucia: Bring the car around.\nI will meet you there.', tr: 'Arabayı getir.\nOrada buluşuruz.', name: 'Lucia', color: '#99EEFF', family: 'Turkuaz / açık mavi' },
    { en: 'Jason: Keep your head down.\nThey are watching us.', tr: 'Başını eğ.\nBizi izliyorlar.', name: 'Jason', color: '#EE99FF', family: 'Mor / lila' }
  ];
  const store = await fixture(rows), session = store.createSession();
  const input = rows.map(row => row.en).join('\n');
  assert.equal(store.match(input, 100, 100), null);
  const result = session.match(input, 100, 100);
  assert.ok(result.multiline);
  assert.equal(result.translation, rows.map(row => row.tr).join('\n'));
  assert.deepEqual(result.speakers.map(span => [span.name, span.color]), rows.map(row => [row.name, row.color]));
  assert.deepEqual(result.speakers.map(span => span.offset), [0, rows[0].tr.length + 1, rows[0].tr.length + rows[1].tr.length + 2]);
});

test('existing whole-block translations win over potentially conflicting line partitions', async () => {
  const store = await fixture([
    { en: 'Stay here.\nWatch the door.', tr: 'Burada bekleyip kapıyı kolla.', name: 'Jason', color: '#D4DF98' },
    { en: 'Stay here.', tr: 'Burada dur.' }, { en: 'Watch the door.', tr: 'Kapıya bak.' }
  ]);
  assert.deepEqual(store.createSession().match('Stay here.\nWatch the door.', 100, 100), store.match('Stay here.\nWatch the door.', 100, 100));
});

test('separate OCR rows reach the pack-only feed as a complete translation', async () => {
  const rows = [
    { en: 'Open the door.', tr: 'Kapıyı aç.' },
    { en: 'Stay here.', tr: 'Burada bekle.' },
    { en: 'Watch the road.', tr: 'Yolu kolla.' }
  ];
  const store = await fixture(rows), session = store.createSession(), shown = [];
  const input = rows.map(row => row.en).join('\n');
  assert.equal(store.match(input, 95, 95), null, 'The full block is not a dictionary entry');
  const feed = createSubtitleFeed({ mode: 'pack', provider: 'gemini', similarity: 95, keys: {} },
    session.match, text => shown.push(text), assert.fail, session);
  feed.read(input, 95);
  assert.deepEqual(shown, [rows.map(row => row.tr).join('\n')]);
  feed.read('Stay here.', 95);
  assert.deepEqual(shown, [rows.map(row => row.tr).join('\n'), 'Burada bekle.']);
});

test('unmatched rows, ambiguous whole blocks and uncertain OCR are never silently discarded', async () => {
  const store = await fixture([{ en: 'Stay here.', tr: 'Burada kal.' }, { en: 'Watch the door.', tr: 'Kapıyı kolla.' }], ['Stay here. Watch the door.']);
  const session = store.createSession();
  assert.equal(session.match('Stay here.\nWatch the door.', 100, 100), null);
  assert.equal(session.match('Stay here.\nUnknown scene text.', 100, 100), null);
  const exact = text => text === 'Known.' ? { translation: 'Biliniyor.', speakers: [] } : null;
  for (const input of ['Known.\nUnknown.', 'Known.\n\nKnown.', Array(7).fill('Known.').join('\n')]) {
    assert.equal(matchMultiline(input, 100, exact, () => false), null);
  }
  assert.equal(matchMultiline('Known.\nKnown.', 84, exact, () => false), null);
  assert.equal(matchMultiline('Known.\nKnown.', NaN, exact, () => false), null);
});

test('conflicting complete partitions and speaker interpretations stay unresolved', () => {
  const values = {
    'A': { translation: 'Bir.', speakers: [] }, 'A\nB': { translation: 'Farklı.', speakers: [] },
    'B\nC': { translation: 'İki.', speakers: [] }, 'C': { translation: 'Üç.', speakers: [] }
  };
  assert.equal(matchMultiline('A\nB\nC', 100, text => values[text], () => false), null);
});

test('long blocks stay local and the next subtitle replaces the current block without accumulating', async () => {
  const one = 'Jason: ' + 'The guards are waiting near the eastern gate. '.repeat(5);
  const two = 'Lucia: ' + 'We should take the road behind the old station. '.repeat(5);
  const store = await fixture([
    { en: one, tr: 'Korumalar doğu kapısının orada bekliyor.', name: 'Jason', color: '#D4DF98' },
    { en: two, tr: 'Eski karakolun arkasındaki yoldan gidelim.', name: 'Lucia', color: '#99EEFF' },
    { en: 'Go now.', tr: 'Hemen git.' }
  ]);
  const session = store.createSession(), input = one + '\n' + two;
  assert.ok(input.length > 360);
  const shown = [];
  const feed = createSubtitleFeed({ mode: 'pack', similarity: 100, provider: 'gemini', keys: {} },
    session.match, (text, speakers) => shown.push({ text, speakers }), assert.fail, session);
  feed.read(input, 100);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].speakers.length, 2);
  feed.read('Go now.', 100);
  assert.deepEqual(shown[1], { text: 'Hemen git.', speakers: [] });
  assert.equal(session.match(input + 'x'.repeat(1441), 100, 100), null);
});

test('factory regions migrate to the measured boxes and preserve custom selections', () => {
  const expected = { x: 6, y: 67, width: 88, height: 26 };
  const objective = { x: 24, y: 93, width: 52, height: 7 };
  assert.deepEqual(settings.publicSettings({}).region, expected);
  assert.deepEqual(settings.publicSettings({ region: { x: 6, y: 62, width: 88, height: 38 } }).region, expected);
  assert.deepEqual(settings.publicSettings({ region: { x: 6, y: 77, width: 88, height: 23 } }).region, expected);
  assert.deepEqual(settings.publicSettings({ region: expected }).region, expected);
  assert.deepEqual(settings.publicSettings({ objectiveRegion: { x: 28, y: 93, width: 44, height: 7 } }).objectiveRegion, objective);
  assert.deepEqual(settings.publicSettings({}).objectiveRegionPresets[2], objective);
  assert.deepEqual(settings.publicSettings({}).hintRegion, { x: 80, y: 92, width: 20, height: 8 });
  const custom = { x: 10, y: 60, width: 80, height: 35 };
  assert.deepEqual(settings.publicSettings({ region: custom }).region, custom);
  assert.deepEqual(settings.publicSettings({ objectiveRegion: custom }).objectiveRegion, custom);
});

test('real five-line scenes retain all selected translations and every speaker occurrence colour', async () => {
  const file = process.env.MERGED_PACK || path.join(root, 'dist/subtitle.json.gz');
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const store = createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'multiline-real-')), file);
  await store.load();
  for (const ref of ['6:s06-00367000', '6:s06-00368000', '6:s06-00369000', '6:s06-07468500']) {
    const row = data.speaker_metadata.records[ref];
    assert.equal(row.english.split('\n').length, 5);
    const expected = store.match(row.english, 100, 100);
    assert.ok(expected && expected.speakers.length === 3, ref);
    const result = store.createSession().match(row.english, 100, 100);
    assert.deepEqual(result, expected, ref);
    const last = result.speakers[result.speakers.length - 1];
    assert.ok(result.translation.slice(last.offset).length, ref);
  }
});

test('historical five-line OCR inputs still display complete translations with names and colours', async () => {
  const file = process.env.MERGED_PACK || path.join(root, 'dist/subtitle.json.gz');
  const store = createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'multiline-ocr-')), file);
  await store.load();
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const directory = path.join(__dirname, 'fixtures/multiline');
  const scenes = JSON.parse(fs.readFileSync(path.join(directory, 'scenes.json')));
  const readings = JSON.parse(fs.readFileSync(path.join(directory, 'readings.json')));
  assert.equal(readings.length, 6);
  for (const reading of readings) {
    const scene = scenes.find(scene => scene.file === reading.file);
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(directory, scene.file))).digest('hex'), reading.sha256);
    assert.equal(reading.sha256, scene.sha256);
    assert.equal(reading.candidate, true);
    assert.equal(reading.text.split('\n').length, 5);
    const expected = store.match(data.speaker_metadata.records[reading.ref].english, 100, 100);
    let shown;
    const session = store.createSession();
    const feed = createSubtitleFeed({ mode: 'pack', similarity: 95, provider: 'gemini', keys: {} },
      session.match, (text, speakers) => { shown = { text, speakers }; }, assert.fail, session);
    feed.read(reading.text, reading.confidence);
    assert.ok(shown, reading.file);
    assert.equal(shown.text, expected.translation, reading.file);
    assert.deepEqual(shown.speakers, expected.speakers, reading.file);
    const element = { children: [], textContent: '', ownerDocument: {
      createTextNode: text => ({ textContent: text }),
      createElement: () => ({ style: {}, textContent: '' })
    }, appendChild(child) { this.children.push(child); } };
    renderer.render(element, shown.text, shown.speakers, true);
    assert.deepEqual(element.children.filter(child => child.style).map(child => [child.textContent, child.style.color]),
      expected.speakers.map(span => [span.name + ': ', span.color]), reading.file);
    const unnamed = { textContent: '' };
    renderer.render(unnamed, shown.text, shown.speakers, false);
    assert.equal(unnamed.textContent, expected.translation);
  }
});
