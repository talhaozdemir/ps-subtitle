'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');
const settings = require('../service/settings');
const { canonical, key } = require('../service/matcher');
const { createPackStore } = require('../service/pack');
const { createSpeakerIndex, stripKnownHeaders } = require('../service/speaker-display');
const { createSubtitleFeed } = require('../service/translation');
const renderer = require('../app/subtitle-renderer');
const root = path.resolve(__dirname, '../..');
const packFile = process.env.MERGED_PACK || path.join(root, 'dist/subtitle.json.gz');
const pack = JSON.parse(zlib.gunzipSync(fs.readFileSync(packFile)));
const realStore = createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-pack-')), packFile);
const loaded = realStore.load();

test('old appearance settings default off and the new preference validates without changing other fields', function () {
  const old = { position: 'bottom', offset: 5, background: true, opacity: 90, fontSize: 38 };
  assert.equal(settings.subtitleAppearance(old).showSpeakerNames, false);
  assert.equal(settings.publicSettings({}).appearance.showSpeakerNames, false);
  const enabled = settings.subtitleAppearance({ ...old, showSpeakerNames: true });
  assert.equal(enabled.showSpeakerNames, true);
  assert.equal(settings.publicSettings({ appearance: enabled }).appearance.showSpeakerNames, true);
  for (const value of ['true', 1, null, {}]) assert.throws(() => settings.subtitleAppearance({ ...old, showSpeakerNames: value }));
});

test('the real service persists the preference across restarts and rejects invalid saves', function () {
  function harness(initial) {
    let saved = JSON.stringify(initial), staged;
    const handlers = {};
    class Service { register(name, handler) { handlers[name] = handler; return { on() {} }; } }
    const context = vm.createContext({ __dirname: path.join(root, 'tv-app/service'), require(name) {
      if (name === 'webos-service') return Service;
      if (name === 'fs') return { readFileSync: () => saved, mkdirSync() {}, writeFileSync: (p, value) => { staged = value; }, renameSync: () => { saved = staged; } };
      if (name === './settings') return settings;
      if (name === './pack') return { createPackStore: () => ({}) };
      if (name === './translation' || name === './remote-setup') return {};
      return require(name);
    } });
    vm.runInContext(fs.readFileSync(path.join(root, 'tv-app/service/service.js'), 'utf8'), context);
    return { config: () => JSON.parse(saved), call(name, payload) {
      let result;
      handlers[name]({ payload, respond: value => { result = JSON.parse(JSON.stringify(value)); } });
      return result;
    } };
  }
  const initial = { address: '192.168.1.10', ocrRate: 7, registKey: 'keep' };
  const service = harness(initial);
  const appearance = { ...settings.publicSettings({}).appearance, showSpeakerNames: true };
  assert.equal(service.call('setAppearance', { appearance }).returnValue, true);
  assert.deepEqual(service.config(), { ...initial, appearance });
  const restarted = harness(service.config());
  assert.equal(restarted.call('settings', {}).settings.appearance.showSpeakerNames, true);
  assert.equal(restarted.call('setAppearance', { appearance: { ...appearance, showSpeakerNames: 'true' } }).returnValue, false);
  assert.deepEqual(restarted.config(), service.config());
});

test('real merged keys carry their own speaker and two Cop colours remain separate', async function () {
  await loaded;
  const ref = '9:s09-10554500';
  const row = pack.speaker_metadata.records[ref];
  const result = realStore.match(row.english, 100, 100);
  assert.ok(result);
  assert.deepEqual(result.speakers.map(span => span.name), ['Polis', 'Polis']);
  assert.deepEqual(result.speakers.map(span => span.color), ['#D8FACB', '#EEB3EE']);
  assert.ok(result.speakers[1].offset > result.speakers[0].offset);
  const two = realStore.match(pack.speaker_metadata.records['1:s01-00520500'].english, 100, 100);
  assert.deepEqual(two.speakers.map(span => span.name), ['Ronda', 'Tera']);
  assert.deepEqual(two.speakers.map(span => span.color), ['#EBB5B8', '#E9BC90']);
});

function fixture(entries) {
  const table = {}, records = {}, keys = {};
  entries.forEach((row, i) => {
    const hash = key(canonical(row.english));
    table[hash] = row.body;
    records[i] = { translation: row.named, speaker_labels: row.labels };
    (keys[hash] ||= []).push(String(i));
  });
  return { format: 2, id: 'gta-6', entries: table, segments: {}, speaker_metadata: { version: 1, records, keys } };
}
function label(name, hex, family) {
  return { source: name, turkish: name, color_occurrences: [{ status: 'measured', hex, name_tr: family }] };
}

