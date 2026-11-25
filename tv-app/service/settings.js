'use strict';

const net = require('net');
const defaultRegion = { x: 6, y: 67, width: 88, height: 26 };
const objectiveRegionPresets = { 2: { x: 24, y: 93, width: 52, height: 7 } };
const hintRegion = { x: 80, y: 92, width: 20, height: 8 };
const defaultAppearance = { position: 'bottom', offset: 5, background: true, opacity: 90, fontSize: 38, paddingX: 14, paddingY: 7, showSpeakerNames: false, durationScale: 100 };
const supportedQualities = [360, 540, 720, 1080];
const defaultOcrRate = 3;
const translationProviderNames = { gemini: 'Gemini', openai: 'OpenAI' };
const defaultTranslation = { mode: 'pack', provider: 'gemini', similarity: 95, keys: { gemini: '', openai: '' } };

function subtitleRegion(value, objective = false) {
  if (!value || !['x', 'y', 'width', 'height'].every(function (key) { return Number.isInteger(value[key]); }) ||
      value.x < 0 || value.y < 0 || value.width < 10 || value.height < (objective ? 3 : 5) ||
      value.x + value.width > 100 || value.y + value.height > 100) {
    throw Error((objective ? 'Görev yazısı alanı' : 'Altyazı alanı') + ' ekran sınırları içinde olmalı.');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function accountBytes(value) {
  if (typeof value !== 'string') throw Error('PSN hesap kimliğini gir.');
  const text = value.trim();
  if (/^\d{1,20}$/.test(text)) {
    const bytes = Buffer.alloc(8);
    for (let index = 0; index < text.length; index++) {
      let carry = Number(text[index]);
      for (let byte = 0; byte < bytes.length; byte++) {
        const sum = 10 * bytes[byte] + carry;
        bytes[byte] = sum & 255;
        carry = sum >>> 8;
      }
      if (carry) throw Error('PSN hesap kimliği 64 bite sığmıyor.');
    }
    if (bytes.some(function (byte) { return byte !== 0; })) return bytes.toString('hex');
  }
  if (/^[A-Za-z0-9+/]{11}=$/.test(text)) {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length === 8 && bytes.toString('base64') === text &&
        bytes.some(function (byte) { return byte !== 0; })) return bytes.toString('hex');
  }
  throw Error('Geçerli bir sayısal veya Base64 PSN hesap kimliği gir.');
}

function captureQuality(value) {
  return supportedQualities.indexOf(value) !== -1 ? value : 540;
}

function subtitleOcrRate(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw Error('Okuma sıklığı saniyede 1 ile 10 arasında olmalı.');
  }
  return value;
}

function savedOcrRate(saved) {
  try { return subtitleOcrRate(saved.ocrRate); }
  catch (error) { return defaultOcrRate; }
}

function settings(payload) {
  if (!net.isIPv4(payload.address)) throw Error('Geçerli bir PS5 IPv4 adresi gir.');
  if ([1, 2, 3, 4].indexOf(payload.port) === -1) throw Error('PS5’in HDMI girişini seç.');
  return { address: payload.address, port: payload.port, quality: captureQuality(payload.quality),
    ocrRate: payload.ocrRate === undefined ? defaultOcrRate : subtitleOcrRate(payload.ocrRate) };
}

function consoleId(value) {
  return typeof value === 'string' && /^[a-f0-9]{12}$/i.test(value) && value !== '000000000000'
    ? value.toLowerCase() : '';
}

function subtitleAppearance(value) {
  const { paddingX = defaultAppearance.paddingX, paddingY = defaultAppearance.paddingY,
    showSpeakerNames = defaultAppearance.showSpeakerNames, durationScale = defaultAppearance.durationScale } = value || {};
  if (!value || (value.position !== 'bottom' && value.position !== 'top') ||
      !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 30 ||
      typeof value.background !== 'boolean' ||
      !Number.isInteger(value.opacity) || value.opacity < 0 || value.opacity > 100 ||
      !Number.isInteger(value.fontSize) || value.fontSize < 24 || value.fontSize > 64 ||
      !Number.isInteger(paddingX) || paddingX < 0 || paddingX > 100 ||
      !Number.isInteger(paddingY) || paddingY < 0 || paddingY > 60 || typeof showSpeakerNames !== 'boolean' ||
      !Number.isInteger(durationScale) || durationScale < 50 || durationScale > 300 || durationScale % 25 !== 0) {
    throw Error('Altyazı görünümü ayarları geçersiz.');
  }
  return { position: value.position, offset: value.offset, background: value.background,
    opacity: value.opacity, fontSize: value.fontSize, paddingX: paddingX, paddingY: paddingY,
    showSpeakerNames: showSpeakerNames, durationScale: durationScale };
}

