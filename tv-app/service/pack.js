'use strict';

const { createHash } = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { promisify } = require('util');
const { createGunzip } = require('zlib');
const { createMatcher } = require('./matcher');

const repository = 'talhaozdemir/ps-subtitle';
const releaseFilename = 'subtitle.json.gz';
const latestRelease = 'https://api.github.com/repos/' + repository + '/releases/latest';
const githubHosts = new Set([
  'api.github.com', 'github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com'
]);
const maxPackBytes = 16 * 1024 * 1024;
const maxJsonBytes = 32 * 1024 * 1024;
const tooLarge = 'Altyazı paketi boyut sınırını aşıyor.';

function collect(stream, limit, limitError) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let bytes = 0;
    function interrupted() { reject(Error('Altyazı dosyası tamamlanmadan bağlantı kapandı.')); }
    stream.on('data', function (chunk) {
      if (bytes + chunk.length > limit) {
        const error = Error(limitError);
        reject(error);
        stream.destroy(error);
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    });
    stream.on('end', function () { resolve(Buffer.concat(chunks, bytes)); });
    stream.on('error', reject);
    stream.on('aborted', interrupted);
    stream.on('close', interrupted);
  });
}

function download(address, accept, limit, deadline, redirects, base) {
  return new Promise(function (resolve, reject) {
    const target = new URL(address, base);
    if (target.protocol !== 'https:' || !githubHosts.has(target.hostname) ||
        target.port || target.username || target.password) {
      reject(Error('GitHub geçersiz bir indirme adresi döndürdü.'));
      return;
    }
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) {
      reject(Error('GitHub bağlantısı zaman aşımına uğradı.'));
      return;
    }
    const request = https.get({
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: { 'User-Agent': 'GTA-VI-Turkce-webOS', Accept: accept, 'Accept-Encoding': 'identity' }
    }, function (response) {
      const code = response.statusCode;
      if (code === 200) {
        resolve(collect(response, limit, tooLarge));
        return;
      }
      response.resume();
      if ([301, 302, 303, 307, 308].indexOf(code) !== -1 && response.headers.location && redirects > 0) {
        resolve(download(response.headers.location, accept, limit, deadline, redirects - 1, target.href));
      } else if (code === 404 && target.href === latestRelease) {
        reject(Error('GitHub’da henüz yayımlanmış bir altyazı sürümü yok.'));
      } else {
        reject(Error('GitHub indirmesi tamamlanamadı (HTTP ' + code + ').'));
      }
    });
    const timer = setTimeout(function () { request.destroy(Error('GitHub bağlantısı zaman aşımına uğradı.')); }, timeLeft);
    request.on('close', function () { clearTimeout(timer); });
    request.on('error', reject);
  });
}

function validateEntries(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw Error('Altyazı paketi biçimi geçersiz.');
  const keys = Object.keys(table);
  for (const hash of keys) {
    if (!/^[0-9a-f]{16}$/.test(hash) || typeof table[hash] !== 'string' || !table[hash].trim()) {
      throw Error('Altyazı paketi geçersiz bir replik içeriyor.');
    }
  }
  return keys.length;
}

async function decode(bytes) {
  const gunzip = createGunzip();
  const unpacked = collect(gunzip, maxJsonBytes, tooLarge);
  gunzip.end(bytes);
  let pack;
  try { pack = JSON.parse((await unpacked).toString('utf8')); }
  catch (error) { throw Error('Altyazı paketi açılamadı.'); }
  if (!pack || pack.format !== 2 || pack.id !== 'gta-6') throw Error('GTA VI altyazı paketi biçimi geçersiz.');
  if (validateEntries(pack.entries) + validateEntries(pack.segments) === 0) throw Error('Altyazı paketi boş.');
  return { match: createMatcher({ format: pack.format, id: pack.id, entries: pack.entries, segments: pack.segments }),
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

function readPack(file) {
  return collect(fs.createReadStream(file), maxPackBytes, tooLarge).then(decode);
}

async function latestAsset() {
  const json = await download(latestRelease, 'application/vnd.github+json', 256 * 1024, Date.now() + 25000, 3);
  let release;
  try { release = JSON.parse(json.toString('utf8')); }
  catch (error) { throw Error('GitHub yayın bilgisi okunamadı.'); }
  const asset = release && Array.isArray(release.assets) &&
    release.assets.find(function (item) { return item && item.name === releaseFilename; });
  if (!asset) throw Error('Son GitHub yayınına ' + releaseFilename + ' dosyasını ekle.');
  if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > maxPackBytes ||
      !/^sha256:[0-9a-f]{64}$/.test(asset.digest || '')) {
    throw Error('GitHub’daki paketin boyutu veya doğrulama bilgisi geçersiz.');
  }
  let url;
  try { url = new URL(asset.browser_download_url); }
  catch (error) { throw Error('GitHub paketi için beklenen indirme adresi bulunamadı.'); }
  if (url.hostname !== 'github.com' || !url.pathname.startsWith('/' + repository + '/releases/download/')) {
    throw Error('GitHub paketi için beklenen indirme adresi bulunamadı.');
  }
  return { asset: asset, version: typeof release.tag_name === 'string' ? release.tag_name.slice(0, 60) : '' };
}

function createPackStore(directory, bundledPath) {
  const cachedPath = path.join(directory, 'gta-6.json.gz');
  let current;
  let loading;
  let updating;

  function load() {
    if (current) return Promise.resolve(current);
    if (!loading) {
      loading = readPack(cachedPath).catch(function () { return readPack(bundledPath); })
        .then(function (result) {
          if (!current) current = result;
          loading = null;
          return current;
        }, function () {
          loading = null;
          if (current) return current;
          throw Error('Yerel GTA VI altyazı paketi açılamadı.');
        });
    }
    return loading;
  }

  async function replace() {
    const release = await latestAsset();
    const asset = release.asset;
    const installed = await load().catch(function () { return null; });
    if (installed && installed.digest === asset.digest) return { updated: false, version: release.version };

    const bytes = await download(asset.browser_download_url, 'application/octet-stream', asset.size, Date.now() + 25000, 4);
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== asset.size || digest !== asset.digest) throw Error('İndirilen altyazı dosyası doğrulanamadı.');
    const next = await decode(bytes);
    const temporary = cachedPath + '.new';
    try {
      await promisify(fs.mkdir)(directory, 0o700).catch(function (error) {
        if (error.code !== 'EEXIST') throw error;
      });
      await promisify(fs.writeFile)(temporary, bytes, { mode: 0o600 });
      await promisify(fs.rename)(temporary, cachedPath);
    } catch (error) {
      await promisify(fs.unlink)(temporary).catch(function () {});
      throw Error('Altyazı paketi TV’ye kaydedilemedi.');
    }
    current = next;
    return { updated: true, version: release.version };
  }

  return {
    load: load,
    match: function (text, confidence) { return current.match(text, confidence); },
    update: function () {
      if (!updating) {
        updating = replace().then(function (result) { updating = null; return result; },
          function (error) { updating = null; throw error; });
      }
      return updating;
    }
  };
}

module.exports = { createPackStore };
