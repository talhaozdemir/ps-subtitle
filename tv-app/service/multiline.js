'use strict';

const maxTextLength = 1440;
const maxLines = 6;

function identity(result) {
  // Ignore only wrapping differences, never punctuation or speaker identity.
  const flat = text => text.replace(/\s+/g, ' ');
  return JSON.stringify([flat(result.translation).trim(), result.speakers.map(span =>
    [flat(result.translation.slice(0, span.offset)).length, span.name])]);
}

function combine(groups) {
  let translation = '';
  const speakers = [], turns = [];
  for (const group of groups) {
    if (translation) translation += '\n';
    const offset = translation.length;
    turns.push(offset);
    for (const span of group.speakers || []) {
      speakers.push({ offset: offset + span.offset, name: span.name, color: span.color });
    }
    translation += group.translation;
  }
  return { score: 100, approximate: false, translation: translation, speakers: speakers, turns: turns, multiline: true };
}

function matchMultiline(text, confidence, exact, blocked) {
  if (typeof text !== 'string' || text.length > maxTextLength || !Number.isFinite(confidence) || confidence < 85 ||
      !text.includes('\n') || blocked(text)) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim());
  if (lines.length < 2 || lines.length > maxLines || lines.some(line => !line)) return null;
  const paths = Array.from({ length: lines.length + 1 }, () => []);
  paths[0].push([]);
  // At most 21 exact lookups and 32 partitions for six physical OCR rows.
  // Wrapped sentences stay together when the dictionary knows the full group.
  // Never translate a prefix while silently discarding unmatched rows.
  for (let end = 1; end <= lines.length; end++) {
    for (let start = 0; start < end; start++) {
      if (!paths[start].length) continue;
      const found = exact(lines.slice(start, end).join('\n'));
      if (!found || found.approximate) continue;
      for (const previous of paths[start]) paths[end].push(previous.concat([found]));
    }
  }
  const complete = paths[lines.length].filter(groups => groups.length > 1)
    .sort((a, b) => a.length - b.length).map(combine);
  if (!complete.length) return null;
  const chosen = complete[0];
  // Conflicting complete interpretations must remain unresolved, including
  // disagreements about an NPC's identity. No translation or colour guessing.
  if (complete.some(result => identity(result) !== identity(chosen))) return null;
  chosen.speakers = chosen.speakers.map((span, i) => ({ offset: span.offset, name: span.name,
    color: complete.every(result => result.speakers[i].color === span.color) ? span.color : null }));
  return chosen;
}

module.exports = { matchMultiline, maxTextLength, maxLines };
