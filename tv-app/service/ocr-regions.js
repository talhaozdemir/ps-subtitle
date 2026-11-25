'use strict';

function captureRegion(dialogue, objective, hint) {
  const x = Math.min(dialogue.x, objective.x, hint.x);
  const y = Math.min(dialogue.y, objective.y, hint.y);
  return { x: x, y: y, width: Math.max(dialogue.x + dialogue.width, objective.x + objective.width, hint.x + hint.width) - x,
    height: Math.max(dialogue.y + dialogue.height, objective.y + objective.height, hint.y + hint.height) - y };
}

function contains(region, line) {
  return line.x >= region.x && line.x < region.x + region.width &&
    line.y >= region.y && line.y < region.y + region.height;
}

function reading(lines, text) {
  return { text: text, confidence: lines.length ?
    Math.floor(lines.reduce(function (sum, line) { return sum + line.confidence; }, 0) / lines.length) : 0 };
}

function positionedText(lines) {
  const rows = [];
  lines.forEach(function (line) {
    const row = rows.find(function (items) {
      const first = items[0];
      return Math.abs(first.y - line.y) <= Math.min(first.height, line.height) / 2;
    });
    if (row) row.push(line);
    else rows.push([line]);
  });
  return rows.map(function (row) {
    return row.sort(function (a, b) { return a.x - b.x; })
      .map(function (line) { return line.text; }).join(' ');
  }).join('\n');
}

function splitReading(result, region, objectiveRegion, hintRegion) {
  if (!Array.isArray(result.lines)) {
    return { dialogue: { text: result.text, confidence: result.confidence }, objective: reading([], ''), hint: reading([], '') };
  }
  const dialogue = [], objective = [], hint = [];
  result.lines.forEach(function (line) {
    if (!line || typeof line.text !== 'string' || !line.text.trim()) return;
    if (contains(hintRegion, line)) hint.push(line);
    else if (contains(objectiveRegion, line)) objective.push(line);
    else if (contains(region, line)) dialogue.push(line);
  });
  return { dialogue: reading(dialogue, positionedText(dialogue)),
    objective: reading(objective, positionedText(objective)), hint: reading(hint, positionedText(hint)) };
}

module.exports = { captureRegion, splitReading };
