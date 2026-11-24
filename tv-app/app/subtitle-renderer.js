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
    clearLayout(element);
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

  function clearLayout(element) {
    if (!element._subtitleLayout) return;
    delete element._subtitleLayout;
    delete element.dataset.layout;
    ['top', 'bottom', 'left', 'right', 'width', 'height', 'visibility'].forEach(function (name) { element.style[name] = ''; });
  }

  function hdmiSubtitleArea(dialogue, objective, height, appearance) {
    var first = Math.min(dialogue.y, objective ? objective.y : dialogue.y);
    var last = Math.max(dialogue.y + dialogue.height, objective ? objective.y + objective.height : 0);
    // The HDMI decoder rounds its source rectangle outwards. Leave room for
    // that rounding and for the subtitle shadow at the edge of the rectangle.
    var gap = Math.max(8, Math.ceil(height / 100));
    var above = { top: 0, bottom: Math.max(0, Math.floor(height * first / 100) - gap) };
    var below = { top: Math.min(height, Math.ceil(height * last / 100) + gap), bottom: height };
    var anchor = height * (appearance.position === 'top' ? appearance.offset : 100 - appearance.offset) / 100;
    var minHeight = (appearance.fontSize || 38) * 2.4 + (appearance.paddingY || 0) * 2 + 16;
    var upperFits = above.bottom >= minHeight, lowerFits = below.bottom - below.top >= minHeight;
    if (upperFits !== lowerFits) return upperFits ? above : below;
    if (!upperFits) return above.bottom >= below.bottom - below.top ? above : below;
    var upperDistance = Math.max(0, anchor - above.bottom);
    var lowerDistance = Math.max(0, below.top - anchor);
    return upperDistance <= lowerDistance ? above : below;
  }

  function createPinnedLayout() {
    var placed = [], hidden = [], signature = '';
    return { place: function (rows, options) {
      var nextSignature = JSON.stringify(options);
      if (!rows.length || signature !== nextSignature) { placed = []; hidden = []; signature = nextSignature; }
      var ids = rows.map(function (row) { return row.id; });
      placed = placed.filter(function (row) { return ids.indexOf(row.id) !== -1; });
      hidden = hidden.filter(function (id) { return ids.indexOf(id) !== -1; });
      var gap = 4, padding = options.paddingY || 0;
      var top = Math.max(8, options.safeTop || 0) + padding;
      var bottom = options.height - Math.max(8, (options.safeBottom || 0) + (options.bottomInset || 0)) - padding;
      if (bottom <= top) return [];
      function space(height) {
        var sorted = placed.slice().sort(function (a, b) { return a.top - b.top; });
        if (!sorted.length) {
          var anchor = options.position === 'top' ? options.height * options.offset / 100 + padding :
            options.height * (1 - options.offset / 100) - padding - height;
          return Math.max(top, Math.min(bottom - height, anchor));
        }
        var below = sorted[sorted.length - 1].top + sorted[sorted.length - 1].height + gap;
        if (below + height <= bottom) return below;
        for (var i = 1; i < sorted.length; i++) {
          var after = sorted[i - 1].top + sorted[i - 1].height + gap;
          if (after + height + gap <= sorted[i].top) return after;
        }
        var above = sorted[0].top - height - gap;
        return above >= top ? above : null;
      }
      rows.forEach(function (row) {
        var existing = placed.filter(function (item) { return item.id === row.id; })[0];
        if (existing || hidden.indexOf(row.id) !== -1) return;
        var height = Math.min(row.height, bottom - top), y = space(height);
        // When unusually long captions cannot fit, retire the oldest block;
        // never move a surviving block or reinsert an already retired one.
        while (y === null && placed.length) {
          var oldest = rows.filter(function (item) { return placed.some(function (p) { return p.id === item.id; }); })[0];
          placed = placed.filter(function (item) { return item.id !== oldest.id; });
          hidden.push(oldest.id);
          y = space(height);
        }
        placed.push({ id: row.id, top: y, height: height });
      });
      return rows.map(function (row) { return placed.filter(function (item) { return item.id === row.id; })[0]; }).filter(Boolean);
    } };
  }

  function renderTimeline(element, state, enabled) {
    var doc = element.ownerDocument, win = doc && doc.defaultView;
    if (!win || typeof element.getBoundingClientRect !== 'function' || !Array.isArray(state.blocks)) {
      render(element, state.text, state.speakers, enabled);
      return;
    }
    var style = win.getComputedStyle(element);
    var paddingX = parseFloat(style.paddingLeft) || 0, paddingY = parseFloat(style.paddingTop) || 0;
    var viewport = { width: win.innerWidth, height: win.innerHeight,
      position: element.dataset.position || 'bottom', offset: parseFloat(style.getPropertyValue('--subtitle-offset')) || 0,
      bottomInset: parseFloat(style.getPropertyValue('--subtitle-reserved-bottom')) || 0,
      safeTop: parseFloat(style.getPropertyValue('--subtitle-safe-top')) || 0,
      safeBottom: parseFloat(style.getPropertyValue('--subtitle-safe-bottom')) || 0,
      paddingY: paddingY, font: style.fontSize + '/' + style.lineHeight, names: enabled };
    var layout = element._subtitleLayout;
    if (!layout) layout = element._subtitleLayout = { planner: createPinnedLayout(), nodes: {} };
    var nodes = {}, measured = [];
    state.blocks.forEach(function (block) {
      var node = layout.nodes[block.id] || doc.createElement('div');
      node.className = 'subtitle-turn';
      node.dataset.turn = String(block.id);
      node.style.maxWidth = Math.max(1, viewport.width * 0.82 - paddingX * 2) + 'px';
      node.style.maxHeight = '';
      node.hidden = false;
      if (node._names !== enabled || node._text !== block.text || node._speakers !== JSON.stringify(block.speakers)) {
        render(node, block.text, block.speakers, enabled);
        node._names = enabled; node._text = block.text; node._speakers = JSON.stringify(block.speakers);
      }
      if (!node.parentNode) { node.style.top = '0px'; element.appendChild(node); }
      var rect = node.getBoundingClientRect();
      nodes[block.id] = node;
      measured.push({ id: block.id, width: rect.width, height: rect.height });
    });
    var positions = layout.planner.place(measured, viewport);
    var width = 0, first = Infinity, last = 0;
    element.textContent = '';
    state.blocks.forEach(function (block, index) {
      if (index) element.appendChild(doc.createTextNode('\n\n'));
      var node = nodes[block.id], position = positions.filter(function (p) { return p.id === block.id; })[0];
      node.hidden = !position;
      if (position) {
        node.style.top = position.top + 'px';
        node.style.maxHeight = position.height + 'px';
        width = Math.max(width, measured.filter(function (row) { return row.id === block.id; })[0].width);
        first = Math.min(first, position.top); last = Math.max(last, position.top + position.height);
      }
      element.appendChild(node);
    });
    layout.nodes = nodes;
    element.dataset.layout = 'stable';
    element.style.visibility = positions.length ? '' : 'hidden';
    if (!positions.length) return;
    element.style.top = (first - paddingY) + 'px';
    element.style.bottom = 'auto'; element.style.right = 'auto';
    element.style.width = (width + paddingX * 2) + 'px';
    element.style.left = (viewport.width - width - paddingX * 2) / 2 + 'px';
    element.style.height = (last - first + paddingY * 2) + 'px';
  }

  function readingDuration(text, scale) {
    var length = text.replace(/\s+/g, ' ').trim().length;
    var lines = Math.max(text.split('\n').length, Math.ceil(length / 48));
    var base = Math.max(500, length * 35 + 250, lines > 1 ? lines * 1250 : 0);
    return Math.round(Math.min(12000, base) * (scale || 100) / 100);
  }

  function createTimeline() {
    var entries = [], sourceKeys = [], scale = 100, nextId = 0;
    // Keep the current source through slow inference, but not a dead stream.
    var watchdog = 10000;

    function identity(text, speakers) {
      return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr').replace(/[.!?…]+$/, '') +
        '\u0000' + JSON.stringify(speakers.map(function (span) { return [span.offset, span.name]; }));
    }

    function snapshot(now) {
      entries = entries.filter(function (entry) { return entry.until > now; });
      if (!entries.length) sourceKeys = [];
      var text = '', speakers = [], next = Infinity;
      entries.forEach(function (entry) {
        if (text) text += '\n\n';
        var offset = text.length;
        entry.speakers.forEach(function (span) {
          speakers.push({ offset: offset + span.offset, name: span.name, color: span.color });
        });
        text += entry.text;
        next = Math.min(next, entry.until);
      });
      return { text: text, speakers: speakers, next: next, count: entries.length,
        blocks: entries.map(function (entry) { return { id: entry.id, text: entry.text, speakers: entry.speakers }; }) };
    }

    function release(now) {
      sourceKeys = [];
      entries.forEach(function (entry) { entry.until = entry.minimum; });
      return snapshot(now);
    }

    function read(text, rawSpeakers, now, turns) {
      var spans = validSpeakers(text, rawSpeakers || []);
      var offsets = spans.map(function (span) { return span.offset; });
      // Only validated complete turns may divide an unlabelled translation.
      if (Array.isArray(turns) && turns.length <= 6 && turns.length > 1 && turns[0] === 0 &&
          turns.every(function (offset, index) {
            return Number.isInteger(offset) && offset >= 0 && offset < text.length &&
              (!index || offset > turns[index - 1] && text[offset - 1] === '\n');
          })) offsets = offsets.concat(turns).filter(function (offset, index, values) {
            return values.indexOf(offset) === index;
          }).sort(function (a, b) { return a - b; });
      if (!offsets.length || offsets[0] !== 0) offsets.unshift(0);
      var parts = offsets.map(function (start, index) {
        var end = index + 1 < offsets.length ? offsets[index + 1] : text.length;
        var body = text.slice(start, end).replace(/\s+$/, '');
        var names = spans.filter(function (span) { return span.offset >= start && span.offset < end; })
          .map(function (span) { return { offset: span.offset - start, name: span.name, color: span.color }; });
        return { text: body, speakers: names, key: identity(body, names) };
      }).filter(function (part) { return part.text; });
      // Number identical occurrences from the newest end of a scrolling block.
      var occurrences = {};
      for (var index = parts.length - 1; index >= 0; index--) {
        var base = parts[index].key;
        var occurrence = occurrences[base] || 0;
        occurrences[base] = occurrence + 1;
        parts[index].key += '\u0001' + occurrence;
      }
      var keys = parts.map(function (part) { return part.key; });
      entries.forEach(function (entry) {
        if (keys.indexOf(entry.key) === -1) entry.until = entry.minimum;
      });
      parts.forEach(function (part) {
        // Repeated/scrolling source blocks must not reinsert an evicted old turn.
        var entry = sourceKeys.indexOf(part.key) !== -1 && entries.filter(function (item) { return item.key === part.key; }).pop();
        if (!entry && sourceKeys.indexOf(part.key) === -1) {
          entry = { id: ++nextId, text: part.text, speakers: part.speakers, key: part.key, at: now,
            minimum: now + readingDuration(part.text, scale) };
          entries.push(entry);
        }
        if (entry) {
          // Equivalent OCR wrapping/punctuation must not reflow a turn being read.
          entry.speakers = part.speakers;
          entry.until = Math.max(entry.minimum, now + watchdog);
        }
      });
      sourceKeys = keys;
      entries = entries.slice(-3);
      return snapshot(now);
    }

    return { read: read, release: release, snapshot: snapshot,
      clear: function () { entries = []; sourceKeys = []; },
      setScale: function (value, now) {
        scale = value || 100;
        entries.forEach(function (entry) {
          entry.minimum = entry.at + readingDuration(entry.text, scale);
          if (sourceKeys.indexOf(entry.key) === -1) entry.until = entry.minimum;
          else entry.until = Math.max(entry.until, entry.minimum);
        });
        return snapshot(now);
      } };
  }

  var api = { render: render, renderTimeline: renderTimeline, clearLayout: clearLayout, createPinnedLayout: createPinnedLayout,
    hdmiSubtitleArea: hdmiSubtitleArea,
    validSpeakers: validSpeakers, readingDuration: readingDuration, createTimeline: createTimeline };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SubtitleRenderer = api;
}(typeof window === 'object' ? window : this));
