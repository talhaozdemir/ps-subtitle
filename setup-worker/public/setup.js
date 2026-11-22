'use strict';

const byId = id => document.getElementById(id);
const form = byId('setup');
const code = byId('code');
const send = byId('send');
const status = byId('status');
const text = new TextEncoder();

function notify(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
  status.hidden = !message;
}

function enableSection(toggle, section) {
  const update = () => {
    section.hidden = section.disabled = !toggle.checked;
  };
  toggle.addEventListener('change', update);
  update();
}

enableSection(byId('includePs5'), byId('ps5'));
enableSection(byId('includeTranslation'), byId('translation'));
enableSection(byId('includeVideo'), byId('video'));

const qrCode = location.hash.slice(1);
if (/^[0-9a-f]{32}$/.test(qrCode)) {
  code.value = qrCode;
  byId('codeRow').hidden = true;
  history.replaceState(null, '', location.pathname);
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

function derive(label, secret) {
  return crypto.subtle.digest('SHA-256', text.encode('ps-subtitle/setup/v1/' + label + '/' + secret));
}

function videoSettings() {
  const video = {};
  for (const name of ['port', 'quality', 'ocrRate']) {
    const value = byId(name).value;
    if (value !== '') video[name] = Number(value);
  }
  const region = {};
  for (const [name, id] of [['x', 'regionX'], ['y', 'regionY'], ['width', 'regionWidth'], ['height', 'regionHeight']]) {
    const value = byId(id).value;
    if (value !== '') region[name] = Number(value);
  }
  if (Object.keys(region).length) video.region = region;

  const appearance = {};
  for (const name of ['offset', 'fontSize', 'opacity', 'durationScale', 'paddingX', 'paddingY']) {
    const value = byId(name).value;
    if (value !== '') appearance[name] = Number(value);
  }
  if (byId('position').value) appearance.position = byId('position').value;
  if (byId('background').value) appearance.background = byId('background').value === 'on';
  if (byId('showSpeakerNames').value) appearance.showSpeakerNames = byId('showSpeakerNames').value === 'on';
  if (Object.keys(appearance).length) video.appearance = appearance;
  return video;
}

function settings() {
  const draft = {};
  if (byId('includePs5').checked) {
    const address = byId('address').value.trim();
    const accountId = byId('account').value.trim();
    const pin = byId('pin').value.replace(/\s/g, '');
    if (address && (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) || address.split('.').some(part => Number(part) > 255))) {
      throw new Error('PS5’in IPv4 adresini kontrol et.');
    }
    if ((accountId || pin) && (!/^(?:\d{1,20}|[A-Za-z0-9+/]{11}=)$/.test(accountId) || !/^\d{8}$/.test(pin))) {
      throw new Error('PSN hesap kimliğini ve 8 haneli eşleştirme kodunu kontrol et.');
    }
    if (address || accountId || pin) {
      draft.ps5 = {};
      if (address) draft.ps5.address = address;
      if (accountId) draft.ps5.accountId = accountId;
      if (pin) draft.ps5.pin = pin;
    }
  }
  if (byId('includeTranslation').checked) {
    const gemini = byId('geminiKey').value.trim();
    const openai = byId('openaiKey').value.trim();
    if ([gemini, openai].some(key => key && !/^[!-~]{1,512}$/.test(key))) {
      throw new Error('API anahtarlarını boşluksuz gir.');
    }
    const mode = byId('mode').value;
    const provider = byId('provider').value;
    if (mode || provider || gemini || openai) {
      draft.translation = {};
      if (gemini || openai) {
        draft.translation.keys = {};
        if (gemini) draft.translation.keys.gemini = gemini;
        if (openai) draft.translation.keys.openai = openai;
      }
      if (mode) draft.translation.mode = mode;
      if (provider) draft.translation.provider = provider;
    }
  }
  if (byId('includeVideo').checked) {
    const video = videoSettings();
    if (Object.keys(video).length) draft.video = video;
  }
  if (!Object.keys(draft).length) throw new Error('Göndereceğin ayarları seç.');
  return draft;
}

async function upload(draft, secret) {
  const [identifier, uploadKey, keyBytes] = await Promise.all([
    derive('id', secret), derive('upload', secret), derive('key', secret)
  ]);
  const id = hex(identifier).slice(0, 32);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(id) },
    key, text.encode(JSON.stringify(draft)));
  return fetch('/api/setup/' + id, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + hex(uploadKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ iv: hex(iv), ciphertext: hex(ciphertext) })
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (send.disabled) return;
  const secret = code.value.toLowerCase().replace(/[\s-]/g, '');
  if (!/^[0-9a-f]{32}$/.test(secret)) {
    notify('TV’deki kurulum kodunu kontrol et.', true);
    return;
  }
  let draft;
  try { draft = settings(); } catch (error) { notify(error.message, true); return; }
  send.disabled = true;
  notify('TV’ye gönderiliyor…');
  try {
    const result = await upload(draft, secret);
    if (result.status === 204) {
      form.reset();
      form.hidden = true;
      notify('Ayarlar gönderildi. TV’de Uygula’ya bas.');
    } else if (result.status === 409) notify('Bu oturumda başka ayarlar bekliyor. TV’den yeni kod al.', true);
    else if (result.status === 404) notify('Kurulum oturumu bulunamadı. TV’den yeni kod al.', true);
    else notify('Ayarlar gönderilemedi. Tekrar dene.', true);
  } catch {
    notify('Bağlantı kurulamadı. Tekrar dene.', true);
  } finally {
    send.disabled = false;
  }
});
