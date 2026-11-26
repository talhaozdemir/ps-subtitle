'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const settle = () => new Promise(setImmediate);
const settings = require('../service/settings');
const config = { mode: 'pack', provider: 'gemini', similarity: 95, keys: { gemini: 'test-key', openai: 'other-test-key' } };

function harness() {
  const jobs = [], timers = new Map();
  let now = 1000, count = 0;
  const fakeHttps = { Agent: class {}, request(options, callback) {
    const request = new EventEmitter();
    request.end = body => jobs.push({ request, callback, body: JSON.parse(body), options });
    request.destroy = () => { request.destroyed = true; };
    return request;
  } };
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.set(++count, { fn, ms }); return count; },
    clearTimeout: id => timers.delete(id), require(name) {
      if (name === 'https') return fakeHttps;
      if (name === './settings') return settings;
      if (name === './speaker-display') return require('../service/speaker-display');
      return require(name);
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../service/translation.js'), 'utf8'), context);
  return { ...context.module.exports, jobs, timers, advance: ms => { now += ms; },
    retry() {
      const entry = [...timers].find(([, timer]) => timer.ms >= 600 && timer.ms <= 1000);
      assert.ok(entry, 'Expected one bounded retry timer');
      timers.delete(entry[0]); now += entry[1].ms; entry[1].fn();
    },
    async respond(index, text, options = {}) {
      const response = new EventEmitter();
      response.statusCode = options.status || 200;
      response.headers = options.headers || {};
      jobs[index].callback(response);
      const openai = jobs[index].options.hostname === 'api.openai.com';
      const data = options.raw === undefined ? JSON.stringify(options.reply || { status: 'completed',
        ...(openai ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } :
          { steps: [{ type: 'thought', content: [{ type: 'text', text: 'Do not display thoughts' }] },
            { type: 'model_output', content: [{ type: 'text', text }] }] }) }) : options.raw;
      // Split a multi-byte Turkish response across chunks as real HTTPS can.
      const bytes = Buffer.from(data);
      response.emit('data', bytes.subarray(0, 37));
      response.emit('data', bytes.subarray(37));
      response.emit('end');
      await settle();
    } };
}

test('Gemini and OpenAI wire requests/complete-response extraction preserve multiline dialogue and never expose thoughts', async () => {
  for (const provider of ['gemini', 'openai']) {
    const api = harness(), text = 'Jason: Wait.\nLucia: Let us go.';
    const request = api.requestTranslation({ ...config, provider }, text);
    const outcome = request.result;
    assert.equal(api.jobs[0].body.input, text);
    assert.equal(api.jobs[0].body.store, false);
    assert.equal(api.jobs[0].body.model, provider === 'gemini' ? 'gemini-3.5-flash-lite' : 'gpt-6-luna');
    assert.equal(api.jobs[0].options.path, provider === 'gemini' ? '/v1beta/interactions' : '/v1/responses');
    if (provider === 'gemini') {
      assert.equal(api.jobs[0].options.headers['Api-Revision'], '2026-05-20');
      assert.equal(api.jobs[0].options.headers['x-goog-api-key'], 'test-key');
      assert.equal(api.jobs[0].body.generation_config.thinking_level, 'minimal');
    }
    await api.respond(0, 'Bekle.\nGidelim.');
    assert.equal(await outcome, 'Bekle.\nGidelim.');
    assert.equal(api.timers.size, 0);
  }
});

