import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { unstable_dev } from 'wrangler';

const require = createRequire(import.meta.url);
const { makeRecord } = require('../../tv-app/service/translation-archive.js');
const { exportCandidates } = require('../../tv-app/tools/export_api_translations.cjs');
const write = 'a'.repeat(64), read = 'b'.repeat(64);
let worker;
const row = (english = 'Unlisted conversation.', turkish = 'Listede olmayan konuşma.') => ({
  ...makeRecord({ english, turkish, provider: 'gemini', model: 'gemini-3.5-flash-lite', confidence: 97 }), createdAt: Date.now()
});
const request = (method, path = '/api/translations', token, body) => worker.fetch('http://worker.test' + path, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
});

before(async () => {
  worker = await unstable_dev('worker.mjs', { config: 'wrangler.jsonc', local: true, ip: '127.0.0.1',
    port: 0, inspectorPort: 0, persist: false, logLevel: 'error',
    vars: { TRANSLATION_WRITE_TOKEN: write, TRANSLATION_READ_TOKEN: read },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
});
after(async () => { if (worker) await worker.stop(); });

test('real workerd/SQLite archive requires separate read/write credentials and rejects untrusted methods', async () => {
  assert.equal((await request('GET')).status, 403);
  assert.equal((await request('GET', undefined, write)).status, 403);
  assert.equal((await request('POST', undefined, read, { records: [row()] })).status, 403);
  assert.equal((await request('GET', undefined, 'c'.repeat(64))).status, 403);
  assert.equal((await request('DELETE', undefined, write)).status, 405);
  assert.equal((await request('GET', undefined, read)).status, 200);
});

test('archive retries deduplicate exactly; conflicting translations survive and arbitrary fields/keys are excluded', async () => {
  const first = row(), variant = row('Unlisted conversation.', 'Kaydı olmayan konuşma.');
  let response = await request('POST', undefined, write, { records: [{ ...first, apiKey: 'DO-NOT-STORE' }, variant] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).saved, [first.id, variant.id]);
  response = await request('POST', undefined, write, { records: [first] });
  assert.equal(response.status, 200);
  const exported = await (await request('GET', undefined, read)).json();
  assert.equal(exported.records.length, 2);
  assert.equal(exported.reviewRequired, true);
  assert.ok(exported.records.every(record => record.review_status === 'unreviewed'));
  assert.equal(JSON.stringify(exported).includes('DO-NOT-STORE'), false);
  assert.deepEqual(exported.records.map(record => record.turkish), [first.turkish, variant.turkish]);
});

test('invalid/oversized batches are rejected atomically, including forged hashes and unknown providers', async () => {
  const first = row('Must not be saved.', 'Kaydedilmemeli.');
  for (const bad of [{ ...row(), id: 'f'.repeat(64) }, { ...row(), provider: 'other' },
    { ...row(), confidence: 71 }, { ...row(), createdAt: Date.now() + 10000000 }, { ...row(), english: '' }]) {
    assert.equal((await request('POST', undefined, write, { records: [first, bad] })).status, 400);
  }
  assert.equal((await request('POST', undefined, write, { records: [] })).status, 400);
  assert.equal((await request('POST', undefined, write, { records: Array(5).fill(first) })).status, 400);
  assert.equal((await request('POST', undefined, write, ' '.repeat(65537))).status, 400);
  const exported = await (await request('GET', undefined, read)).json();
  assert.equal(exported.records.length, 2);
  assert.equal((await request('GET', '/api/translations?limit=201', read)).status, 400);
  assert.equal((await request('GET', '/api/translations?after=-1', read)).status, 400);
});

test('paginated exports are a stable snapshot while gameplay appends more candidates', async () => {
  const first = await (await request('GET', '/api/translations?limit=1', read)).json();
  assert.ok(first.next);
  assert.equal((await request('POST', undefined, write, { records: [row('New conversation.', 'Yeni konuşma.')] })).status, 200);
  const second = await (await request('GET', '/api/translations?limit=1&after=' + first.next + '&through=' + first.through, read)).json();
  assert.equal(second.next, null);
  assert.equal(second.through, first.through);
  assert.equal(second.records.length, 1);
  assert.notEqual(second.records[0].id, first.records[0].id);
  assert.equal((await (await request('GET', undefined, read)).json()).records.length, 3);
});

test('production TV outbox transport saves and acknowledges a real SQLite record without forwarding provider keys', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'subtitle-worker-outbox-'));
  try {
    writeFileSync(path.join(directory, 'translation-archive.json'), JSON.stringify({ writeToken: write }));
    const https = { Agent: class {}, request(options, callback) {
      const client = new EventEmitter();
      client.destroy = () => {};
      client.end = async body => {
        try {
          assert.equal(options.hostname, 'ps-subtitle.u-talha-o.workers.dev');
          assert.equal(body.includes('DO-NOT-SEND-PROVIDER-KEY'), false);
          const reply = await worker.fetch('http://worker.test' + options.path, {
            method: options.method, headers: options.headers, body });
          const incoming = new EventEmitter(); incoming.statusCode = reply.status;
          callback(incoming); incoming.emit('data', Buffer.from(await reply.arrayBuffer())); incoming.emit('end');
        } catch (error) { client.emit('error', error); }
      };
      return client;
    } };
    const context = vm.createContext({ Buffer, module: { exports: {} }, setTimeout, clearTimeout,
      require(name) {
        if (name === 'https') return https;
        if (name === './translation') return require('../../tv-app/service/translation.js');
        return require(name);
      } });
    vm.runInContext(readFileSync(new URL('../../tv-app/service/translation-archive.js', import.meta.url), 'utf8'), context);
    const archive = context.module.exports.createTranslationArchive(directory);
    await archive.record({ english: 'Outbox transport test.', turkish: 'Gönderim kuyruğu testi.', provider: 'gemini',
      model: 'gemini-3.5-flash-lite', confidence: 99, apiKey: 'DO-NOT-SEND-PROVIDER-KEY' });
    assert.equal(archive.status().pending, 0);
    assert.equal(archive.status().confirmed, 1);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'translation-outbox.json'))), []);
    const exported = await (await request('GET', undefined, read)).json();
    assert.ok(exported.records.some(record => record.english === 'Outbox transport test.'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('existing encrypted phone → Worker → TV transfer still carries only the submitted patch and cleans up the session', async () => {
  const https = { Agent: class {}, request(options, callback) {
    const client = new EventEmitter();
    client.destroy = () => {};
    client.end = async body => {
      try {
        const reply = await worker.fetch('http://worker.test' + options.path, { method: options.method, headers: options.headers,
          ...(body ? { body } : {}) });
        const incoming = new EventEmitter(); incoming.statusCode = reply.status;
        callback(incoming);
        incoming.emit('data', Buffer.from(await reply.arrayBuffer())); incoming.emit('end');
      } catch (error) { client.emit('error', error); }
    };
    return client;
  } };
  const service = vm.createContext({ Buffer, module: { exports: {} }, setTimeout, clearTimeout,
    require: name => name === 'https' ? https : require(name) });
  vm.runInContext(readFileSync(new URL('../../tv-app/service/remote-setup.js', import.meta.url), 'utf8'), service);
  const transfer = service.module.exports.createRemoteTransfer();
  await transfer.start();
  const nodes = {};
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes[match[1]] = { value: '', checked: false, addEventListener() {} };
  const phone = vm.createContext({ document: { getElementById: id => nodes[id] }, location: { hash: '', pathname: '/' },
    history: {}, TextEncoder, crypto: webcrypto,
    fetch: (url, options) => worker.fetch('http://worker.test' + url, options) });
  vm.runInContext(readFileSync(new URL('../public/setup.js', import.meta.url), 'utf8'), phone);
  nodes.includeTranslation.checked = true; nodes.geminiKey.value = 'phone-test-key';
  phone.secret = transfer.code;
  const uploaded = await vm.runInContext('upload(settings(), secret)', phone);
  assert.equal(uploaded.status, 204);
  const received = await transfer.read();
  assert.deepEqual(JSON.parse(JSON.stringify(received.data)), { translation: { keys: { gemini: 'phone-test-key' } } });
  await transfer.close();
  await assert.rejects(transfer.read(), /sona erdi/);
});

test('review exporter consumes the real archive without changing or approving the candidates', async () => {
  const exported = await exportCandidates(read, (url, options) => worker.fetch(url, options));
  assert.equal(exported.reviewRequired, true);
  assert.equal(exported.game, 'gta-6');
  assert.equal(exported.records.length, 4);
  assert.ok(exported.records.every(row => row.review_status === 'unreviewed'));
});

test('labelled connectivity records are exported separately from real dialogue candidates', async () => {
  const testRecord = row('[PS Subtitle connectivity test] We need to leave now.', 'Hemen gitmeliyiz.');
  assert.equal((await request('POST', undefined, write, { records: [testRecord] })).status, 200);
  const exported = await exportCandidates(read, (url, options) => worker.fetch(url, options));
  assert.equal(exported.records.length, 4);
  assert.equal(exported.testRecords.length, 1);
  assert.equal(exported.testRecords[0].id, testRecord.id);
  assert.ok(exported.records.every(row => !row.english.startsWith('[PS Subtitle connectivity test] ')));
});
