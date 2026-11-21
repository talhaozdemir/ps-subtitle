'use strict';

const { canonical } = require('./text-key');
const { sourceBody } = require('./lookup');
const { describeRecord, consensus } = require('./speaker-display');

function speech(record) {
  return record.english.split('\n').map(line => {
    for (const label of record.speaker_labels) {
      if (line.startsWith(label.source + ':')) return line.slice(label.source.length + 1).replace(/^\s+/, '');
    }
    return line;
  }).join('\n');
}

function reading(text) {
  return canonical(text.split('\n').map(line => {
    const match = /^([A-Za-zÀ-ž][A-Za-zÀ-ž0-9 &$.'’\-]{0,28}):\s*/.exec(line);
    return match && !/^(In |Unknown Language$)/i.test(match[1]) ? line.slice(match[0].length) : line;
  }).join('\n'));
}

function follows(later, earlier, seconds, distance) {
  const gap = later.time - earlier.time;
  return later.part === earlier.part && later.order > earlier.order &&
    later.order - earlier.order <= distance && gap >= 0.5 && gap <= seconds;
}

function containsPhrase(longer, shorter) {
  return (' ' + longer + ' ').includes(' ' + shorter + ' ');
}

function fitsReadings(first, last, observations) {
  let positions = [first];
  for (const observation of observations) {
    positions = observation.rawRows.filter(row => row.part === last.part && row.order <= last.order && row.time <= last.time &&
      positions.some(previous => row.order >= previous.order && row.time >= previous.time));
    if (!positions.length) return false;
  }
  return true;
}

// Bounded edit distance is used only for unresolved reads inside a confirmed
// source window. It never replaces the existing global OCR/similarity matcher.
function similarity(a, b, minimum) {
  if (a === b) return 100;
  const length = Math.max(a.length, b.length);
  const limit = Math.floor(length * (100 - minimum) / 100);
  if (!limit || Math.abs(a.length - b.length) > limit) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1).fill(limit + 1);
    current[0] = i;
    let least = limit + 1;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      least = Math.min(least, current[j]);
    }
    if (least > limit) return 0;
    previous = current;
  }
  return previous[b.length] <= limit ? 100 * (1 - previous[b.length] / length) : 0;
}

function indexReader(parts, full, bare, size) {
  return {
    size: size,
    exact: function (text) {
      const raw = canonical(text);
      const named = full.get(raw);
      let norm = reading(text);
      let rows;
      if (named && named.some(row => row.speech !== raw)) {
        rows = named;
        if (rows.every(row => row.speech === rows[0].speech)) norm = rows[0].speech;
      } else rows = bare.get(norm) || named || [];
      return { rows: rows, norm: norm };
    },
    nearby: function (anchors) {
      const found = new Set();
      for (const anchor of anchors) {
        const rows = parts.get(anchor.part);
        for (let i = anchor.order + 1; i < rows.length && i <= anchor.order + 60; i++) {
          const row = rows[i];
          if (row.time - anchor.time > 15) break;
          if (follows(row, anchor, 15, 60)) found.add(row);
        }
      }
      return Array.from(found);
    }
  };
}

function createContextIndex(pack) {
  const sequence = pack.local_context;
  const records = pack.speaker_metadata && pack.speaker_metadata.records;
  if (!sequence || sequence.version !== 1 || !sequence.parts || !records) return null;
  const parts = new Map(), full = new Map(), bare = new Map(), seen = new Set();
  // Context is an optional aid. Malformed optional data disables this aid,
  // leaving the validated dictionary, OCR repair and speaker display usable.
  for (const part of Object.keys(sequence.parts)) {
    const samples = sequence.parts[part];
    if (!part || part.length > 32 || !Array.isArray(samples)) return null;
    const rows = [];
    let lastTime = -1;
    for (const sample of samples) {
      if (!Array.isArray(sample) || sample.length !== 2) return null;
      const ref = sample[0], time = sample[1];
      const source = records[ref];
      if (typeof ref !== 'string' || !ref.startsWith(part + ':') || seen.has(ref) ||
          typeof time !== 'number' || !Number.isFinite(time) || time < lastTime || time < 0 ||
          !source || typeof source.english !== 'string' || source.english.length > 10000 ||
          !Array.isArray(source.speaker_labels) || source.speaker_labels.length > 32 ||
          source.speaker_labels.some(label => !label || typeof label.source !== 'string' || typeof label.turkish !== 'string')) return null;
      const body = sourceBody(source);
      if (typeof body !== 'string' || !body.trim() || body.length > 10000) return null;
      const description = describeRecord(source);
      const spans = description ? description.speakers : [];
      const normalized = canonical(speech(source));
      const meaning = canonical(body) + (body.includes('?') ? '?' : '.');
      const row = { ref: ref, part: part, time: time, order: rows.length, speech: normalized, body: body,
        spans: spans, displayBody: description && description.body,
        meaning: meaning, variant: meaning + JSON.stringify(spans.map(span => [span.offset, span.name])),
        anchor: normalized.length >= 24 && normalized.split(' ').length >= 4 &&
          !/\*{2,}|\[(?:inaudible|unreadable|censored|unclear|redacted)\]/i.test(source.english) };
      const key = canonical(source.english);
      if (!full.has(key)) full.set(key, []);
      if (!bare.has(normalized)) bare.set(normalized, []);
      full.get(key).push(row);
      bare.get(normalized).push(row);
      rows.push(row);
      seen.add(ref);
      lastTime = time;
    }
    parts.set(part, rows);
  }
  if (!seen.size || seen.size !== Object.keys(records).length) return null;
  return indexReader(parts, full, bare, seen.size);
}

