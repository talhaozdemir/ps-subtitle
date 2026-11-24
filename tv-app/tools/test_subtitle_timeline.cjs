'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTimeline, readingDuration, createPinnedLayout, hdmiSubtitleArea } = require('../app/subtitle-renderer');
const { subtitleAppearance, publicSettings } = require('../service/settings');

test('reading time follows length, two physical rows and the saved multiplier', () => {
  assert.equal(readingDuration('Tamam.', 100), 500);
  assert.equal(readingDuration('Kapıyı aç.\nArka tarafta bekle.', 100), 2500);
  assert.equal(readingDuration('Kapıyı aç.\nArka tarafta bekle.', 200), 5000);
  assert.ok(readingDuration('Bu oldukça uzun bir konuşma, '.repeat(8), 100) > 2500);
  const original = publicSettings({}).appearance;
  for (const scale of [50, 100, 175, 300]) {
    const saved = subtitleAppearance({ ...original, durationScale: scale });
    assert.equal(publicSettings({ appearance: saved }).appearance.durationScale, scale);
  }
  assert.equal(subtitleAppearance({ ...original, durationScale: undefined }).durationScale, 100);
  for (const durationScale of [0, 49, 101, 325, '200', NaN]) {
    assert.throws(() => subtitleAppearance({ ...original, durationScale }));
  }
});

test('a short reply expires independently while the previous long conversation remains readable', () => {
  const timeline = createTimeline(), long = 'Kapıyı aç.\nArka tarafta bekle.';
  timeline.read(long, [], 0);
  timeline.read('Tamam.', [], 100);
  timeline.release(200);
  assert.equal(timeline.snapshot(601).text, long);
  assert.equal(timeline.snapshot(2499).text, long);
  assert.equal(timeline.snapshot(2500).text, '');
});

test('the multiplier applies to active and retained conversations without losing their start time', () => {
  const timeline = createTimeline();
  timeline.setScale(200, 0);
  timeline.read('Tamam.', [], 0);
  timeline.release(100);
  assert.equal(timeline.snapshot(999).text, 'Tamam.');
  timeline.setScale(300, 999);
  assert.equal(timeline.snapshot(1499).text, 'Tamam.');
  assert.equal(timeline.snapshot(1500).text, '');
});

test('rolling multi-turn OCR blocks preserve order, speaker offsets and the last three conversations', () => {
  const timeline = createTimeline();
  const read = (texts, at) => timeline.read(texts.join('\n'), texts.map((text, i) => ({
    offset: texts.slice(0, i).join('\n').length + (i ? 1 : 0), name: 'Konuşmacı ' + text, color: '#99EEFF'
  })), at);
  read(['A', 'B', 'C'], 0);
  let result = read(['A', 'B', 'C', 'D'], 100);
  assert.equal(result.text, 'B\n\nC\n\nD');
  assert.deepEqual(result.speakers.map(span => span.offset), [0, 3, 6]);
  result = read(['A', 'B', 'C', 'D'], 200);
  assert.equal(result.text, 'B\n\nC\n\nD');
  assert.equal(result.count, 3);
  assert.equal(read(['B', 'C', 'D'], 300).text, 'B\n\nC\n\nD');
});

test('unlabelled complete turn boundaries split blocks but wrapped lines stay together', () => {
  const timeline = createTimeline(), text = 'Kapıyı aç.\nArka tarafta bekle.\nTamam.';
  const result = timeline.read(text, [], 0, [0, text.indexOf('Tamam.')]);
  assert.equal(result.count, 2);
  assert.equal(result.text, 'Kapıyı aç.\nArka tarafta bekle.\n\nTamam.');
  timeline.clear();
  assert.equal(timeline.read(text, [], 0, [0, 3]).count, 1, 'Invalid boundaries cannot slice words');
});

test('identical turns in one source block remain distinct and do not disappear during repeated OCR', () => {
  const timeline = createTimeline();
  for (let at = 0; at <= 15000; at += 2000) {
    assert.equal(timeline.read('Tamam.\nTamam.', [], at, [0, 7]).count, 2);
  }
  assert.equal(timeline.read('Tamam.', [], 15100).count, 1, 'A scrolling block retains the newest occurrence');
});

test('a composed group never conceals the individual speakers inside that group', () => {
  const timeline = createTimeline();
  const state = timeline.read('A\nB\nC', [
    { offset: 0, name: 'Jason' }, { offset: 2, name: 'Lucia' }, { offset: 4, name: 'Jason' }
  ], 0, [0, 4]);
  assert.equal(state.count, 3);
  assert.equal(state.text, 'A\n\nB\n\nC');
});

