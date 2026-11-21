// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// CouchSubs PackFuzzy v1 stores Bloom signatures of character trigrams.
const minimumLength = 16;
const { createLookup } = require('./lookup');
const minimumLead = 5;
const fold = { l: 'i', 1: 'i', ı: 'i', j: 'i', 0: 'o', 5: 's', æ: 'a', ø: 'o', œ: 'o', ß: 's' };

function signatureSize(length) {
  if (length * 3 <= 64) return 8;
  if (length * 3 <= 128) return 16;
  return 32;
}

function popcount(value) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function querySignatures(text) {
  const signatures = [new Uint32Array(2), new Uint32Array(4), new Uint32Array(8)];
  for (let index = 0; index + 2 < text.length; index++) {
    // Only the low eight bits of FNV-1a are needed for the largest signature.
    let hash = 0x25;
    const gram = Buffer.from(text.slice(index, index + 3), 'utf8');
    for (const byte of gram) hash = ((hash ^ byte) * 0xb3) & 255;
    for (const words of signatures) {
      const bit = hash & (words.length * 32 - 1);
      words[bit >>> 5] |= 1 << (bit & 31);
    }
  }
  return signatures.map(function (words) {
    return { words: words, ones: words.reduce(function (total, word) { return total + popcount(word); }, 0) };
  });
}

function readIndex(pack, table) {
  const data = pack.fuzzy;
  if (!data || data.version !== 1 || typeof data.mask !== 'string' ||
      typeof data.lengths !== 'string' || typeof data.blooms !== 'string') return null;

  const keys = table.keys.slice().sort();
  if (data.count !== keys.length) return null;
  const mask = Buffer.from(data.mask, 'base64');
  const lengths = Buffer.from(data.lengths, 'base64');
  const bytes = Buffer.from(data.blooms, 'base64');
  if (mask.length !== Math.ceil(keys.length / 8) || lengths.length > keys.length || bytes.length % 8) return null;

  const groups = Array.from({ length: 256 }, function () { return []; });
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) words[i] = bytes.readUInt32LE(i * 4);
  let row = 0;
  let offset = 0;
  for (let index = 0; index < keys.length; index++) {
    if (!(mask[index >>> 3] & (1 << (index & 7)))) continue;
    const length = lengths[row++];
    if (length === undefined || length < minimumLength) return null;
    const count = signatureSize(length) / 4;
    if (offset + count > words.length) return null;
    let ones = 0;
    for (let i = 0; i < count; i++) ones += popcount(words[offset + i]);
    const key = keys[index];
    groups[length].push({ key: key, offset: offset, ones: ones, translation: table.get(key) });
    offset += count;
  }
  if (row !== lengths.length || offset !== words.length) return null;
  return { groups: groups, words: words };
}

function findNearest(index, text, minimum) {
  const length = Math.min(text.length, 255);
  const tolerance = Math.floor(length / 4);
  const [small, medium, large] = querySignatures(text);
  let best = null;
  let runnerUp = 0;
  const provenance = [];
  let overflow = false;
  const floor = minimum - minimumLead;

  for (let size = Math.max(minimumLength, length - tolerance); size <= Math.min(255, length + tolerance); size++) {
    const bytes = signatureSize(size);
    const query = bytes === 8 ? small : bytes === 16 ? medium : large;
    const bits = bytes * 8;
    for (const candidate of index.groups[size]) {
      let common = 0;
      for (let word = 0; word < query.words.length; word++) {
        common += popcount(query.words[word] & index.words[candidate.offset + word]);
      }
      // Discount overlaps expected by chance when either signature has many set bits.
      const expected = query.ones * candidate.ones / bits;
      const overlap = common - expected;
      const unionWeight = Math.max(query.ones, candidate.ones) - expected;
      if (overlap <= 0 || 100 * overlap < floor * unionWeight) continue;
      const variance = expected * (1 - Math.min(query.ones, candidate.ones) / bits);
      if (overlap * overlap < 25 * variance) continue;

      const score = 100 * overlap / unionWeight;
      if (provenance.length < 256) provenance.push({ key: candidate.key, score: score, translation: candidate.translation });
      else overflow = true;
      if (!best || score > best.score) {
        if (best && best.translation !== candidate.translation) runnerUp = best.score;
        best = { score: score, translation: candidate.translation };
      } else if (best.translation !== candidate.translation) {
        runnerUp = Math.max(runnerUp, score);
      }
    }
  }
  if (!best || best.score < minimum || best.score - runnerUp < minimumLead) return null;
  best.keys = overflow ? [] : provenance.filter(row => row.translation === best.translation &&
    row.score >= best.score - minimumLead).map(row => row.key);
  return best;
}

function createSimilaritySearch(pack, table) {
  const index = readIndex(pack, table || createLookup(pack));
  const cache = new Map();
  return function nearest(canonical, minimum) {
    if (!index || minimum >= 100) return null;
    const text = canonical.replace(/ /g, '').replace(/[l1ıj05æøœß]/g, function (char) { return fold[char]; });
    if (text.length < minimumLength) return null;
    const cacheKey = minimum + ':' + text;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const match = findNearest(index, text, minimum);
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, match);
    return match;
  };
}

module.exports = { createSimilaritySearch };