test('incomplete, malformed, missing-output and oversized API replies never become subtitles', async () => {
  for (const reply of [{ status: 'incomplete', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Yarım' }] }] },
    { status: 'completed', steps: [] }, { status: 'completed', outputs: [{ text: 'old schema' }] }]) {
    const api = harness(), request = api.requestTranslation(config, 'Missing.');
    const rejected = assert.rejects(request.result, /geçerli bir çeviri/);
    await api.respond(0, '', { reply }); await rejected;
  }
  for (const raw of ['not-json', 'x'.repeat(17000)]) {
    const api = harness(), request = api.requestTranslation(config, 'Missing.');
    const rejected = assert.rejects(request.result, /geçerli bir çeviri/);
    await api.respond(0, '', { raw }); await rejected;
    assert.equal(api.timers.size, 0);
  }
});

test('missing keys, invalid input, cancellation and timeout settle cleanly without leaving timers', async () => {
  const api = harness();
  await assert.rejects(api.requestTranslation({ ...config, keys: {} }, 'Missing.').result);
  await assert.rejects(api.requestTranslation(config, 'x'.repeat(1441)).result);
  assert.equal(api.jobs.length, 0);
  const cancelled = api.requestTranslation(config, 'Missing.');
  const done = assert.rejects(cancelled.result);
  cancelled.cancel(); await done;
  assert.equal(api.jobs[0].request.destroyed, true);
  assert.equal(api.timers.size, 0);
  const timeout = api.requestTranslation(config, 'Missing.');
  const timedout = assert.rejects(timeout.result, /zaman aşımı/);
  [...api.timers.values()][0].fn(); await timedout;
  assert.equal(api.timers.size, 0);
});

test('Google object and array error envelopes identify rejected keys without copying provider error messages', async () => {
  const failure = { error: { message: 'secret-key-in-provider-message', details: [{ reason: 'API_KEY_INVALID' }] } };
  for (const reply of [failure, [failure]]) {
    const api = harness(), request = api.requestTranslation(config, 'Missing.');
    const result = assert.rejects(request.result, error => /API anahtarını/.test(error.message) && !/secret-key/.test(error.message));
    await api.respond(0, '', { status: 400, reply });
    await result;
  }
});

test('pack hits never call API; missing long OCR blocks retain line breaks and are archived only after success', async () => {
  const api = harness(), shown = [], archived = [];
  const feed = api.createSubtitleFeed(config, text => text === 'Known.' ? 'Bilinen.' : null,
    text => shown.push(text), assert.fail, null, row => archived.push(row));
  feed.read('Known.', 95);
  assert.equal(api.jobs.length, 0);
  const long = 'This missing conversation is quite long. '.repeat(12).trim() + '\nNext speaker: We should leave.';
  feed.read(long, 95);
  feed.read(long, 95);
  assert.equal(api.jobs.length, 1);
  assert.equal(api.jobs[0].body.input, long);
  assert.equal(archived.length, 0);
  await api.respond(0, 'Bu uzun bir konuşma.\nGitmeliyiz.');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].english, long);
  assert.equal(archived[0].provider, 'gemini');
  assert.equal(archived[0].confidence, 95);
  assert.equal(shown.at(-1), 'Bu uzun bir konuşma.\nGitmeliyiz.');
  feed.read(long, 95);
  assert.equal(api.jobs.length, 1);
  assert.equal(archived.length, 1);
  feed.reset();
});

test('the two-word dialogue minimum keeps single-word local hits and skips single-word API misses in both modes', async () => {
  for (const mode of ['pack', 'api']) {
    const api = harness(), shown = [], lookups = [];
    const feed = api.createSubtitleFeed({ ...config, mode }, text => {
      lookups.push(text);
      return text === 'Wait!' ? 'Bekle!' : null;
    }, text => shown.push(text), assert.fail, null, null, { minApiWords: 2 });

    assert.equal(feed.read('Wait!', 99), true);
    for (const text of ['8ABC-123', 'STOP', 'Can’t.', '— Go!', 'Jason: Wait.']) {
      assert.equal(feed.read(text, 99), false, text);
    }
    assert.deepEqual(shown, ['Bekle!']);
    assert.equal(api.jobs.length, 0);
    assert.equal(feed.diagnostics().queued, 0);

    const source = 'I\ncan’t.';
    feed.read(source, 99);
    assert.equal(lookups.includes(source), mode === 'pack');
    assert.deepEqual(api.jobs.map(job => job.body.input), [source]);
    await api.respond(0, 'Yapamam.');
    assert.deepEqual(shown, ['Bekle!', 'Yapamam.']);
    feed.reset();
  }
});

test('two fast successive captions finish and are saved, but an older completion never replaces the current source', async () => {
  const api = harness(), shown = [], archived = [];
  const feed = api.createSubtitleFeed(config, () => null, text => shown.push(text), assert.fail, null, row => archived.push(row));
  feed.read('First missing line.', 99);
  feed.read('Second missing line.', 99);
  assert.ok(api.jobs.every(job => !job.request.destroyed));
  await api.respond(1, 'İkinci.');
  await api.respond(0, 'Birinci.');
  assert.deepEqual(shown, ['İkinci.']);
  assert.equal(archived.length, 2);
  feed.reset();
});

