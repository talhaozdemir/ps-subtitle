'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const settings = require('../service/settings');
const serviceDirectory = path.resolve(__dirname, '../service');
const source = fs.readFileSync(path.join(serviceDirectory, 'service.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const handlers = {}, workers = [], timers = new Map();
  const files = new Map([['/media/internal/.com.gtavi.turkce.altyazi/settings.json', JSON.stringify({
    address: '192.168.1.10', port: 1, quality: 540, registKey: 'registration', rpKey: 'pairing', ...options.settings
  })]]);
  let nextToken = 0;
  class Service {
    register(name, handler) {
      handlers[name] = handler || {};
      return { on: (event, listener) => { handlers[name][event] = listener; } };
    }
  }
  function spawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.close = function () {};
    child.commands = [];
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.write = text => child.commands.push(JSON.parse(text));
    child.stdin.end = () => { child.stdin.writable = false; child.stopping = true; };
    child.exit = () => child.emit('close', 0);
    child.kill = signal => { child.signal = signal; child.exit(); };
    child.send = result => child.stdout.emit('line', JSON.stringify(result));
    workers.push(child);
    return child;
  }
  const context = vm.createContext({
    __dirname: serviceDirectory, process,
    setTimeout: (callback, delay) => { const timer = {}; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout: timer => timers.delete(timer),
    require(name) {
      if (name === 'webos-service') return Service;
      if (name === 'child_process') return { spawn };
      if (name === 'readline') return { createInterface: ({ input }) => input };
      if (name === 'fs') return {
        readFileSync: file => files.get(file), mkdirSync() {},
        writeFileSync: (file, text) => files.set(file, text),
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); }
      };
      if (name === 'path') return path.posix;
      if (name === './settings') return settings;
      if (name === './pack') return { createPackStore: () => ({
        load: () => Promise.resolve(), createSession: () => ({ match: options.match || (() => null) }),
        match: options.matchObjective || (() => null)
      }) };
      if (name === './translation') return options.api || (options.realFeed ? require('../service/translation') :
        { createSubtitleFeed: () => ({ reset() {}, read() {} }) });
      if (name === './remote-setup') return {};
      if (name === './translation-archive') return options.api ? { createTranslationArchive: () => ({ flush() {} }) } :
        require('../service/translation-archive');
      if (name.startsWith('./')) return require(path.join(serviceDirectory, name));
      return require(name);
    }
  });
  vm.runInContext(source, context);
  return {
    workers, timers,
    config: () => JSON.parse(files.get('/media/internal/.com.gtavi.turkce.altyazi/settings.json')),
    setRegion(payload) {
      let result;
      handlers.setRegion({ payload, respond: reply => { result = reply; } });
      return result;
    },
    diagnostics() {
      let result;
      handlers.videoDiagnostics({ payload: {}, respond: reply => { result = JSON.parse(JSON.stringify(reply)); } });
      return result;
    },
    start(quality = 540) {
      const messages = [];
      const message = { uniqueToken: ++nextToken, isSubscription: true,
        payload: { address: '192.168.1.10', port: 1, quality },
        respond: reply => messages.push(JSON.parse(JSON.stringify(reply))) };
      handlers.start.request(message);
      return { messages, cancel: () => handlers.start.cancel(message) };
    },
    tick(delay) {
      const entry = Array.from(timers).find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'Expected a timer for ' + delay + ' ms');
      timers.delete(entry[0]);
      entry[1].callback();
    }
  };
}

