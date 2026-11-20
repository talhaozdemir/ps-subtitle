'use strict';

const net = require('net');
const defaultRegion = { x: 6, y: 77, width: 88, height: 23 };
const defaultAppearance = { position: 'bottom', offset: 5, background: true, opacity: 90, fontSize: 38 };

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

function settings(payload) {
  if (!net.isIPv4(payload.address)) throw Error('Geçerli bir PS5 IPv4 adresi gir.');
  if ([1, 2, 3, 4].indexOf(payload.port) === -1) throw Error('PS5’in HDMI girişini seç.');
  return { address: payload.address, port: payload.port, quality: payload.quality === 720 ? 720 : 540 };
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

function publicSettings(saved) {
  const paired = Boolean(saved.registKey && saved.rpKey);
  let appearance = defaultAppearance;
  if (saved.appearance) {
    try { appearance = subtitleAppearance(saved.appearance); }
    catch (error) { /* Use the defaults when stored values are invalid. */ }
  }
  return { address: saved.address || '', port: saved.port || 1, quality: saved.quality || 540,
    paired: paired, setupComplete: paired && saved.setupComplete !== false, consoleId: consoleId(saved.consoleId),
    region: saved.region || defaultRegion, appearance: appearance };
}

module.exports = { accountBytes, settings, publicSettings, subtitleRegion, subtitleAppearance, consoleId };
