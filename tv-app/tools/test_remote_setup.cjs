'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const settings = require('../service/settings');
const root = path.resolve(__dirname, '../..');
const settle = () => new Promise(setImmediate);
const plain = value => JSON.parse(JSON.stringify(value));

function phone() {
  const nodes = {}, html = fs.readFileSync(path.join(root, 'setup-worker/public/index.html'), 'utf8');
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes[match[1]] = { value: '', checked: false, handlers: {}, dataset: {},
    addEventListener(name, fn) { this.handlers[name] = fn; }, reset() { this.resetCalled = true; } };
  const context = vm.createContext({ document: { getElementById: id => nodes[id] }, location: { hash: '', pathname: '/' },
    history: { replaceState() {} }, TextEncoder, crypto: webcrypto, fetch: async () => ({ status: 409 }) });
  vm.runInContext(fs.readFileSync(path.join(root, 'setup-worker/public/setup.js'), 'utf8'), context);
  return { nodes, draft: () => plain(vm.runInContext('settings()', context)) };
}

function service(initial, options = {}) {
  const handlers = {}, files = new Map(), timers = new Map();
  const configPath = '/media/internal/.com.gtavi.turkce.altyazi/settings.json';
  files.set(configPath, JSON.stringify(initial));
  let incoming;
  class Service { register(name, handler) { handlers[name] = handler || {}; return { on(event, fn) { handlers[name][event] = fn; } }; } }
  const context = vm.createContext({ __dirname: path.join(root, 'tv-app/service'), process,
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    require(name) {
      if (name === 'webos-service') return Service;
      if (name === 'path') return path.posix;
      if (name === 'fs') return { readFileSync: file => files.get(file), mkdirSync() {},
        writeFileSync: (file, text) => files.set(file, text), renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); } };
      if (name === './settings') return settings;
      if (name === './pack') return { createPackStore: () => ({ load: () => Promise.resolve() }) };
      if (name === './translation' && options.api) return options.api;
      if (name === './translation-archive' && options.archive) return options.archive;
      if (name === './remote-setup') return { createRemoteTransfer: () => ({ start: async () => {}, read: async () => ({ data: incoming }), close: async () => {} }) };
      if (name.startsWith('./')) return require(path.join(root, 'tv-app/service', name));
      return require(name);
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'tv-app/service/service.js'), 'utf8'), context);
  return { context, config: () => JSON.parse(files.get(configPath)),
    call(name, payload) { return new Promise(resolve => handlers[name]({ payload, respond: value => resolve(plain(value)) })); },
    replace(value) { files.set(configPath, JSON.stringify(value)); },
    prepared(draft) { context.draft = draft; return plain(vm.runInContext('remoteSettings(draft, readSettings())', context)); },
    async receive(draft) {
      incoming = draft;
      const messages = [];
      handlers.startRemoteSetup.request({ uniqueToken: 1, isSubscription: true, respond: value => messages.push(plain(value)) });
      await settle();
      assert.equal(messages.at(-1).type, 'received');
      return messages.at(-1).summary;
    },
    async apply() {
      let response;
      await handlers.applyRemoteSetup({ payload: {}, respond: value => { response = plain(value); } });
      return response;
    } };
}

const original = { address: '192.168.1.10', port: 3, quality: 720, ocrRate: 8,
  registKey: 'registration', rpKey: 'pairing', account: 'account', consoleId: '112233445566', setupComplete: true,
  region: { x: 26, y: 72, width: 48, height: 27 },
  appearance: { ...settings.publicSettings({}).appearance, durationScale: 175, paddingX: 22, offset: 20 },
  translation: { mode: 'pack', provider: 'gemini', similarity: 85, keys: { gemini: 'old-test-key', openai: 'keep-other-key' } } };

