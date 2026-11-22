'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function exportCandidates(token, fetcher = fetch) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw Error('Arşiv okuma anahtarı geçersiz.');
  const records = [], ids = new Set();
  let after = 0, through = null;
  for (;;) {
    const params = new URLSearchParams({ after: String(after), limit: '200' });
    if (through !== null) params.set('through', String(through));
    const response = await fetcher('https://ps-subtitle.u-talha-o.workers.dev/api/translations?' + params,
      { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status !== 200) throw Error('Arşiv dışa aktarılamadı (HTTP ' + response.status + ').');
    const body = await response.json();
    if (!body || body.format !== 1 || body.reviewRequired !== true || !Array.isArray(body.records) ||
        body.records.length > 200 || !Number.isSafeInteger(body.through) || body.through < 0 ||
        (through !== null && body.through !== through)) throw Error('Arşiv sayfası geçersiz.');
    through = body.through;
    for (const row of body.records) {
      if (!row || !Number.isSafeInteger(row.sequence) || row.sequence <= after || row.sequence > through ||
          typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) || ids.has(row.id) || row.review_status !== 'unreviewed') {
        throw Error('Arşiv kaydı geçersiz veya yinelenmiş.');
      }
      after = row.sequence; ids.add(row.id); records.push(row);
    }
    if (records.length > 20000 || (body.next !== null && (!body.records.length || body.next !== after))) {
      throw Error('Arşiv sayfalaması geçersiz.');
    }
    if (body.next === null) break;
  }
  const isTest = row => typeof row.english === 'string' && row.english.startsWith('[PS Subtitle connectivity test] ');
  return { format: 1, game: 'gta-6', reviewRequired: true, exportedAt: new Date().toISOString(), through,
    records: records.filter(row => !isTest(row)), testRecords: records.filter(isTest) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw Error('Kullanım: node tv-app/tools/export_api_translations.cjs --output DOSYA.json');
  let token = process.env.TRANSLATION_READ_TOKEN;
  if (!token) {
    try { token = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/ps-subtitle/archive-secrets.json'), 'utf8')).TRANSLATION_READ_TOKEN; }
    catch { throw Error('Yerel arşiv okuma anahtarı bulunamadı. Önce Cloudflare arşiv kurulumunu tamamla.'); }
  }
  const output = await exportCandidates(token);
  fs.writeFileSync(path.resolve(args[1]), JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(output.records.length + ' aday ve ayrı listede ' + output.testRecords.length + ' bağlantı testi dışa aktarıldı. Dil paketi değiştirilmedi.');
}

module.exports = { exportCandidates };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