test('equal translations do not transfer names, and colours belong to each occurrence', function () {
  const data = fixture([
    { english: 'We should leave.', body: 'Gidelim.', named: 'Jason: Gidelim.', labels: [label('Jason', '#EEEE99', 'Sarı')] },
    { english: 'We should leave.', body: 'Gidelim.', named: 'Lucia: Gidelim.', labels: [label('Lucia', '#99EEFF', 'Turkuaz / açık mavi')] },
    { english: 'This is another cue.', body: 'Gidelim.', named: 'Jason: Gidelim.', labels: [label('Jason', '#EE99FF', 'Mor / lila')] }
  ]);
  const index = createSpeakerIndex(data);
  assert.deepEqual(index.get(key(canonical('We should leave.'))), []);
  assert.deepEqual(index.get('0000000000000000'), []);
  assert.deepEqual(index.get(key(canonical('This is another cue.'))), [{ offset: 0, name: 'Jason', color: '#EE99FF' }]);
  const legacy = createSpeakerIndex({ format: 2, id: 'gta-6', entries: data.entries, segments: {} });
  assert.deepEqual(legacy.get(key(canonical('This is another cue.'))), []);
});

test('unmeasured colour families work and unresolved colours stay neutral', function () {
  const data = fixture([
    { english: 'Visual family only.', body: 'Tamam.', named: 'Jason: Tamam.', labels: [label('Jason', null, 'Sarı')] },
    { english: 'Unknown colour.', body: 'Olur.', named: 'Lucia: Olur.', labels: [{ source: 'Lucia', turkish: 'Lucia', color_occurrences: [{ status: 'unresolved' }] }] }
  ]);
  const index = createSpeakerIndex(data);
  assert.match(index.get(key(canonical('Visual family only.')))[0].color, /^#[0-9a-f]{6}$/i);
  assert.equal(index.get(key(canonical('Unknown colour.')))[0].color, null);
  const broken = fixture([{ english: 'Broken names.', body: 'Metin.', named: 'Metin.', labels: [null] }]);
  assert.deepEqual(createSpeakerIndex(broken).get(key(canonical('Broken names.'))), []);
});

test('OCR repair and fuzzy matches retain source identity without reverse-matching Turkish', async function () {
  await loaded;
  let repaired = false, fuzzy = false;
  for (const row of Object.values(pack.speaker_metadata.records)) {
    if (row.english.length < 110 || row.english.length > 340) continue;
    const exact = realStore.match(row.english, 100, 100);
    if (!exact || exact.speakers.length !== 1) continue;
    if (!repaired && row.english.includes('i')) {
      const found = realStore.match(row.english.replace('i', '1'), 100, 90);
      if (found && found.approximate && found.speakers.length) {
        assert.equal(found.translation, exact.translation);
        assert.deepEqual(found.speakers, exact.speakers);
        repaired = true;
      }
    }
    if (!fuzzy && row.english.includes(' the ')) {
      const found = realStore.match(row.english.replace(' the ', ' tqe '), 100, 85);
      if (found && found.approximate && found.speakers.length) {
        assert.equal(found.translation, exact.translation);
        assert.deepEqual(found.speakers, exact.speakers);
        fuzzy = true;
      }
    }
    if (repaired && fuzzy) break;
  }
  assert.equal(repaired, true);
  assert.equal(fuzzy, true);
});

test('pack feed forwards names separately; unverified labels are removed without removing dialogue colons', function () {
  const shown = [];
  const names = [{ offset: 0, name: 'Jason', color: '#EEEE99' }];
  const feed = createSubtitleFeed({ mode: 'pack', provider: 'gemini', similarity: 95, keys: { gemini: '', openai: '' } },
    () => ({ translation: 'Gidelim.', speakers: names }), (text, speakers) => shown.push({ text, speakers }), assert.fail);
  feed.read('Jason: Let us leave.', 100);
  assert.deepEqual(shown, [{ text: 'Gidelim.', speakers: names }]);
  assert.equal(stripKnownHeaders('Jason: Saat 12:30.\nPolis: Dur!'), 'Saat 12:30.\nDur!');
  assert.equal(stripKnownHeaders('İspanyolca: Hadi!\nNot: Bir açıklama.'), 'İspanyolca: Hadi!\nNot: Bir açıklama.');
  assert.equal(stripKnownHeaders('Newname: Selam.', 'Newname: Hello.'), 'Selam.');
});

function fakeDocument() {
  const doc = { activeElement: null, hidden: false, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
  function node(tag, text) {
    const n = { tagName: tag && tag.toUpperCase(), ownerDocument: doc, children: [], style: { setProperty() {} },
      dataset: {}, attrs: {}, handlers: {}, hidden: false, disabled: false, value: '', tabIndex: 0, options: [],
      classList: { add() {}, remove() {} }, labels: [{ dataset: {} }],
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(name, value) { this.attrs[name] = value; },
      focus() { doc.activeElement = this; }, load() {}, closest() { return null; }, querySelectorAll() { return []; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; } };
    let own = text || '';
    Object.defineProperty(n, 'textContent', { get() { return this.children.length ? this.children.map(c => c.textContent).join('') : own; },
      set(value) { own = String(value); this.children = []; } });
    Object.defineProperty(n, 'innerHTML', { set() { throw Error('HTML injection attempted'); } });
    return n;
  }
  doc.createElement = tag => node(tag);
  doc.createTextNode = text => node(null, text);
  doc.body = node('body');
  return doc;
}

test('renderer toggles names while keeping body white and treating HTML/CSS as untrusted data', function () {
  const doc = fakeDocument(), el = doc.createElement('div');
  const text = 'Dur!\nKıpırdama!';
  const spans = [{ offset: 0, name: 'Polis', color: '#D8FACB' }, { offset: 5, name: 'Polis', color: '#EEB3EE' }];
  renderer.render(el, text, spans, true);
  assert.equal(el.textContent, 'Polis: Dur!\nPolis: Kıpırdama!');
  assert.deepEqual(el.children.filter(n => n.tagName === 'SPAN').map(n => n.style.color), ['#D8FACB', '#EEB3EE']);
  assert.equal(el.style.color, undefined);
  renderer.render(el, text, spans, false);
  assert.equal(el.textContent, text);
  assert.equal(el.children.length, 0);
  renderer.render(el, text, [], true);
  assert.equal(el.textContent, text);
  renderer.render(el, '<script>alert(1)</script>', [{ offset: 0, name: '<img src=x onerror=alert(1)>', color: 'url(javascript:x)' }], true);
  assert.ok(el.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(el.children.find(n => n.tagName === 'SPAN').style.color, undefined);
  renderer.render(el, 'Metin', [{ offset: 2, name: 'Jason', color: '#FFFFFF' }], true);
  assert.equal(el.textContent, 'Metin');
});

test('the actual settings screen previews, saves, cancels and restores the preference', function () {
  const doc = fakeDocument(), nodes = {};
  const html = fs.readFileSync(path.join(root, 'tv-app/app/index.html'), 'utf8');
  for (const found of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const n = nodes[found[2]] = doc.createElement(found[1]);
    n.hidden = /\bhidden\b/.test(found[0]);
  }
  doc.getElementById = id => nodes[id];
  let appearance = settings.publicSettings({}).appearance;
  const calls = [];
  let stream;
  class Bridge {
    cancel() {}
    call(uri, raw) {
      const payload = JSON.parse(raw);
      let response;
      if (uri.endsWith('/settings')) response = { returnValue: true, settings: settings.publicSettings({ appearance,
        address: '192.168.1.10', registKey: 'test', rpKey: 'test', setupComplete: false }) };
      else if (uri.endsWith('/start')) { stream = this.onservicecallback; return; }
      else if (uri.endsWith('/setAppearance')) {
        appearance = settings.subtitleAppearance(payload.appearance);
        calls.push(appearance);
        response = { returnValue: true, appearance };
      } else response = { returnValue: true, devices: [] };
      this.onservicecallback(JSON.stringify(response));
    }
  }
  const win = { PalmServiceBridge: Bridge, addEventListener() {}, setTimeout() { return 1; }, clearTimeout() {} };
  const context = vm.createContext({ window: win, document: doc, performance: { now: () => 1000 }, SubtitleRenderer: renderer });
  vm.runInContext(fs.readFileSync(path.join(root, 'tv-app/app/app.js'), 'utf8'), context);
  const click = id => nodes[id].handlers.click({ preventDefault() {} });
  click('editAppearance');
  assert.equal(nodes.appearanceNamesValue.textContent, 'Kapalı');
  assert.equal(nodes.subtitle.textContent, 'Örnek altyazı');
  click('appearanceNames');
  assert.equal(nodes.appearanceNames.attrs['aria-pressed'], 'true');
  assert.equal(nodes.subtitle.textContent, 'Jason: Örnek altyazı');
  click('saveAppearance');
  assert.equal(calls[0].showSpeakerNames, true);
  nodes.setup.handlers.submit({ preventDefault() {} });
  const emit = (name, color) => stream(JSON.stringify({ returnValue: true, type: 'subtitle', text: 'Tamam.',
    speakers: name ? [{ offset: 0, name, color }] : [] }));
  emit('Jason', '#EEEE99');
  assert.equal(nodes.subtitle.textContent, 'Jason: Tamam.');
  emit('Lucia', '#99EEFF');
  assert.equal(nodes.subtitle.textContent, 'Lucia: Tamam.');
  emit(null);
  assert.equal(nodes.subtitle.textContent, 'Tamam.');
  click('editAppearance');
  assert.equal(nodes.appearanceNamesValue.textContent, 'Açık');
  click('appearanceNames');
  click('cancelAppearance');
  assert.equal(appearance.showSpeakerNames, true);
  click('editAppearance');
  assert.equal(nodes.appearanceNamesValue.textContent, 'Açık');
  click('appearanceNames');
  click('saveAppearance');
  assert.equal(calls[1].showSpeakerNames, false);
  emit('Jason', '#EEEE99');
  assert.equal(nodes.subtitle.textContent, 'Tamam.');
});
