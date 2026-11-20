(function () {
  'use strict';

  var service = 'luna://com.gtavi.turkce.altyazi/';
  var view = {};
  var session;
  var sessionReady = false;
  var sessionNumber = 0;
  var noticeTimer;
  var subtitleTimer;
  var saved = { port: 1, address: '', quality: 540, paired: false };
  var pending = true;
  var manualHdmi = false;
  var selectedConsoleId = '';
  var edit;
  var regionRevision = 0;
  var appearanceDraft;
  var appearanceSaving = false;
  var setupStep = 0;
  var setupSaving = false;

  ['hdmi', 'subtitle', 'notice', 'settings', 'setup', 'port', 'findPs5', 'discoveryStatus', 'consoleList',
    'address', 'quality', 'account', 'pin',
    'status', 'start', 'pair', 'editArea', 'updatePack', 'close', 'regionEditor', 'regionBox', 'regionHandle', 'regionTitle',
    'regionHelp', 'regionPreview', 'regionError', 'regionAction', 'regionCancel', 'editAppearance',
    'appearanceEditor', 'appearancePosition', 'appearancePositionValue', 'appearanceEdge',
    'appearanceOffset', 'appearanceOffsetValue', 'appearanceSize', 'appearanceSizeValue',
    'appearanceBackground', 'appearanceBackgroundValue', 'appearanceOpacity', 'appearanceOpacityValue',
    'appearanceError', 'saveAppearance', 'cancelAppearance', 'tabHdmi', 'tabPs5',
    'tabSubtitle', 'stepHdmi', 'stepPs5', 'stepSubtitle', 'trialHelp', 'subtitleOptions', 'previousStep',
    'nextStep', 'finishSetup']
    .forEach(function (id) { view[id] = document.getElementById(id); });
  var setupTabs = [view.tabHdmi, view.tabPs5, view.tabSubtitle];
  var setupPanels = [view.stepHdmi, view.stepPs5, view.stepSubtitle];
  var appearanceControls = [view.appearancePosition, view.appearanceOffset, view.appearanceSize,
    view.appearanceBackground, view.appearanceOpacity, view.saveAppearance, view.cancelAppearance];

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

  function subtitle(text) {
    if (appearanceDraft) return;
    window.clearTimeout(subtitleTimer);
    view.subtitle.textContent = text || '';
    view.subtitle.hidden = !text;
    if (text) subtitleTimer = window.setTimeout(function () { subtitle(''); }, 1800);
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
    return { port: Number(view.port.value), address: view.address.value.trim(), quality: Number(view.quality.value) };
  }

  function isPaired() {
    if (!saved.paired) return false;
    if (selectedConsoleId && saved.consoleId) return selectedConsoleId === saved.consoleId;
    return view.address.value.trim() === saved.address;
  }

  function updateButtons() {
    var paired = isPaired();
    var complete = saved.setupComplete;
    view.port.disabled = pending || setupSaving;
    view.findPs5.disabled = pending;
    view.start.disabled = pending || setupSaving || !paired;
    view.pair.disabled = pending;
    view.editArea.disabled = pending || !saved.region;
    view.editAppearance.disabled = pending || !saved.appearance;
    view.previousStep.hidden = complete || setupStep === 0;
    view.previousStep.disabled = pending || setupSaving;
    view.nextStep.hidden = complete || setupStep === 2;
    view.nextStep.disabled = pending || (setupStep === 0 && !view.port.value) || (setupStep === 1 && !paired);
    view.finishSetup.hidden = complete || setupStep !== 2;
    view.finishSetup.disabled = pending || setupSaving || !paired || !sessionReady;
    view.close.hidden = !complete;
    view.subtitleOptions.hidden = !complete;
    view.start.textContent = complete ? 'Altyazıyı başlat' : 'Altyazıyı dene';
    view.trialHelp.hidden = complete && paired;
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
    view.regionPreview.textContent = session ? 'Metin aranıyor…' : 'Canlı önizleme için altyazıyı başlat.';
    if (!session) return;
    var revision = draft.revision;
    draft.timer = window.setTimeout(function () {
      call('setRegion', { region: draft.region, revision: revision, preview: true }, function () {}, function (error) {
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

  function changeRegion(origin, dx, dy) {
    var next = Object.assign({}, origin);
    if (edit.mode === 'resize') {
      var bottom = origin.y + origin.height;
      next.width = clamp(origin.width + dx, 10, 100 - origin.x);
      next.height = clamp(origin.height - dy, 5, bottom);
      next.y = bottom - next.height;
    } else {
      next.x = clamp(origin.x + dx, 0, 100 - origin.width);
      next.y = clamp(origin.y + dy, 0, 100 - origin.height);
    }
    var current = edit.region;
    if (next.x === current.x && next.y === current.y &&
        next.width === current.width && next.height === current.height) return;
    edit.region = next;
    drawRegion();
    regionError('');
    previewRegion();
  }

  function setRegionMode(mode) {
    edit.mode = mode;
    var resize = mode === 'resize';
    view.regionEditor.dataset.mode = mode;
    view.regionTitle.textContent = resize ? 'Altyazı alanını boyutlandır' : 'Altyazı alanını taşı';
    view.regionHelp.textContent = resize
      ? '← / → genişliği, ↑ / ↓ yüksekliği ayarlar. İki satırlık yer bırak.'
      : 'Yön tuşlarıyla kutuyu altyazının üzerine getir.';
    view.regionAction.textContent = resize ? 'OK · Kaydet' : 'OK · Boyutlandır';
    view.regionHandle.hidden = !resize;
    view.regionEditor.focus();
  }

  function openRegionEditor() {
    edit = { region: Object.assign({}, saved.region), busy: false };
    view.settings.hidden = true;
    view.notice.hidden = true;
    subtitle('');
    view.regionEditor.hidden = false;
    regionError('');
    setRegionMode('move');
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
    var region = save ? draft.region : saved.region;
    call('setRegion', { region: region, revision: draft.revision, save: save }, function () {
      if (save) saved.region = region;
      edit = null;
      view.regionEditor.hidden = true;
      view.regionAction.disabled = view.regionCancel.disabled = false;
      if (!save) showSettings(view.editArea);
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

  function applyAppearance(appearance) {
    view.subtitle.dataset.position = appearance.position;
    view.subtitle.style.setProperty('--subtitle-offset', appearance.offset + '%');
    view.subtitle.style.setProperty('--subtitle-size', appearance.fontSize + 'px');
    view.subtitle.style.setProperty('--subtitle-background', appearance.background
      ? 'rgba(0, 0, 0, ' + appearance.opacity / 100 + ')' : 'transparent');
  }

  function drawAppearanceEditor() {
    var draft = appearanceDraft;
    var top = draft.position === 'top';
    view.appearancePositionValue.textContent = top ? 'Üst orta' : 'Alt orta';
    view.appearanceEdge.textContent = top ? 'Üst kenardan mesafe' : 'Alt kenardan mesafe';
    view.appearanceBackground.setAttribute('aria-pressed', String(draft.background));
    view.appearanceBackgroundValue.textContent = draft.background ? 'Açık' : 'Kapalı';
    view.appearanceOffset.value = draft.offset;
    view.appearanceSize.value = draft.fontSize;
    view.appearanceOpacity.value = draft.opacity;
    view.appearanceOffsetValue.textContent = '%' + draft.offset;
    view.appearanceSizeValue.textContent = draft.fontSize + ' px';
    view.appearanceOpacityValue.textContent = '%' + draft.opacity;
    appearanceControls.forEach(function (control) { control.disabled = appearanceSaving; });
    view.appearanceOpacity.disabled = appearanceSaving || !draft.background;
    view.appearanceOpacity.labels[0].dataset.disabled = String(!draft.background);
    applyAppearance(draft);
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
    drawAppearanceEditor();
    view.subtitle.textContent = 'Örnek altyazı';
    view.subtitle.hidden = false;
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

  function stop() {
    sessionNumber++;
    if (session) session.cancel();
    session = null;
    sessionReady = false;
    updateButtons();
    subtitle('');
    if (edit) view.regionPreview.textContent = 'Canlı önizleme için altyazıyı başlat.';
  }

  function start() {
    stop();
    var settings = values();
    var formAddress = settings.address;
    settings.consoleId = saved.consoleId;
    var ticket = sessionNumber;
    showHdmi(settings.port);
    view.settings.hidden = Boolean(saved.setupComplete);
    status('PS5’e bağlanıyor…');
    settings.subscribe = true;
    session = call('start', settings, function (message) {
      if (ticket !== sessionNumber) return;
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
        if (edit && !edit.busy) previewRegion();
        else status(saved.setupComplete ? '' : 'PS5’e bağlandı.');
      }
      if (message.type === 'preview' && edit && message.revision === edit.revision) {
        var text = (message.text || '').trim();
        view.regionPreview.textContent = text ? 'Okunan metin · ' + text : 'Bu alanda metin okunamadı.';
      }
      if (message.type === 'subtitle' && !edit) subtitle(message.text);
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
  view.quality.addEventListener('change', function () { if (!saved.setupComplete && session) stop(); });
  view.close.addEventListener('click', function () { view.settings.hidden = true; });
  view.editArea.addEventListener('click', openRegionEditor);
  view.editAppearance.addEventListener('click', openAppearanceEditor);
  view.appearancePosition.addEventListener('click', function () {
    appearanceDraft.position = appearanceDraft.position === 'top' ? 'bottom' : 'top';
    drawAppearanceEditor();
  });
  view.appearanceBackground.addEventListener('click', function () {
    appearanceDraft.background = !appearanceDraft.background;
    drawAppearanceEditor();
  });
  [[view.appearanceOffset, 'offset'], [view.appearanceSize, 'fontSize'], [view.appearanceOpacity, 'opacity']]
    .forEach(function (entry) {
      var range = entry[0];
      function updateRange() {
        appearanceDraft[entry[1]] = Number(range.value);
        drawAppearanceEditor();
      }
      range.addEventListener('input', updateRange);
      range.addEventListener('keydown', function (event) {
        if (event.keyCode !== 37 && event.keyCode !== 39) return;
        event.preventDefault();
        range.stepUp(event.keyCode === 39 ? 1 : -1);
        updateRange();
      });
    });
  view.saveAppearance.addEventListener('click', saveAppearance);
  view.cancelAppearance.addEventListener('click', closeAppearanceEditor);
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
    if (!edit || edit.busy || event.button !== 0 || (edit.mode === 'resize' && event.target !== view.regionHandle)) return;
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
    if (document.hidden) stop();
    else if (saved.setupComplete && isPaired() && view.settings.hidden) start();
  });
  window.addEventListener('unload', stop);

  updateButtons();
  call('settings', {}, function (response) {
    pending = false;
    saved = response.settings;
    applyAppearance(saved.appearance);
    view.port.value = saved.paired ? saved.port : '';
    view.address.value = saved.address;
    view.quality.value = saved.quality;
    showStep(saved.paired ? 2 : 0);
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