test('a brief blank preserves the pending translation and gives it a readable inactive-source display', async () => {
  const api = harness(), shown = [], archived = [];
  const feed = api.createSubtitleFeed(config, () => null, (text, speakers, turns, details) => shown.push({ text, details }),
    assert.fail, null, row => archived.push(row));
  feed.read('Missing.', 99);
  api.advance(100); feed.read('', 0);
  api.advance(700); await api.respond(0, 'Eksik.');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].text, 'Eksik.');
  assert.equal(shown[0].details.sourceActive, false);
  assert.equal(archived.length, 1);
  feed.reset();
});

test('a newer local subtitle suppresses an older API display without losing its successful review record', async () => {
  for (const next of ['Known.']) {
    const api = harness(), shown = [], archived = [];
    const feed = api.createSubtitleFeed(config, text => text === 'Known.' ? 'Bilinen.' : null,
      text => shown.push(text), assert.fail, null, row => archived.push(row));
    feed.read('Missing.', 99); feed.read(next, 99);
    await api.respond(0, 'Eksik.');
    assert.equal(shown.includes('Eksik.'), false);
    assert.equal(archived.length, 1);
    feed.reset();
  }
});

test('request backlog is bounded; reset/key changes cannot show or archive a cancelled request', async () => {
  const api = harness(), shown = [], archived = [];
  const feed = api.createSubtitleFeed(config, () => null, text => shown.push(text), assert.fail, null, row => archived.push(row));
  feed.read('One.', 99); feed.read('Two.', 99); feed.read('Three.', 99);
  assert.equal(api.jobs.length, 2, 'The third source waits rather than aborting a paid in-flight request');
  assert.ok(api.jobs.every(job => !job.request.destroyed));
  feed.update({ ...config, keys: { ...config.keys, gemini: 'replacement' } });
  for (let i = 0; i < 2; i++) await api.respond(i, 'İptal.');
  assert.equal(shown.filter(Boolean).length, 0);
  assert.equal(archived.length, 0);
});

test('rapid source changes cannot starve in-flight translations; three conversations can finish in order', async () => {
  const api = harness(), shown = [];
  const feed = api.createSubtitleFeed(config, () => null, text => shown.push(text), assert.fail);
  feed.read('One.', 99); api.advance(200); feed.read('Two.', 99); api.advance(200); feed.read('Three.', 99);
  assert.equal(api.jobs.length, 2);
  assert.ok(api.jobs.every(job => !job.request.destroyed));
  await api.respond(0, 'Bir.');
  assert.deepEqual(shown, ['Bir.']);
  assert.equal(api.jobs.length, 3);
  assert.equal(api.jobs[2].body.input, 'Three.');
  await api.respond(1, 'İki.'); await api.respond(2, 'Üç.');
  assert.deepEqual(shown, ['Bir.', 'İki.', 'Üç.']);
  feed.reset();
});

