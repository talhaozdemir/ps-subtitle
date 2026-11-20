'use strict';

const crypto = require('crypto');

function canonical(text) {
  return text.replace(/<[^<>]{0,40}>/g, ' ').normalize('NFKC').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9æøœßðþłđı]+/g, ' ').trim();
}

function key(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function createMatcher(pack) {
  if (pack.format !== 2 || pack.id !== 'gta-6' || !pack.entries || !pack.segments) {
    throw Error('GTA VI altyazı paketi okunamadı.');
  }

  function lookup(text) {
    if (!text) return '';
    const hash = key(text);
    return pack.entries[hash] || pack.segments[hash] || '';
  }

  return function match(text, confidence) {
    if (typeof text !== 'string' || text.length > 360 || confidence < 55) return '';
    const line = canonical(text);
    const exact = lookup(line);
    if (exact) return exact;

    const speakerless = text.replace(/^[\wÀ-ž][\wÀ-ž .'’\-]{0,23}:\s+/, '');
    if (speakerless !== text) {
      const spoken = lookup(canonical(speakerless));
      if (spoken) return spoken;
    }
    if (confidence < 72 || line.length < 16) return '';

    // The pack stores hashes without source text. Try only bounded, common OCR confusions.
    const replacements = { '0': 'o', '1': 'il', '5': 's', '8': 'b' };
    const results = new Set();
    let attempts = 0;
    for (let index = 0; index < line.length && attempts < 12; index++) {
      const variants = replacements[line[index]] || '';
      for (let variant = 0; variant < variants.length; variant++) {
        attempts++;
        const result = lookup(line.slice(0, index) + variants[variant] + line.slice(index + 1));
        if (result) results.add(result);
      }
      if (results.size > 1) return '';
    }
    return results.size === 1 ? results.values().next().value : '';
  };
}

module.exports = { canonical, createMatcher, key };
