'use strict';

const { canonical, key, sourceWithoutSpeaker } = require('./text-key');

function body(record) {
  if (!record || typeof record.translation !== 'string' || !Array.isArray(record.speaker_labels)) return null;
  const names = new Set();
  for (const label of record.speaker_labels) {
    if (!label) return null;
    names.add(label.source);
    names.add(label.turkish);
  }
  return record.translation.split('\n').map(line => {
    const colon = line.indexOf(':');
    return colon >= 0 && names.has(line.slice(0, colon)) ? line.slice(colon + 1).replace(/^\s+/, '') : line;
  }).join('\n');
}

function reader(entries, segments, routes) {
  function get(hash) {
    const target = routes.get(hash) || hash;
    return entries[target] || segments[target] || '';
  }
  return { get: get, keys: Array.from(new Set(Object.keys(entries).concat(Object.keys(segments), Array.from(routes.keys())))),
    compacted: routes.size };
}

function createLookup(pack) {
  const entries = pack.entries;
  const segments = pack.segments;
  const direct = hash => entries[hash] || segments[hash] || '';
  const routes = new Map();
  const info = pack.key_compaction;
  if (info !== undefined) {
    const metadata = pack.speaker_metadata;
    if (!info || info.version !== 1 || !Number.isInteger(info.removed_key_count) ||
        !metadata || metadata.version !== 1 || !metadata.keys || !metadata.records) {
      throw Error('Tekilleştirilmiş altyazı paketinin kaynak bilgisi geçersiz.');
    }
    const blocked = new Set(pack.blocked_keys || []);
    for (const hash of Object.keys(metadata.keys)) {
      if (direct(hash)) continue;
      const refs = metadata.keys[hash];
      if (!Array.isArray(refs) || !refs.length || blocked.has(hash)) throw Error('Tekilleştirilmiş replik doğrulanamadı.');
      let target;
      for (const ref of refs) {
        const record = metadata.records[ref];
        if (!record || typeof record.english !== 'string' || key(canonical(record.english)) !== hash) {
          throw Error('Tekilleştirilmiş repliğin İngilizce kaynağı uyuşmuyor.');
        }
        const speech = sourceWithoutSpeaker(record.english, record.speaker_labels);
        const candidate = key(canonical(speech));
        if (speech === record.english || candidate === hash || !direct(candidate) || blocked.has(candidate) ||
            (target && target !== candidate)) throw Error('Tekilleştirilmiş repliğin hedefi geçersiz.');
        target = candidate;
      }
      const expected = metadata.equivalent_keys && metadata.equivalent_keys[hash] || body(metadata.records[refs[0]]);
      if (!expected || direct(target) !== expected) throw Error('Tekilleştirilmiş repliğin çevirisi uyuşmuyor.');
      routes.set(hash, target);
    }
    const count = new Set(Object.keys(entries).concat(Object.keys(segments))).size;
    if (routes.size !== info.removed_key_count || count + routes.size !== info.source_key_count) {
      throw Error('Tekilleştirilmiş altyazı paketinin kayıt sayısı uyuşmuyor.');
    }
  }
  // No copied translation values or extra on-disk alias table: reconstruct
  // compatibility routes from the existing speaker/source metadata once.
  return reader(entries, segments, routes);
}

module.exports = { createLookup };