test('phone sends only filled inputs, including zeros/false; enabled but empty sections do not force PS5 pairing', () => {
  const p = phone();
  p.nodes.includePs5.checked = p.nodes.includeTranslation.checked = p.nodes.includeVideo.checked = true;
  p.nodes.geminiKey.value = 'new-test-key';
  assert.deepEqual(p.draft(), { translation: { keys: { gemini: 'new-test-key' } } });
  p.nodes.geminiKey.value = '';
  p.nodes.offset.value = '0'; p.nodes.opacity.value = '0'; p.nodes.background.value = 'off';
  p.nodes.regionX.value = '0'; p.nodes.durationScale.value = '150'; p.nodes.ocrRate.value = '6';
  p.nodes.subtitleCount.value = '4';
  p.nodes.backgroundBlur.value = '0';
  assert.deepEqual(p.draft(), { video: { ocrRate: 6, region: { x: 0 }, appearance: { offset: 0, opacity: 0, durationScale: 150,
    subtitleCount: 4, backgroundBlur: 0, background: false } } });
});

test('PS5 address can be sent alone; re-pairing requires the account and PIN together', () => {
  const p = phone(); p.nodes.includePs5.checked = true;
  p.nodes.address.value = '192.168.1.20';
  assert.deepEqual(p.draft(), { ps5: { address: '192.168.1.20' } });
  p.nodes.pin.value = '12345678'; assert.throws(p.draft, /PSN/);
  p.nodes.account.value = '123456'; p.nodes.address.value = '';
  assert.deepEqual(p.draft(), { ps5: { accountId: '123456', pin: '12345678' } });
});

test('phone conflict response is an error and does not claim that new settings were sent', async () => {
  const p = phone(); p.nodes.includeTranslation.checked = true; p.nodes.provider.value = 'gemini'; p.nodes.code.value = 'a'.repeat(32);
  await p.nodes.setup.handlers.submit({ preventDefault() {} });
  assert.equal(p.nodes.setup.hidden, undefined);
  assert.match(p.nodes.status.textContent, /başka ayarlar/);
  assert.equal(p.nodes.status.dataset.error, 'true');
});

test('mode/provider/key-only translation patches retain all unentered settings; only explicit null deletes a key', () => {
  for (const edit of [{ mode: 'api' }, { provider: 'openai' }, { keys: { gemini: 'new-test-key' } }, { similarity: 90 }]) {
    const next = settings.translationSettings(edit, original.translation);
    assert.deepEqual(next, { ...original.translation, ...edit, keys: { ...original.translation.keys, ...(edit.keys || {}) } });
  }
  assert.deepEqual(settings.translationSettings({ keys: { gemini: '', openai: '' } }, original.translation), original.translation);
  assert.equal(settings.translationSettings({ keys: { gemini: null } }, original.translation).keys.gemini, '');
  assert.throws(() => settings.translationSettings({ keys: null }, original.translation));
});

test('received phone patches are applied against the latest settings without resetting keys, ROI, CPU/OCR rate or pairing', async () => {
  const s = service(original);
  await s.receive({ translation: { keys: { gemini: 'new-test-key' } }, video: { appearance: { fontSize: 44, subtitleCount: 4, backgroundBlur: 8 } } });
  // The TV changes another setting while the phone draft waits for Apply.
  const latest = { ...original, ocrRate: 6, appearance: { ...original.appearance, offset: 24 } };
  s.replace(latest);
  const result = await s.apply();
  assert.equal(result.returnValue, true);
  assert.equal(result.pairedNow, false);
  assert.deepEqual(s.config(), { ...latest, translation: { ...original.translation,
    keys: { ...original.translation.keys, gemini: 'new-test-key' } }, appearance: { ...latest.appearance, fontSize: 44, subtitleCount: 4, backgroundBlur: 8 } });
});

test('address-only updates preserve Remote Play pairing; account+PIN patches use the saved IP/HDMI/quality', async () => {
  const s = service(original);
  const prepared = s.prepared({ ps5: { accountId: '123456', pin: '12345678' } });
  assert.equal(prepared.ps5.address, original.address);
  assert.equal(prepared.ps5.port, original.port);
  assert.equal(prepared.ps5.quality, original.quality);
  assert.equal(prepared.summary.ps5.pairing, true);
  await s.receive({ ps5: { address: '192.168.1.20' } });
  const result = await s.apply();
  assert.equal(result.returnValue, true);
  assert.equal(result.pairedNow, false);
  assert.deepEqual(s.config(), { ...original, address: '192.168.1.20' });
});

