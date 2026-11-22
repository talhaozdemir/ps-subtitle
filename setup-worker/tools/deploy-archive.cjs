'use strict';

// Run after `wrangler login`. Credentials stay outside the repository/IPK.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const secretsPath = path.join(os.homedir(), '.config/ps-subtitle/archive-secrets.json');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');

function cli(args, capture = false) {
  return execFileSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--device' || !/^[\w-]+$/.test(args[1]))) {
    throw Error('Kullanım: node tools/deploy-archive.cjs [--device lgtv]');
  }
  let listed;
  try { listed = JSON.parse(cli(['secret', 'list'], true)); }
  catch { throw Error('Cloudflare oturumu doğrulanamadı. setup-worker içinde npx wrangler login çalıştır.'); }
  let secrets;
  try { secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw Error('Yerel arşiv anahtarı dosyası okunamadı.');
    if (listed.some(item => /^TRANSLATION_(READ|WRITE)_TOKEN$/.test(item.name))) {
      throw Error('Cloudflare’de arşiv anahtarı zaten var. Mevcut yerel archive-secrets.json dosyasını geri getir; anahtarlar otomatik değiştirilmeyecek.');
    }
    secrets = { TRANSLATION_WRITE_TOKEN: crypto.randomBytes(32).toString('hex'), TRANSLATION_READ_TOKEN: crypto.randomBytes(32).toString('hex') };
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
  }
  if (!secrets || ![secrets.TRANSLATION_WRITE_TOKEN, secrets.TRANSLATION_READ_TOKEN].every(value =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) || secrets.TRANSLATION_WRITE_TOKEN === secrets.TRANSLATION_READ_TOKEN) {
    throw Error('Yerel arşiv anahtarları geçersiz.');
  }
  cli(['secret', 'bulk', secretsPath]);
  cli(['deploy']);
  if (args.length) {
    const { installArchiveKey } = require('./install-archive-key.cjs');
    await installArchiveKey(args[1], secrets.TRANSLATION_WRITE_TOKEN);
    console.log('TV arşiv yazma anahtarı kuruldu. Okuma anahtarı TV’ye aktarılmadı.');
  }
  console.log('Cloudflare arşivi ve telefon formu yayımlandı. Anahtarlar kaynak koduna/IPK’ye eklenmedi.');
}

main().catch(error => { console.error(error.message || 'Arşiv kurulumu tamamlanamadı.'); process.exitCode = 1; });
