'use strict';

const Service = require('webos-service');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { createPackStore } = require('./pack');
const { accountBytes, settings, publicSettings, subtitleRegion, subtitleAppearance, consoleId,
  translationSettings, savedTranslation, publicTranslation, translationProviderNames } = require('./settings');
const { createSubtitleFeed, requestTranslation, testLine } = require('./translation');
const { createRemoteTransfer } = require('./remote-setup');

const service = new Service('com.gtavi.turkce.altyazi');
const configDirectory = '/media/internal/.com.gtavi.turkce.altyazi';
const configPath = path.join(configDirectory, 'settings.json');
const runtime = path.join(__dirname, 'runtime');
const packs = createPackStore(configDirectory, path.join(__dirname, 'gta-6.json.gz'));
let active = null;
let pairing = false;
let discovery = null;
let remoteSetup = null;

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

async function saveTranslation(payload) {
  translationSettings(payload, savedTranslation(readSettings()));
  if (payload.mode === 'pack') await packs.load().catch(function () {});
  const config = readSettings();
  config.translation = translationSettings(payload, savedTranslation(config));
  saveSettings(config);
  if (active) active.feed.update(config.translation);
  return config;
}

service.register('setTranslation', async function (message) {
  try {
    const config = await saveTranslation(message.payload);
    message.respond({ returnValue: true, translation: publicTranslation(config.translation) });
  } catch (error) { replyError(message, error); }
});

service.register('testTranslation', function (message) {
  try {
    const translation = translationSettings(message.payload, savedTranslation(readSettings()));
    if (!translation.keys[translation.provider]) {
      throw Error('Önce ' + translationProviderNames[translation.provider] + ' API anahtarını gir.');
    }
    requestTranslation(translation, testLine).result.then(function (text) {
      message.respond({ returnValue: true, text: text });
    }, function (error) { replyError(message, error); });
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
      active.feed.reset();
      if (active.worker) active.worker.send({ region: region, revision: revision });
    }
    message.respond({ returnValue: true });
  } catch (error) { replyError(message, error); }
});

function pairInput(payload) {
  const config = settings(payload);
  if (typeof payload.pin !== 'string' || !/^\d{8}$/.test(payload.pin)) throw Error('8 haneli eşleştirme kodunu gir.');
  const command = { mode: 'pair', address: config.address, pin: payload.pin, account: accountBytes(payload.accountId) };
  return { config: config, command: command };
}

function pairConsole(payload, additionalSettings) {
  return new Promise(function (resolve, reject) {
    if (pairing) throw Error('Bir PS5 eşleştirmesi zaten sürüyor.');
    const input = pairInput(payload);
    const config = input.config;
    if (active) active.close();
    pairing = true;
    let result;
    let failure;
    try {
      launch(input.command, function (event) {
        if (event.type === 'error') failure = event.text;
        if (event.type === 'paired') result = event;
      }, function (error) {
        pairing = false;
        if (!result) { reject(Error(failure || error)); return; }
        try {
          config.registKey = result.registKey;
          config.rpKey = result.rpKey;
          config.consoleId = consoleId(result.consoleId);
          config.account = input.command.account;
          const previousConfig = readSettings();
          const previous = publicSettings(previousConfig);
          config.setupComplete = previous.setupComplete;
          config.region = previous.region;
          config.appearance = previous.appearance;
          config.translation = savedTranslation(previousConfig);
          if (additionalSettings) Object.assign(config, additionalSettings(previousConfig));
          saveSettings(config);
          resolve(config);
        } catch (saveError) { reject(saveError); }
      });
    } catch (error) {
      pairing = false;
      reject(error);
    }
  });
}

service.register('pair', function (message) {
  pairConsole(message.payload).then(function (config) {
    message.respond({ returnValue: true, settings: publicSettings(config) });
  }, function (error) { replyError(message, error); });
});

function mergedSetting(current, edits, validate) {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw Error('Altyazı ayarları geçersiz.');
  const result = Object.assign({}, current);
  for (const property of Object.keys(current)) {
    if (Object.prototype.hasOwnProperty.call(edits, property)) result[property] = edits[property];
  }
  return validate(result);
}

function remoteSettings(draft, saved) {
  if (!draft || (!draft.ps5 && !draft.translation && !draft.video)) throw Error('Gönderilen ayarlar boş.');
  const previous = publicSettings(saved);
  const summary = {};
  const changes = {};
  let ps5;
  if (draft.video) {
    const video = draft.video;
    if (video.port !== undefined) {
      if ([1, 2, 3, 4].indexOf(video.port) === -1) throw Error('Geçerli bir HDMI girişi seç.');
      changes.port = video.port;
    }
    if (video.quality !== undefined) {
      if ([540, 720].indexOf(video.quality) === -1) throw Error('Geçerli bir okuma çözünürlüğü seç.');
      changes.quality = video.quality;
    }
    if (video.region !== undefined) changes.region = mergedSetting(previous.region, video.region, subtitleRegion);
    if (video.appearance !== undefined) {
      changes.appearance = mergedSetting(previous.appearance, video.appearance, subtitleAppearance);
    }
    if (Object.keys(changes).length) summary.video = Object.assign({}, changes);
  }
  if (draft.ps5) {
    ps5 = Object.assign({}, draft.ps5, {
      port: changes.port || (draft.ps5.port === undefined ? previous.port : draft.ps5.port),
      quality: changes.quality || previous.quality
    });
    const input = pairInput(ps5);
    summary.ps5 = { address: input.config.address, port: input.config.port };
  }
  if (draft.translation) {
    const previousTranslation = savedTranslation(saved);
    const value = translationSettings(Object.assign({
      mode: previousTranslation.mode, provider: previousTranslation.provider
    }, draft.translation), previousTranslation);
    changes.translation = value;
    summary.translation = { provider: translationProviderNames[value.provider], mode: value.mode };
    const keys = Object.keys(translationProviderNames).filter(function (provider) {
      return value.keys[provider] !== previousTranslation.keys[provider];
    }).map(function (provider) { return translationProviderNames[provider]; });
    if (keys.length) summary.translation.keys = keys;
  }
  if (!Object.keys(summary).length) throw Error('Gönderilen ayarlar boş.');
  return { ps5: ps5, changes: changes, summary: summary };
}

