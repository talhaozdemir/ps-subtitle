'use strict';

const Service = require('webos-service');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { createPackStore } = require('./pack');
const { accountBytes, settings, publicSettings, subtitleRegion, subtitleAppearance, consoleId,
  translationSettings, savedTranslation, publicTranslation, translationProviderNames, supportedQualities,
  subtitleOcrRate, savedOcrRate } = require('./settings');
const { createSubtitleFeed, requestTranslation, testLine } = require('./translation');
const { createRemoteTransfer } = require('./remote-setup');

const service = new Service('com.gtavi.turkce.altyazi');
const configDirectory = '/media/internal/.com.gtavi.turkce.altyazi';
const configPath = path.join(configDirectory, 'settings.json');
const runtime = path.join(__dirname, 'runtime');
const packs = createPackStore(configDirectory, path.join(__dirname, 'gta-6.json.gz'));
let active = null;
// Cancellation clears active before the native Remote Play process has exited.
let streamClosed = Promise.resolve();
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
  let stopping = false;
  let resolveClosed;
  const closed = new Promise(function (resolve) { resolveClosed = resolve; });
  if (input.mode === 'stream') streamClosed = closed;
  function finish(error) {
    if (exited) return;
    exited = true;
    lines.close();
    resolveClosed();
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
      if (exited || stopping) return;
      stopping = true;
      worker.stdin.end();
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

service.register('setOcrRate', function (message) {
  try {
    const rate = subtitleOcrRate(message.payload.ocrRate);
    const config = readSettings();
    config.ocrRate = rate;
    saveSettings(config);
    if (active) {
      active.ocrRate = rate;
      if (active.worker) active.worker.send({ ocrRate: rate });
    }
    message.respond({ returnValue: true, ocrRate: rate });
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
      const changed = region.x !== active.region.x || region.y !== active.region.y ||
        region.width !== active.region.width || region.height !== active.region.height;
      active.region = region;
      active.revision = revision;
      active.preview = payload.preview === true;
      active.feed.reset();
      if (changed) {
        active.frameRevision = revision;
        if (active.worker) active.worker.send({ region: region, revision: revision });
      }
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
          if (payload.ocrRate === undefined) config.ocrRate = previous.ocrRate;
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
      if (supportedQualities.indexOf(video.quality) === -1) throw Error('Geçerli bir okuma çözünürlüğü seç.');
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

let videoDiagnostics;
let previousCapturePermit;
const capturePermitPath = '/tmp/gtavi-ocr-capture-enable';
service.register('videoDiagnostics', function (message) {
  const frames = message.payload && message.payload.captureFrames;
  if (frames !== undefined) {
    if (!Number.isInteger(frames) || frames < 1 || frames > 12 || !active || !active.worker ||
        !videoDiagnostics || videoDiagnostics.phase !== 'reading') {
      return replyError(message, Error('Örnekler için altyazı akışı açık olmalı. 1–12 kare seçebilirsin.'));
    }
    const capture = videoDiagnostics.capture;
    if (capture && !capture.complete && Date.now() < capture.expiresAt) {
      return replyError(message, Error('Altyazı kareleri zaten kaydediliyor.'));
    }
    try {
      const permit = message.payload.capturePermit;
      if (typeof permit !== 'string' || !/^[0-9a-f]{32}$/.test(permit) || permit === previousCapturePermit ||
          fs.readFileSync(capturePermitPath, 'utf8').trim() !== permit) throw Error('capture permit');
      previousCapturePermit = permit;
      try { fs.unlinkSync(capturePermitPath); } catch (error) { /* The developer session can remove its own file. */ }
    } catch (error) {
      return replyError(message, Error('Geliştirici yakalama izni bulunamadı.'));
    }
    videoDiagnostics.capture = { complete: false, frames: 0, expiresAt: Date.now() + 20000 };
    active.worker.send({ captureFrames: frames });
  }
  message.respond({ returnValue: true, active: Boolean(active), preview: Boolean(active && active.preview),
    video: videoDiagnostics || null });
});

const stream = service.register('start');
const reconnectDelays = [2000, 5000, 10000];
const videoTimeout = 12000;
const noVideo = 'PS5’e bağlanıldı ama altyazı için görüntü gelmiyor.';
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
    const ocrRate = message.payload.ocrRate === undefined ? savedOcrRate(saved) : requested.ocrRate;
    saveSettings(Object.assign(saved, { port: requested.port, quality: requested.quality, ocrRate: ocrRate }));
    const translation = savedTranslation(saved);
    const metrics = { phase: 'starting', attempt: 0, requestedQuality: requested.quality, engine: null,
      reads: 0, nonEmptyReads: 0, usableReads: 0, staleReads: 0,
      packMatches: 0, approximatePackMatches: 0, contextualPackMatches: 0, multilinePackMatches: 0, lastPackSimilarity: null, displayed: 0,
      timing: { queueMs: 0, maxQueueMs: 0, ocrMs: 0, maxOcrMs: 0, cropAgeMs: 0, maxCropAgeMs: 0,
        matchMs: 0, maxMatchMs: 0 } };
    videoDiagnostics = metrics;
    const localSession = packs.createSession();
    const feed = createSubtitleFeed(translation, function (text, confidence, minimum) {
      const started = Date.now();
      const found = localSession.match(text, confidence, minimum);
      metrics.timing.matchMs = Date.now() - started;
      metrics.timing.maxMatchMs = Math.max(metrics.timing.maxMatchMs, metrics.timing.matchMs);
      if (found) {
        metrics.packMatches++;
        if (found.approximate) metrics.approximatePackMatches++;
        if (found.contextual) metrics.contextualPackMatches++;
        if (found.multiline) metrics.multilinePackMatches++;
        metrics.lastPackSimilarity = Math.round(found.score * 10) / 10;
      }
      return found || '';
    }, function (text, speakers) {
      if (text) metrics.displayed++;
      message.respond({ returnValue: true, type: 'subtitle', text: text, speakers: speakers || [] });
    }, function (error) {
      message.respond({ returnValue: true, type: 'translationError', text: error });
    }, localSession);
    let reconnectTimer;
    let videoTimer;
    slot = { token: message.uniqueToken, worker: null, ocrRate: ocrRate,
      region: publicSettings(saved).region, revision: 0, frameRevision: 0,
      preview: false, feed: feed, close: function () {
      if (active === slot) active = null;
      metrics.phase = 'stopped';
      clearTimeout(reconnectTimer);
      clearTimeout(videoTimer);
      feed.reset();
      if (slot.worker) slot.worker.stop();
    } };
    active = slot;
    const consoles = id ? discoverConsoles().catch(function () { return []; }) : Promise.resolve([]);
    const pack = translation.mode === 'api' ? Promise.resolve() : packs.load().catch(function (error) {
      const current = savedTranslation(readSettings());
      if (current.mode === 'pack' && !current.keys[current.provider]) throw error;
    });
    Promise.all([pack, consoles, streamClosed]).then(function (results) {
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
      let reconnectAttempts = 0;
      function startWorker() {
        if (active !== slot) return;
        metrics.phase = 'connecting';
        metrics.attempt++;
        metrics.engine = null;
        let failure;
        let connected = false;
        let timedOut = false;
        let firstFrameAt;
        let lastFrameAt;
        function watchVideo() {
          clearTimeout(videoTimer);
          videoTimer = setTimeout(function () {
            if (active !== slot) return;
            timedOut = true;
            slot.worker.stop();
          }, videoTimeout);
        }
        const input = Object.assign({}, saved, { mode: 'stream', region: slot.region,
          revision: slot.frameRevision, ocrRate: slot.ocrRate });
        delete input.translation;
        slot.worker = launch(input, function (result) {
          if (active !== slot || timedOut) return;
          if (result.type === 'error') failure = result.text;
          if (result.type === 'sampleCapture') {
            metrics.capture = Object.assign({}, metrics.capture, { directory: result.directory,
              frames: result.frames, complete: result.complete });
          }
          if (result.type === 'videoStats') {
            metrics.engine = { videoSamples: result.videoSamples, droppedSamples: result.droppedSamples,
              sampledCrops: result.sampledCrops, replacedCrops: result.replacedCrops,
              decodedFrames: result.decodedFrames, ocrRuns: result.ocrRuns, skippedCrops: result.skippedCrops,
              width: result.width, height: result.height, ocrIntervalMs: result.ocrIntervalMs };
          }
          if (result.type === 'ready') {
            connected = true;
            metrics.phase = 'waitingVideo';
            watchVideo();
            message.respond({ returnValue: true, type: 'waitingVideo' });
          }
          if (result.type !== 'ocr') return;
          ['queueMs', 'ocrMs', 'cropAgeMs'].forEach(function (field) {
            const value = result[field];
            if (!Number.isFinite(value) || value < 0) return;
            metrics.timing[field] = value;
            const maximum = 'max' + field[0].toUpperCase() + field.slice(1);
            metrics.timing[maximum] = Math.max(metrics.timing[maximum], value);
          });
          metrics.reads++;
          if (result.text && result.text.trim()) {
            metrics.nonEmptyReads++;
            if (result.confidence >= 55) metrics.usableReads++;
          }
          lastFrameAt = Date.now();
          watchVideo();
          if (firstFrameAt === undefined) {
            firstFrameAt = lastFrameAt;
            metrics.phase = 'reading';
            message.respond({ returnValue: true, type: 'ready' });
          }
          if (result.revision !== slot.frameRevision) {
            metrics.staleReads++;
            return;
          }
          if (result.skipped) return;
          if (slot.preview) {
            message.respond({ returnValue: true, type: 'preview', text: result.text, revision: slot.revision });
            return;
          }
          feed.read(result.text, result.confidence);
        }, function (error) {
          if (active !== slot) return;
          clearTimeout(videoTimer);
          slot.worker = null;
          feed.reset();
          if (firstFrameAt !== undefined && lastFrameAt - firstFrameAt >= 30000) reconnectAttempts = 0;
          const busy = failure === 'Remote Play on Console is already in use';
          metrics.lastError = timedOut ? noVideo : failure || error;
          if ((!failure || connected || busy) && reconnectAttempts < reconnectDelays.length) {
            metrics.phase = 'reconnecting';
            reconnectTimer = setTimeout(startWorker, reconnectDelays[reconnectAttempts++]);
            message.respond({ returnValue: true, type: 'reconnecting' });
            return;
          }
          slot.close();
          metrics.phase = 'ended';
          message.respond({ returnValue: true, type: 'ended', text: timedOut ? noVideo : failure || error });
        });
      }
      startWorker();
    }).catch(function (error) {
      if (active !== slot) return;
      slot.close();
      metrics.phase = 'ended';
      metrics.lastError = error.message;
      replyError(message, error);
    });
  } catch (error) { replyError(message, error); }
});

stream.on('cancel', function (message) {
  if (active && active.token === message.uniqueToken) active.close();
});
