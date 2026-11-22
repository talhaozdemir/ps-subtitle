'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createPackStore } = require('../service/pack');
const { createSubtitleFeed } = require('../service/translation');
const { publicSettings } = require('../service/settings');
const { createTimeline } = require('../app/subtitle-renderer');
const root = path.resolve(__dirname, '../..');

test('current C OCR → local pack → feed → three-turn overlay, on real 540p/720p/1080p images', {
  skip: !process.env.OCR_RUNTIME || !process.env.OCR_ONNX_INCLUDE ?
    'Set OCR_RUNTIME and OCR_ONNX_INCLUDE (and OCR_VCVARS on Windows) to build and run the real reader' : false,
  timeout: 120000
}, async () => {
  const directory = process.env.OCR_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'current-ocr-'));
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'current-ocr.json');
  const top = publicSettings({}).region.y;
  const build = spawnSync(process.env.OCR_PYTHON || 'python', [path.join(__dirname, 'current_ocr.py'),
    '--runtime', process.env.OCR_RUNTIME, '--onnx-include', process.env.OCR_ONNX_INCLUDE,
    '--region-top', String(top), '--output', output], { encoding: 'utf8', timeout: 110000 });
  assert.equal(build.status, 0, [build.error, build.stdout, build.stderr].filter(Boolean).join('\n'));
  const report = JSON.parse(fs.readFileSync(output));
  for (const [file, hash] of Object.entries(report.source_sha256)) {
    assert.equal(hash, createHash('sha256').update(fs.readFileSync(path.join(root, 'tv-app/native', file))).digest('hex'));
  }
  assert.equal(report.results.length, 12);
  const packFile = process.env.MERGED_PACK || path.join(root, 'dist/subtitle.json.gz');
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(packFile)));
  const store = createPackStore(directory, packFile);
  await store.load();
  const expectedCompact = {
    security: 'Hassiktir! Dur. Hey, başa sar.\nBaşa sar.\nHım.',
    relay: 'İspanyolca: Dikkat, burada biri var!\nİspanyolca: Sağdan ikinci! Ona bas! Ona bas!\nOlmazsa bütün sıraya bas amına koyayım!'
  };
  for (const reading of report.results) {
    assert.equal(reading.candidate, true, reading.file);
    assert.equal(reading.lines, reading.region_top === 62 ? 5 : 3, reading.file);
    const session = store.createSession(), timeline = createTimeline();
    let shown;
    const feed = createSubtitleFeed({ mode: 'pack', similarity: 95, provider: 'gemini', keys: {} },
      session.match, (text, speakers, turns) => { shown = { text, speakers, turns }; timeline.read(text, speakers, 0, turns); }, assert.fail, session);
    assert.equal(feed.read(reading.text, reading.confidence), true, reading.file);
    const expected = reading.region_top === 62 ? store.match(data.speaker_metadata.records[reading.ref].english, 100, 100).translation :
      expectedCompact[reading.file.split('-')[0]];
    assert.equal(shown.text, expected, reading.file);
    assert.equal(shown.speakers.length, reading.region_top === 62 ? 3 : 2, reading.file);
    assert.equal(timeline.snapshot(2000).count, reading.region_top === 62 ? 3 : 2, 'Slow OCR must not hide any current turn');
    report.results[report.results.indexOf(reading)].translation = shown.text;
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const cache = spawnSync(process.env.OCR_PYTHON || 'python', [path.join(__dirname, 'test_cache_ocr.py'),
    '--library', path.join(directory, 'current-native', process.platform === 'win32' ? 'reader.dll' : 'reader.so'),
    '--runtime', process.env.OCR_RUNTIME, '--output', path.join(directory, 'cache-validation.json')],
    { encoding: 'utf8', timeout: 90000 });
  assert.equal(cache.status, 0, [cache.error, cache.stdout, cache.stderr].filter(Boolean).join('\n'));
});
