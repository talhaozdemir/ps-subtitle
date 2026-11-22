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

function harness() {
  const handlers = {}, workers = [], timers = new Map();
  const files = new Map([['/media/internal/.com.gtavi.turkce.altyazi/settings.json', JSON.stringify({
    address: '192.168.1.10', port: 1, quality: 540, registKey: 'registration', rpKey: 'pairing'
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
        load: () => Promise.resolve(), createSession: () => ({ match: () => null })
      }) };
      if (name === './translation') return { createSubtitleFeed: () => ({ reset() {}, read() {} }) };
      if (name === './remote-setup') return {};
      return require(name);
    }
  });
  vm.runInContext(source, context);
  return {
    workers, timers,
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
  assert.equal(first.messages.at(-1).type, 'ready');
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
  assert.equal(next.messages.at(-1).type, 'ready');
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
  assert.equal(stream.messages.at(-1).type, 'ready');
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