test('API waiting queue is bounded, expires stale entries, and never issues old queued requests after cooldown', async () => {
  const api = harness(), errors = [];
  const feed = api.createSubtitleFeed(config, () => null, () => {}, error => errors.push(error));
  for (const source of ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']) feed.read(source, 99);
  assert.equal(api.jobs.length, 2);
  assert.equal(feed.diagnostics().queued, 3);
  assert.equal(feed.diagnostics().dropped, 1);
  api.advance(1600);
  await api.respond(0, 'Bir.');
  assert.equal(api.jobs.length, 2, 'Queued sources older than 1500 ms are not sent');
  assert.equal(feed.diagnostics().queued, 0);
  feed.read('Fresh.', 99);
  assert.equal(api.jobs.length, 3);
  feed.read('Queued.', 99);
  await api.respond(1, '', { status: 429, headers: { 'retry-after': '45' } });
  assert.equal(feed.diagnostics().queued, 0);
  assert.equal(api.jobs.length, 3);
  feed.reset(); await settle();
});

test('expired responses are saved but hidden; repeated current reads refresh display eligibility', async () => {
  for (const keepReading of [false, true]) {
    const api = harness(), shown = [], archived = [];
    const feed = api.createSubtitleFeed(config, () => null, text => shown.push(text), assert.fail, null, row => archived.push(row));
    feed.read('Missing.', 99);
    api.advance(3500);
    if (keepReading) feed.read('Missing.', 99);
    feed.read('', 0); api.advance(600);
    await api.respond(0, 'Eksik.');
    assert.equal(shown.length, keepReading ? 1 : 0);
    assert.equal(archived.length, 1);
    feed.reset();
  }
});

test('429 honours Retry-After and throttles future OCR calls; error messages never contain response secrets', async () => {
  const api = harness(), errors = [];
  const feed = api.createSubtitleFeed(config, () => null, assert.fail, error => errors.push(error));
  feed.read('One.', 99);
  await api.respond(0, '', { status: 429, headers: { 'retry-after': '45' }, reply: { error: { message: 'secret-provider-key' } } });
  for (let i = 0; i < 10; i++) feed.read('One.', 99);
  api.advance(44000); feed.read('Two.', 99);
  assert.equal(api.jobs.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes('secret-provider-key'), false);
  api.advance(1001); feed.read('Two.', 99);
  assert.equal(api.jobs.length, 2);
  feed.reset(); await settle();
});

test('provider failures stay visible after a short source vanished, without leaking credentials in diagnostics', async () => {
  const api = harness(), errors = [];
  const feed = api.createSubtitleFeed(config, () => null, assert.fail, message => errors.push(message));
  feed.read('Missing.', 99); feed.read('', 0);
  await api.respond(0, '', { status: 503, reply: { error: { message: 'secret-provider-key' } } });
  assert.equal(errors.length, 0, 'The first temporary response is retried quietly');
  api.retry();
  await api.respond(1, '', { status: 503, reply: { error: { message: 'secret-provider-key' } } });
  assert.equal(errors.length, 1);
  const details = JSON.parse(JSON.stringify(feed.diagnostics()));
  assert.equal(details.failed, 1);
  assert.equal(details.httpAttempts, 2);
  assert.equal(details.retried, 1);
  assert.equal(details.lastErrorStatusCode, 503);
  assert.equal(details.keyConfigured, true);
  assert.equal(details.inFlight, 0);
  assert.equal(JSON.stringify(details).includes('test-key'), false);
  assert.equal(JSON.stringify(details).includes('secret-provider-key'), false);
  feed.reset();
});

test('transient 5xx responses retry once with jitter and retain the original total timeout', async () => {
  for (const status of [500, 502, 503, 504]) {
    const api = harness(), request = api.requestTranslation(config, 'Missing.');
    api.advance(200);
    await api.respond(0, '', { status });
    assert.equal(request.stats.waitingToRetry, true);
    assert.equal(api.jobs.length, 1);
    api.retry();
    assert.equal(api.jobs.length, 2);
    assert.equal(api.jobs[1].body.input, 'Missing.');
    const timeout = [...api.timers.values()][0].ms;
    assert.ok(timeout >= 3800 && timeout <= 4200, 'Retry uses the remaining original five-second budget');
    await api.respond(1, 'Eksik.');
    assert.equal(await request.result, 'Eksik.');
    assert.equal(request.stats.attempts, 2);
    assert.equal(request.stats.retries, 1);
    assert.equal(request.stats.lastStatusCode, 200);
    assert.equal(request.stats.lastErrorStatusCode, status);
    assert.equal(api.timers.size, 0);
  }
});

test('a temporary failure preserves other queued captions instead of dropping the entire queue', async () => {
  const api = harness(), shown = [], errors = [];
  const feed = api.createSubtitleFeed(config, () => null, text => shown.push(text), error => errors.push(error));
  feed.read('One.', 99); feed.read('Two.', 99); feed.read('Three.', 99);
  await api.respond(0, '', { status: 503 });
  assert.equal(feed.diagnostics().queued, 1);
  assert.equal(feed.diagnostics().failed, 0);
  assert.equal(feed.diagnostics().retrying, 1);
  assert.equal(errors.length, 0);
  await api.respond(1, 'İki.');
  assert.equal(api.jobs[2].body.input, 'Three.');
  api.retry();
  assert.equal(api.jobs[3].body.input, 'One.');
  await api.respond(3, 'Bir.'); await api.respond(2, 'Üç.');
  assert.deepEqual(shown, ['İki.', 'Üç.'], 'A recovered old reply still cannot overwrite a newer displayed turn');
  assert.equal(feed.diagnostics().httpAttempts, 4);
  assert.equal(feed.diagnostics().completed, 3);
  assert.equal(feed.diagnostics().failed, 0);
  feed.reset();
});

test('authentication, invalid requests and rate limits are not retried automatically', async () => {
  for (const status of [400, 401, 402, 403, 404, 429]) {
    const api = harness(), request = api.requestTranslation(config, 'Missing.');
    const rejected = assert.rejects(request.result, error => error.statusCode === status);
    await api.respond(0, '', { status }); await rejected;
    assert.equal(api.jobs.length, 1);
    assert.equal(request.stats.retries, 0);
    assert.equal(api.timers.size, 0);
  }
});

test('Retry-After is never shortened to squeeze a retry into an expiring subtitle', async () => {
  const api = harness(), request = api.requestTranslation(config, 'Missing.');
  const rejected = assert.rejects(request.result, error => error.statusCode === 503 && error.retryMs === 120000);
  await api.respond(0, '', { status: 503, headers: { 'retry-after': '120' } }); await rejected;
  assert.equal(api.jobs.length, 1);
  assert.equal(api.timers.size, 0);
});

test('cancelling during backoff clears the retry and cannot start a request under the old key', async () => {
  const api = harness(), request = api.requestTranslation(config, 'Missing.');
  const rejected = assert.rejects(request.result);
  await api.respond(0, '', { status: 503 });
  request.cancel(); await rejected;
  assert.equal(api.timers.size, 0);
  assert.equal(api.jobs.length, 1);
  assert.equal(request.stats.waitingToRetry, false);
});

test('late failures and delayed retry timers cannot extend the overall five-second deadline', async () => {
  const late = harness(), request = late.requestTranslation(config, 'Missing.');
  const rejected = assert.rejects(request.result, error => error.statusCode === 503);
  late.advance(4500); await late.respond(0, '', { status: 503 }); await rejected;
  assert.equal(late.jobs.length, 1);
  const api = harness(), delayed = api.requestTranslation(config, 'Missing.');
  const expired = assert.rejects(delayed.result, /zaman aşımı/);
  await api.respond(0, '', { status: 503 });
  api.advance(5001); api.retry(); await expired;
  assert.equal(api.jobs.length, 1);
  assert.equal(api.timers.size, 0);
});

test('a successful request after a terminal error signals recovery exactly once', async () => {
  const api = harness(), errors = [], recoveries = [];
  const feed = api.createSubtitleFeed(config, () => null, () => {}, error => errors.push(error), { recovered: () => recoveries.push(true) });
  feed.read('One.', 99); await api.respond(0, '', { status: 503 }); api.retry();
  await api.respond(1, '', { status: 503 });
  assert.equal(errors.length, 1);
  assert.equal(recoveries.length, 0);
  api.advance(5001); feed.read('Two.', 99); await api.respond(2, 'İki.');
  assert.equal(recoveries.length, 1);
  assert.equal(feed.diagnostics().lastStatusCode, 200);
  assert.equal(feed.diagnostics().lastError, '');
  feed.read('Two.', 99);
  assert.equal(recoveries.length, 1);
  feed.reset();
});

test('API-only mode, weak OCR, invalid confidence and absent keys do not create missing-pack records', async () => {
  const api = harness(), archived = [];
  const feed = api.createSubtitleFeed({ ...config, mode: 'api' }, assert.fail, () => {}, assert.fail, null, row => archived.push(row));
  for (const confidence of [NaN, Infinity, -1, 71, 101, '99']) assert.equal(feed.read('Missing.', confidence), false);
  assert.equal(api.jobs.length, 0);
  feed.read('Missing.', 99); await api.respond(0, 'Eksik.');
  assert.equal(archived.length, 0);
  feed.reset();
});

test('a local save failure does not lose the displayed API translation', async () => {
  const api = harness(), shown = [], errors = [];
  const feed = api.createSubtitleFeed(config, () => null, text => shown.push(text), error => errors.push(error), null,
    () => { throw Error('disk full'); });
  feed.read('Missing.', 99); await api.respond(0, 'Eksik.');
  assert.deepEqual(shown, ['Eksik.']);
  assert.equal(errors.length, 1);
  feed.reset();
});
