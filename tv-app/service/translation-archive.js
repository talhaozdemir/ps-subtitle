'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { translationModels } = require('./translation');

const host = 'ps-subtitle.u-talha-o.workers.dev';
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
const maxPending = 1000;

function makeRecord(value) {
  if (!value || typeof value.english !== 'string' || !value.english.trim() || value.english.length > 1440 ||
      typeof value.turkish !== 'string' || !value.turkish.trim() || value.turkish.length > 2880 ||
      !Number.isFinite(value.confidence) || value.confidence < 72 || value.confidence > 100 ||
      !Object.prototype.hasOwnProperty.call(translationModels, value.provider) || translationModels[value.provider] !== value.model) {
    throw Error('İnceleme kaydı geçersiz.');
  }
  const fields = [1, 'gta-6', value.english, value.turkish, value.provider, value.model];
  return { id: crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    game: 'gta-6', english: value.english, turkish: value.turkish,
    provider: value.provider, model: value.model, confidence: value.confidence };
}

function upload(records, token) {
  const body = JSON.stringify({ records: records });
  return new Promise(function (resolve, reject) {
    let settled = false, timer, client;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    function fail() { finish(Error('Cloudflare kaydı bekliyor; bağlantı yeniden denenecek.')); if (client) client.destroy(); }
    client = https.request({ hostname: host, path: '/api/translations', method: 'POST', agent: agent,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) } }, function (response) {
      let bytes = 0;
      const chunks = [];
      response.on('data', function (chunk) {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > 8300) { fail(); return; }
        chunks.push(chunk);
      });
      response.on('aborted', fail);
      response.on('error', fail);
      response.on('end', function () {
        if (settled) return;
        let reply;
        try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) {}
        if (response.statusCode === 200 && reply && Array.isArray(reply.saved) &&
            records.every(function (record) { return reply.saved.indexOf(record.id) !== -1; })) finish(null, reply.saved);
        else if (response.statusCode === 401 || response.statusCode === 403) {
          finish(Error('Cloudflare kayıt anahtarı doğrulanamadı; çeviriler TV’de bekliyor.'));
        } else fail();
      });
    });
    timer = setTimeout(fail, 6500);
    client.on('error', fail);
    client.end(body);
  });
}

function createTranslationArchive(directory, options) {
  options = options || {};
  const disk = options.fs || fs;
  const send = options.upload || upload;
  const later = options.setTimeout || setTimeout;
  const filename = path.join(directory, 'translation-outbox.json');
  const credentials = path.join(directory, 'translation-archive.json');
  let records = [], timer, busy = false, lastError = '', confirmed = 0, loaded = false;

  function token() {
    try {
      const value = JSON.parse(disk.readFileSync(credentials, 'utf8')).writeToken;
      return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : '';
    } catch (error) { return ''; }
  }
  function load() {
    if (loaded) return;
    let parsed;
    try { parsed = JSON.parse(disk.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('TV’de bekleyen çeviriler okunamadı.'); parsed = []; }
    if (!Array.isArray(parsed) || parsed.length > maxPending || !parsed.every(function (row) {
      try { return makeRecord(row).id === row.id && Number.isSafeInteger(row.createdAt) && row.createdAt > 0; }
      catch (error) { return false; }
    })) throw Error('TV’de bekleyen çeviri dosyası geçersiz.');
    records = parsed;
    loaded = true;
  }
  function persist(next) {
    try { disk.mkdirSync(directory, 0o700); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    disk.writeFileSync(filename + '.new', JSON.stringify(next), { mode: 0o600 });
    disk.renameSync(filename + '.new', filename);
    records = next;
  }
  function schedule(delay) {
    if (timer) return;
    timer = later(function () { timer = null; flush(); }, delay);
    if (timer && timer.unref) timer.unref();
  }
  function flush() {
    try { load(); } catch (error) { lastError = error.message; return Promise.resolve(); }
    if (busy || !records.length) return Promise.resolve();
    const key = token();
    if (!key) { lastError = 'Cloudflare kayıt anahtarı kurulmadı; çeviriler TV’de bekliyor.'; schedule(60000); return Promise.resolve(); }
    busy = true;
    const batch = records.slice(0, 4);
    return Promise.resolve().then(function () { return send(batch, key); }).then(function () {
      const ids = new Set(batch.map(function (record) { return record.id; }));
      persist(records.filter(function (record) { return !ids.has(record.id); }));
      confirmed += batch.length;
      lastError = '';
    }).catch(function (error) {
      // Never expose provider keys or transport payloads through diagnostics.
      lastError = error.message && error.message.indexOf('Cloudflare') === 0 ? error.message : 'Çeviriler TV’de bekliyor; kayıt yeniden denenecek.';
    }).then(function () {
      busy = false;
      if (records.length) schedule(lastError ? 30000 : 1000);
    });
  }
  return {
    configure: function (writeToken) {
      if (typeof writeToken !== 'string' || !/^[0-9a-f]{64}$/.test(writeToken)) throw Error('Cloudflare kayıt anahtarı geçersiz.');
      try { disk.mkdirSync(directory, 0o700); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      disk.writeFileSync(credentials + '.new', JSON.stringify({ writeToken: writeToken }), { mode: 0o600 });
      disk.renameSync(credentials + '.new', credentials);
      flush();
    },
    record: function (value) {
      load();
      const record = makeRecord(value);
      if (!records.some(function (row) { return row.id === record.id; })) {
        if (records.length >= maxPending) throw Error('TV’de bekleyen çeviri kuyruğu dolu.');
        record.createdAt = Date.now();
        persist(records.concat([record]));
      }
      return flush();
    },
    flush: flush,
    status: function () {
      try { load(); } catch (error) { lastError = error.message; }
      return { configured: Boolean(token()), pending: records.length, confirmed: confirmed, busy: busy, lastError: lastError };
    }
  };
}

module.exports = { createTranslationArchive, makeRecord };
