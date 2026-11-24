'use strict';

function captureRegion(dialogue, objective) {
  const x = Math.min(dialogue.x, objective.x);
  const y = Math.min(dialogue.y, objective.y);
  return { x: x, y: y, width: Math.max(dialogue.x + dialogue.width, objective.x + objective.width) - x,
    height: Math.max(dialogue.y + dialogue.height, objective.y + objective.height) - y };
}

function contains(region, line) {
  return line.x >= region.x && line.x < region.x + region.width &&
    line.y >= region.y && line.y < region.y + region.height;
}

function reading(lines, text) {
  return { text: text, confidence: lines.length ?
    Math.floor(lines.reduce(function (sum, line) { return sum + line.confidence; }, 0) / lines.length) : 0 };
}

function objectiveText(lines) {
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

function splitReading(result, region, objectiveRegion) {
  if (!Array.isArray(result.lines)) {
    return { dialogue: { text: result.text, confidence: result.confidence }, objective: reading([], '') };
  }
  const dialogue = [], objective = [];
  result.lines.forEach(function (line) {
    if (!line || typeof line.text !== 'string' || !line.text.trim()) return;
    if (contains(objectiveRegion, line)) objective.push(line);
    else if (contains(region, line)) dialogue.push(line);
  });
  return { dialogue: reading(dialogue, dialogue.map(function (line) { return line.text; }).join('\n')),
    objective: reading(objective, objectiveText(objective)) };
}

module.exports = { captureRegion, splitReading };