test('turn identifiers survive scrolling, and equivalent OCR wrapping never rewrites text being read', () => {
  const timeline = createTimeline();
  const text = 'Burada bekle.\nKapıyı kontrol et.';
  const first = timeline.read(text, [], 0);
  const repeated = timeline.read('Burada bekle. Kapıyı kontrol et!', [], 100);
  assert.equal(repeated.blocks[0].id, first.blocks[0].id);
  assert.equal(repeated.blocks[0].text, text);
  const next = timeline.read('Tamam.', [], 200);
  assert.equal(next.blocks[0].id, first.blocks[0].id);
  assert.notEqual(next.blocks[1].id, first.blocks[0].id);
});

const geometry = { width: 1920, height: 1080, position: 'bottom', offset: 20, paddingY: 10 };
const block = (id, height = 43.2) => ({ id, height });

test('HDMI keeps the bottom preference and places subtitles just above the OCR band', () => {
  const appearance = { ...geometry, fontSize: 36 };
  const area = hdmiSubtitleArea({ y: 72, height: 27 }, { y: 93, height: 7 }, geometry.height, appearance);
  const options = { ...geometry, safeTop: area.top, safeBottom: geometry.height - area.bottom };
  const caption = createPinnedLayout().place([block(1, 45)], options)[0];
  assert.equal(area.bottom, 766);
  assert.ok(caption.top > geometry.height * 0.65);
  assert.equal(caption.top + caption.height + geometry.paddingY, area.bottom);

  const withObjective = createPinnedLayout().place([block(1, 45)], { ...options, bottomInset: 42 })[0];
  assert.equal(withObjective.top + withObjective.height + geometry.paddingY + 42, area.bottom);
});

test('HDMI keeps the configured position when its anchor is outside the OCR band', () => {
  const regions = [{ y: 36, height: 18 }, { y: 55, height: 5 }];
  for (const position of ['top', 'bottom']) {
    const options = { ...geometry, position };
    const safe = hdmiSubtitleArea(...regions, options.height, options);
    const requested = createPinnedLayout().place([block(1)], options);
    const guarded = createPinnedLayout().place([block(1)], {
      ...options, safeTop: safe.top, safeBottom: options.height - safe.bottom
    });
    assert.deepEqual(guarded, requested);
  }
});

test('new captions sit four pixels below existing captions without moving the text being read', () => {
  for (const position of ['bottom', 'top']) {
    const layout = createPinnedLayout(), options = { ...geometry, position };
    const first = layout.place([block(1)], options)[0];
    const two = layout.place([block(1), block(2, 86.4)], options);
    assert.equal(two[0].top, first.top);
    assert.ok(Math.abs(two[1].top - (first.top + first.height + 4)) < 0.001);
    const three = layout.place([block(1), block(2, 86.4), block(3)], options);
    assert.deepEqual(three.slice(0, 2), two);
    assert.ok(Math.abs(three[2].top - (two[1].top + two[1].height + 4)) < 0.001);
  }
});

test('expiration of an earlier caption does not pull a surviving caption up', () => {
  const layout = createPinnedLayout();
  const before = layout.place([block(1), block(2)], geometry);
  const after = layout.place([block(2), block(3)], geometry);
  assert.deepEqual(after[0], before[1]);
  layout.place([], geometry);
  assert.equal(layout.place([block(4)], geometry)[0].top, before[0].top, 'A fully empty overlay resets its anchor');
});

test('continuous conversation reuses free space without moving survivors or exceeding the screen', () => {
  const layout = createPinnedLayout();
  let before = [];
  for (let id = 1; id <= 30; id++) {
    const rows = [id - 2, id - 1, id].filter(value => value > 0).map(value => block(value));
    const after = layout.place(rows, geometry);
    for (const previous of before) {
      const survivor = after.find(row => row.id === previous.id);
      if (survivor) assert.equal(survivor.top, previous.top);
    }
    const sorted = [...after].sort((a, b) => a.top - b.top);
    sorted.forEach((row, i) => {
      assert.ok(row.top >= 18 && row.top + row.height <= 1062);
      if (i) assert.ok(row.top >= sorted[i - 1].top + sorted[i - 1].height + 3.999);
    });
    before = after;
  }
});

test('oversized caption groups retire the oldest block without resurrecting it or shifting survivors', () => {
  const layout = createPinnedLayout();
  const before = layout.place([block(1, 400), block(2, 400)], geometry);
  const after = layout.place([block(1, 400), block(2, 400), block(3, 400)], geometry);
  assert.deepEqual(after.find(row => row.id === 2), before.find(row => row.id === 2));
  assert.equal(after.some(row => row.id === 1), false);
  assert.deepEqual(layout.place([block(1, 400), block(2, 400), block(3, 400)], geometry), after);
});