test('changing resolution waits for the old native session to close', async function () {
  const service = harness();
  const first = service.start();
  await settle();
  const old = service.workers[0];
  old.send({ type: 'ready' });
  old.send({ type: 'ocr', text: '', confidence: 0, revision: 0 });
  assert.ok(first.messages.some(message => message.type === 'ready'));
  const next = service.start(1080);
  await settle();
  assert.equal(old.stopping, true);
  assert.equal(service.workers.length, 1);
  old.send({ type: 'error', text: 'Late failure from old session' });
  old.exit();
  await settle();
  assert.equal(service.workers.length, 2);
  assert.equal(service.workers[1].commands[0].quality, 1080);
  service.workers[1].send({ type: 'ocr', text: '', confidence: 0, revision: 0 });
  assert.ok(next.messages.some(message => message.type === 'ready'));
  assert.equal(service.timers.size, 1, 'Old shutdown timer must be cleared');
});

test('video diagnostics preserve the latest and maximum native stage durations', async function () {
  const service = harness();
  service.start();
  await settle();
  const worker = service.workers[0];
  worker.send({ type: 'ocr', revision: 0, text: 'Hello.', confidence: 95,
    queueMs: 300, ocrMs: 650, cropAgeMs: 950 });
  worker.send({ type: 'ocr', revision: 0, text: 'Hello.', confidence: 95,
    queueMs: 10, ocrMs: 200, cropAgeMs: 210 });
  const expected = { queueMs: 10, maxQueueMs: 300, ocrMs: 200, maxOcrMs: 650,
    cropAgeMs: 210, maxCropAgeMs: 950, matchMs: 0, maxMatchMs: 0 };
  assert.deepEqual(service.diagnostics().video.timing, expected);
  worker.send({ type: 'ocr', revision: 0, text: '', confidence: 0,
    queueMs: -1, ocrMs: 'invalid', cropAgeMs: null });
  assert.deepEqual(service.diagnostics().video.timing, expected);
});

test('real pack-only feed forwards complete turns and only confirmed blank/unmatched reads release the overlay', async () => {
  const service = harness({ realFeed: true, match: text => text === 'Known.' ?
    { translation: 'Kapıyı aç.\nTamam.', speakers: [], turns: [0, 11] } : null });
  const stream = service.start();
  await settle();
  const worker = service.workers[0];
  worker.send({ type: 'ocr', revision: 0, text: 'Known.', confidence: 95 });
  assert.deepEqual(stream.messages.at(-1), { returnValue: true, type: 'subtitle', text: 'Kapıyı aç.\nTamam.', speakers: [], turns: [0, 11] });
  const count = stream.messages.length;
  worker.send({ type: 'ocr', revision: 0, text: '', confidence: 0, skipped: true });
  worker.send({ type: 'ocr', revision: 1, text: '', confidence: 0 });
  assert.equal(stream.messages.length, count, 'Skipped and stale frames cannot clear a current subtitle');
  worker.send({ type: 'ocr', revision: 0, text: 'Unknown.', confidence: 95 });
  assert.equal(stream.messages.at(-1).type, 'subtitleIdle');
  worker.send({ type: 'ocr', revision: 0, text: 'Known.', confidence: 95 });
  assert.equal(stream.messages.at(-1).type, 'subtitle');
  worker.send({ type: 'ocr', revision: 0, text: '', confidence: 0 });
  assert.equal(stream.messages.at(-1).type, 'subtitleIdle');
});