function display(row, text) {
  if (row.displayBody !== text && !(row.spans.length === 1 && row.spans[0].offset === 0)) return [];
  return row.spans;
}

function createLocalContext(index, options) {
  options = options || {};
  const now = options.now || Date.now;
  const ttl = 45000;
  let history = [], lastIdentity = '', misses = 0, epoch = 0, revision = 0;
  let blankSince = null;

  function actorOf(baseline) {
    return baseline && baseline.speakers && baseline.speakers.length ? baseline.speakers.map(span => span.name).join('|') : '';
  }

  function clear(keepLast) {
    history = [];
    misses = 0;
    epoch++;
    revision = 0;
    blankSince = null;
    if (!keepLast) lastIdentity = '';
  }

  function expire(time) {
    const anchors = history.filter(row => row.strong);
    const latest = anchors[anchors.length - 1] || history[history.length - 1];
    if (latest && (time < latest.at || time - latest.at > ttl)) clear(true);
  }

  function anchors(time) {
    const strong = history.filter(row => row.strong);
    const last = strong[strong.length - 1];
    if (!last || time - last.at > 20000) return null;
    const previous = strong.slice(0, -1).reverse().find(row => row.norm !== last.norm && time - row.at <= ttl);
    return previous ? [previous, last] : null;
  }

  function choose(exact, confidence, minimum, time, baseline, newOccurrence) {
    const pair = anchors(time);
    if (!pair || confidence < 85) return null;
    const latestRead = history[history.length - 1];
    if (latestRead && exact.norm.length < latestRead.norm.length && time - latestRead.at < 5000 &&
        containsPhrase(latestRead.norm, exact.norm)) return null;
    const afterAnchor = history.slice(history.lastIndexOf(pair[1]) + 1);
    const repeating = !newOccurrence && lastIdentity === exact.norm + '\u0000' + actorOf(baseline);
    const latest = afterAnchor[afterAnchor.length - 1];
    const past = repeating && latest && latest.norm === exact.norm ? afterAnchor.slice(0, -1) : afterAnchor;
    // Repeated short replies in different turns must not reuse the previous
    // speaker. Fresh strong anchors are required before assigning it again.
    if (past.some(observation => observation.norm === exact.norm)) return null;
    let required = 100;
    let candidates = exact.rows.map(row => ({ row: row, score: 100 }));
    if (!candidates.length) {
      if (confidence < 90 || minimum >= 100 || exact.norm.length < 16 || exact.norm.split(' ').length < 3) return null;
      required = Math.max(minimum, 92);
      candidates = index.nearby(pair[1].rows).map(row => ({ row: row, score: similarity(exact.norm, row.speech, required - 5) }))
        .filter(item => item.score >= required - 5);
    }
    const groups = new Map();
    for (const item of candidates) {
      const current = item.row;
      const supported = pair[1].rows.some(last => follows(current, last, 15, 60) &&
        pair[0].rows.some(previous => follows(last, previous, 45, 160)));
      if (!supported) continue;
      const group = groups.get(current.variant);
      if (!group) groups.set(current.variant, { row: current, score: item.score, rows: [item] });
      else {
        group.rows.push(item);
        if (item.score > group.score) { group.row = current; group.score = item.score; }
      }
    }
    const ranked = Array.from(groups.values()).sort((a, b) => b.score - a.score);
    // Two equally plausible source scenes/meanings remain unresolved.
    if (!ranked.length || ranked[0].score < required || (ranked[1] && ranked[0].score - ranked[1].score < 5)) return null;
    const chosen = ranked[0];
    const lastStrong = history.lastIndexOf(pair[1]);
    const intervening = history.slice(lastStrong + 1).filter(observation =>
      observation.norm !== exact.norm && observation.rawRows.length);
    // Short known replies are not positive anchors. They can, however, veto
    // rewinding to a line that precedes an independently observed later reply.
    // A veto never promotes a runner-up into the winning scene.
    chosen.rows = chosen.rows.filter(item => pair[1].rows.some(last => {
      if (!follows(item.row, last, 15, 60) || !pair[0].rows.some(previous => follows(last, previous, 45, 160))) return false;
      return fitsReadings(last, item.row, intervening);
    }));
    if (!chosen.rows.length) return null;
    chosen.rows.sort((a, b) => b.score - a.score);
    chosen.row = chosen.rows[0].row;
    chosen.score = chosen.rows[0].score;
    if (chosen.score < required || (ranked[1] && chosen.score - ranked[1].score < 5)) return null;
    return chosen;
  }

  function observe(exact, confidence, baseline, time, newOccurrence) {
    if (confidence < 72 || !exact.norm) return;
    const actor = actorOf(baseline);
    const identity = exact.norm + '\u0000' + actor;
    if (!newOccurrence && identity === lastIdentity) return;
    lastIdentity = identity;
    const last = history[history.length - 1];
    if (!newOccurrence && last && exact.norm === last.norm && (!actor || !last.actor || actor === last.actor)) return;
    const meanings = new Set(exact.rows.map(row => row.meaning));
    const strong = confidence >= 90 && baseline && !baseline.approximate && meanings.size === 1 &&
      typeof baseline.translation === 'string' && exact.rows.length <= 64 &&
      canonical(baseline.translation) === canonical(exact.rows[0].body) && exact.rows.some(row => row.anchor);
    const observation = { norm: exact.norm, actor: actor, at: time, strong: !!strong,
      rows: strong ? exact.rows.filter(row => row.anchor) : [],
      rawRows: confidence >= 90 && exact.rows.length <= 256 ? exact.rows : [] };
    const latest = history.filter(row => row.strong).slice(-1)[0];
    const intervening = latest ? history.slice(history.lastIndexOf(latest) + 1)
      .filter(row => row.norm !== exact.norm && row.rawRows.length) : [];
    if (strong && latest && !observation.rows.some(row => latest.rows.some(previous =>
      follows(row, previous, 45, 160) && fitsReadings(previous, row, intervening)))) {
      clear(true); // a new scene, a seek, a branch, or out-of-order dialogue
    }
    const currentLast = history[history.length - 1];
    if (!newOccurrence && currentLast && time - currentLast.at < 5000 && (!actor || !currentLast.actor || actor === currentLast.actor) &&
        (containsPhrase(exact.norm, currentLast.norm) || containsPhrase(currentLast.norm, exact.norm))) {
      if (exact.norm.length >= currentLast.norm.length) history[history.length - 1] = observation;
    } else history.push(observation);
    history = history.slice(-10);
    revision++;
    if (strong) misses = 0;
    else if (confidence >= 85 && exact.norm.length >= 10 && !exact.rows.length) {
      if (++misses >= 2) clear(true);
    }
  }

  return {
    read: function (text, confidence, minimum, baseline) {
      const time = now();
      if (!Number.isFinite(time)) return baseline;
      expire(time);
      if (typeof text !== 'string' || text.length > 360) return baseline;
      if (!text.trim()) { if (blankSince === null) blankSince = time; return baseline; }
      const newOccurrence = blankSince !== null && time - blankSince >= 1200;
      blankSince = null;
      if (!Number.isFinite(confidence) || !Number.isFinite(minimum)) return baseline;
      const exact = index.exact(text);
      let result = baseline;
      // A reliable existing translation/speaker or an existing approximate
      // match wins outright. Context is only an aid for unresolved reads/names.
      if (!baseline || (!baseline.approximate && !(baseline.speakers || []).length)) {
        const chosen = choose(exact, confidence, minimum, time, baseline, newOccurrence);
        if (chosen) {
          const ambiguous = new Set(exact.rows.map(row => row.meaning)).size > 1;
          const translation = baseline && !ambiguous ? baseline.translation : chosen.row.body;
          const speakers = consensus(chosen.rows.filter(item => item.score >= chosen.score - 5)
            .map(item => display(item.row, translation)));
          if (!baseline || translation !== baseline.translation || speakers.length) {
            result = Object.assign({}, baseline || { score: chosen.score, approximate: chosen.score < 100 },
              { translation: translation, speakers: speakers, contextual: true });
          }
        }
      }
      // Only the original matcher result can seed strong anchors. A result
      // rescued by this context must never confirm its own future guesses.
      observe(exact, confidence, baseline, time, newOccurrence);
      return result;
    },
    reset: function () { clear(false); },
    token: function () { expire(now()); return epoch + ':' + revision; }
  };
}

module.exports = { createContextIndex, createLocalContext };
