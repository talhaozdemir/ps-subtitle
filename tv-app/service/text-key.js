'use strict';

const crypto = require('crypto');

function canonical(text) {
  return text.replace(/<[^<>]{0,40}>/g, ' ').normalize('NFKC').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9æøœßðþłđı]+/g, ' ').trim();
}

function key(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function sourceWithoutSpeaker(text, labels) {
  // Source labels are already reviewed. Do not treat language annotations or
  // an arbitrary colon in dialogue as an NPC name.
  if (Array.isArray(labels)) {
    for (const label of labels) {
      if (label && typeof label.source === 'string' && text.startsWith(label.source + ':')) {
        return text.slice(label.source.length + 1).replace(/^\s+/, '');
      }
    }
  }
  return text;
}

module.exports = { canonical, key, sourceWithoutSpeaker };