test('positioned reads keep dialogue, tasks, and button hints independent', async () => {
  const lookups = [];
  const service = harness({ realFeed: true, match: text => ({ 'Go now!': 'Git!', 'Wait!': 'Bekle!' })[text],
    settings: { objectiveRegion: { x: 24, y: 93, width: 76, height: 7 } },
    matchObjective: text => {
      lookups.push(text);
      return text === 'Follow the plane' ? 'Uçağı takip et.' : 'Ekipmanını açmak için L1’e basılı tut.';
    } });
  const stream = service.start();
  await settle();
  const worker = service.workers[0];
  const line = (text, x, y) => ({ text, x, y, height: 2, confidence: 95 });
  const read = (...lines) => worker.send({ type: 'ocr', revision: 0, lines,
    text: lines.map(item => item.text).join('\n'), confidence: 95 });
  const taskMessages = () => stream.messages.filter(message => message.type === 'objective').map(message => message.text);
  const hintMessages = () => stream.messages.filter(message => message.type === 'hint').map(message => message.text);

  read(line('now!', 54, 89.9), line('Go', 46, 90), line('to open your loadout', 58, 95.7),
    line('Hold L1', 43, 96), line('HOLD HANDS', 91, 96));
  read(line('Wait!', 50, 90), line('HoldL1 to open your loadout!', 50, 96),
    line('R2', 97, 96), line('HOLDHANDS', 91, 96));
  worker.send({ type: 'ocr', revision: 0, text: '', lines: [], confidence: 0, skipped: true });
  assert.deepEqual(lookups, ['Hold L1 to open your loadout']);
  assert.deepEqual(taskMessages(), ['Ekipmanını açmak için L1’e basılı tut.']);
  assert.deepEqual(hintMessages(), ['El ele tutuş']);
  assert.deepEqual(stream.messages.filter(message => message.type === 'subtitle').map(message => message.text), ['Git!', 'Bekle!']);

  read(line('Wait!', 50, 90));
  assert.deepEqual(taskMessages(), ['Ekipmanını açmak için L1’e basılı tut.', '']);
  assert.deepEqual(hintMessages(), ['El ele tutuş', '']);
  assert.equal(stream.messages.some(message => message.type === 'subtitleIdle'), false);
  read(line('Hold L1 to open your loadout', 50, 96));
  assert.equal(taskMessages().at(-1), 'Ekipmanını açmak için L1’e basılı tut.');
  read(line('Follow the plane', 50, 96));
  assert.equal(taskMessages().at(-1), 'Uçağı takip et.');
});

test('moving the objective box previews only its lines, persists the box, and still uses a single native capture', async () => {
  const service = harness({ realFeed: true, matchObjective: () => 'Hedef' });
  const stream = service.start();
  await settle();
  const worker = service.workers[0];
  const region = { x: 2, y: 50, width: 24, height: 5 };
  assert.equal(service.setRegion({ target: 'objectiveRegion', region, revision: 1, preview: true }).returnValue, true);
  assert.deepEqual(worker.commands[1], { region: { x: 2, y: 50, width: 98, height: 50 },
    dialogueRegion: { x: 6, y: 67, width: 88, height: 26 }, objectiveRegion: region,
    hintRegion: { x: 80, y: 92, width: 20, height: 8 }, revision: 1 });
  const lines = [{ text: 'Target', x: 14, y: 52, height: 2, confidence: 95 },
    { text: 'Go!', x: 50, y: 90, height: 2, confidence: 95 },
    { text: 'Outside either box', x: 50, y: 64, height: 2, confidence: 95 }];
  worker.send({ type: 'ocr', revision: 0, lines, text: 'Stale', confidence: 95 });
  assert.equal(stream.messages.some(message => message.type === 'preview'), false);
  worker.send({ type: 'ocr', revision: 1, lines, text: 'OCR', confidence: 95 });
  assert.deepEqual(stream.messages.at(-1), { returnValue: true, type: 'preview', text: 'Target', revision: 1 });
  assert.equal(service.config().objectiveRegion, undefined);
  assert.equal(service.setRegion({ target: 'objectiveRegion', region, revision: 2, save: true }).returnValue, true);
  assert.deepEqual(service.config().objectiveRegion, region);
  assert.equal(worker.commands.length, 2);
  worker.send({ type: 'ocr', revision: 1, lines, text: 'OCR', confidence: 95 });
  assert.equal(stream.messages.at(-1).text, 'Hedef');
});

