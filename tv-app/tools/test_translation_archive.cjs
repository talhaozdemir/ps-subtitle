'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createTranslationArchive, makeRecord } = require('../service/translation-archive');
const sample = { english: 'This line is missing.', turkish: 'Bu replik eksik.', provider: 'gemini',
  model: 'gemini-3.5-flash-lite', confidence: 97 };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-archive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timers = [];
  return { directory, options: { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; } }, timers,
    credentials() { fs.writeFileSync(path.join(directory, 'translation-archive.json'), JSON.stringify({ writeToken: 'a'.repeat(64) })); },
    queue() { return JSON.parse(fs.readFileSync(path.join(directory, 'translation-outbox.json'))); } };
}

test('unconfigured/offline archive persists records across restarts and removes them only after acknowledgement', async t => {
  const f = fixture(t), calls = [];
  const first = createTranslationArchive(f.directory, f.options);
  first.record({ ...sample, keys: { gemini: 'NEVER-SAVE-KEY' } });
  first.record(sample);
  assert.equal(first.status().pending, 1);
  assert.equal(first.status().configured, false);
  assert.equal(JSON.stringify(f.queue()).includes('NEVER-SAVE-KEY'), false);
  f.credentials();
  let offline = true;
  const restarted = createTranslationArchive(f.directory, { ...f.options, upload: async (rows, token) => {
    calls.push(rows); assert.equal(token, 'a'.repeat(64));
    if (offline) throw Error('simulated network failure with secret');
  } });
  await restarted.flush();
  assert.equal(restarted.status().pending, 1);
  assert.equal(restarted.status().lastError.includes('secret'), false);
  offline = false; await restarted.flush();
  assert.equal(restarted.status().pending, 0);
  assert.deepEqual(f.queue(), []);
  assert.equal(calls[0][0].id, calls[1][0].id, 'A retry has the same server deduplication identity');
});

test('a successful upload cannot remove a different caption added while that upload was running', async t => {
  const f = fixture(t); f.credentials();
  let acknowledge;
  const archive = createTranslationArchive(f.directory, { ...f.options,
    upload: () => new Promise(resolve => { acknowledge = resolve; }) });
  archive.record(sample);
  await new Promise(setImmediate);
  archive.record({ ...sample, english: 'Another line.', turkish: 'Başka bir replik.' });
  assert.equal(archive.status().pending, 2);
  acknowledge(); await new Promise(setImmediate);
  assert.equal(archive.status().pending, 1);
  assert.equal(f.queue()[0].english, 'Another line.');
});

test('conflicting translations are retained as separate review candidates; confidence alone does not duplicate records', () => {
  const a = makeRecord(sample), b = makeRecord({ ...sample, turkish: 'Bu satır eksik.' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, makeRecord({ ...sample, confidence: 99 }).id);
  assert.notEqual(a.id, makeRecord({ ...sample, provider: 'openai', model: 'gpt-6-luna' }).id);
  for (const bad of [{ ...sample, confidence: 71 }, { ...sample, model: 'untrusted-model' },
    { ...sample, turkish: '' }, { ...sample, english: 'x'.repeat(1441) }]) assert.throws(() => makeRecord(bad));
});

test('corrupted and full queues are preserved, never silently replaced or truncated', t => {
  const f = fixture(t), file = path.join(f.directory, 'translation-outbox.json');
  fs.writeFileSync(file, 'incomplete download');
  const corrupt = createTranslationArchive(f.directory, f.options);
  assert.throws(() => corrupt.record(sample), /okunamadı/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'incomplete download');
  assert.ok(corrupt.status().lastError);
  const full = Array.from({ length: 1000 }, (_, i) => ({ ...makeRecord({ ...sample, english: 'Line ' + i }), createdAt: Date.now() }));
  fs.writeFileSync(file, JSON.stringify(full));
  const archive = createTranslationArchive(f.directory, f.options);
  assert.throws(() => archive.record(sample), /kuyruğu dolu/);
  assert.equal(f.queue().length, 1000);
});

test('a disk failure after server success leaves retryable data intact', async t => {
  const f = fixture(t); f.credentials();
  let fail = false;
  const disk = { ...fs, renameSync(from, to) { if (fail) throw Error('disk failure'); fs.renameSync(from, to); } };
  const archive = createTranslationArchive(f.directory, { ...f.options, fs: disk, upload: async () => { fail = true; } });
  archive.record(sample); await new Promise(setImmediate);
  assert.equal(archive.status().pending, 1);
  assert.equal(f.queue().length, 1);
  const recovered = createTranslationArchive(f.directory, { ...f.options, upload: async () => {} });
  await recovered.flush();
  assert.equal(recovered.status().pending, 0);
});

test('the service-owned credentials file can be configured without returning or mixing tokens into the outbox', t => {
  const f = fixture(t), archive = createTranslationArchive(f.directory, { ...f.options, upload: async () => {} });
  archive.record(sample);
  assert.equal(archive.status().configured, false);
  assert.throws(() => archive.configure('invalid'));
  archive.configure('a'.repeat(64));
  assert.equal(archive.status().configured, true);
  assert.equal(JSON.stringify(archive.status()).includes('a'.repeat(64)), false);
  assert.equal(JSON.stringify(f.queue()).includes('a'.repeat(64)), false);
  const restarted = createTranslationArchive(f.directory, f.options);
  assert.equal(restarted.status().configured, true);
});