test('invalid partial numeric/region/appearance requests are rejected before changing stored settings', () => {
  const s = service(original);
  for (const draft of [{ video: { ocrRate: 11 } }, { video: { region: { width: 100 } } },
    { video: { appearance: { durationScale: 10 } } }, { video: { appearance: { subtitleCount: 5 } } }, { ps5: { pin: '12345678' } },
    { translation: { keys: { gemini: 'has whitespace' } } }]) {
    assert.throws(() => s.prepared(draft));
    assert.deepEqual(s.config(), original);
  }
});

test('live API diagnostic archives only an explicitly requested labelled test and returns no credentials', async () => {
  const calls = [], records = [];
  const { makeRecord } = require('../service/translation-archive');
  const s = service(original, {
    api: { testLine: 'We need to leave now.', translationModels: { gemini: 'gemini-3.5-flash-lite' },
      requestTranslation(config, source) { calls.push(source); return { result: Promise.resolve('Hemen gitmeliyiz.') }; } },
    archive: { makeRecord, createTranslationArchive: () => ({
      async record(value) { records.push(value); }, status: () => ({ configured: true, pending: 0, confirmed: records.length, lastError: '' })
    }) }
  });
  assert.deepEqual(await s.call('testTranslation', {}), { returnValue: true, text: 'Hemen gitmeliyiz.' });
  assert.equal(records.length, 0);
  const result = await s.call('testTranslation', { archive: true });
  assert.equal(result.returnValue, true);
  assert.equal(result.archive.confirmed, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].english, '[PS Subtitle connectivity test] We need to leave now.');
  assert.equal(result.testRecordId, makeRecord(records[0]).id);
  assert.equal(calls[1], records[0].english);
  assert.equal(JSON.stringify(result).includes('old-test-key'), false);
  assert.equal((await s.call('testTranslation', { archive: 'true' })).returnValue, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(s.config(), original);
});

test('diagnostic custom input preserves language cues, rejects invalid/oversized text and does not save settings', async () => {
  const calls = [];
  const s = service(original, { api: { testLine: 'We need to leave now.',
    requestTranslation(config, source) { calls.push(source); return { result: Promise.resolve('İspanyolca: Hadi gidelim!') }; }
  } });
  const text = "In Spanish: Let's go!";
  assert.deepEqual(await s.call('testTranslation', { text }), { returnValue: true, text: 'İspanyolca: Hadi gidelim!' });
  assert.deepEqual(calls, [text]);
  for (const invalid of [null, '', ' ', 3, 'x'.repeat(1441)]) {
    assert.equal((await s.call('testTranslation', { text: invalid })).returnValue, false);
  }
  assert.equal((await s.call('testTranslation', { text: 'x'.repeat(1440), archive: true })).returnValue, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(s.config(), original);
});

test('screen diagnostic uses the running feed and reproduces a blank before the API reply', async () => {
  const s = service(original);
  assert.equal((await s.call('testTranslation', { display: true })).returnValue, false);
  s.context.feedReads = [];
  vm.runInContext('active = { feed: { read: (text, confidence) => feedReads.push({ text, confidence }) } }', s.context);
  const result = await s.call('testTranslation', { text: 'Please wait here.', display: true });
  assert.equal(result.returnValue, true);
  assert.equal(result.started, true);
  assert.deepEqual(plain(s.context.feedReads), [
    { text: '[PS Subtitle connectivity test] Please wait here.', confidence: 100 },
    { text: '', confidence: 0 }
  ]);
  assert.equal(JSON.stringify(result).includes('old-test-key'), false);
  assert.deepEqual(s.config(), original);
});