test('single-word dialogue requires a local hit, two-word dialogue can use the API, and blank tasks cancel', async () => {
  const requests = [];
  const api = { module: { exports: {} }, Buffer, setTimeout, clearTimeout, require(name) {
    if (name === 'https') return { Agent: class {}, request(options, reply) {
      const request = new EventEmitter();
      request.end = body => requests.push({ reply, body: JSON.parse(body), request });
      request.destroy = () => { request.destroyed = true; };
      return request;
    } };
    return require(path.join(serviceDirectory, name));
  } };
  vm.runInNewContext(fs.readFileSync(path.join(serviceDirectory, 'translation.js'), 'utf8'), api);
  const service = harness({ api: api.module.exports, match: text => text === 'Wait!' ? 'Bekle!' : null, settings: {
    translation: { mode: 'api', provider: 'gemini', keys: { gemini: 'test-key' } }
  } });
  const stream = service.start();
  await settle();
  const worker = service.workers[0];
  function read(text, y = 96) {
    worker.send({ type: 'ocr', revision: 0, text, confidence: 95,
      lines: text ? [{ text, x: 50, y, height: 2, confidence: 95 }] : [] });
  }
  read('8ABC-123', 90);
  assert.equal(stream.messages.at(-1).type, 'subtitleIdle');
  read('Wait!', 90);
  assert.equal(stream.messages.at(-1).text, 'Bekle!');
  assert.equal(requests.length, 0);

  read('Hold L2');
  read('HoldL2!');
  assert.deepEqual(requests.map(request => request.body.input), ['Hold L2']);
  read('');
  assert.equal(requests[0].request.destroyed, true);

  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = {};
  requests[0].reply(response);
  response.emit('data', Buffer.from(JSON.stringify({ status: 'completed', steps: [
    { type: 'model_output', content: [{ type: 'text', text: 'Nişan almak için L2’ye bas.' }] }
  ] })));
  response.emit('end');
  await settle();
  assert.equal(stream.messages.some(message => message.type === 'objective'), false);

  read('Come here!', 90);
  assert.deepEqual(requests.map(request => request.body.input), ['Hold L2', 'Come here!']);
  stream.cancel();
});

test('native line cache and thread counters reach diagnostics without accepting invalid values', async () => {
  const service = harness();
  service.start();
  await settle();
  const worker = service.workers[0];
  worker.send({ type: 'ocr', revision: 0, text: '', confidence: 0, ocrThreads: 2, readerRuns: 8, lineCacheHits: 12 });
  assert.deepEqual(service.diagnostics().video.ocr, { threads: 2, readerRuns: 8, lineCacheHits: 12 });
  worker.send({ type: 'ocr', revision: 0, text: '', confidence: 0, ocrThreads: 'bad', readerRuns: -1, lineCacheHits: null });
  assert.deepEqual(service.diagnostics().video.ocr, { threads: 2, readerRuns: 8, lineCacheHits: 12 });
  worker.send({ type: 'ocr', revision: 0, text: '', confidence: 0, ocrThreads: 0, readerRuns: 1.5, lineCacheHits: 2.3 });
  assert.deepEqual(service.diagnostics().video.ocr, { threads: 2, readerRuns: 8, lineCacheHits: 12 });
});

test('a cancelled subscription still blocks replacement until its worker exits', async function () {
  const service = harness();
  const first = service.start();
  await settle();
  first.cancel();
  const cancelled = service.start(720);
  await settle();
  cancelled.cancel();
  const latest = service.start(1080);
  await settle();
  assert.equal(service.workers.length, 1);
  service.workers[0].exit();
  await settle();
  assert.equal(service.workers.length, 2, 'Only the latest request may start a worker');
  assert.equal(service.workers[1].commands[0].quality, 1080);
  assert.deepEqual(cancelled.messages, []);
  latest.cancel();
});

test('an unresponsive old worker is killed before its replacement starts', async function () {
  const service = harness();
  const first = service.start();
  await settle();
  first.cancel();
  service.start(1080);
  await settle();
  assert.equal(service.workers.length, 1);
  service.tick(3000);
  await settle();
  assert.equal(service.workers[0].signal, 'SIGKILL');
  assert.equal(service.workers.length, 2);
});

