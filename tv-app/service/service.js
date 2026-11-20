'use strict';

const Service = require('webos-service');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { createPackStore } = require('./pack');
const { accountBytes, settings, publicSettings, subtitleRegion, subtitleAppearance, consoleId } = require('./settings');

const service = new Service('com.gtavi.turkce.altyazi');
const configDirectory = '/media/internal/.com.gtavi.turkce.altyazi';
const configPath = path.join(configDirectory, 'settings.json');
const runtime = path.join(__dirname, 'runtime');
const packs = createPackStore(configDirectory, path.join(__dirname, 'gta-6.json.gz'));
let active = null;
let pairing = false;
let discovery = null;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Error('TV’de kayıtlı ayarlar okunamadı.');
  }
}

function saveSettings(config) {
  const temporary = configPath + '.new';
  try {
    try { fs.mkdirSync(configDirectory, 0o700); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) { throw Error('TV’de ayarlar kaydedilemedi.'); }
}

function replyError(message, error) {
  message.respond({ returnValue: false, errorText: error.message });
}

function launch(input, onMessage, onExit) {
  const worker = spawn(path.join(runtime, 'lib', 'ld-linux-armhf.so.3'), [
    '--library-path', path.join(runtime, 'lib'), path.join(runtime, 'subtitle-engine'), runtime
  ], { stdio: ['pipe', 'pipe', 'ignore'], env: Object.assign({}, process.env, { OMP_THREAD_LIMIT: '1' }) });
  const lines = readline.createInterface({ input: worker.stdout, terminal: false });
  let exited = false;
  function finish(error) {
    if (exited) return;
    exited = true;
    lines.close();
    onExit(error);
  }
  worker.on('error', function () { finish('TV altyazı motorunu başlatamadı.'); });
  worker.on('close', function () { finish('PS5 altyazı bağlantısı kapandı.'); });
  worker.stdin.on('error', function () {});
  lines.on('line', function (line) {
    if (line.length > 8192) return;
    let object;
    try { object = JSON.parse(line); } catch (error) { return; }
    onMessage(object);
  });
  function send(command) {
    if (!exited && worker.stdin.writable) worker.stdin.write(JSON.stringify(command) + '\n');
  }
  send(input);
  return {
    send: send,
    stop: function () {
      worker.stdin.end();
      if (exited) return;
      const timer = setTimeout(function () { if (!exited) worker.kill('SIGKILL'); }, 3000);
      worker.once('close', function () { clearTimeout(timer); });
    }
  };
}

function discoverConsoles() {
  if (discovery) return discovery;
  discovery = new Promise(function (resolve, reject) {
    let consoles;
    let failure;
    launch({ mode: 'discover' }, function (result) {
      if (result.type === 'error') failure = result.text;
      if (result.type !== 'discovered' || !Array.isArray(result.consoles)) return;
      const found = new Map();
      result.consoles.forEach(function (console) {
        if (!console || !net.isIPv4(console.address)) return;
        const id = consoleId(console.id);
        if (!id) return;
        const name = typeof console.name === 'string' ? console.name.trim() : '';
        found.set(id, { id: id, address: console.address, name: name || 'PS5', ready: console.ready === true });
      });
      consoles = Array.from(found.values());
    }, function (error) {
      if (consoles) resolve(consoles);
      else reject(Error(failure || error));
    });
  }).then(function (consoles) {
    discovery = null;
    return consoles;
  }, function (error) {
    discovery = null;
    throw error;
  });
  return discovery;
}

service.register('settings', function (message) {
  try { message.respond({ returnValue: true, settings: publicSettings(readSettings()) }); }
  catch (error) { replyError(message, error); }
});

service.register('completeSetup', function (message) {
  try {
    const config = readSettings();
    if (!config.registKey || !config.rpKey) throw Error('Önce PS5’i eşleştir.');
    config.setupComplete = true;
    saveSettings(config);
    message.respond({ returnValue: true });
  } catch (error) { replyError(message, error); }
});

service.register('discover', function (message) {
  discoverConsoles().then(function (consoles) {
    message.respond({ returnValue: true, consoles: consoles });
  }, function (error) { replyError(message, error); });
});

service.register('updatePack', function (message) {
  packs.update().then(function (result) {
    message.respond(Object.assign({ returnValue: true }, result));
  }, function (error) { replyError(message, error); });
});

service.register('setAppearance', function (message) {
  try {
    const appearance = subtitleAppearance(message.payload.appearance);
    const config = readSettings();
    config.appearance = appearance;
    saveSettings(config);
    message.respond({ returnValue: true, appearance: appearance });
  } catch (error) { replyError(message, error); }
});

service.register('setRegion', function (message) {
  try {
    const payload = message.payload;
    const region = subtitleRegion(payload.region);
    const revision = payload.revision;
    if (!Number.isInteger(revision) || revision < 1 || revision > 2147483647) {
      throw Error('Altyazı alanı isteği geçersiz.');
    }
    if (active && revision <= active.revision) {
      message.respond({ returnValue: true });
      return;
    }
    if (payload.save === true) {
      const config = readSettings();
      config.region = region;
      saveSettings(config);
    }
    if (active) {
      active.region = region;
      active.revision = revision;
      active.preview = payload.preview === true;
      if (active.worker) active.worker.send({ region: region, revision: revision });
    }
    message.respond({ returnValue: true });
  } catch (error) { replyError(message, error); }
});

service.register('pair', function (message) {
  try {
    if (pairing) throw Error('Bir PS5 eşleştirmesi zaten sürüyor.');
    const config = settings(message.payload);
    const pin = message.payload.pin;
    if (typeof pin !== 'string' || !/^\d{8}$/.test(pin)) throw Error('8 haneli eşleştirme kodunu gir.');
    const input = { mode: 'pair', address: config.address, pin: pin, account: accountBytes(message.payload.accountId) };
    if (active) active.close();
    pairing = true;
    let answered = false;
    let failure;
    launch(input, function (result) {
      if (result.type === 'error') failure = result.text;
      if (result.type !== 'paired' || answered) return;
      answered = true;
      try {
        config.registKey = result.registKey;
        config.rpKey = result.rpKey;
        config.consoleId = consoleId(result.consoleId);
        config.account = input.account;
        const previous = publicSettings(readSettings());
        config.setupComplete = previous.setupComplete;
        config.region = previous.region;
        config.appearance = previous.appearance;
        saveSettings(config);
        message.respond({ returnValue: true, settings: publicSettings(config) });
      } catch (error) { replyError(message, error); }
    }, function (error) {
      pairing = false;
      if (!answered) replyError(message, Error(failure || error));
    });
  } catch (error) { replyError(message, error); }
});

const stream = service.register('start');
stream.on('request', function (message) {
  let slot;
  try {
    if (!message.isSubscription) throw Error('Altyazı akışı için abonelik gerekiyor.');
    if (pairing) throw Error('Eşleştirmenin tamamlanmasını bekle.');
    const requested = settings(message.payload);
    const saved = readSettings();
    const id = consoleId(saved.consoleId);
    if (!saved.registKey || !saved.rpKey ||
        (saved.address !== requested.address && (!id || id !== consoleId(message.payload.consoleId)))) {
      throw Error('Önce PS5’i eşleştir.');
    }
    if (active) active.close();
    saveSettings(Object.assign(saved, { port: requested.port, quality: requested.quality }));
    slot = { token: message.uniqueToken, worker: null, region: publicSettings(saved).region, revision: 0,
      preview: false, close: function () {
      if (active === slot) active = null;
      if (slot.worker) slot.worker.stop();
    } };
    active = slot;
    const consoles = id ? discoverConsoles().catch(function () { return []; }) : Promise.resolve([]);
    Promise.all([packs.load(), consoles]).then(function (results) {
      if (active !== slot) return;
      const found = results[1];
      const matched = found.find(function (console) { return console.id === id; });
      const previousAddress = saved.address;
      if (matched && matched.address !== saved.address) {
        const latest = readSettings();
        latest.address = matched.address;
        saveSettings(latest);
        saved.address = matched.address;
      } else if (!matched && found.some(function (console) { return console.address === saved.address; })) {
        throw Error('Eşleştirilen PS5 ağda bulunamadı. PS5’i açıp tekrar dene.');
      }
      if (saved.address !== previousAddress || saved.address !== requested.address) {
        message.respond({ returnValue: true, type: 'address', address: saved.address });
      }
      let missed = 0;
      let playingRevision = slot.revision;
      let failure;
      const input = Object.assign({}, saved, { mode: 'stream', region: slot.region, revision: slot.revision });
      slot.worker = launch(input, function (result) {
        if (active !== slot) return;
        if (result.type === 'error') failure = result.text;
        if (result.type === 'ready') message.respond({ returnValue: true, type: 'ready' });
        if (result.type !== 'ocr' || result.revision !== slot.revision) return;
        if (slot.preview) {
          message.respond({ returnValue: true, type: 'preview', text: result.text, revision: slot.revision });
          return;
        }
        if (playingRevision !== slot.revision) {
          playingRevision = slot.revision;
          missed = 0;
        }
        const translated = packs.match(result.text, result.confidence);
        if (translated) {
          missed = 0;
          message.respond({ returnValue: true, type: 'subtitle', text: translated });
        } else if (++missed === 2) {
          message.respond({ returnValue: true, type: 'subtitle', text: '' });
        }
      }, function (error) {
        if (active !== slot) return;
        active = null;
        message.respond({ returnValue: true, type: 'ended', text: failure || error });
      });
    }).catch(function (error) {
      if (active !== slot) return;
      slot.close();
      replyError(message, error);
    });
  } catch (error) { replyError(message, error); }
});

stream.on('cancel', function (message) {
  if (active && active.token === message.uniqueToken) active.close();
});
