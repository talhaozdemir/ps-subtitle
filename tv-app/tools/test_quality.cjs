'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const settings = require('../service/settings');
const appDirectory = path.resolve(__dirname, '../app');

function harness(options = {}) {
  const nodes = {}, starts = [];
  const doc = { addEventListener() {}, getElementById: id => nodes[id] };
  function node() {
    return { dataset: {}, handlers: {}, style: { setProperty() {} }, value: '', hidden: false,
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute() {}, focus() {}, load() {}, appendChild() {} };
  }
  doc.createElement = node;
  const html = fs.readFileSync(path.join(appDirectory, 'index.html'), 'utf8');
  for (const found of html.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    nodes[found[1]] = node();
    nodes[found[1]].hidden = /\bhidden\b/.test(found[0]);
  }
  const paired = options.paired !== false;
  class Bridge {
    cancel() { this.cancelled = true; }
    call(uri, raw) {
      let response;
      if (uri.endsWith('/settings')) response = { returnValue: true,
        settings: settings.publicSettings({ address: '192.168.1.10', port: 2, quality: 540,
          ocrRate: 7, setupComplete: options.complete !== false,
          registKey: paired ? 'registration' : '', rpKey: paired ? 'pairing' : '' }) };
      else if (uri.endsWith('/start')) {
        starts.push({ bridge: this, payload: JSON.parse(raw) });
        return;
      } else response = { returnValue: true, devices: [] };
      this.onservicecallback(JSON.stringify(response));
    }
  }
  const win = { PalmServiceBridge: Bridge, addEventListener() {}, setTimeout() { return 1; }, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.join(appDirectory, 'app.js'), 'utf8'), {
    window: win, document: doc, performance: { now: () => 0 }
  });
  return {
    nodes, starts,
    select(quality) {
      nodes.settings.hidden = false;
      nodes.quality.value = String(quality);
      nodes.quality.handlers.change();
    },
    emit(message) { starts.at(-1).bridge.onservicecallback(JSON.stringify({ returnValue: true, ...message })); }
  };
}

test('every resolution change automatically replaces the stream and keeps settings open', function () {
  const app = harness();
  assert.equal(app.starts.length, 1, 'Startup creates the original stream');
  for (const quality of [1080, 720, 360, 540]) {
    const previous = app.starts.at(-1);
    const count = app.starts.length;
    app.select(quality);
    assert.equal(app.starts.length, count + 1);
    assert.equal(previous.bridge.cancelled, true);
    assert.equal(app.starts.at(-1).payload.quality, quality);
    assert.equal(app.starts.at(-1).payload.ocrRate, 7);
    assert.equal(app.starts.at(-1).payload.port, 2);
    assert.equal(app.nodes.settings.hidden, false);
    app.emit({ type: 'ready' });
    assert.equal(app.nodes.settings.hidden, false);
  }
});

test('selecting a resolution starts the first paired setup trial without submitting the form', function () {
  const app = harness({ complete: false });
  assert.equal(app.starts.length, 0);
  app.select(1080);
  assert.equal(app.starts.length, 1);
  assert.equal(app.starts[0].payload.quality, 1080);
  assert.equal(app.nodes.finishSetup.disabled, true);
  app.emit({ type: 'ready' });
  assert.equal(app.nodes.finishSetup.disabled, false);
  assert.equal(app.nodes.settings.hidden, false);
});

test('resolution changes do not connect an unpaired console', function () {
  const app = harness({ complete: false, paired: false });
  app.select(1080);
  assert.equal(app.starts.length, 0);
});

test('failed automatic application reports the error and another selection can reconnect', function () {
  const app = harness();
  app.select(1080);
  app.emit({ returnValue: false, errorText: 'PS5 bağlantısı kurulamadı.' });
  assert.equal(app.nodes.status.textContent, 'PS5 bağlantısı kurulamadı.');
  assert.equal(app.nodes.settings.hidden, false);
  app.select(720);
  assert.equal(app.starts.at(-1).payload.quality, 720);
  app.emit({ type: 'ready' });
  assert.equal(app.nodes.status.textContent, '');
});
