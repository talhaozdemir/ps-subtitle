'use strict';

const crypto = require('crypto');
const { createSimilaritySearch } = require('./fuzzy');

function canonical(text) {
  return text.replace(/<[^<>]{0,40}>/g, ' ').normalize('NFKC').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9æøœßðþłđı]+/g, ' ').trim();
}

function key(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function withoutSpeaker(text) {
  return text.replace(/^[\wÀ-ž][\wÀ-ž .'’\-]{0,23}:\s+/, '');
}

function repairCapitalI(text) {
  // A thin capital I can be read as a vertical bar, sometimes joined to the next word.
  return text.replace(/(^|\s)\|(?=\s|[a-z]|$)/gi, '$1I ');
}

const digitConfusions = { '0': 'o', '1': 'il', '5': 's', '8': 'b' };
const shortConfusions = { c: 'e', e: 'c', h: 'n', i: 'lt', l: 'it', m: 'n', n: 'hm', o: 'q', q: 'o', t: 'il' };
const alphabet = 'abcdefghijklmnopqrstuvwxyz';

function correctedMatch(text, minimum, lookup) {
  const speech = canonical(repairCapitalI(withoutSpeaker(text)));
  const short = speech.length >= 12 && speech.length <= 24 && /\S+ \S+ \S+/.test(speech);
  const longestCandidate = short ? speech.length + 1 : speech.length;
  if ((!short && speech.length < 16) || 100 - 100 / longestCandidate < minimum) return null;

  let match = null;
  const matchedKeys = new Set();
  // Each candidate is checked against the full hash key of the normalized text.
  function consider(candidate) {
    const score = 100 - 100 / Math.max(speech.length, candidate.length);
    if (score < minimum) return true;
    const translation = lookup(candidate);
    if (!translation) return true;
    if (match && match.translation !== translation) return false;
    matchedKeys.add(key(candidate));
    if (!match || score > match.score) match = { score: score, translation: translation, keys: [] };
    match.keys = matchedKeys.size <= 64 ? Array.from(matchedKeys) : [];
    return true;
  }

  // A space correction keeps all of the letters read on screen.
  if (short) {
    for (let index = 1; index < speech.length; index++) {
      const head = speech.slice(0, index);
      const tail = speech.slice(index);
      if (tail[0] === ' ') {
        if (!consider(head + tail.slice(1))) return false;
      } else if (!head.endsWith(' ') && !consider(head + ' ' + tail)) {
        return false;
      }
    }
    if (match) return match;
  }

  let attempts = 0;
  for (let index = 0; index < speech.length && attempts < 12; index++) {
    const variants = digitConfusions[speech[index]] || '';
    for (const variant of variants) {
      attempts++;
      if (!consider(speech.slice(0, index) + variant + speech.slice(index + 1))) return false;
    }
  }

  // Compressed gameplay can turn the crossbar of "to" into "lo".
  const misreadTo = /\blo\b/g;
  for (let count = 0, word; count < 4 && (word = misreadTo.exec(speech)); count++) {
    if (!consider(speech.slice(0, word.index) + 'to' + speech.slice(word.index + 2))) return false;
  }
  if (!short) return match;

  // Short captions may not have a Bloom signature. Recover one dropped, extra or misread glyph.
  for (let index = 0; index <= speech.length; index++) {
    const head = speech.slice(0, index);
    const tail = speech.slice(index);
    const previousIsLetter = /[a-z]$/.test(head);
    const nextIsLetter = /^[a-z]/.test(tail);
    if (previousIsLetter || nextIsLetter) {
      for (const letter of alphabet) {
        if (!consider(head + letter + tail)) return false;
      }
    }
    if (index === speech.length) continue;
    const next = speech.slice(index + 1);
    if (tail[0] !== ' ' && (previousIsLetter || /^[a-z]/.test(next)) && !consider(head + next)) return false;
    for (const alternative of shortConfusions[speech[index]] || '') {
      if (!consider(head + alternative + next)) return false;
    }
  }
  return match;
}

function createMatcher(pack) {
  if (pack.format !== 2 || pack.id !== 'gta-6' || !pack.entries || !pack.segments) {
    throw Error('GTA VI altyazı paketi okunamadı.');
  }
  // The pack also contains editable source/name/colour evidence. The current
  // text-only display needs the lookup tables, not that whole metadata tree.
  const entries = pack.entries;
  const segments = pack.segments;
  const blockedKeys = new Set(Array.isArray(pack.blocked_keys) ? pack.blocked_keys : []);

  function blocked(text) {
    const full = key(canonical(text));
    // A complete, safe speaker-labelled key still takes precedence over an
    // ambiguous shortened caption such as "Okay".
    return blockedKeys.has(full) || (!lookupHash(full) && blockedKeys.has(key(canonical(withoutSpeaker(text)))));
  }

  function lookupHash(hash) {
    return entries[hash] || segments[hash] || '';
  }

  function lookup(text) {
    return text ? lookupHash(key(text)) : '';
  }

  function exactDetails(text) {
    if (blocked(text)) return null;
    const line = canonical(text);
    const exact = lookup(line);
    if (exact) return { translation: exact, keys: [key(line)] };

    const speakerless = withoutSpeaker(text);
    if (speakerless !== text) {
      const spoken = lookup(canonical(speakerless));
      if (spoken) return { translation: spoken, keys: [key(canonical(speakerless))] };
    }
    const repaired = repairCapitalI(speakerless);
    if (repaired !== speakerless) {
      const spoken = lookup(canonical(repaired));
      if (spoken) return { translation: spoken, keys: [key(canonical(repaired))] };
    }
    const speech = canonical(repaired);
    const contracted = speech.replace(/\b(we|you|they) are\b/g, '$1 re').replace(/\bi am\b/g, 'i m');
    const expanded = speech.replace(/\b(we|you|they) re\b/g, '$1 are').replace(/\bi m\b/g, 'i am');
    const compactMatch = contracted !== speech && lookup(contracted);
    const fullMatch = expanded !== speech && lookup(expanded);
    if (compactMatch && fullMatch && compactMatch !== fullMatch) return null;
    if (!compactMatch && !fullMatch) return null;
    return { translation: compactMatch || fullMatch,
      keys: [compactMatch && key(contracted), fullMatch && key(expanded)].filter(Boolean) };
  }

  const nearest = createSimilaritySearch(pack);
  return {
    blocked: blocked,
    exact: function (text) { const found = exactDetails(text); return found ? found.translation : ''; },
    exactDetails: exactDetails,
    lookup: lookupHash,
    similar: function (text, minimum) {
      return blocked(text) ? null : nearest(canonical(repairCapitalI(withoutSpeaker(text))), minimum);
    }
  };
}

module.exports = { canonical, correctedMatch, createMatcher, key };
