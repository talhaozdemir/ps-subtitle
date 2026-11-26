'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTimeline, readingDuration, placeSubtitleStack, hdmiSubtitleArea } = require('../app/subtitle-renderer');
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
  const remaining = timeline.snapshot(601);
  assert.equal(remaining.text, long);
  assert.equal(remaining.blocks[0].age, 1);
  assert.equal(timeline.snapshot(2599).text, long);
  assert.equal(timeline.snapshot(2600).text, '');
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

test('rolling multi-turn OCR blocks preserve order and speaker offsets for the last three conversations by default', () => {
  const timeline = createTimeline();
  const read = (texts, at) => timeline.read(texts.join('\n'), texts.map((text, i) => ({
    offset: texts.slice(0, i).join('\n').length + (i ? 1 : 0), name: 'Konuşmacı ' + text, color: '#99EEFF'
  })), at);
  read(['A', 'B', 'C'], 0);
  let result = read(['A', 'B', 'C', 'D'], 100);
  assert.equal(result.text, 'B\n\nC\n\nD');
  assert.deepEqual(result.speakers.map(span => span.offset), [0, 3, 6]);
  assert.deepEqual(result.blocks.map(block => block.age), [2, 1, 0]);
  result = read(['A', 'B', 'C', 'D'], 200);
  assert.equal(result.text, 'B\n\nC\n\nD');
  assert.equal(result.count, 3);
  assert.equal(read(['B', 'C', 'D'], 300).text, 'B\n\nC\n\nD');
});

test('the saved limit counts the current caption and keeps recent history through consecutive changes', () => {
  const appearance = publicSettings({}).appearance;
  assert.equal(appearance.subtitleCount, 3);
  assert.equal(subtitleAppearance({ ...appearance, subtitleCount: undefined }).subtitleCount, 3);
  for (const subtitleCount of [2, 3, 4]) {
    const saved = subtitleAppearance({ ...appearance, subtitleCount });
    const timeline = createTimeline();
    timeline.setLimit(publicSettings({ appearance: saved }).appearance.subtitleCount);
    const captions = ['A', 'B', 'C', 'D', 'E'];
    captions.forEach((caption, index) => timeline.read(caption, [], index * 800));
    assert.deepEqual(timeline.snapshot(3200).blocks.map(block => block.text), captions.slice(-subtitleCount));
    assert.equal(timeline.snapshot(5699).count, subtitleCount);
    assert.equal(timeline.snapshot(5700).text, 'E');
  }
  for (const subtitleCount of [1, 5, 2.5, '3', null]) {
    assert.throws(() => subtitleAppearance({ ...appearance, subtitleCount }));
  }
});

test('unlabelled complete turn boundaries split blocks but wrapped lines stay together', () => {
  const timeline = createTimeline(), text = 'Kapıyı aç.\nArka tarafta bekle.\nTamam.';
  const result = timeline.read(text, [], 0, [0, text.indexOf('Tamam.')]);
  assert.equal(result.count, 2);
  assert.equal(result.text, 'Kapıyı aç.\nArka tarafta bekle.\n\nTamam.');
  timeline.clear();
  assert.equal(timeline.read(text, [], 0, [0, 3]).count, 1, 'Invalid boundaries cannot slice words');
});

test('identical turns stay distinct and repeated OCR does not revive the previous turn', () => {
  const timeline = createTimeline();
  const read = at => timeline.read('Tamam.\nTamam.', [], at, [0, 7]);
  const pair = read(0).blocks;
  assert.deepEqual(pair.map(block => block.age), [1, 0]);
  assert.notEqual(pair[0].id, pair[1].id);
  assert.deepEqual(read(2499).blocks, pair);
  assert.deepEqual(read(2500).blocks, [pair[1]]);
  for (let at = 4000; at <= 15000; at += 2000) {
    assert.deepEqual(read(at).blocks, [pair[1]]);
  }
  assert.deepEqual(timeline.read('Tamam.', [], 15100).blocks, [pair[1]]);
});

