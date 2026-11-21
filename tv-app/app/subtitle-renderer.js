(function (root) {
  'use strict';

  function validSpeakers(text, speakers) {
    if (!Array.isArray(speakers) || speakers.length > 32) return [];
    var result = [];
    var previous = -1;
    for (var i = 0; i < speakers.length; i++) {
      var span = speakers[i];
      if (!span || !Number.isInteger(span.offset) || span.offset <= previous || span.offset > text.length ||
          (span.offset !== 0 && text[span.offset - 1] !== '\n') || typeof span.name !== 'string' ||
          !span.name.length || span.name.length > 64 || /[\u0000-\u001f]/.test(span.name)) return [];
      result.push({ offset: span.offset, name: span.name,
        color: typeof span.color === 'string' && /^#[0-9a-f]{6}$/i.test(span.color) ? span.color : null });
      previous = span.offset;
    }
    return result;
  }

  function render(element, text, speakers, enabled) {
    var spans = enabled ? validSpeakers(text, speakers) : [];
    if (!spans.length) { element.textContent = text; return; }
    var doc = element.ownerDocument;
    element.textContent = '';
    var cursor = 0;
    spans.forEach(function (speaker) {
      element.appendChild(doc.createTextNode(text.slice(cursor, speaker.offset)));
      var name = doc.createElement('span');
      name.className = 'subtitle-speaker';
      name.textContent = speaker.name + ': ';
      if (speaker.color) name.style.color = speaker.color;
      element.appendChild(name);
      cursor = speaker.offset;
    });
    element.appendChild(doc.createTextNode(text.slice(cursor)));
  }

  var api = { render: render, validSpeakers: validSpeakers };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SubtitleRenderer = api;
}(typeof window === 'object' ? window : this));
