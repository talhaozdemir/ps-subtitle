(function () {
  'use strict';

  var service = 'luna://com.gtavi.turkce.altyazi/';
  var view = {};
  var session;
  var sessionReady = false;
  var sessionNumber = 0;
  var noticeTimer;
  var subtitleTimer;
  var lastSubtitleText = '';
  var lastSubtitleSpeakers = [];
  var lastSubtitleKey = '';
  var objectiveText = '';
  var objectiveInset = 0;
  var showSpeakerNames = false;
  var subtitleTimeline = SubtitleRenderer.createTimeline();
  var screenSaverBridge = null;
  var screenSaverReplies = [];
  var screenSaverWanted = false;
  var saved = { port: 1, address: '', quality: 540, ocrRate: 3, paired: false };
  var ocrRateSaving = false;
  var pending = true;
  var manualHdmi = false;
  var selectedConsoleId = '';
  var edit;
  var regionRevision = 0;
  var appearanceDraft;
  var appearanceSaving = false;
  var translationDraft;
  var translationBusy = false;
  var lastTranslationError = '';
  var remoteSetupDraft;
  var setupStep = 0;
  var setupSaving = false;

  ['hdmi', 'subtitle', 'objective', 'hint', 'notice', 'settings', 'setup', 'port', 'findPs5', 'discoveryStatus', 'consoleList',
    'address', 'source', 'hdmiHelp', 'skipRemotePlay', 'quality', 'ocrRate', 'ocrRateValue', 'ocrRateHelp', 'saveOcrRate', 'account', 'pin',
    'status', 'start', 'pair', 'editArea', 'editObjectiveArea', 'updatePack', 'close', 'regionEditor', 'regionBox', 'regionHandle', 'regionTitle',
    'regionHelp', 'regionPreview', 'regionError', 'regionPresets', 'regionAction', 'regionCancel', 'editAppearance',
    'appearanceEditor', 'appearancePosition', 'appearancePositionValue', 'appearanceEdge',
    'appearanceOffset', 'appearanceOffsetValue', 'appearanceSize', 'appearanceSizeValue',
    'appearanceCount', 'appearanceCountValue',
    'appearanceBackground', 'appearanceBackgroundValue', 'appearanceOpacity', 'appearanceOpacityValue',
    'appearanceBlur', 'appearanceBlurValue',
    'appearancePaddingX', 'appearancePaddingXValue', 'appearancePaddingY', 'appearancePaddingYValue',
    'appearanceNames', 'appearanceNamesValue', 'appearanceDuration', 'appearanceDurationValue',
    'appearanceError', 'saveAppearance', 'cancelAppearance', 'tabHdmi', 'tabPs5',
    'tabSubtitle', 'stepHdmi', 'stepPs5', 'stepSubtitle', 'trialHelp', 'subtitleOptions', 'previousStep',
    'nextStep', 'finishSetup', 'editTranslation', 'translationEditor', 'translationMode', 'translationModeValue',
    'translationSimilaritySection', 'translationSimilarity', 'translationSimilarityValue',
    'translationProvider', 'translationProviderValue', 'translationKeyLabel', 'translationKey', 'testTranslation',
    'removeTranslationKey', 'saveTranslation', 'cancelTranslation', 'translationStatus',
    'openRemoteSetup', 'remoteSetupEditor', 'remoteSetupCodePanel', 'remoteSetupQr', 'remoteSetupAddress',
    'remoteSetupCode', 'remoteSetupStatus', 'remoteSetupApply', 'remoteSetupRetry', 'remoteSetupCancel']
    .forEach(function (id) { view[id] = document.getElementById(id); });
  var setupTabs = [view.tabHdmi, view.tabPs5, view.tabSubtitle];
  var setupPanels = [view.stepHdmi, view.stepPs5, view.stepSubtitle];
  var appearanceControls = [view.appearancePosition, view.appearanceOffset, view.appearanceSize, view.appearanceCount,
    view.appearanceDuration, view.appearanceNames, view.appearanceBackground, view.appearanceOpacity, view.appearanceBlur,
    view.appearancePaddingX, view.appearancePaddingY,
    view.saveAppearance, view.cancelAppearance];
  var backgroundControls = [view.appearanceOpacity, view.appearanceBlur, view.appearancePaddingX, view.appearancePaddingY];
  var translationControls = [view.translationMode, view.translationSimilarity, view.translationProvider, view.translationKey, view.testTranslation,
    view.removeTranslationKey, view.saveTranslation, view.cancelTranslation];

  function call(method, parameters, success, failure) {
    return callLuna(service + method, parameters, success, failure);
  }

  function callLuna(uri, parameters, success, failure) {
    if (!window.PalmServiceBridge) {
      failure('Bu işlem LG TV’de kullanılabilir.');
      return null;
    }
    var bridge = new window.PalmServiceBridge();
    bridge.onservicecallback = function (raw) {
      var message;
      try { message = JSON.parse(raw); } catch (error) { failure('TV servisinden geçersiz yanıt geldi.'); return; }
      if (!message || typeof message !== 'object') failure('TV servisinden geçersiz yanıt geldi.');
      else if (message.returnValue === false) failure(message.errorText || 'TV servisi isteği tamamlayamadı.');
      else success(message);
    };
    try { bridge.call(uri, JSON.stringify(parameters)); }
    catch (error) {
      failure('TV servisine bağlanılamadı.');
      return null;
    }
    return bridge;
  }

  function status(text, error) {
    view.status.textContent = text;
    view.status.dataset.error = String(Boolean(error));
    if (!view.settings.hidden) return;
    window.clearTimeout(noticeTimer);
    view.notice.textContent = text;
    view.notice.hidden = !text;
    noticeTimer = window.setTimeout(function () { view.notice.hidden = true; }, 5100);
  }

  function hideSubtitle() {
    window.clearTimeout(subtitleTimer);
    SubtitleRenderer.clearLayout(view.subtitle);
    view.subtitle.textContent = '';
    view.subtitle.hidden = true;
  }

  function drawSubtitles(state, fadeIn) {
    window.clearTimeout(subtitleTimer);
    var key = state.blocks.map(function (block) { return block.id; }).join(',') + '\u0000' +
      state.text + '\u0000' + (showSpeakerNames ? JSON.stringify(state.speakers) : '');
    var previous = lastSubtitleKey;
    lastSubtitleKey = key;
    lastSubtitleText = state.text;
    lastSubtitleSpeakers = state.speakers;
    if (!state.text) { hideSubtitle(); return; }
    var wasHidden = view.subtitle.hidden;
    view.subtitle.hidden = false;
    if (wasHidden || key !== previous) {
      SubtitleRenderer.renderTimeline(view.subtitle, state, showSpeakerNames, {
        region: saved.appearance && saved.appearance.background ? saved.region : null,
        fadeIn: fadeIn
      });
    }
    subtitleTimer = window.setTimeout(function () {
      drawSubtitles(subtitleTimeline.snapshot(performance.now()));
    }, Math.max(1, state.next - performance.now()));
  }

  function subtitle(text, speakers, turns) {
    if (appearanceDraft) return;
    if (!text) {
      subtitleTimeline.clear();
      lastSubtitleText = '';
      lastSubtitleSpeakers = [];
      hideSubtitle();
      return;
    }
    drawSubtitles(subtitleTimeline.read(text, speakers, performance.now(), turns), true);
  }

  function reserveObjectiveSpace() {
    var inset = view.objective.hidden ? 0 : view.objective.offsetHeight + window.innerHeight * 0.01 + 4;
    if (inset === objectiveInset) return;
    objectiveInset = inset;
    view.subtitle.style.setProperty('--subtitle-reserved-bottom', inset + 'px');
    lastSubtitleKey = '';
    if (!appearanceDraft && !view.subtitle.hidden) drawSubtitles(subtitleTimeline.snapshot(performance.now()));
  }

  function objective(text) {
    objectiveText = text;
    view.objective.textContent = text;
    view.objective.hidden = !text || Boolean(edit);
    reserveObjectiveSpace();
  }

  function hint(text) {
    view.hint.textContent = text;
    view.hint.hidden = !text || Boolean(edit);
  }

  function placeHdmiOverlay(appearance) {
    appearance = appearance || saved.appearance;
    var area;
    if (saved.source === 'hdmi' && saved.region && appearance) {
      area = SubtitleRenderer.hdmiSubtitleArea(saved.region, saved.objectiveRegion, window.innerHeight, appearance);
      document.body.dataset.hdmiOverlay = 'true';
    } else {
      delete document.body.dataset.hdmiOverlay;
    }
    var safeTop = area ? area.top : 0;
    var safeBottom = area ? window.innerHeight - area.bottom : 0;
    document.body.style.setProperty('--subtitle-safe-top', safeTop + 'px');
    document.body.style.setProperty('--subtitle-safe-bottom', safeBottom + 'px');
    lastSubtitleKey = '';
  }

  function updateScreenSaver() {
    var enabled = screenSaverWanted && !document.hidden;
    if (!enabled) {
      if (screenSaverBridge) screenSaverBridge.cancel();
      screenSaverBridge = null;
      screenSaverReplies.forEach(function (bridge) { bridge.cancel(); });
      screenSaverReplies = [];
      return;
    }
    if (screenSaverBridge || !window.PalmServiceBridge) return;
    screenSaverBridge = callLuna('luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
      { subscribe: true, clientName: 'com.gtavi.turkce' }, function (request) {
        if (!screenSaverWanted || document.hidden ||
            !(typeof request.timestamp === 'string' && request.timestamp.length ||
              typeof request.timestamp === 'number' && Number.isFinite(request.timestamp)) ||
            (request.state !== undefined && request.state !== 'Active')) return;
        // Older firmware sends a timestamp without a state field.
        var reply = callLuna('luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
          { clientName: 'com.gtavi.turkce', ack: false, timestamp: request.timestamp }, function () {}, function () {});
        if (reply) screenSaverReplies = screenSaverReplies.slice(-3).concat([reply]);
      }, function (error) { status('Ekran koruyucu engellenemedi: ' + error, true); });
  }

  function showHdmi(port) {
    if (!window.PalmServiceBridge || !port) return;
    if (view.hdmi.dataset.port === String(port)) return;
    view.hdmi.dataset.port = String(port);
    var source = document.createElement('source');
    source.type = 'service/webos-external';
    source.src = 'ext://hdmi:' + port;
    source.addEventListener('error', function () {
      if (source.parentNode === view.hdmi) {
        status('HDMI görüntüsü alınamadı. PS5’i açıp giriş numarasını kontrol et.', true);
      }
    });
    view.hdmi.textContent = '';
    view.hdmi.appendChild(source);
    view.hdmi.load();
  }

  function detectHdmiInputs() {
    callLuna('luna://com.webos.service.eim/getAllInputStatus', {}, function (response) {
      if (!Array.isArray(response.devices)) return;
      var ps5Ports = {};
      var ps5Name = /\b(?:ps[\s_-]*5|play[\s_-]*station[\s_-]*5)\b/i;
      response.devices.forEach(function (device) {
        if (!device || device.connected === false || device.hdmiPlugIn === false) return;
        var hdmi = /^HDMI_?([1-4])$/i.exec(device.id) || /^com\.webos\.app\.hdmi([1-4])$/i.exec(device.appId);
        if (hdmi && (ps5Name.test(device.label || '') || ps5Name.test(device.spdProductDescription || ''))) {
          ps5Ports[hdmi[1]] = true;
        }
      });
      var matches = Object.keys(ps5Ports);
      Array.prototype.forEach.call(view.port.options, function (option) {
        if (ps5Ports[option.value]) option.textContent = 'HDMI ' + option.value + ' · PS5';
      });
      if (matches.length !== 1 || saved.paired || manualHdmi) return;
      view.port.value = matches[0];
      showHdmi(Number(matches[0]));
      updateButtons();
    }, function () {});
  }

  function values() {
    return { port: Number(view.port.value), address: view.address.value.trim(), quality: Number(view.quality.value),
      source: view.source.value, ocrRate: saved.ocrRate || 3 };
  }

  function isPaired() {
    if (!saved.paired) return false;
    if (selectedConsoleId && saved.consoleId) return selectedConsoleId === saved.consoleId;
    return view.address.value.trim() === saved.address;
  }

  function updateButtons() {
    var paired = isPaired();
    var complete = saved.setupComplete;
    var hdmi = view.source.value === 'hdmi';
    var sourceReady = hdmi ? Boolean(Number(view.port.value)) : paired;
    view.address.required = !hdmi;
    view.port.disabled = pending || setupSaving;
    view.quality.disabled = pending || setupSaving || hdmi;
    view.source.disabled = pending || setupSaving;
    view.skipRemotePlay.disabled = pending || !Number(view.port.value);
    view.hdmiHelp.hidden = !hdmi;
    view.ocrRate.disabled = pending || ocrRateSaving;
    view.saveOcrRate.disabled = pending || ocrRateSaving || Number(view.ocrRate.value) === (saved.ocrRate || 3);
    view.findPs5.disabled = pending;
    view.start.disabled = pending || setupSaving || !sourceReady;
    view.pair.disabled = pending;
    view.editArea.disabled = pending || !saved.region;
    view.editObjectiveArea.disabled = pending || !saved.objectiveRegion;
    view.editAppearance.disabled = pending || !saved.appearance;
    view.editTranslation.disabled = pending || !saved.translation;
    view.openRemoteSetup.disabled = pending || setupSaving || !saved.translation;
    view.previousStep.hidden = complete || setupStep === 0;
    view.previousStep.disabled = pending || setupSaving;
    view.nextStep.hidden = complete || setupStep === 2;
    view.nextStep.disabled = pending || (setupStep === 0 && !view.port.value) || (setupStep === 1 && !paired);
    view.finishSetup.hidden = complete || setupStep !== 2;
    view.finishSetup.disabled = pending || setupSaving || !sourceReady || !sessionReady;
    view.close.hidden = !complete;
    view.subtitleOptions.hidden = !complete;
    view.start.textContent = complete ? 'Altyazıyı başlat' : 'Altyazıyı dene';
    view.trialHelp.hidden = hdmi || (complete && paired);
    view.trialHelp.textContent = paired
      ? 'Ana hesabına dön ve İngilizce altyazıyı aç.'
      : 'Önce PS5’i eşleştir.';
  }

  function showStep(step, focus) {
    setupStep = step;
    setupTabs.forEach(function (tab, index) {
      var selected = index === step;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      setupPanels[index].hidden = !selected;
    });
    updateButtons();
    if (focus) {
      view.settings.scrollTop = 0;
      setupTabs[step].focus();
    }
  }

  function showSettings(focus) {
    view.settings.hidden = false;
    view.notice.hidden = true;
    (focus || setupTabs[setupStep]).focus();
  }

  function navigateSetup(step) {
    if (pending || setupSaving || step < 0 || step >= setupTabs.length || step === setupStep) return;
    status('');
    showStep(step, true);
  }

  function finishSetup() {
    if (view.finishSetup.disabled) return;
    setupSaving = true;
    updateButtons();
    call('completeSetup', {}, function () {
      setupSaving = false;
      saved.setupComplete = true;
      updateButtons();
      view.settings.hidden = true;
      status('Kurulum tamamlandı.');
    }, function (error) {
      setupSaving = false;
      updateButtons();
      if (sessionReady) view.finishSetup.focus();
      else setupTabs[setupStep].focus();
      status(error, true);
    });
  }

  function regionError(text) {
    view.regionError.textContent = text;
    view.regionError.hidden = !text;
  }

  function previewRegion() {
    var draft = edit;
    window.clearTimeout(draft.timer);
    draft.revision = ++regionRevision;
    draft.lastReadAt = 0;
    view.regionPreview.textContent = session ? 'Metin aranıyor…' : 'Canlı önizleme için altyazıyı başlat.';
    if (!session) return;
    var revision = draft.revision;
    draft.timer = window.setTimeout(function () {
      call('setRegion', { target: draft.target, region: draft.region, revision: revision, preview: true }, function () {}, function (error) {
        if (edit === draft && draft.revision === revision) regionError(error);
      });
    }, 90);
  }

  function drawRegion() {
    var region = edit.region;
    view.regionBox.style.left = region.x + '%';
    view.regionBox.style.top = region.y + '%';
    view.regionBox.style.width = region.width + '%';
    view.regionBox.style.height = region.height + '%';
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }

  function centeredChange(start, size, delta, minimum) {
    // Whole percentages on both edges preserve the center of even and odd sizes.
    return clamp(delta, Math.ceil((minimum - size) / 2), Math.min(start, 100 - start - size));
  }

  function sameRegion(first, second) {
    return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
  }

  function changeRegion(origin, dx, dy) {
    var next = Object.assign({}, origin);
    if (edit.mode === 'resize') {
      var horizontal = centeredChange(origin.x, origin.width, dx, 10);
      var vertical = centeredChange(origin.y, origin.height, -dy, edit.target === 'objectiveRegion' ? 3 : 5);
      next.x -= horizontal;
      next.width += 2 * horizontal;
      next.y -= vertical;
      next.height += 2 * vertical;
    } else {
      next.x = clamp(origin.x + dx, 0, 100 - origin.width);
      next.y = clamp(origin.y + dy, 0, 100 - origin.height);
    }
    if (sameRegion(next, edit.region)) return;
    edit.region = next;
    drawRegion();
    regionError('');
    previewRegion();
  }

  function setRegionMode(mode) {
    edit.mode = mode;
    var resize = mode === 'resize';
    var isObjective = edit.target === 'objectiveRegion';
    var label = isObjective ? 'Görev yazısı alanını' : 'Altyazı alanını';
    view.regionEditor.dataset.mode = mode;
    view.regionTitle.textContent = label + (resize ? ' boyutlandır' : ' taşı');
    view.regionHelp.textContent = resize
      ? '← / → genişliği, ↑ / ↓ yüksekliği merkezden ayarlar.' + (isObjective ? '' : ' İki satırlık yer bırak.')
      : 'Yön tuşlarıyla kutuyu ' + (isObjective ? 'görev yazısının' : 'altyazının') + ' üzerine getir.';
    view.regionAction.textContent = resize ? 'OK · Kaydet' : 'OK · Boyutlandır';
    view.regionAction.hidden = false;
    view.regionPresets.hidden = true;
    view.regionHandle.hidden = !resize;
    view.regionEditor.focus();
  }

  function chooseObjectiveRegion() {
    edit.mode = 'choose';
    edit.choices = [];
    view.regionEditor.dataset.mode = 'choose';
    view.regionTitle.textContent = 'Görev yazısı alanı';
    view.regionHelp.textContent = 'Bir boyut seç veya kutuyu elle ayarla.';
    view.regionHandle.hidden = true;
    view.regionAction.hidden = true;
    view.regionPresets.hidden = false;
    view.regionPresets.textContent = '';

    function addChoice(label, onClick) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', function () {
        if (edit && edit.mode === 'choose' && !edit.busy) onClick();
      });
      view.regionPresets.appendChild(button);
      edit.choices.push(button);
      return button;
    }

    var selected;
    var presets = saved.objectiveRegionPresets || {};
    Object.keys(presets).forEach(function (size) {
      var region = presets[size];
      var button = addChoice('Boyut ' + size, function () {
        edit.region = Object.assign({}, region);
        setRegionMode('resize');
        drawRegion();
        regionError('');
        previewRegion();
      });
      if (sameRegion(region, edit.region)) selected = button;
    });
    var custom = addChoice('Özel', function () { setRegionMode('move'); });
    (selected || custom).focus();
  }

  function openRegionEditor(target) {
    edit = { target: target, region: Object.assign({}, saved[target]), busy: false };
    view.settings.hidden = true;
    view.notice.hidden = true;
    subtitle('');
    objective('');
    hint('');
    view.regionEditor.hidden = false;
    regionError('');
    if (target === 'objectiveRegion') chooseObjectiveRegion();
    else setRegionMode('move');
    drawRegion();
    previewRegion();
  }

  function finishRegionEdit(save) {
    var draft = edit;
    if (draft.busy) return;
    draft.busy = true;
    draft.revision = ++regionRevision;
    window.clearTimeout(draft.timer);
    view.regionAction.disabled = view.regionCancel.disabled = true;
    var region = save ? draft.region : saved[draft.target];
    call('setRegion', { target: draft.target, region: region, revision: draft.revision, save: save }, function () {
      if (save) saved[draft.target] = region;
      edit = null;
      placeHdmiOverlay();
      view.regionEditor.hidden = true;
      view.regionAction.disabled = view.regionCancel.disabled = false;
      objective(objectiveText);
      hint(view.hint.textContent);
      if (!save) showSettings(draft.target === 'objectiveRegion' ? view.editObjectiveArea : view.editArea);
    }, function (error) {
      draft.busy = false;
      view.regionAction.disabled = view.regionCancel.disabled = false;
      regionError(error);
    });
  }

  function advanceRegionEdit() {
    if (edit.busy) return;
    if (edit.mode === 'move') setRegionMode('resize');
    else finishRegionEdit(true);
  }

  function bindRangeChange(range, update) {
    function change() { update(Number(range.value)); }
    range.addEventListener('input', change);
    range.addEventListener('keydown', function (event) {
      if (event.keyCode !== 37 && event.keyCode !== 39) return;
      event.preventDefault();
      range.stepUp(event.keyCode === 39 ? 1 : -1);
      change();
    });
  }

  function drawOcrRate() {
    var rate = Number(view.ocrRate.value);
    var label = rate + ' kez/sn · ' + Math.round(1000 / rate) + ' ms';
    view.ocrRateValue.textContent = label;
    view.ocrRate.setAttribute('aria-valuetext', label);
    updateButtons();
  }

  function saveOcrRate() {
    if (view.saveOcrRate.disabled) return;
    var rate = Number(view.ocrRate.value);
    ocrRateSaving = true;
    updateButtons();
    call('setOcrRate', { ocrRate: rate }, function (response) {
      saved.ocrRate = response.ocrRate;
      ocrRateSaving = false;
      drawOcrRate();
      view.ocrRate.focus();
      status('Okuma sıklığı kaydedildi.');
    }, function (error) {
      ocrRateSaving = false;
      updateButtons();
      view.saveOcrRate.focus();
      status(error, true);
    });
  }

  function applyAppearance(appearance) {
    SubtitleRenderer.clearLayout(view.subtitle);
    lastSubtitleKey = '';
    showSpeakerNames = appearance.showSpeakerNames === true;
    if (!appearanceDraft) subtitleTimeline.setLimit(appearance.subtitleCount);
    subtitleTimeline.setScale(appearance.durationScale || 100, performance.now());
    view.subtitle.dataset.position = appearance.position;
    view.subtitle.style.setProperty('--subtitle-offset', appearance.offset + '%');
    view.subtitle.style.setProperty('--subtitle-size', appearance.fontSize + 'px');
    view.subtitle.style.setProperty('--subtitle-background', appearance.background
      ? 'rgba(0, 0, 0, ' + appearance.opacity / 100 + ')' : 'transparent');
    var blur = appearance.background && appearance.opacity > 0 ? appearance.backgroundBlur : 0;
    if (blur) view.subtitle.dataset.backgroundBlur = 'true';
    else delete view.subtitle.dataset.backgroundBlur;
    view.subtitle.style.setProperty('--subtitle-background-blur', blur ? blur + 'px' : '');
    view.subtitle.style.setProperty('--subtitle-padding-x', appearance.background ? appearance.paddingX + 'px' : '');
    view.subtitle.style.setProperty('--subtitle-padding-y', appearance.background ? appearance.paddingY + 'px' : '');
    if (saved.source === 'hdmi') placeHdmiOverlay(appearance);
    if (!appearanceDraft && !view.subtitle.hidden && lastSubtitleText) {
      drawSubtitles(subtitleTimeline.snapshot(performance.now()));
    }
  }

  function drawAppearanceEditor() {
    var draft = appearanceDraft;
    var top = draft.position === 'top';
    view.appearancePositionValue.textContent = top ? 'Üst orta' : 'Alt orta';
    view.appearanceEdge.textContent = top ? 'Üst kenardan mesafe' : 'Alt kenardan mesafe';
    view.appearanceBackground.setAttribute('aria-pressed', String(draft.background));
    view.appearanceBackgroundValue.textContent = draft.background ? 'Açık' : 'Kapalı';
    view.appearanceNames.setAttribute('aria-pressed', String(draft.showSpeakerNames === true));
    view.appearanceNamesValue.textContent = draft.showSpeakerNames ? 'Açık' : 'Kapalı';
    view.appearanceOffset.value = draft.offset;
    view.appearanceSize.value = draft.fontSize;
    view.appearanceCount.value = draft.subtitleCount || 3;
    view.appearanceCountValue.textContent = String(view.appearanceCount.value);
    view.appearanceOpacity.value = draft.opacity;
    view.appearanceBlur.value = draft.backgroundBlur || 0;
    view.appearancePaddingX.value = draft.paddingX;
    view.appearancePaddingY.value = draft.paddingY;
    view.appearanceDuration.value = draft.durationScale || 100;
    view.appearanceDurationValue.textContent = ((draft.durationScale || 100) / 100).toLocaleString('tr') + '×';
    view.appearanceOffsetValue.textContent = '%' + draft.offset;
    view.appearanceSizeValue.textContent = draft.fontSize + ' px';
    view.appearanceOpacityValue.textContent = '%' + draft.opacity;
    view.appearanceBlurValue.textContent = view.appearanceBlur.value + ' px';
    view.appearancePaddingXValue.textContent = draft.paddingX + ' px';
    view.appearancePaddingYValue.textContent = draft.paddingY + ' px';
    appearanceControls.forEach(function (control) { control.disabled = appearanceSaving; });
    backgroundControls.forEach(function (control) {
      control.disabled = appearanceSaving || !draft.background;
      control.labels[0].dataset.disabled = String(!draft.background);
    });
    applyAppearance(draft);
    var preview = SubtitleRenderer.createTimeline();
    preview.setLimit(draft.subtitleCount);
    ['Beni duyuyor musun?', 'Evet, duyuyorum.', 'Hazırsan başlayalım.'].forEach(function (text) {
      preview.read(text, [], 0);
    });
    SubtitleRenderer.renderTimeline(view.subtitle,
      preview.read('Örnek altyazı', [{ offset: 0, name: 'Jason', color: '#D4DF98' }], 0), draft.showSpeakerNames,
      { region: draft.background ? saved.region : null });
  }

  function appearanceError(text) {
    view.appearanceError.textContent = text;
    view.appearanceError.hidden = !text;
  }

  function openAppearanceEditor() {
    window.clearTimeout(subtitleTimer);
    appearanceDraft = Object.assign({}, saved.appearance);
    view.settings.hidden = true;
    view.notice.hidden = true;
    appearanceError('');
    view.subtitle.hidden = false;
    drawAppearanceEditor();
    view.appearanceEditor.hidden = false;
    view.appearancePosition.focus();
  }

  function closeAppearanceEditor() {
    appearanceDraft = null;
    view.appearanceEditor.hidden = true;
    applyAppearance(saved.appearance);
    subtitle('');
    showSettings(view.editAppearance);
  }

  function saveAppearance() {
    if (appearanceSaving) return;
    appearanceSaving = true;
    appearanceError('');
    drawAppearanceEditor();
    call('setAppearance', { appearance: appearanceDraft }, function (response) {
      appearanceSaving = false;
      saved.appearance = response.appearance;
      closeAppearanceEditor();
    }, function (error) {
      appearanceSaving = false;
      appearanceError(error);
      drawAppearanceEditor();
      view.saveAppearance.focus();
    });
  }

  function translationStatus(text, error) {
    view.translationStatus.textContent = text;
    view.translationStatus.hidden = !text;
    view.translationStatus.dataset.error = String(Boolean(error));
  }

  function drawTranslationEditor() {
    var provider = translationDraft.provider;
    var label = provider === 'openai' ? 'OpenAI' : 'Gemini';
    view.translationModeValue.textContent = translationDraft.mode === 'api' ? 'Sadece API' : 'Paket öncelikli';
    view.translationProviderValue.textContent = label;
    view.translationKeyLabel.textContent = label + ' API anahtarı';
    var hasKey = saved.translation.hasKeys[provider] && translationDraft.keys[provider] !== null;
    view.translationKey.placeholder = hasKey ? 'Kayıtlı anahtar kullanılıyor' : '';
    view.removeTranslationKey.hidden = !hasKey;
    translationControls.forEach(function (control) { control.disabled = translationBusy; });
    view.translationSimilaritySection.hidden = translationDraft.mode === 'api';
    view.translationSimilarity.disabled = translationBusy || translationDraft.mode === 'api';
    view.translationSimilarity.value = translationDraft.similarity;
    view.translationSimilarityValue.textContent = '%' + translationDraft.similarity;
    view.translationSimilarity.setAttribute('aria-valuetext', 'Yüzde ' + translationDraft.similarity);
  }

  function openTranslationEditor() {
    translationDraft = { mode: saved.translation.mode, provider: saved.translation.provider,
      similarity: saved.translation.similarity, keys: {} };
    view.translationKey.value = '';
    translationStatus('');
    drawTranslationEditor();
    view.settings.hidden = true;
    view.notice.hidden = true;
    subtitle('');
    view.translationEditor.hidden = false;
    view.translationMode.focus();
  }

  function closeTranslationEditor() {
    translationDraft = null;
    view.translationEditor.hidden = true;
    view.translationKey.value = '';
    showSettings(view.editTranslation);
  }

  function rememberTranslationKey() {
    var provider = translationDraft.provider;
    var key = view.translationKey.value.trim();
    if (key || translationDraft.keys[provider] !== null) translationDraft.keys[provider] = key;
  }

  function submitTranslation(test) {
    if (translationBusy) return;
    var button = test ? view.testTranslation : view.saveTranslation;
    rememberTranslationKey();
    var draft = translationDraft;
    if (test) {
      draft = { mode: draft.mode, provider: draft.provider, keys: {} };
      draft.keys[draft.provider] = translationDraft.keys[draft.provider];
    }
    translationBusy = true;
    drawTranslationEditor();
    translationStatus(test ? 'Örnek replik çevriliyor…' : 'Kaydediliyor…');
    function finish() {
      translationBusy = false;
      drawTranslationEditor();
      button.focus();
    }
    call(test ? 'testTranslation' : 'setTranslation', draft, function (response) {
      finish();
      if (test) translationStatus('Bağlantı başarılı · ' + response.text);
      else {
        saved.translation = response.translation;
        closeTranslationEditor();
        status('Çeviri ayarları kaydedildi.');
      }
    }, function (error) {
      finish();
      translationStatus(error, true);
    });
  }

  function remoteSetupStatus(text, error) {
    view.remoteSetupStatus.textContent = text;
    view.remoteSetupStatus.dataset.error = String(Boolean(error));
  }

  function drawSetupQr(link) {
    var qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    var canvas = view.remoteSetupQr;
    var modules = qr.getModuleCount();
    var pixel = 5;
    var size = (modules + 8) * pixel;
    canvas.width = canvas.height = size;
    var context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#000';
    for (var row = 0; row < modules; row++) {
      for (var col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) context.fillRect((col + 4) * pixel, (row + 4) * pixel, pixel, pixel);
      }
    }
  }

  function beginRemoteSetup() {
    if (remoteSetupDraft && remoteSetupDraft.bridge) remoteSetupDraft.bridge.cancel();
    var draft = { bridge: null, summary: null, applying: false };
    remoteSetupDraft = draft;
    view.settings.hidden = true;
    view.notice.hidden = true;
    subtitle('');
    view.remoteSetupEditor.hidden = false;
    view.remoteSetupCodePanel.hidden = true;
    view.remoteSetupApply.hidden = view.remoteSetupRetry.hidden = true;
    remoteSetupStatus('Kurulum bağlantısı açılıyor…');
    view.remoteSetupCancel.focus();
    draft.bridge = call('startRemoteSetup', { subscribe: true }, function (message) {
      if (remoteSetupDraft !== draft) return;
      if (message.type === 'waiting') {
        drawSetupQr(message.link);
        view.remoteSetupAddress.textContent = message.address;
        view.remoteSetupCode.textContent = message.code.toUpperCase().match(/.{4}/g).join(' ');
        view.remoteSetupCodePanel.hidden = false;
        remoteSetupStatus('Kod 5 dakika geçerli.');
      }
      if (message.type === 'received') {
        draft.summary = message.summary;
        var labels = [];
        if (draft.summary.ps5) labels.push('PS5 · ' + draft.summary.ps5.address + ' · HDMI ' + draft.summary.ps5.port);
        if (draft.summary.translation) labels.push(draft.summary.translation.provider + ' · ' +
          (draft.summary.translation.mode === 'api' ? 'Sadece API' : 'Paket öncelikli'));
        if (draft.summary.translation && draft.summary.translation.keys) {
          labels.push('API anahtarları · ' + draft.summary.translation.keys.join(', '));
        }
        var video = draft.summary.video;
        if (video) {
          if (video.port && !draft.summary.ps5) labels.push('HDMI ' + video.port);
          if (video.quality) labels.push('Okuma çözünürlüğü · ' + video.quality + 'p');
          if (video.ocrRate) labels.push('Okuma sıklığı · ' + video.ocrRate + '/sn');
          if (video.region) labels.push('Altyazı alanı · ' + video.region.width + ' × ' + video.region.height + '%');
          if (video.appearance) labels.push('Altyazı görünümü · ' +
            (video.appearance.position === 'top' ? 'Üst orta' : 'Alt orta') + ' · ' + video.appearance.fontSize + ' px' +
            ' · ' + video.appearance.subtitleCount + ' altyazı');
        }
        view.remoteSetupCodePanel.hidden = true;
        view.remoteSetupApply.hidden = false;
        remoteSetupStatus('Ayarlar ulaştı.\n' + labels.join('\n'));
        view.remoteSetupApply.focus();
      }
    }, function (error) {
      if (remoteSetupDraft !== draft) return;
      draft.summary = null;
      view.remoteSetupCodePanel.hidden = view.remoteSetupApply.hidden = true;
      view.remoteSetupRetry.hidden = false;
      remoteSetupStatus(error, true);
      view.remoteSetupRetry.focus();
    });
  }

  function closeRemoteSetup() {
    var draft = remoteSetupDraft;
    if (!draft || draft.applying) return;
    remoteSetupDraft = null;
    if (draft.bridge) draft.bridge.cancel();
    view.remoteSetupEditor.hidden = true;
    view.remoteSetupCode.textContent = '';
    view.remoteSetupQr.width = view.remoteSetupQr.width;
    showSettings(view.openRemoteSetup);
  }

  function applyRemoteSetup() {
    var draft = remoteSetupDraft;
    if (!draft || !draft.summary || draft.applying) return;
    draft.applying = true;
    var wasRunning = Boolean(session);
    if (draft.summary.ps5) stop();
    view.remoteSetupApply.disabled = view.remoteSetupCancel.disabled = true;
    remoteSetupStatus(draft.summary.ps5 && draft.summary.ps5.pairing ? 'PS5 eşleştiriliyor…' : 'Ayarlar kaydediliyor…');
    function finish() {
      draft.applying = false;
      view.remoteSetupApply.disabled = view.remoteSetupCancel.disabled = false;
    }
    call('applyRemoteSetup', {}, function (response) {
      finish();
      saved = response.settings;
      view.ocrRate.value = saved.ocrRate || 3;
      drawOcrRate();
      var video = draft.summary.video || {};
      if (response.pairedNow) {
        selectedConsoleId = '';
        view.address.value = saved.address;
        view.pin.value = view.account.value = '';
        clearConsoleList();
      }
      if (draft.summary.ps5) view.address.value = saved.address;
      if (response.pairedNow || video.port) {
        manualHdmi = true;
        view.port.value = saved.port;
        showHdmi(saved.port);
      }
      if (response.pairedNow || video.quality) view.quality.value = saved.quality;
      if (response.pairedNow || video.appearance) applyAppearance(saved.appearance);
      closeRemoteSetup();
      updateButtons();
      if (response.pairedNow) showStep(2, true);
      else if (wasRunning && (draft.summary.ps5 || video.quality || video.region)) {
        start({ port: saved.port, address: saved.address, quality: saved.quality });
      }
      status('Ayarlar kaydedildi.');
    }, function (error) {
      finish();
      view.remoteSetupRetry.hidden = false;
      remoteSetupStatus(error, true);
      view.remoteSetupRetry.focus();
    });
  }

  function stop() {
    screenSaverWanted = false;
    updateScreenSaver();
    sessionNumber++;
    if (session) session.cancel();
    session = null;
    sessionReady = false;
    updateButtons();
    subtitle('');
    objective('');
    hint('');
    if (edit) view.regionPreview.textContent = 'Canlı önizleme için altyazıyı başlat.';
  }

  function start(requested, keepSettingsOpen) {
    stop();
    screenSaverWanted = true;
    updateScreenSaver();
    var settings = requested || values();
    settings.source = settings.source || saved.source || 'remotePlay';
    saved.source = settings.source;
    placeHdmiOverlay();
    var formAddress = settings.address;
    settings.consoleId = saved.consoleId;
    var ticket = sessionNumber;
    showHdmi(settings.port);
    if (!keepSettingsOpen) view.settings.hidden = Boolean(saved.setupComplete);
    status(settings.source === 'hdmi' ? 'HDMI yakalama hazırlanıyor…' : 'PS5’e bağlanıyor…');
    settings.subscribe = true;
    session = call('start', settings, function (message) {
      if (ticket !== sessionNumber) return;
      if (message.type === 'hdmiPairing') status('TV’deki ekran yakalama bağlantısını onayla.');
      if (message.type === 'address') {
        if ((!selectedConsoleId || selectedConsoleId === saved.consoleId) &&
            (view.address.value.trim() === formAddress || view.address.value.trim() === saved.address)) {
          view.address.value = message.address;
        }
        saved.address = message.address;
        updateButtons();
      }
      if (message.type === 'ready') {
        sessionReady = true;
        updateButtons();
        status(saved.setupComplete ? '' : 'PS5’e bağlandı.');
        if (edit && !edit.busy) previewRegion();
      }
      if (message.type === 'waitingVideo') {
        if (edit) view.regionPreview.textContent = 'PS5 görüntüsü bekleniyor…';
        else status('PS5 görüntüsü bekleniyor…');
      }
      if (message.type === 'reconnecting') {
        sessionReady = false;
        updateButtons();
        subtitle('');
        objective('');
        hint('');
        if (edit) view.regionPreview.textContent = 'PS5’e yeniden bağlanıyor…';
        else status('PS5’e yeniden bağlanıyor…');
      }
      if (message.type === 'preview' && edit && message.revision === edit.revision) {
        var text = (message.text || '').trim();
        var now = Date.now();
        if (text) {
          edit.lastReadAt = now;
          view.regionPreview.textContent = 'Okunan metin · ' + text;
        } else if (now - edit.lastReadAt >= 1100) {
          view.regionPreview.textContent = 'Bu alanda metin okunamadı.';
        }
      }
      if (message.type === 'subtitle' && !edit) {
        subtitle(message.text, message.speakers, message.turns);
        if (message.sourceActive === false && !appearanceDraft) drawSubtitles(subtitleTimeline.release(performance.now()));
      }
      if (message.type === 'subtitleIdle' && !edit && !appearanceDraft) {
        drawSubtitles(subtitleTimeline.release(performance.now()));
      }
      if (message.type === 'objective') objective(message.text);
      if (message.type === 'hint') hint(message.text);
      if (message.type === 'translationError') {
        lastTranslationError = message.text || '';
        if (view.translationEditor.hidden) status(message.text, true);
      }
      if (message.type === 'translationRecovered') {
        if (lastTranslationError && view.status.textContent === lastTranslationError) status('');
        lastTranslationError = '';
      }
      if (message.type === 'ended') {
        stop();
        if (edit) regionError(message.text);
        else status(message.text, true);
      }
    }, function (error) {
      if (ticket !== sessionNumber) return;
      stop();
      if (edit) regionError(error);
      else {
        if (!appearanceDraft) showSettings();
        status(error, true);
      }
    });
  }

  function clearConsoleList() {
    view.consoleList.hidden = true;
    view.consoleList.textContent = '';
    discoveryStatus('');
  }

  function discoveryStatus(text, error) {
    view.discoveryStatus.textContent = text;
    view.discoveryStatus.hidden = !text;
    view.discoveryStatus.dataset.error = String(Boolean(error));
  }

  view.findPs5.addEventListener('click', function () {
    if (pending) return;
    clearConsoleList();
    pending = true;
    updateButtons();
    discoveryStatus('PS5 aranıyor…');
    function finish(text, error) {
      pending = false;
      updateButtons();
      discoveryStatus(text, error);
    }
    function focusResult(element) {
      if (!view.settings.hidden && setupStep === 1 &&
          (document.activeElement === document.body || document.activeElement === view.findPs5)) element.focus();
    }
    call('discover', {}, function (response) {
      if (!response.consoles.length) {
        finish('PS5 bulunamadı. Aynı ağı kontrol et veya IP adresini gir.');
        focusResult(view.address);
        return;
      }
      response.consoles.forEach(function (console) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = console.name + ' · ' + console.address + (console.ready ? '' : ' · Dinlenme modu');
        button.addEventListener('click', function () {
          if (pending) return;
          selectedConsoleId = console.id;
          view.address.value = console.address;
          clearConsoleList();
          updateButtons();
          if (isPaired()) {
            if (saved.setupComplete) navigateSetup(2);
            else view.nextStep.focus();
          } else view.account.focus();
        });
        view.consoleList.appendChild(button);
      });
      view.consoleList.hidden = false;
      finish('');
      focusResult(view.consoleList.firstElementChild);
    }, function (error) {
      finish(error + ' PS5 IP adresini elle girebilirsin.', true);
      focusResult(view.address);
    });
  });

  view.pair.addEventListener('click', function () {
    var request = values();
    if (!request.port) {
      navigateSetup(0);
      view.port.focus();
      status('PS5’in HDMI girişini seç.', true);
      return;
    }
    request.pin = view.pin.value.replace(/\s/g, '');
    request.accountId = view.account.value.trim();
    if (!/^\d{8}$/.test(request.pin) || !request.accountId) {
      status('PSN hesap kimliğini ve 8 haneli kodu gir.', true);
      return;
    }
    stop();
    pending = true;
    updateButtons();
    status('PS5 eşleştiriliyor…');
    call('pair', request, function (response) {
      pending = false;
      saved = response.settings;
      applyAppearance(saved.appearance);
      view.ocrRate.value = saved.ocrRate || 3;
      drawOcrRate();
      selectedConsoleId = '';
      view.address.value = saved.address;
      clearConsoleList();
      view.pin.value = '';
      view.account.value = '';
      updateButtons();
      if (saved.setupComplete) navigateSetup(2);
      else view.nextStep.focus();
      status('PS5 eşleştirildi.');
    }, function (error) { pending = false; updateButtons(); status(error, true); });
  });

  view.setup.addEventListener('submit', function (event) {
    event.preventDefault();
    if (setupStep === 2 && !view.start.disabled) start();
  });

  setupTabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { navigateSetup(index); });
  });
  view.previousStep.addEventListener('click', function () { navigateSetup(setupStep - 1); });
  view.nextStep.addEventListener('click', function () { navigateSetup(setupStep + 1); });
  view.finishSetup.addEventListener('click', finishSetup);
  view.skipRemotePlay.addEventListener('click', function () {
    view.source.value = 'hdmi';
    navigateSetup(2);
  });
  view.source.addEventListener('change', updateButtons);

  view.address.addEventListener('input', function () {
    selectedConsoleId = '';
    clearConsoleList();
    updateButtons();
  });
  view.port.addEventListener('change', function () {
    manualHdmi = true;
    if (!saved.setupComplete && session) stop();
    showHdmi(Number(view.port.value));
    updateButtons();
  });
  view.quality.addEventListener('change', function () {
    if (pending || setupSaving || !isPaired()) return;
    start(null, true);
  });
  bindRangeChange(view.ocrRate, drawOcrRate);
  view.saveOcrRate.addEventListener('click', saveOcrRate);
  view.close.addEventListener('click', function () { view.settings.hidden = true; });
  view.editArea.addEventListener('click', function () { openRegionEditor('region'); });
  view.editObjectiveArea.addEventListener('click', function () { openRegionEditor('objectiveRegion'); });
  window.addEventListener('resize', function () {
    placeHdmiOverlay();
    reserveObjectiveSpace();
    if (!appearanceDraft && !view.subtitle.hidden) drawSubtitles(subtitleTimeline.snapshot(performance.now()));
  });
  view.editAppearance.addEventListener('click', openAppearanceEditor);
  view.appearancePosition.addEventListener('click', function () {
    appearanceDraft.position = appearanceDraft.position === 'top' ? 'bottom' : 'top';
    drawAppearanceEditor();
  });
  view.appearanceBackground.addEventListener('click', function () {
    appearanceDraft.background = !appearanceDraft.background;
    drawAppearanceEditor();
  });
  view.appearanceNames.addEventListener('click', function () {
    appearanceDraft.showSpeakerNames = !appearanceDraft.showSpeakerNames;
    drawAppearanceEditor();
  });
  [[view.appearanceOffset, 'offset'], [view.appearanceSize, 'fontSize'], [view.appearanceCount, 'subtitleCount'],
    [view.appearanceOpacity, 'opacity'], [view.appearanceBlur, 'backgroundBlur'],
    [view.appearancePaddingX, 'paddingX'], [view.appearancePaddingY, 'paddingY'], [view.appearanceDuration, 'durationScale']]
    .forEach(function (entry) {
      bindRangeChange(entry[0], function (value) {
        appearanceDraft[entry[1]] = value;
        drawAppearanceEditor();
      });
    });
  view.saveAppearance.addEventListener('click', saveAppearance);
  view.cancelAppearance.addEventListener('click', closeAppearanceEditor);
  view.editTranslation.addEventListener('click', openTranslationEditor);
  view.translationMode.addEventListener('click', function () {
    translationDraft.mode = translationDraft.mode === 'api' ? 'pack' : 'api';
    drawTranslationEditor();
  });
  bindRangeChange(view.translationSimilarity, function (value) {
    translationDraft.similarity = value;
    drawTranslationEditor();
  });
  view.translationProvider.addEventListener('click', function () {
    rememberTranslationKey();
    translationDraft.provider = translationDraft.provider === 'gemini' ? 'openai' : 'gemini';
    view.translationKey.value = translationDraft.keys[translationDraft.provider] || '';
    drawTranslationEditor();
    translationStatus('');
  });
  view.removeTranslationKey.addEventListener('click', function () {
    translationDraft.keys[translationDraft.provider] = null;
    translationDraft.mode = 'pack';
    view.translationKey.value = '';
    drawTranslationEditor();
    view.translationKey.focus();
    translationStatus('Anahtar kaydedince kaldırılacak.');
  });
  view.testTranslation.addEventListener('click', function () { submitTranslation(true); });
  view.saveTranslation.addEventListener('click', function () { submitTranslation(false); });
  view.cancelTranslation.addEventListener('click', closeTranslationEditor);
  view.openRemoteSetup.addEventListener('click', beginRemoteSetup);
  view.remoteSetupApply.addEventListener('click', applyRemoteSetup);
  view.remoteSetupRetry.addEventListener('click', beginRemoteSetup);
  view.remoteSetupCancel.addEventListener('click', closeRemoteSetup);
  view.updatePack.addEventListener('click', function () {
    if (view.updatePack.disabled) return;
    view.updatePack.disabled = true;
    status('Altyazı paketi kontrol ediliyor…');
    function finish(text, error) {
      view.updatePack.disabled = false;
      if (!view.settings.hidden && document.activeElement === document.body) view.updatePack.focus();
      status(text, error);
    }
    call('updatePack', {}, function (result) {
      if (result.updated) subtitle('');
      var text = result.updated ? 'Altyazı paketi güncellendi' : 'Altyazı paketi zaten güncel';
      if (result.version) text += ' (' + result.version + ')';
      finish(text + '.');
    }, function (error) { finish(error, true); });
  });
  view.regionAction.addEventListener('click', advanceRegionEdit);
  view.regionCancel.addEventListener('click', function () { finishRegionEdit(false); });

  view.regionBox.addEventListener('pointerdown', function (event) {
    if (!edit || edit.busy || edit.mode === 'choose' || event.button !== 0 ||
        (edit.mode === 'resize' && event.target !== view.regionHandle)) return;
    event.preventDefault();
    edit.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, region: edit.region };
    view.regionBox.setPointerCapture(event.pointerId);
  });
  view.regionBox.addEventListener('pointermove', function (event) {
    var drag = edit && edit.drag;
    if (!drag || drag.id !== event.pointerId || edit.busy) return;
    changeRegion(drag.region, Math.round((event.clientX - drag.x) * 100 / window.innerWidth),
      Math.round((event.clientY - drag.y) * 100 / window.innerHeight));
  });
  view.regionBox.addEventListener('lostpointercapture', function (event) {
    if (edit && edit.drag && edit.drag.id === event.pointerId) edit.drag = null;
  });

  document.addEventListener('keydown', function (event) {
    if (remoteSetupDraft) {
      if (event.keyCode === 461 || event.keyCode === 27) {
        event.preventDefault();
        if (!event.repeat) closeRemoteSetup();
      } else if (event.keyCode >= 37 && event.keyCode <= 40) {
        event.preventDefault();
        if (remoteSetupDraft.applying) return;
        var remoteControls = [view.remoteSetupApply, view.remoteSetupRetry, view.remoteSetupCancel]
          .filter(function (control) { return !control.hidden; });
        var remoteIndex = remoteControls.indexOf(document.activeElement);
        remoteControls[clamp(remoteIndex + (event.keyCode === 37 || event.keyCode === 38 ? -1 : 1),
          0, remoteControls.length - 1)].focus();
      }
      return;
    }
    if (!view.translationEditor.hidden) {
      if (event.keyCode === 461 || event.keyCode === 27) {
        if (event.target === view.translationKey) return;
        event.preventDefault();
        if (!translationBusy && !event.repeat) closeTranslationEditor();
      } else if (event.keyCode === 38 || event.keyCode === 40) {
        event.preventDefault();
        if (translationBusy) return;
        var translationFields = translationControls.filter(function (control) { return !control.hidden && !control.disabled; });
        var translationIndex = translationFields.indexOf(document.activeElement);
        translationFields[clamp(translationIndex + (event.keyCode === 40 ? 1 : -1), 0, translationFields.length - 1)].focus();
      }
      return;
    }
    if (appearanceDraft) {
      if (event.keyCode === 461 || event.keyCode === 27) {
        event.preventDefault();
        if (!appearanceSaving && !event.repeat) closeAppearanceEditor();
      } else if (event.keyCode === 38 || event.keyCode === 40) {
        event.preventDefault();
        if (appearanceSaving) return;
        var controls = appearanceControls.filter(function (control) { return !control.disabled; });
        var index = controls.indexOf(document.activeElement);
        controls[clamp(index + (event.keyCode === 40 ? 1 : -1), 0, controls.length - 1)].focus();
      }
      return;
    }
    if (edit) {
      var key = event.keyCode;
      if (key === 461 || key === 27) {
        event.preventDefault();
        if (!event.repeat) finishRegionEdit(false);
      } else if (edit.mode === 'choose') {
        if (key >= 37 && key <= 40) {
          event.preventDefault();
          if (edit.busy) return;
          var choices = edit.choices.concat(view.regionCancel);
          var choice = choices.indexOf(document.activeElement);
          choices[clamp(choice + (key === 37 || key === 38 ? -1 : 1), 0, choices.length - 1)].focus();
        }
      } else if (key === 13 && event.target !== view.regionAction && event.target !== view.regionCancel) {
        event.preventDefault();
        if (!event.repeat) advanceRegionEdit();
      } else if (key >= 37 && key <= 40) {
        event.preventDefault();
        if (!edit.busy) changeRegion(edit.region, Number(key === 39) - Number(key === 37),
          Number(key === 40) - Number(key === 38));
      }
      return;
    }
    if (event.keyCode === 461 || event.keyCode === 27) {
      if (event.target === view.address || event.target === view.account || event.target === view.pin) return;
      event.preventDefault();
      if (view.settings.hidden) showSettings();
      else if (pending || setupSaving) return;
      else if (saved.setupComplete) view.settings.hidden = true;
      else if (setupStep > 0) navigateSetup(setupStep - 1);
      return;
    }
    if (view.settings.hidden) return;
    if ((event.keyCode === 37 || event.keyCode === 39) && setupTabs.indexOf(event.target) !== -1) {
      event.preventDefault();
      navigateSetup(setupStep + (event.keyCode === 39 ? 1 : -1));
      return;
    }
    if (event.keyCode !== 38 && event.keyCode !== 40) return;
    var focusable = Array.prototype.filter.call(view.setup.querySelectorAll('input, select, button, summary'), function (element) {
      return !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden]');
    });
    if (!focusable.length) return;
    var current = focusable.indexOf(document.activeElement);
    event.preventDefault();
    focusable[Math.min(focusable.length - 1, Math.max(0, current + (event.keyCode === 40 ? 1 : -1)))].focus();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (remoteSetupDraft) closeRemoteSetup();
      stop();
    }
    else if (saved.setupComplete && (saved.source === 'hdmi' || isPaired()) && view.settings.hidden) start();
  });
  window.addEventListener('unload', stop);
  document.addEventListener('visibilitychange', updateScreenSaver);

  updateButtons();
  call('settings', {}, function (response) {
    pending = false;
    saved = response.settings;
    applyAppearance(saved.appearance);
    view.ocrRate.value = saved.ocrRate || 3;
    drawOcrRate();
    view.port.value = saved.paired ? saved.port : '';
    view.address.value = saved.address;
    view.quality.value = saved.quality;
    view.source.value = saved.source || 'remotePlay';
    showStep(saved.paired || saved.setupComplete ? 2 : 0);
    showHdmi(Number(view.port.value));
    detectHdmiInputs();
    if (saved.setupComplete) start();
    else {
      showSettings();
      status('');
    }
  }, function (error) {
    pending = false;
    showStep(0);
    showSettings();
    if (window.PalmServiceBridge) status(error, true);
    else {
      document.body.classList.add('browser-preview');
      status('');
    }
  });
}());
