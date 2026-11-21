'use strict';

// These are recognised headers, never an identity or a person-to-colour map.
const knownLabels = require('./speaker-labels.json');
const { createLookup } = require('./lookup');
const headerNames = new Set(knownLabels);
const familyColours = {
  'Sarı': '#D4DF98', 'Açık yeşil': '#D6F8C9', 'Nane yeşili': '#9DEDD0',
  'Turkuaz / açık mavi': '#A5E2EA', 'Mor / lila': '#EDB6EE', 'Pembe': '#F0AFBA',
  'Turuncu / şeftali': '#EDB77F', 'Yeşil': '#93CC8C', 'Kırmızı': '#EF7373',
  'Sarı-yeşil': '#CFDF94', 'Lila / pembe-mor': '#EDB6EE', 'Mavi': '#9EC8F0',
  'Beyaz': '#FFFFFF', 'Gri': '#D0D0D0'
};
const safeHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function stripKnownHeaders(text, source) {
  const sourceNames = new Set();
  if (typeof source === 'string') {
    for (const line of source.split('\n')) {
      const found = /^([A-Za-zÀ-ž][A-Za-zÀ-ž0-9 &$.'’\-]{0,28}):/.exec(line);
      if (found && !/^In /i.test(found[1])) sourceNames.add(found[1]);
    }
  }
  return text.split('\n').map(line => {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon);
    return colon >= 0 && (headerNames.has(name) || sourceNames.has(name)) ? line.slice(colon + 1).replace(/^\s+/, '') : line;
  }).join('\n');
}

function parseRecord(record) {
  if (!record || typeof record.translation !== 'string' || record.translation.length > 10000 ||
      !Array.isArray(record.speaker_labels) || record.speaker_labels.length > 32) return null;
  const labels = new Map();
  for (const label of record.speaker_labels) {
    if (label && typeof label.turkish === 'string' && label.turkish.length && label.turkish.length <= 64 &&
        !/[\u0000-\u001f]/.test(label.turkish)) {
      labels.set(label.turkish, { label: label, used: 0 });
    }
  }
  let body = '';
  const speakers = [];
  for (const [lineIndex, line] of record.translation.split('\n').entries()) {
    if (lineIndex) body += '\n';
    const colon = line.indexOf(':');
    const found = labels.get(line.slice(0, colon));
    if (colon < 0 || !found) { body += line; continue; }
    const occurrences = Array.isArray(found.label.color_occurrences) ? found.label.color_occurrences : [];
    const colour = occurrences[found.used++];
    const family = colour && colour.status !== 'unresolved' && typeof colour.name_tr === 'string' ? colour.name_tr : null;
    const measured = colour && colour.status !== 'unresolved' && safeHex(colour.hex) ? colour.hex : null;
    const fallback = safeHex(familyColours[family]) ? familyColours[family] : null;
    speakers.push({ offset: body.length, name: found.label.turkish,
      color: measured || fallback, family: family });
    body += line.slice(colon + 1).replace(/^\s+/, '');
  }
  // A missing/reordered header must not attach a later occurrence's colour.
  for (const found of labels.values()) {
    const expected = Array.isArray(found.label.color_occurrences) ? found.label.color_occurrences.length : 0;
    if (expected && expected !== found.used) return null;
  }
  return speakers.length ? { body: body, speakers: speakers } : null;
}

function consensus(groups) {
  if (!groups.length || groups.some(group => !group || !group.length)) return [];
  const first = groups[0];
  if (groups.some(group => group.length !== first.length || group.some((span, i) =>
    span.offset !== first[i].offset || span.name !== first[i].name))) return [];
  return first.map((span, i) => {
    const colours = groups.map(group => group[i]);
    const agree = colours.every(item => item.family === span.family && item.color);
    return { offset: span.offset, name: span.name, color: agree ? span.color : null };
  });
}

function indexReader(compact) {
  // Use a separate closure so the compiler's metadata/map callbacks cannot
  // keep the large source-record tree reachable through a shared JS context.
  return { get: hash => compact.get(hash) || [] };
}

function createSpeakerIndex(pack, lookup) {
  const translationFor = lookup || createLookup(pack).get;
  const compact = new Map();
  const metadata = pack.speaker_metadata;
  if (metadata && metadata.version === 1 && metadata.keys && typeof metadata.keys === 'object' &&
      metadata.records && typeof metadata.records === 'object') {
    const parsed = new Map();
    for (const hash of Object.keys(metadata.keys)) {
      const refs = metadata.keys[hash];
      const translation = translationFor(hash);
      if (!Array.isArray(refs) || refs.length > 256 || !translation) continue;
      const groups = refs.map(ref => {
        if (!parsed.has(ref)) parsed.set(ref, parseRecord(metadata.records[ref]));
        const row = parsed.get(ref);
        if (!row) return null;
        // A single speaker can label a neutral synonym chosen during merging.
        // Multiple speakers require exact body alignment, never guessed offsets.
        if (row.body === translation || (row.speakers.length === 1 && row.speakers[0].offset === 0)) return row.speakers;
        return null;
      });
      const spans = consensus(groups);
      if (spans.length) compact.set(hash, spans);
    }
  }
  // Only this small index survives loading; raw frame/colour evidence can be GC'd.
  return indexReader(compact);
}

module.exports = { createSpeakerIndex, consensus, stripKnownHeaders, describeRecord: parseRecord };
