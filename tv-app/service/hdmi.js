'use strict';

const https = require('https');
const os = require('os');
const { URL } = require('url');

const maxImageSize = 2 * 1024 * 1024;

function openCapture(key, onPrompt) {
  const WebSocket = require('ws');
  const socket = new WebSocket('wss://127.0.0.1:3001', {
    rejectUnauthorized: false, handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 32 * 1024
  });
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  let request, pending, sequence = 0, closed = false;

  function settle(error, result) {
    if (!pending) return;
    const operation = pending;
    pending = null;
    clearTimeout(operation.timer);
    if (error) operation.reject(error); else operation.resolve(result);
  }

  function expect(id, timeout, error) {
    return new Promise(function (resolve, reject) {
      pending = { id: id, resolve: resolve, reject: reject, timer: setTimeout(function () {
        settle(Error(error));
      }, timeout) };
    });
  }

  const ready = expect('register', 45000, 'TV kumanda eşleştirmesi zaman aşımına uğradı.');
  socket.on('open', function () {
    const payload = { pairingType: 'PROMPT', forcePairing: false,
      manifest: { manifestVersion: 1, appVersion: '1.0', permissions: ['CONTROL_DISPLAY'] } };
    if (key) payload['client-key'] = key;
    socket.send(JSON.stringify({ type: 'register', id: 'register', payload: payload }));
  });
  socket.on('message', function (bytes) {
    let message;
    try { message = JSON.parse(bytes); } catch (error) { return; }
    if (!pending || message.id !== pending.id) return;
    const data = message.payload || {};
    if (pending.id === 'register' && message.type === 'registered') {
      settle(null, typeof data['client-key'] === 'string' ? data['client-key'] : key);
    } else if (pending.id === 'register' && data.pairingType === 'PROMPT') {
      onPrompt();
    } else if (message.type === 'error' || data.returnValue === false) {
      settle(Error(pending.id === 'register' ? 'TV kumanda eşleştirmesini reddetti.' : 'TV ekran görüntüsü isteğini reddetti.'));
    } else if (pending.id !== 'register' && typeof data.imageUri === 'string') {
      settle(null, data.imageUri);
    }
  });
  socket.on('error', function () { settle(Error('TV ekran görüntüsü bağlantısı açılamadı.')); });
  socket.on('close', function () { settle(Error('TV ekran görüntüsü bağlantısı kapandı.')); });

  function download(uri) {
    const url = new URL(uri);
    const local = Object.keys(os.networkInterfaces()).reduce(function (addresses, name) {
      return addresses.concat(os.networkInterfaces()[name].map(function (entry) { return entry.address; }));
    }, ['127.0.0.1', 'localhost']);
    if (url.protocol !== 'https:' || local.indexOf(url.hostname) === -1 ||
        url.username || url.password || url.hash) throw Error('TV geçersiz bir ekran görüntüsü adresi döndürdü.');
    return new Promise(function (resolve, reject) {
      request = https.get({ hostname: '127.0.0.1', port: url.port || 443, path: url.pathname + url.search,
        agent: agent, rejectUnauthorized: false }, function (response) {
        if (response.statusCode !== 200) {
          response.resume();
          reject(Error('TV ekran görüntüsü indirilemedi.'));
          return;
        }
        const chunks = [];
        let length = 0;
        response.on('data', function (chunk) {
          length += chunk.length;
          if (length > maxImageSize) request.destroy(Error('TV ekran görüntüsü boyutu geçersiz.'));
          else chunks.push(chunk);
        });
        response.on('aborted', function () { reject(Error('TV ekran görüntüsü yarıda kesildi.')); });
        response.on('error', reject);
        response.on('end', function () {
          const image = Buffer.concat(chunks);
          if (image.length < 4 || image.readUInt16BE(0) !== 0xffd8 ||
              image.readUInt16BE(image.length - 2) !== 0xffd9) {
            reject(Error('TV geçerli bir JPEG karesi döndürmedi.'));
          } else resolve(image);
        });
      });
      request.setTimeout(6000, function () { request.destroy(Error('TV ekran görüntüsü indirme süresi doldu.')); });
      request.on('error', reject);
      request.on('close', function () { request = null; });
    });
  }

  return {
    ready: ready,
    async frame() {
      if (closed || pending || socket.readyState !== WebSocket.OPEN) throw Error('TV ekran görüntüsü bağlantısı hazır değil.');
      const id = 'capture-' + (++sequence);
      const uri = expect(id, 6000, 'TV ekran görüntüsü isteği zaman aşımına uğradı.');
      socket.send(JSON.stringify({ type: 'request', id: id, uri: 'ssap://tv/executeOneShot', payload: {} }),
        function (error) { if (error) settle(Error('TV ekran görüntüsü isteği gönderilemedi.')); });
      return download(await uri);
    },
    close() {
      if (closed) return;
      closed = true;
      settle(Error('HDMI bağlantısı durduruldu.'));
      if (request) request.destroy();
      agent.destroy();
      socket.terminate();
    }
  };
}

module.exports = { openCapture };
