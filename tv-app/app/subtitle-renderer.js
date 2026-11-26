(function (root) {
  'use strict';

  var turnScales = [1, 0.9, 0.8, 0.7];
  var previousHold = 2500, stackGap = 4, blurOutset = 3;

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
    var count = appearance.subtitleCount || 3;
    var stackedScale = turnScales.slice(0, count).reduce(function (total, scale) { return total + scale; }, 0);
    var blur = appearance.background && appearance.opacity > 0 ? appearance.backgroundBlur || 0 : 0;
    var minHeight = (appearance.fontSize || 38) * 1.2 * stackedScale +
      (count - 1) * stackGap + (appearance.paddingY || 0) * 2 + blur * blurOutset * 2 + 16;
    var upperFits = above.bottom >= minHeight, lowerFits = below.bottom - below.top >= minHeight;
    if (upperFits !== lowerFits) return upperFits ? above : below;
    if (!upperFits) return above.bottom >= below.bottom - below.top ? above : below;
    var upperDistance = Math.max(0, anchor - above.bottom);
    var lowerDistance = Math.max(0, below.top - anchor);
    return upperDistance <= lowerDistance ? above : below;
  }

  function turnScale(age) {
    return turnScales[Math.min(age, turnScales.length - 1)];
  }

  function placeSubtitleStack(rows, options, lastCurrentHeight) {
    var padding = options.paddingY || 0;
    var top = Math.max(8, options.safeTop || 0) + padding;
    var bottom = options.height - Math.max(8, (options.safeBottom || 0) + (options.bottomInset || 0)) - padding;
    if (!rows.length || bottom <= top) return {};

    var latest = rows[rows.length - 1];
    // Allow the blurred edge to spread inside the safe area while keeping room for the text.
    var blurMargin = Math.min((options.backgroundBlur || 0) * blurOutset,
      Math.max(0, (bottom - top - latest.height) / 2));
    top += blurMargin;
    bottom -= blurMargin;
    var available = bottom - top;
    var current = latest.age === 0 ? latest : null;
    // Reserve the current slot if its caption finishes before the older ones.
    var currentHeight = Math.min(available, current ? current.height : lastCurrentHeight || options.lineHeight);
    var previousRows = [], previousSpace = 0;
    for (var index = rows.length - (current ? 2 : 1); index >= 0; index--) {
      var row = rows[index], height = row.height * turnScale(row.age);
      var space = height + stackGap;
      if (currentHeight + previousSpace + space > available) break;
      previousRows.push({ id: row.id, height: height });
      previousSpace += space;
    }
    if (!current && !previousRows.length) {
      currentHeight = 0;
      previousSpace = Math.min(available, latest.height * turnScale(latest.age));
      previousRows.push({ id: latest.id, height: previousSpace });
    }

    var anchor = options.position === 'top' ? options.height * options.offset / 100 + padding :
      options.height * (1 - options.offset / 100) - padding - currentHeight;
    var currentTop = Math.max(top + previousSpace, Math.min(bottom - currentHeight, anchor));
    var positions = {};
    var previousTop = currentTop - previousSpace;
    for (var older = previousRows.length - 1; older >= 0; older--) {
      var placed = previousRows[older];
      positions[placed.id] = { top: previousTop, height: placed.height };
      previousTop += placed.height + stackGap;
    }
    if (current) positions[current.id] = { top: currentTop, height: currentHeight };
    return positions;
  }

  function renderTimeline(element, state, enabled, options) {
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
      backgroundBlur: parseFloat(style.getPropertyValue('--subtitle-background-blur')) || 0,
      paddingY: paddingY, lineHeight: parseFloat(style.lineHeight) || 46 };
    var fixedWidth = options && options.region ? Math.min(viewport.width,
      Math.max(viewport.lineHeight + paddingX * 2, viewport.width * options.region.width / 100)) : 0;
    var maxContentWidth = Math.max(1, (fixedWidth || viewport.width * 0.82) - paddingX * 2);
    var layout = element._subtitleLayout;
    if (!layout) {
      element.textContent = '';
      layout = element._subtitleLayout = { nodes: {} };
    }
    var ids = state.blocks.map(function (block) { return String(block.id); });
    Object.keys(layout.nodes).forEach(function (id) {
      if (ids.indexOf(id) === -1) element.removeChild(layout.nodes[id]);
    });
    var nodes = {}, measured = [];
    state.blocks.forEach(function (block) {
      var node = layout.nodes[block.id] || doc.createElement('div');
      node.style.maxWidth = maxContentWidth + 'px';
      node.style.maxHeight = '';
      node.hidden = false;
      if (node._names !== enabled || node._text !== block.text || node._speakers !== JSON.stringify(block.speakers)) {
        render(node, block.text, block.speakers, enabled);
        node._names = enabled; node._text = block.text; node._speakers = JSON.stringify(block.speakers);
      }
      if (!node.parentNode) {
        node.className = 'subtitle-turn';
        styleTurn(node, turnScale(block.age));
        if (options && options.fadeIn && block.age === 0) {
          node.dataset.entering = 'true';
          node.addEventListener('animationend', function () { delete node.dataset.entering; });
        }
        element.appendChild(node);
      }
      nodes[block.id] = node;
      var row = { id: block.id, age: block.age, width: node.offsetWidth, height: node.offsetHeight };
      measured.push(row);
      if (row.age === 0) layout.currentHeight = row.height;
    });
    var positions = placeSubtitleStack(measured, viewport, layout.currentHeight);
    var width = 0, first = Infinity, last = 0;
    measured.forEach(function (row) {
      var node = nodes[row.id], position = positions[row.id];
      var scale = turnScale(row.age);
      styleTurn(node, scale);
      node.hidden = !position;
      if (!position) return;
      var unscaledHeight = position.height / scale;
      node.style.top = (position.top + position.height - unscaledHeight) + 'px';
      node.style.maxHeight = unscaledHeight + 'px';
      width = Math.max(width, row.width * scale);
      first = Math.min(first, position.top); last = Math.max(last, position.top + position.height);
    });
    layout.nodes = nodes;
    element.dataset.layout = 'stack';
    element.style.visibility = first < Infinity ? '' : 'hidden';
    if (first === Infinity) return;
    var frameWidth = fixedWidth || width + paddingX * 2;
    element.style.top = (first - paddingY) + 'px';
    element.style.bottom = 'auto'; element.style.right = 'auto';
    element.style.width = frameWidth + 'px';
    element.style.left = (viewport.width - frameWidth) / 2 + 'px';
    element.style.height = (last - first + paddingY * 2) + 'px';
  }

  function styleTurn(node, scale) {
    if (scale < 1) {
      node.dataset.previous = 'true';
      delete node.dataset.entering;
    }
    node.style.transform = scale < 1 ? 'translateX(-50%) scale(' + scale + ')' : '';
  }

  function readingDuration(text, scale) {
    var length = text.replace(/\s+/g, ' ').trim().length;
    var lines = Math.max(text.split('\n').length, Math.ceil(length / 48));
    var base = Math.max(500, length * 35 + 250, lines > 1 ? lines * 1250 : 0);
    return Math.round(Math.min(12000, base) * (scale || 100) / 100);
  }

  function createTimeline() {
    var entries = [], sourceKeys = [], scale = 100, nextId = 0, lastChange = 0, limit = 3;
    var sourceActive = false;
    // Keep the current source through slow inference, but not a dead stream.
    var watchdog = 10000;

    function identity(text, speakers) {
      return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr').replace(/[.!?…]+$/, '') +
        '\u0000' + JSON.stringify(speakers.map(function (span) { return [span.offset, span.name]; }));
    }

    function expire(now) {
      entries = entries.filter(function (entry) { return entry.until > now; });
      if (!entries.length || (!sourceActive && entries[entries.length - 1].id !== nextId)) sourceKeys = [];
    }

    function snapshot(now) {
      expire(now);
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
        blocks: entries.map(function (entry) {
          return { id: entry.id, text: entry.text, speakers: entry.speakers, age: nextId - entry.id };
        }) };
    }

    function readingDeadline(entry) {
      return entry.id === nextId ? entry.minimum : Math.max(entry.minimum, lastChange + previousHold);
    }

    function release(now) {
      // A missed OCR read shortens visibility without replacing a turn that is still on screen.
      sourceActive = false;
      entries.forEach(function (entry) { entry.until = readingDeadline(entry); });
      return snapshot(now);
    }

    function read(text, rawSpeakers, now, turns) {
      expire(now);
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
      var previousId = nextId;
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
        }
      });
      sourceKeys = keys;
      sourceActive = true;
      entries = entries.slice(-limit);
      if (nextId !== previousId) lastChange = now;
      entries.forEach(function (entry) {
        entry.until = readingDeadline(entry);
        if (entry.id === nextId && keys.indexOf(entry.key) !== -1) entry.until = Math.max(entry.until, now + watchdog);
      });
      return snapshot(now);
    }

    return { read: read, release: release, snapshot: snapshot,
      clear: function () { entries = []; sourceKeys = []; sourceActive = false; },
      setLimit: function (value) {
        limit = value === 2 || value === 4 ? value : 3;
        entries = entries.slice(-limit);
      },
      setScale: function (value, now) {
        scale = value || 100;
        entries.forEach(function (entry) {
          entry.minimum = entry.at + readingDuration(entry.text, scale);
          if (!sourceActive || entry.id !== nextId || sourceKeys.indexOf(entry.key) === -1) entry.until = readingDeadline(entry);
          else entry.until = Math.max(entry.until, entry.minimum);
        });
        return snapshot(now);
      } };
  }

  var api = { render: render, renderTimeline: renderTimeline, clearLayout: clearLayout, placeSubtitleStack: placeSubtitleStack,
    hdmiSubtitleArea: hdmiSubtitleArea,
    validSpeakers: validSpeakers, readingDuration: readingDuration, createTimeline: createTimeline };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SubtitleRenderer = api;
}(typeof window === 'object' ? window : this));