test('brief OCR gaps keep a visible caption in the same slot', () => {
  const timeline = createTimeline();
  const text = 'Kapıyı aç.\nArka tarafta bekle.';
  const first = timeline.read(text, [], 0).blocks;
  for (const at of [100, 300, 500]) {
    timeline.release(at);
    assert.deepEqual(timeline.read(text, [], at + 50).blocks, first);
  }

  // The same words can be a new turn after the current one has expired.
  const short = timeline.read('Tamam.', [], 600).blocks[1];
  timeline.release(700);
  assert.equal(timeline.snapshot(1100).text, text);
  const repeated = timeline.read('Tamam.', [], 1200).blocks;
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[1].id, short.id);
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

test('a direct change keeps the prior turn briefly even after its minimum reading time passed', () => {
  const timeline = createTimeline();
  const old = timeline.read('Tamam.', [], 0).blocks[0];
  const next = timeline.read('Başla.', [], 2000).blocks;
  assert.deepEqual(next[0], { ...old, age: 1 });
  assert.deepEqual(timeline.snapshot(4499).blocks, next);
  assert.deepEqual(timeline.snapshot(4500).blocks, [next[1]]);
});

const geometry = { height: 1080, position: 'bottom', offset: 20, paddingY: 10, lineHeight: 40 };
const block = (id, height = 40, age = 0) => ({ id, height, age });

test('the caption stack grows upward as more text arrives', () => {
  const short = placeSubtitleStack([block(1)], geometry)[1];
  const tall = placeSubtitleStack([block(1, 40, 1), block(2, 80)], geometry);
  assert.equal(tall[2].top + tall[2].height, short.top + short.height);
  assert.ok(tall[1].top < short.top);
});

test('HDMI keeps the bottom preference and places subtitles just above the OCR band', () => {
  const appearance = { ...geometry, fontSize: 36 };
  const area = hdmiSubtitleArea({ y: 72, height: 27 }, { y: 93, height: 7 }, geometry.height, appearance);
  const options = { ...geometry, safeTop: area.top, safeBottom: geometry.height - area.bottom };
  const caption = placeSubtitleStack([block(1, 45)], options)[1];
  assert.equal(area.bottom, 766);
  assert.ok(caption.top > geometry.height * 0.65);
  assert.equal(caption.top + caption.height + geometry.paddingY, area.bottom);

  const withObjective = placeSubtitleStack([block(1, 45)], { ...options, bottomInset: 42 })[1];
  assert.equal(withObjective.top + withObjective.height + geometry.paddingY + 42, area.bottom);

  const withBlur = placeSubtitleStack([block(1, 45)], { ...options, backgroundBlur: 12 })[1];
  assert.equal(withBlur.top + withBlur.height + geometry.paddingY + 36, area.bottom);
});

test('HDMI keeps the configured position when its anchor is outside the OCR band', () => {
  const regions = [{ y: 36, height: 18 }, { y: 55, height: 5 }];
  for (const position of ['top', 'bottom']) {
    const options = { ...geometry, position };
    const safe = hdmiSubtitleArea(...regions, options.height, options);
    const requested = placeSubtitleStack([block(1)], options);
    const guarded = placeSubtitleStack([block(1)], {
      ...options, safeTop: safe.top, safeBottom: options.height - safe.bottom
    });
    assert.deepEqual(guarded, requested);
  }
});

test('the previous caption moves above the current caption and reserves only its scaled height', () => {
  for (const position of ['bottom', 'top']) {
    const options = { ...geometry, position };
    const first = placeSubtitleStack([block(1)], options)[1];
    const pair = placeSubtitleStack([block(1, 40, 1), block(2, 80)], options);
    assert.equal(pair[1].height, 36);
    assert.ok(pair[1].top < first.top);
    assert.equal(pair[2].top, pair[1].top + pair[1].height + 4);
    assert.deepEqual(pair[2], placeSubtitleStack([block(2, 80)], options)[2]);
  }
});

test('previous captions keep their size and position when the current one expires first', () => {
  const history = [block(1, 40, 2), block(2, 40, 1)], current = block(3, 80);
  const before = placeSubtitleStack([...history, current], geometry);
  const after = placeSubtitleStack(history, geometry, current.height);
  assert.deepEqual(after, { 1: before[1], 2: before[2] });
});

test('both captions fit inside the safe area even if the top setting leaves no room above its anchor', () => {
  const options = { ...geometry, position: 'top', offset: 0, safeTop: 100, safeBottom: 780, bottomInset: 20 };
  const pair = placeSubtitleStack([block(1, 40, 1), block(2, 80)], options);
  assert.equal(pair[1].top, 110);
  assert.equal(pair[2].top, 150);
  assert.ok(pair[2].top + pair[2].height + options.paddingY <= 280);
});

test('when the safe area is tight the longest current caption gets all available space', () => {
  const options = { ...geometry, safeTop: 600, safeBottom: 200 };
  const pair = placeSubtitleStack([block(1, 80, 1), block(2, 400)], options);
  assert.deepEqual(pair, { 2: { top: 610, height: 260 } });
});

test('limited vertical space trims the oldest history before placing the newest captions', () => {
  const rows = [block(1, 40, 3), block(2, 40, 2), block(3, 40, 1), block(4)];
  const fullStack = placeSubtitleStack(rows, geometry);
  assert.deepEqual(Object.values(fullStack).map(position => position.height), [28, 32, 36, 40]);
  const options = { ...geometry, safeTop: 710, safeBottom: 210 };
  const stack = placeSubtitleStack(rows, options);
  assert.deepEqual(Object.keys(stack), ['2', '3', '4']);
  assert.equal(stack[2].top + stack[2].height + 4, stack[3].top);
  assert.equal(stack[3].top + stack[3].height + 4, stack[4].top);
});
