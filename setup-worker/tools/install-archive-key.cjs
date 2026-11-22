'use strict';

// Configure the webOS app through its own PalmServiceBridge. Its private data
// directory is owned by the service UID and cannot be written by SSH prisoner.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

async function installArchiveKey(device, token) {
  if (!/^[\w-]+$/.test(device) || !/^[0-9a-f]{64}$/.test(token)) throw Error('TV veya kayıt anahtarı geçersiz.');
  if (!process.env.APPDATA) throw Error('TV aktarımı için Windows webOS CLI gerekiyor.');
  const cli = path.join(process.env.APPDATA, 'npm/node_modules/@webos-tools/cli/bin');
  execFileSync(process.execPath, [path.join(cli, 'ares-launch.js'), '-d', device, 'com.gtavi.turkce'], { stdio: 'ignore' });
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const inspector = spawn(process.execPath, [path.join(cli, 'ares-inspect.js'), '-d', device, '--host-port', String(port), 'com.gtavi.turkce'],
    { stdio: 'ignore', windowsHide: true });
  let socket;
  try {
    let page;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) });
        const pages = await response.json();
        page = pages.find(item => typeof item.url === 'string' && item.url.includes('com.gtavi.turkce'));
        if (page) break;
      } catch (error) { /* The forwarder is still starting. */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!page) throw Error('TV uygulamasının tanılama bağlantısı açılamadı.');
    const target = new URL(page.webSocketDebuggerUrl);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || Number(target.port) !== port) throw Error('TV tanılama adresi geçersiz.');
    socket = new WebSocket(target);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('TV bağlantısı zaman aşımı.')), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(Error('TV tanılama bağlantısı kurulamadı.')); };
    });
    const payload = JSON.stringify({ writeToken: token });
    // Neither the CDP expression nor its credential payload is logged or saved.
    const expression = `new Promise(function(resolve){var bridge=new PalmServiceBridge();window.__archiveProvision=bridge;
      var timer=setTimeout(function(){delete window.__archiveProvision;resolve({returnValue:false});},8000);
      bridge.onservicecallback=function(raw){clearTimeout(timer);delete window.__archiveProvision;resolve(JSON.parse(raw));};
      bridge.call('luna://com.gtavi.turkce.altyazi/setTranslationArchive',${JSON.stringify(payload)});})`;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('TV anahtar kurulumu zaman aşımı.')), 12000);
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result.exceptionDetails) reject(Error('TV servis çağrısı tamamlanamadı.'));
        else resolve(message.result.result.value);
      };
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (!result || result.returnValue !== true || !result.archive || !result.archive.configured) {
      throw Error('TV kayıt anahtarını kabul etmedi. Önce TV’ye 1.0.34 veya sonraki sürümü yükle.');
    }
    return result.archive;
  } finally {
    if (socket) socket.close();
    inspector.kill();
  }
}

module.exports = { installArchiveKey };
if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (args.length !== 2 || args[0] !== '--device') throw Error('Kullanım: node tools/install-archive-key.cjs --device lgtv');
    const secrets = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/ps-subtitle/archive-secrets.json'), 'utf8'));
    const result = await installArchiveKey(args[1], secrets.TRANSLATION_WRITE_TOKEN);
    console.log(JSON.stringify(result));
  }).catch(error => { console.error(error.message || 'TV anahtarı kurulamadı.'); process.exitCode = 1; });
}
