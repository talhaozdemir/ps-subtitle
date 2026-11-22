'use strict';

// Score every recognizer against the same current offline pack. No API calls,
// no scene anchors and no source-reference hints are passed to the reader.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { createPackStore } = require('../service/pack');

const median = values => quantile(values, 0.5);
function quantile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b), at = (sorted.length - 1) * p;
  const low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}
const normalize = text => text.replace(/\s+/g, ' ').trim();

async function run(filename) {
  const report = JSON.parse(fs.readFileSync(filename));
  const reviewFile = process.argv[3];
  const reviews = reviewFile ? JSON.parse(fs.readFileSync(reviewFile)).decisions : [];
  if (reviewFile) report.translation_review = { file: path.resolve(reviewFile), sha256: createHash('sha256').update(fs.readFileSync(reviewFile)).digest('hex') };
  const packFile = path.resolve(__dirname, '../../dist/subtitle.json.gz');
  report.pack_sha256 = createHash('sha256').update(fs.readFileSync(packFile)).digest('hex');
  const store = createPackStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-compare-pack-')),
    packFile);
  await store.load();
  function lookup(text, confidence) {
    const times = [];
    let result;
    for (let i = 0; i < 5; i++) {
      const session = store.createSession({ enabled: false });
      const start = performance.now();
      result = session.match(text, confidence, 95);
      times.push(performance.now() - start);
    }
    return { result, match_ms: median(times) };
  }
  for (const row of report.frames) {
    const expected = row.reference && lookup(row.reference, 100).result;
    row.expected_translation = expected ? expected.translation : null;
    // Regenerating the score must not treat an already scored hybrid as a model.
    for (const name of Object.keys(row.models).filter(name => name.endsWith('_then_small'))) delete row.models[name];
    for (const model of Object.values(row.models)) {
      const matched = lookup(model.text, model.confidence);
      model.pack = matched.result;
      model.match_ms = matched.match_ms;
      model.total_ms = model.median_ms + model.match_ms;
      model.correct_translation = !!expected && !!model.pack && normalize(model.pack.translation) === normalize(expected.translation);
      const review = expected && model.pack && reviews.find(item => item.id === row.id &&
        item.expected_translation === expected.translation && item.actual_translation === model.pack.translation);
      model.translation_judgment = model.correct_translation ? 'reference_equal' : review ? review.category : null;
      model.complete_translation = model.correct_translation || model.translation_judgment === 'equivalent_wording';
    }
    for (const base of ['tiny', 'tiny_latin']) {
      const fast = row.models[base], small = row.models.small;
      // Confidence alone is not enough: require a high-scoring local match.
      const fallback = !(fast.pack && fast.confidence >= 85 && fast.pack.score >= 95);
      const chosen = fallback ? small : fast;
      row.models[base + '_then_small'] = {
        pack: chosen.pack, text: chosen.text, confidence: chosen.confidence, fallback,
        total_ms: fast.total_ms + (fallback ? small.total_ms : 0),
        correct_translation: chosen.correct_translation, complete_translation: chosen.complete_translation,
        translation_judgment: chosen.translation_judgment
      };
    }
  }
  report.pack_method = {
    similarity: 95, api: false, context: false,
    expected: 'Match the annotated reference against the current pack; score only references with an unambiguous local translation.',
    hybrid: 'Tiny first. Accept only with OCR confidence >=85 and a local score >=95. Otherwise run the full Small reader on the identical crop.',
    hybrid_timing: 'Conservative sum of independently measured complete calls, including a second detector run. Both models assumed resident; not a measured live hybrid implementation.',
    timing: 'Median OCR call time + median of five current session.match calls. Excludes transport, queueing, model startup and overlay scheduling.'
  };
  report.pack_summary = {};
  for (const suite of ['live', 'multiline', 'all']) {
    const rows = report.frames.filter(row => suite === 'all' || row.suite === suite);
    const captions = rows.filter(row => row.reference), eligible = captions.filter(row => row.expected_translation);
    const blanks = rows.filter(row => !row.reference);
    const summary = report.pack_summary[suite] = {};
    for (const name of Object.keys(report.frames[0].models)) {
      const correct = eligible.filter(row => row.models[name].correct_translation);
      const common = eligible.filter(row => row.models.small.correct_translation && row.models[name].correct_translation);
      const times = captions.map(row => row.models[name].total_ms);
      summary[name] = {
        caption_frames: captions.length, eligible_captions: eligible.length, correct_translations: correct.length,
        non_reference_translations: eligible.filter(row => row.models[name].pack && !row.models[name].correct_translation).length,
        complete_translations_after_review: eligible.filter(row => row.models[name].complete_translation).length,
        unreviewed_non_reference_translations: eligible.filter(row => row.models[name].pack && !row.models[name].translation_judgment).length,
        missing_translations: eligible.filter(row => !row.models[name].pack).length,
        blank_frames: blanks.length, false_translation_on_blank: blanks.filter(row => row.models[name].pack).length,
        candidate_gated_false_translation_on_blank: blanks.filter(row => row.candidate && row.models[name].pack).length,
        median_ms: median(times), p95_ms: quantile(times, 0.95), mean_ms: times.reduce((a, b) => a + b, 0) / times.length,
        fallback_captions: captions.filter(row => row.models[name].fallback).length,
        common_correct_frames: common.length,
        paired_speedup_on_common_correct: median(common.map(row => row.models.small.total_ms / row.models[name].total_ms))
      };
    }
  }
  fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\n');
  const fields = ['suite', 'model', 'caption_frames', 'eligible_captions', 'correct_translations', 'non_reference_translations', 'complete_translations_after_review',
    'missing_translations', 'median_ms', 'p95_ms', 'fallback_captions', 'false_translation_on_blank', 'paired_speedup_on_common_correct'];
  const csv = [fields.join(',')];
  for (const [suite, models] of Object.entries(report.pack_summary)) {
    for (const [model, summary] of Object.entries(models)) csv.push(fields.map(key => key === 'suite' ? suite : key === 'model' ? model : summary[key]).join(','));
  }
  fs.writeFileSync(filename.replace(/\.json$/, '.csv'), csv.join('\n') + '\n');
  for (const [suite, models] of Object.entries(report.pack_summary)) {
    for (const [name, result] of Object.entries(models)) console.log(JSON.stringify({ suite, model: name,
      median_ms: Math.round(result.median_ms * 100) / 100, p95_ms: Math.round(result.p95_ms * 100) / 100,
      reference_equal: result.correct_translations, complete_after_review: result.complete_translations_after_review,
      eligible: result.eligible_captions, fallback: result.fallback_captions }));
  }
}

run(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
