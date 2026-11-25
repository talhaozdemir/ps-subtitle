'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const settings = require('../service/settings');
const renderer = require('../app/subtitle-renderer');
const appDirectory = path.resolve(__dirname, '../app');

function harness(options = {}) {
  const nodes = {}, starts = [], calls = [], events = {};
  const timers = new Map();
  let now = 0, timerId = 0, renders = 0;
  const doc = { hidden: false, addEventListener(name, handler) { (events[name] || (events[name] = [])).push(handler); }, getElementById: id => nodes[id] };
  function node() {
    return { dataset: {}, handlers: {}, style: { setProperty() {} }, value: '', hidden: false, offsetHeight: 40, children: [],
      set textContent(text) { this.text = text; this.children.length = 0; }, get textContent() { return this.text; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute() {}, focus() { doc.activeElement = this; }, load() {}, appendChild(child) { this.children.push(child); } };
  }
  doc.createElement = node;
  doc.body = node();
  const html = fs.readFileSync(path.join(appDirectory, 'index.html'), 'utf8');
  for (const found of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    nodes[found[1]] = node();
    nodes[found[1]].hidden = /\bhidden\b/.test(found[0]);
  }
  const paired = options.paired !== false;
  class Bridge {
    cancel() { this.cancelled = true; }
    call(uri, raw) {
      calls.push({ bridge: this, uri, payload: JSON.parse(raw) });
      let response;
      if (uri.endsWith('/settings')) response = { returnValue: true,
        settings: settings.publicSettings({ address: '192.168.1.10', port: 2, quality: 540,
          ocrRate: 7, setupComplete: options.complete !== false, objectiveRegion: options.objectiveRegion,
          registKey: paired ? 'registration' : '', rpKey: paired ? 'pairing' : '' }) };
      else if (uri.endsWith('/start')) {
        starts.push({ bridge: this, payload: JSON.parse(raw) });
        return;
      } else response = { returnValue: true, devices: [] };
      this.onservicecallback(JSON.stringify(response));
    }
  }
  const win = { PalmServiceBridge: Bridge, innerHeight: 1080, addEventListener() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(appDirectory, 'app.js'), 'utf8'), {
    window: win, document: doc, performance: { now: () => now },
    SubtitleRenderer: Object.assign({}, renderer, {
      render(element, text) { renders++; element.textContent = text; },
      renderTimeline(element, state) { renders++; element.textContent = state.text; }
    })
  });
  return {
    nodes, starts, calls, renders: () => renders,
    focus: () => doc.activeElement,
    key(keyCode) {
      const event = { keyCode, target: doc.activeElement, preventDefault() { this.defaultPrevented = true; } };
      (events.keydown || []).forEach(handler => handler(event));
      if (keyCode === 13 && !event.defaultPrevented && event.target.handlers.click) event.target.handlers.click(event);
    },
    visibility(hidden) { doc.hidden = hidden; (events.visibilitychange || []).forEach(handler => handler()); },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = Array.from(timers).filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = target;
    },
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

test('slow OCR keeps the latest conversation visible without blinking or redrawing', function () {
  const app = harness();
  const read = () => app.emit({ type: 'subtitle', text: 'Tamam.' });
  read();
  for (let i = 0; i < 5; i++) {
    app.advance(2000);
    assert.equal(app.nodes.subtitle.hidden, false, 'Slow inference must not hide the current source');
    read();
    assert.equal(app.nodes.subtitle.hidden, false, 'A fresh result must restore the same translation');
    assert.equal(app.nodes.subtitle.textContent, 'Tamam.');
  }
  assert.equal(app.renders(), 1);
  app.advance(10000);
  assert.equal(app.nodes.subtitle.hidden, true, 'A dead stream has a finite watchdog');
  read();
  assert.equal(app.nodes.subtitle.hidden, false, 'A fresh result restores an expired source');
});

test('objectives stay visible through dialogue changes and hide immediately on the service clear event', () => {
  const app = harness();
  app.emit({ type: 'subtitle', text: 'Gazla!' });
  app.emit({ type: 'objective', text: 'Kasayı çıkarmak için R2’ye bas.' });
  app.emit({ type: 'hint', text: 'El ele tutuş' });
  app.advance(12000);
  app.emit({ type: 'subtitle', text: 'Çıkmıyor!' });
  assert.equal(app.nodes.objective.hidden, false);
  assert.equal(app.nodes.objective.textContent, 'Kasayı çıkarmak için R2’ye bas.');
  app.emit({ type: 'objective', text: '' });
  assert.equal(app.nodes.objective.hidden, true);
  assert.equal(app.nodes.hint.hidden, false);
  assert.equal(app.nodes.hint.textContent, 'El ele tutuş');
  assert.equal(app.nodes.subtitle.textContent, 'Çıkmıyor!');
  app.emit({ type: 'objective', text: 'Tekrar dene.' });
  app.emit({ type: 'reconnecting' });
  assert.equal(app.nodes.objective.hidden, true);
  assert.equal(app.nodes.hint.hidden, true);
});

test('the objective editor reuses the adjustable rectangle and sends a separate settings target', () => {
  const app = harness();
  app.nodes.editObjectiveArea.handlers.click();
  assert.equal(app.nodes.regionEditor.hidden, false);
  app.nodes.regionPresets.children.find(button => button.textContent === 'Özel').handlers.click();
  assert.equal(app.nodes.regionTitle.textContent, 'Görev yazısı alanını taşı');
  app.key(39);
  app.advance(90);
  const preview = app.calls.at(-1);
  assert.equal(preview.uri.endsWith('/setRegion'), true);
  assert.equal(preview.payload.target, 'objectiveRegion');
  assert.equal(preview.payload.preview, true);
  assert.equal(preview.payload.region.x, 25);
  app.emit({ type: 'objective', text: 'Görev çevirisi' });
  assert.equal(app.nodes.objective.hidden, true);
  app.nodes.regionAction.handlers.click();
  app.nodes.regionAction.handlers.click();
  assert.equal(app.calls.at(-1).payload.target, 'objectiveRegion');
  assert.equal(app.calls.at(-1).payload.save, true);
  assert.equal(app.nodes.regionEditor.hidden, true);
  assert.equal(app.nodes.objective.textContent, 'Görev çevirisi');
  assert.equal(app.nodes.objective.hidden, false);
});

test('Size 2 can be selected with the remote, previewed, cancelled, and saved', () => {
  const custom = { x: 30, y: 90, width: 42, height: 8 };
  const size2 = { x: 24, y: 93, width: 52, height: 7 };
  const app = harness({ objectiveRegion: custom });
  function chooseSize2() {
    app.nodes.editObjectiveArea.handlers.click();
    assert.deepEqual(app.nodes.regionPresets.children.map(button => button.textContent), ['Boyut 2', 'Özel']);
    assert.equal(app.focus().textContent, 'Özel');
    app.key(37);
    assert.equal(app.focus().textContent, 'Boyut 2');
    app.key(13);
    assert.equal(app.nodes.regionPresets.hidden, true);
    app.advance(90);
    assert.deepEqual(app.calls.at(-1).payload.region, size2);
    assert.equal(app.calls.at(-1).payload.preview, true);
  }
  chooseSize2();
  app.key(461);
  assert.deepEqual(app.calls.at(-1).payload.region, custom);
  assert.equal(app.calls.at(-1).payload.save, false);
  chooseSize2();
  app.key(13);
  assert.deepEqual(app.calls.at(-1).payload.region, size2);
  assert.equal(app.calls.at(-1).payload.save, true);
  app.nodes.editObjectiveArea.handlers.click();
  assert.equal(app.focus().textContent, 'Boyut 2');
});

test('a late API reply after the source disappeared is visible for its reading duration', () => {
  const app = harness();
  app.emit({ type: 'subtitleIdle' });
  app.advance(1000);
  app.emit({ type: 'subtitle', text: 'Bekle.', sourceActive: false });
  assert.equal(app.nodes.subtitle.hidden, false);
  app.advance(499);
  assert.equal(app.nodes.subtitle.hidden, false);
  app.advance(1);
  assert.equal(app.nodes.subtitle.hidden, true, 'Inactive short replies use their minimum, not the 10-second watchdog');
});

test('a late two-line API reply remains readable for 2.5 seconds despite repeated blank OCR', () => {
  const app = harness(), text = 'Kapıyı aç.\nBurada bekle.';
  app.emit({ type: 'subtitle', text, sourceActive: false });
  for (let i = 0; i < 24; i++) { app.advance(100); app.emit({ type: 'subtitleIdle' }); }
  assert.equal(app.nodes.subtitle.hidden, false);
  assert.equal(app.nodes.subtitle.textContent, text);
  app.advance(100);
  assert.equal(app.nodes.subtitle.hidden, true);
});

test('frequent repeated readings extend visibility without redrawing or accumulating text', function () {
  const app = harness();
  for (let i = 0; i < 5; i++) {
    app.emit({ type: 'subtitle', text: 'Kapıyı aç.\nHemen gel.' });
    app.advance(1000);
    assert.equal(app.nodes.subtitle.hidden, false);
  }
  assert.equal(app.renders(), 1);
  app.emit({ type: 'subtitle', text: 'Burada bekle.' });
  assert.equal(app.nodes.subtitle.textContent, 'Burada bekle.');
  app.emit({ type: 'subtitleIdle' });
  app.advance(1000);
  assert.equal(app.nodes.subtitle.hidden, true);
  app.emit({ type: 'subtitle', text: '' });
  app.emit({ type: 'subtitle', text: 'Burada bekle.' });
  assert.equal(app.nodes.subtitle.hidden, false);
});

test('new conversations appear below older ones, with independent length-based expiry and a three-turn cap', function () {
  const app = harness();
  const long = 'Kapıyı kontrol et.\nArka tarafta seni bekliyor olacağım.';
  app.emit({ type: 'subtitle', text: long });
  app.advance(100);
  app.emit({ type: 'subtitle', text: 'Tamam.' });
  assert.equal(app.nodes.subtitle.textContent, long + '\n\nTamam.');
  app.advance(100);
  app.emit({ type: 'subtitle', text: 'Git.' });
  assert.equal(app.nodes.subtitle.textContent, long + '\n\nTamam.\n\nGit.');
  app.advance(100);
  app.emit({ type: 'subtitle', text: 'Dur.' });
  assert.equal(app.nodes.subtitle.textContent, 'Tamam.\n\nGit.\n\nDur.');
  app.advance(400);
  assert.equal(app.nodes.subtitle.textContent, 'Dur.');
  app.emit({ type: 'subtitleIdle' });
  app.advance(100);
  assert.equal(app.nodes.subtitle.hidden, true);
});

test('screen saver requests are vetoed throughout gameplay and released when the app leaves the foreground', () => {
  const app = harness();
  const registrations = () => app.calls.filter(call => call.uri.endsWith('/registerScreenSaverRequest'));
  const guard = registrations()[0];
  assert.equal(guard.payload.subscribe, true);
  for (const request of [{ state: 'Active', timestamp: '100' }, { timestamp: 200 }]) {
    guard.bridge.onservicecallback(JSON.stringify({ returnValue: true, ...request }));
    const reply = app.calls.at(-1);
    assert.ok(reply.uri.endsWith('/responseScreenSaverRequest'));
    assert.deepEqual(reply.payload, { clientName: 'com.gtavi.turkce', ack: false, timestamp: request.timestamp });
  }
  const count = app.calls.length;
  guard.bridge.onservicecallback(JSON.stringify({ returnValue: true, state: 'Inactive', timestamp: '300' }));
  guard.bridge.onservicecallback('{bad json');
  assert.equal(app.calls.length, count);
  app.visibility(true);
  assert.equal(guard.bridge.cancelled, true);
  guard.bridge.onservicecallback(JSON.stringify({ returnValue: true, timestamp: '400' }));
  assert.equal(app.calls.filter(call => call.uri.endsWith('/responseScreenSaverRequest')).length, 2);
  app.visibility(false);
  assert.equal(registrations().length, 2);
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

test('API recovery clears its stale error notice without clearing a newer connection notice', () => {
  const app = harness();
  app.emit({ type: 'translationError', text: 'Gemini temporarily unavailable.' });
  assert.equal(app.nodes.status.textContent, 'Gemini temporarily unavailable.');
  app.emit({ type: 'translationRecovered' });
  assert.equal(app.nodes.status.textContent, '');
  assert.equal(app.nodes.notice.hidden, true);
  app.emit({ type: 'translationError', text: 'Gemini temporarily unavailable.' });
  app.emit({ type: 'reconnecting' });
  const connection = app.nodes.status.textContent;
  app.emit({ type: 'translationRecovered' });
  assert.equal(app.nodes.status.textContent, connection);
  assert.match(connection, /PS5/);
});