function translationSettings(value, previous = defaultTranslation) {
  if (value && value.provider === undefined && (value.apiKey === null || typeof value.apiKey === 'string')) {
    value = { mode: value.mode, provider: 'gemini', similarity: value.similarity, keys: { gemini: value.apiKey } };
  }
  const providers = Object.keys(translationProviderNames);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Çeviri ayarları geçersiz.');
  const mode = value.mode === undefined ? previous.mode : value.mode;
  const selected = value.provider === undefined ? previous.provider : value.provider;
  const edits = value.keys === undefined ? {} : value.keys;
  if (['pack', 'api'].indexOf(mode) === -1 || providers.indexOf(selected) === -1 ||
      !edits || typeof edits !== 'object' || Array.isArray(edits)) {
    throw Error('Çeviri ayarları geçersiz.');
  }
  const keys = {};
  for (const provider of providers) {
    const entry = edits[provider];
    const key = typeof entry === 'string' ? entry.trim() : '';
    if ((entry !== undefined && entry !== null && typeof entry !== 'string') ||
        (key && !/^[!-~]{1,512}$/.test(key))) {
      throw Error(translationProviderNames[provider] + ' API anahtarını boşluksuz gir.');
    }
    keys[provider] = entry === null ? '' : key || previous.keys[provider];
  }
  if (mode === 'api' && !keys[selected]) {
    throw Error('Önce ' + translationProviderNames[selected] + ' API anahtarını gir.');
  }
  const similarity = value.similarity === undefined ? previous.similarity : value.similarity;
  if (!Number.isInteger(similarity) || similarity < 80 || similarity > 100) {
    throw Error('Benzerlik eşiği %80 ile %100 arasında olmalı.');
  }
  return { mode: mode, provider: selected, similarity: similarity, keys: keys };
}

function savedTranslation(saved) {
  if (saved.translation) {
    try { return translationSettings(saved.translation); } catch (error) {}
  }
  return defaultTranslation;
}

function publicTranslation(config) {
  return { mode: config.mode, provider: config.provider, similarity: config.similarity,
    hasKeys: { gemini: Boolean(config.keys.gemini), openai: Boolean(config.keys.openai) } };
}

function publicSettings(saved) {
  const paired = Boolean(saved.registKey && saved.rpKey);
  let appearance = defaultAppearance;
  if (saved.appearance) {
    try { appearance = subtitleAppearance(saved.appearance); }
    catch (error) { /* Use the defaults when stored values are invalid. */ }
  }
  const oldDefault = saved.region && saved.region.x === 6 && saved.region.width === 88 &&
    (saved.region.y === 62 || saved.region.y === 77) && saved.region.y + saved.region.height === 100;
  const oldObjective = saved.objectiveRegion && saved.objectiveRegion.x === 28 && saved.objectiveRegion.y === 93 &&
    saved.objectiveRegion.width === 44 && saved.objectiveRegion.height === 7;
  let objectiveRegion = objectiveRegionPresets[2];
  if (saved.objectiveRegion && !oldObjective) {
    try { objectiveRegion = subtitleRegion(saved.objectiveRegion, true); }
    catch (error) { /* Use the defaults when stored values are invalid. */ }
  }
  const source = saved.source === 'hdmi' ? 'hdmi' : 'remotePlay';
  return { address: saved.address || '', port: saved.port || 1, quality: captureQuality(saved.quality), ocrRate: savedOcrRate(saved),
    source: source, paired: paired, setupComplete: (paired || (source === 'hdmi' && !!saved.hdmiClientKey)) && saved.setupComplete !== false,
    consoleId: consoleId(saved.consoleId),
    region: !saved.region || oldDefault ? defaultRegion : saved.region, objectiveRegion: objectiveRegion,
    objectiveRegionPresets: objectiveRegionPresets, hintRegion: hintRegion,
    appearance: appearance, translation: publicTranslation(savedTranslation(saved)) };
}

module.exports = { accountBytes, settings, publicSettings, subtitleRegion, subtitleAppearance, consoleId,
  translationSettings, savedTranslation, publicTranslation, translationProviderNames, supportedQualities,
  subtitleOcrRate, savedOcrRate };