async function saveRemoteSettings(draft) {
  let config = readSettings();
  let prepared = remoteSettings(draft, config);
  if (prepared.ps5) {
    return pairConsole(prepared.ps5, function (previous) { return remoteSettings(draft, previous).changes; });
  }
  if (prepared.changes.translation && prepared.changes.translation.mode === 'pack') {
    await packs.load().catch(function () {});
    config = readSettings();
    prepared = remoteSettings(draft, config);
  }
  Object.assign(config, prepared.changes);
  saveSettings(config);
  if (active && prepared.changes.translation) active.feed.update(config.translation);
  return config;
}

const remote = service.register('startRemoteSetup');
remote.on('request', function (message) {
  try {
    if (!message.isSubscription) throw Error('Kurulum oturumu için abonelik gerekiyor.');
    if (remoteSetup && remoteSetup.applying) throw Error('Ayarların kaydedilmesini bekle.');
    if (remoteSetup) remoteSetup.close();
    const transfer = createRemoteTransfer();
    const registered = transfer.start();
    let pollTimer;
    let expiryTimer;
    const slot = { token: message.uniqueToken, draft: null, applying: false, expiresAt: 0, close: function () {
      clearTimeout(pollTimer);
      clearTimeout(expiryTimer);
      if (remoteSetup === slot) remoteSetup = null;
      slot.draft = null;
      return registered.then(function () { return transfer.close(); }).catch(function () {});
    } };
    remoteSetup = slot;

    function fail(error) {
      if (remoteSetup !== slot || slot.applying) return;
      slot.close();
      replyError(message, error);
    }

    async function poll() {
      try {
        const reply = await transfer.read();
        if (remoteSetup !== slot) return;
        if (!reply) {
          pollTimer = setTimeout(poll, 2000);
          return;
        }
        const { summary } = remoteSettings(reply.data, readSettings());
        slot.draft = reply.data;
        message.respond({ returnValue: true, type: 'received', summary: summary });
      } catch (error) { fail(error); }
    }

    registered.then(function () {
      if (remoteSetup !== slot) return;
      slot.expiresAt = Date.now() + 5 * 60 * 1000;
      message.respond({ returnValue: true, type: 'waiting', address: transfer.address, code: transfer.code, link: transfer.link });
      expiryTimer = setTimeout(function () { fail(Error('Kurulum oturumunun süresi doldu.')); }, 5 * 60 * 1000);
      poll();
    }, fail);
  } catch (error) { replyError(message, error); }
});

remote.on('cancel', function (message) {
  if (remoteSetup && remoteSetup.token === message.uniqueToken && !remoteSetup.applying) remoteSetup.close();
});

service.register('applyRemoteSetup', async function (message) {
  const slot = remoteSetup;
  try {
    if (!slot || !slot.draft) throw Error('Uygulanacak ayar yok.');
    if (slot.applying) throw Error('Ayarlar zaten kaydediliyor.');
    if (Date.now() >= slot.expiresAt) {
      slot.close();
      throw Error('Kurulum oturumunun süresi doldu.');
    }
    const draft = slot.draft;
    slot.applying = true;
    try {
      const config = await saveRemoteSettings(draft);
      await slot.close();
      message.respond({ returnValue: true, settings: publicSettings(config), pairedNow: Boolean(draft.ps5) });
    } finally {
      slot.applying = false;
      if (remoteSetup === slot && Date.now() >= slot.expiresAt) slot.close();
    }
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
    const translation = savedTranslation(saved);
    const feed = createSubtitleFeed(translation, packs.match, function (text) {
      message.respond({ returnValue: true, type: 'subtitle', text: text });
    }, function (error) {
      message.respond({ returnValue: true, type: 'translationError', text: error });
    });
    slot = { token: message.uniqueToken, worker: null, region: publicSettings(saved).region, revision: 0,
      preview: false, feed: feed, close: function () {
      if (active === slot) active = null;
      feed.reset();
      if (slot.worker) slot.worker.stop();
    } };
    active = slot;
    const consoles = id ? discoverConsoles().catch(function () { return []; }) : Promise.resolve([]);
    const pack = translation.mode === 'api' ? Promise.resolve() : packs.load().catch(function (error) {
      const current = savedTranslation(readSettings());
      if (current.mode === 'pack' && !current.keys[current.provider]) throw error;
    });
    Promise.all([pack, consoles]).then(function (results) {
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
      let failure;
      const input = Object.assign({}, saved, { mode: 'stream', region: slot.region, revision: slot.revision });
      delete input.translation;
      slot.worker = launch(input, function (result) {
        if (active !== slot) return;
        if (result.type === 'error') failure = result.text;
        if (result.type === 'ready') message.respond({ returnValue: true, type: 'ready' });
        if (result.type !== 'ocr' || result.revision !== slot.revision) return;
        if (slot.preview) {
          message.respond({ returnValue: true, type: 'preview', text: result.text, revision: slot.revision });
          return;
        }
        feed.read(result.text, result.confidence);
      }, function (error) {
        if (active !== slot) return;
        active = null;
        feed.reset();
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
