'use strict';

const { canonical, sourceWithoutSpeaker } = require('./text-key');
const { describeRecord, consensus } = require('./speaker-display');

// Index complete, source-labelled turns from reviewed multi-turn records.
// Never align translations by sentence count or split an unlabelled sentence.
function createTurnIndex(pack, matcher) {
  const table = new Map();
  const records = pack.speaker_metadata && pack.speaker_metadata.version === 1 && pack.speaker_metadata.records;
  function add(source, translation, speaker) {
    const norm = canonical(source);
    if (!norm) return;
    const previous = table.get(norm);
    if (previous === false) return;
    if (previous && previous.translation !== translation) { table.set(norm, false); return; }
    if (previous) {
      previous.speakers = consensus([previous.speakers, [speaker]]);
    } else table.set(norm, { translation, speakers: [speaker], score: 100, approximate: false, turn: true });
  }
  for (const record of Object.values(records || {})) {
    if (!record || typeof record.english !== 'string' || record.english.length > 1440) continue;
    const parsed = describeRecord(record);
    if (!parsed || parsed.speakers.length < 2 || parsed.speakers.length > 6 || parsed.speakers[0].offset !== 0) continue;
    const selected = matcher.exactDetails(record.english);
    // A source variant must not undo a reviewed dictionary resolution.
    if (!selected || selected.translation !== parsed.body) continue;
    const groups = [];
    for (const line of record.english.split('\n')) {
      const label = record.speaker_labels.find(item => item && typeof item.source === 'string' && line.startsWith(item.source + ':'));
      if (label) groups.push({ label, lines: [line] });
      else if (groups.length) groups[groups.length - 1].lines.push(line);
      else { groups.length = 0; break; }
    }
    if (groups.length !== parsed.speakers.length || groups.some((group, i) => group.label.turkish !== parsed.speakers[i].name)) continue;
    groups.forEach((group, i) => {
      const start = parsed.speakers[i].offset;
      const end = i + 1 < groups.length ? parsed.speakers[i + 1].offset : parsed.body.length;
      const translation = parsed.body.slice(start, end).replace(/\s+$/, '');
      const source = group.lines.join('\n');
      const speaker = Object.assign({}, parsed.speakers[i], { offset: 0 });
      add(source, translation, speaker);
      add(sourceWithoutSpeaker(source, [group.label]), translation, speaker);
    });
  }
  return { match(text) { return matcher.blocked(text) ? null : table.get(canonical(text)) || null; } };
}

module.exports = { createTurnIndex };