test('a busy console on the first attempt retries and becomes ready without another start', async function () {
  const service = harness();
  const stream = service.start(1080);
  await settle();
  service.workers[0].send({ type: 'error', text: 'Remote Play on Console is already in use' });
  service.workers[0].exit();
  assert.equal(stream.messages.at(-1).type, 'reconnecting');
  service.tick(2000);
  const retry = service.workers[1];
  assert.equal(retry.commands[0].quality, 1080);
  retry.send({ type: 'ready' });
  retry.send({ type: 'ocr', text: '', confidence: 0, revision: 0 });
  assert.ok(stream.messages.some(message => message.type === 'ready'));
});

test('a rejected reconnect handshake after a healthy stream retries and resumes real subtitles', async () => {
  const service = harness({ realFeed: true, match: text => text === 'Known.' ? { translation: 'Merhaba.', speakers: [] } : null });
  const stream = service.start();
  await settle();
  service.workers[0].send({ type: 'ready' });
  service.workers[0].send({ type: 'ocr', text: 'Known.', confidence: 99, revision: 0 });
  service.workers[0].exit();
  service.tick(2000);
  const rejected = service.workers[1];
  rejected.send({ type: 'error', text: 'Unknown Session Request Error' });
  rejected.exit();
  assert.equal(stream.messages.at(-1).type, 'reconnecting');
  service.tick(5000);
  const recovered = service.workers[2];
  recovered.send({ type: 'ready' });
  recovered.send({ type: 'ocr', text: 'Known.', confidence: 99, revision: 0 });
  assert.equal(stream.messages.at(-1).text, 'Merhaba.');
  assert.equal(service.diagnostics().video.phase, 'reading');
  assert.equal(service.diagnostics().video.lastError, undefined, 'A recovered stream must not advertise a stale current error');
});

test('unknown session handshake errors have bounded retries and do not loop indefinitely', async () => {
  const service = harness();
  const stream = service.start();
  await settle();
  for (const delay of [2000, 5000, 10000]) {
    service.workers.at(-1).send({ type: 'error', text: 'Unknown Session Request Error' });
    service.workers.at(-1).exit();
    assert.equal(stream.messages.at(-1).type, 'reconnecting');
    service.tick(delay);
  }
  service.workers.at(-1).send({ type: 'error', text: 'Unknown Session Request Error' });
  service.workers.at(-1).exit();
  assert.equal(stream.messages.at(-1).type, 'ended');
  assert.equal(service.workers.length, 4);
  assert.equal(service.timers.size, 0);
});

test('a busy console has a finite retry limit', async function () {
  const service = harness();
  const stream = service.start();
  await settle();
  for (const delay of [2000, 5000, 10000]) {
    const worker = service.workers.at(-1);
    worker.send({ type: 'error', text: 'Remote Play on Console is already in use' });
    worker.exit();
    assert.equal(stream.messages.at(-1).type, 'reconnecting');
    service.tick(delay);
  }
  service.workers.at(-1).send({ type: 'error', text: 'Remote Play on Console is already in use' });
  service.workers.at(-1).exit();
  assert.equal(service.workers.length, 4);
  assert.equal(stream.messages.at(-1).type, 'ended');
  assert.equal(service.timers.size, 0);
});

test('cancelling during retry prevents another connection', async function () {
  const service = harness();
  const stream = service.start();
  await settle();
  service.workers[0].send({ type: 'error', text: 'Remote Play on Console is already in use' });
  service.workers[0].exit();
  stream.cancel();
  assert.equal(service.timers.size, 0);
  assert.equal(service.workers.length, 1);
});

test('permanent setup errors are reported without retrying', async function () {
  const service = harness();
  const stream = service.start();
  await settle();
  service.workers[0].send({ type: 'error', text: 'Kayıtlı PS5 eşleştirmesi geçersiz.' });
  service.workers[0].exit();
  assert.equal(stream.messages.at(-1).type, 'ended');
  assert.equal(service.timers.size, 0);
});
