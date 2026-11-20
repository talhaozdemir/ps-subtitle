'use strict';

const net = require('net');
const defaultRegion = { x: 6, y: 77, width: 88, height: 23 };
const defaultAppearance = { position: 'bottom', offset: 5, background: true, opacity: 90, fontSize: 38 };
const supportedQualities = [360, 540, 720, 1080];
const translationProviderNames = { gemini: 'Gemini', openai: 'OpenAI' };
const defaultTranslation = { mode: 'pack', provider: 'gemini', keys: { gemini: '', openai: '' } };

function subtitleRegion(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(function (key) { return Number.isInteger(value[key]); }) ||
      value.x < 0 || value.y < 0 || value.width < 10 || value.height < 5 ||
      value.x + value.width > 100 || value.y + value.height > 100) {
    throw Error('Altyazı alanı ekran sınırları içinde olmalı.');
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

function settings(payload) {
  if (!net.isIPv4(payload.address)) throw Error('Geçerli bir PS5 IPv4 adresi gir.');
  if ([1, 2, 3, 4].indexOf(payload.port) === -1) throw Error('PS5’in HDMI girişini seç.');
  return { address: payload.address, port: payload.port, quality: captureQuality(payload.quality) };
}

function consoleId(value) {
  return typeof value === 'string' && /^[a-f0-9]{12}$/i.test(value) && value !== '000000000000'
    ? value.toLowerCase() : '';
}

function subtitleAppearance(value) {
  if (!value || (value.position !== 'bottom' && value.position !== 'top') ||
      !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 30 ||
      typeof value.background !== 'boolean' ||
      !Number.isInteger(value.opacity) || value.opacity < 0 || value.opacity > 100 ||
      !Number.isInteger(value.fontSize) || value.fontSize < 24 || value.fontSize > 64) {
    throw Error('Altyazı görünümü ayarları geçersiz.');
  }
  return { position: value.position, offset: value.offset, background: value.background,
    opacity: value.opacity, fontSize: value.fontSize };
}

function translationSettings(value, previous = defaultTranslation) {
  if (value && value.provider === undefined && (value.apiKey === null || typeof value.apiKey === 'string')) {
    value = { mode: value.mode, provider: 'gemini', keys: { gemini: value.apiKey } };
  }
  const providers = Object.keys(translationProviderNames);
  if (!value || ['pack', 'api'].indexOf(value.mode) === -1 || providers.indexOf(value.provider) === -1 ||
      !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) {
    throw Error('Çeviri ayarları geçersiz.');
  }
  const keys = {};
  for (const provider of providers) {
    const entry = value.keys[provider];
    const key = typeof entry === 'string' ? entry.trim() : '';
    if ((entry !== undefined && entry !== null && typeof entry !== 'string') ||
        (key && !/^[!-~]{1,512}$/.test(key))) {
      throw Error(translationProviderNames[provider] + ' API anahtarını boşluksuz gir.');
    }
    keys[provider] = entry === null ? '' : key || previous.keys[provider];
  }
  if (value.mode === 'api' && !keys[value.provider]) {
    throw Error('Önce ' + translationProviderNames[value.provider] + ' API anahtarını gir.');
  }
  return { mode: value.mode, provider: value.provider, keys: keys };
}

function savedTranslation(saved) {
  if (saved.translation) {
    try { return translationSettings(saved.translation); } catch (error) {}
  }
  return defaultTranslation;
}

function publicTranslation(config) {
  return { mode: config.mode, provider: config.provider,
    hasKeys: { gemini: Boolean(config.keys.gemini), openai: Boolean(config.keys.openai) } };
}

function publicSettings(saved) {
  const paired = Boolean(saved.registKey && saved.rpKey);
  let appearance = defaultAppearance;
  if (saved.appearance) {
    try { appearance = subtitleAppearance(saved.appearance); }
    catch (error) { /* Use the defaults when stored values are invalid. */ }
  }
  return { address: saved.address || '', port: saved.port || 1, quality: captureQuality(saved.quality),
    paired: paired, setupComplete: paired && saved.setupComplete !== false, consoleId: consoleId(saved.consoleId),
    region: saved.region || defaultRegion, appearance: appearance, translation: publicTranslation(savedTranslation(saved)) };
}

module.exports = { accountBytes, settings, publicSettings, subtitleRegion, subtitleAppearance, consoleId,
  translationSettings, savedTranslation, publicTranslation, translationProviderNames, supportedQualities };
